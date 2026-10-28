import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import type { AppConfig } from "../config/app-config.js";
import { HOST_FRESHNESS_THRESHOLD_MS } from "../common/host-health.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { VpsRecord } from "../vps/vps.models.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { KeyService } from "../ssh/keyService.js";
import { SshService } from "../ssh/ssh.service.js";
import { AuditService } from "../audit/audit.service.js";
import { AgentLifecycleCoordinator } from "./agent-lifecycle-coordinator.js";
import { buildAgentPresenceProbeCommand, classifyAgentPresence } from "./agent-lifecycle-remote.js";
import {
  AGENT_REPOSITORY,
  APP_CONFIG,
  KEY_SERVICE,
  VPS_REPOSITORY,
} from "../tokens.js";

const DEFAULT_INTERVAL_SECONDS = 60;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_CANDIDATES_PER_SWEEP = 10;

type PresenceResult = "present" | "absent" | "unknown";

@Injectable()
export class AgentPresenceReconcilerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AgentPresenceReconcilerService.name);
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private candidateCursor = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    @Inject(VPS_REPOSITORY) private readonly vpss: VpsRepository,
    @Inject(KEY_SERVICE) private readonly keys: KeyService,
    @Inject(SshService) private readonly ssh: SshService,
    @Inject(AgentLifecycleCoordinator) private readonly lifecycle: AgentLifecycleCoordinator,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.mode === "demo" || this.config.agentPresenceReconcileEnabled === false) return;
    if (this.intervalTimer) return;
    this.stopping = false;
    const intervalMs = Math.max(
      10,
      this.config.agentPresenceReconcileIntervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
    ) * 1000;
    // Do not open SSH connections during application startup; the first sweep is
    // delayed by one interval and is still bounded to stale states.
    this.intervalTimer = setInterval(() => void this.runOnce(), intervalMs);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    await this.inFlight;
  }

  async runOnce(): Promise<void> {
    if (this.stopping || this.inFlight) return;
    this.inFlight = this.reconcile().catch((error: unknown) => {
      this.logger.warn(`Agent presence sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async reconcile(): Promise<void> {
    const [states, vpss] = await Promise.all([this.agents.listStates(), this.vpss.list()]);
    const records = new Map(vpss.map((vps) => [vps.id, vps]));
    const cutoff = Date.now() - HOST_FRESHNESS_THRESHOLD_MS;
    const candidates = states
      .filter((state) => {
        const vps = records.get(state.vpsId);
        const seen = state.lastSeenAt ? Date.parse(state.lastSeenAt) : NaN;
        return state.status === "online" && Number.isFinite(seen) && seen <= cutoff &&
          vps?.kind !== "local" && vps?.managedBy !== "system" && Boolean(vps?.keyProvisionedAt);
      })
      .sort((a, b) => Date.parse(a.lastSeenAt!) - Date.parse(b.lastSeenAt!));
    const start = this.candidateCursor % (candidates.length || 1);
    this.candidateCursor = start + MAX_CANDIDATES_PER_SWEEP;
    const batch = candidates.slice(start, start + MAX_CANDIDATES_PER_SWEEP);
    if (candidates.length > MAX_CANDIDATES_PER_SWEEP && batch.length < MAX_CANDIDATES_PER_SWEEP)
      batch.push(...candidates.slice(0, MAX_CANDIDATES_PER_SWEEP - batch.length));

    for (const state of batch) {
      if (this.stopping) return;
      const vps = records.get(state.vpsId);
      if (vps) await this.reconcileOne(vps, state.lastSeenAt!);
    }
  }

  private async reconcileOne(vps: VpsRecord, expectedLastSeenAt: string): Promise<void> {
    let key: string;
    try {
      key = await this.keys.readPrivateKey(vps.id);
    } catch {
      return;
    }

    let result: PresenceResult;
    try {
      const response = await this.ssh.execCommandStrict(
        vps,
        buildAgentPresenceProbeCommand(vps.id),
        { privateKey: key },
        PROBE_TIMEOUT_MS,
      );
      result = classifyAgentPresence(response.stdout);
    } catch {
      return;
    }
    if (result !== "absent") return;

    let release: (() => void) | undefined;
    try {
      release = await this.lifecycle.tryAcquire(vps.id, "reconcile");
      const currentVps = await this.vpss.get(vps.id);
      if (!currentVps || currentVps.host !== vps.host || currentVps.port !== vps.port || currentVps.username !== vps.username || currentVps.keyProvisionedAt !== vps.keyProvisionedAt) return;
      const current = await this.agents.getState(vps.id);
      if (current?.status !== "online" || current.lastSeenAt !== expectedLastSeenAt) return;
      if (await this.agents.markAgentAbsent(vps.id, expectedLastSeenAt)) {
        await this.audit.record({
          actor: "system",
          action: "agent.reconcile.removed",
          resourceType: "vps",
          resourceId: vps.id,
          result: "success",
          severity: "warning",
          metadata: { reason: "managed-agent-absent", lastSeenAt: expectedLastSeenAt },
        });
      }
    } catch (error) {
      this.logger.warn(`Agent presence reconciliation failed for ${vps.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      release?.();
    }
  }
}
