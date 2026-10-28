import {
  createContext,
  FormEvent,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { Alert } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import {
  createVps,
  deleteVps,
  getDashboardOverview,
  getHostKeyTrustRequired,
  listAuditEvents,
  listJobs,
  listMetrics,
  listVps,
  installAgent,
  logoutDashboard,
  provisionKey,
  restartAgent,
  rotateAgent,
  trustSshHostKey,
  uninstallAgent,
  updateDashboardSettings,
  updateVps,
  verifyKey,
  type DashboardOverview,
  type DashboardSettingsResponse,
  type UpdateDashboardSettingsPayload,
  type UpdateVpsPayload,
  type VpsRecord,
} from "../lib/api";
import { subscribeMonitoring, type LiveConnectionState } from "../lib/live-api";
import { vpsDisplayName } from "../lib/dashboard-formatters";

// ── Types ────────────────────────────────────────────────────────────

type StatusKind = "default" | "success" | "destructive";
type Status = { message: string; kind: StatusKind } | null;

type PendingHostKeyTrust = {
  vpsId: string;
  vpsName: string;
  host: string;
  port: number;
  fingerprint?: string;
  keyType?: string;
  password: string;
  afterTrustPath?: string;
};

const initialCreateForm = {
  name: "",
  displayName: "",
  host: "",
  port: "22",
  username: "",
  password: "",
};

export type DashboardCtx = {
  records: VpsRecord[];
  visibleRecords: VpsRecord[];
  overview: DashboardOverview;
  statusAlert: ReactNode;
  serverSearch: string;
  statusFilter: string;
  busy: boolean;
  provisionPasswords: Record<string, string>;
  createForm: typeof initialCreateForm;
  metrics: DashboardOverview["metrics"];
  systemInfo: DashboardOverview["systemInfo"];
  dockerMetrics: DashboardOverview["dockerMetrics"];
  jobs: DashboardOverview["jobs"];
  auditEvents: DashboardOverview["auditEvents"];
  terminal: DashboardOverview["terminal"];
  settings: DashboardOverview["settings"];
  liveState: LiveConnectionState;
  mode: "demo" | "local";
  loaded: boolean;
  onLogout: (() => void) | undefined;
  onRefresh: () => Promise<void>;
  onUpdateSettings: (
    payload: UpdateDashboardSettingsPayload,
  ) => Promise<DashboardSettingsResponse>;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onCreateFormChange: (value: typeof initialCreateForm) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onPasswordChange: (id: string, value: string) => void;
  onProvision: (vps: VpsRecord) => void;
  onVerify: (vps: VpsRecord) => void;
  onInstallAgent: (vps: VpsRecord) => void;
  onUninstallAgent: (vps: VpsRecord) => void;
  onRestartAgent: (vps: VpsRecord) => void;
  onRotateAgent: (vps: VpsRecord) => void;
  onToggleDockerMetrics: (vps: VpsRecord) => void;
  onEdit: (vps: VpsRecord, payload: UpdateVpsPayload) => Promise<void>;
  onDelete: (vps: VpsRecord) => void;
};

// ── Context ──────────────────────────────────────────────────────────

export const DashboardContext = createContext<DashboardCtx | null>(null);

export function useDashboard(): DashboardCtx {
  const ctx = useContext(DashboardContext);
  if (!ctx)
    throw new Error("useDashboard must be used within DashboardProvider");
  return ctx;
}

// ── Helpers ──────────────────────────────────────────────────────────

function mergeMetrics<T extends { vpsId: string }>(
  existing: T[] = [],
  updated: T[] = [],
): T[] {
  const safeExisting = Array.isArray(existing) ? existing : [];
  const safeUpdated = Array.isArray(updated) ? updated : [];
  const updatedMap = new Map(safeUpdated.map((m) => [m.vpsId, m]));
  const seen = new Set<string>();
  const merged = safeExisting.map((m) => {
    const replacement = updatedMap.get(m.vpsId);
    if (replacement) {
      seen.add(m.vpsId);
      return replacement;
    }
    return m;
  });
  for (const m of updated) {
    if (!seen.has(m.vpsId)) {
      merged.push(m);
      seen.add(m.vpsId);
    }
  }
  return merged;
}

function mergeJobs(
  existing: DashboardOverview["jobs"] = [],
  updated: DashboardOverview["jobs"] = [],
) {
  const safeExisting = Array.isArray(existing) ? existing : [];
  const safeUpdated = Array.isArray(updated) ? updated : [];
  const byId = new Map(safeExisting.map((job) => [job.id, job]));
  for (const job of safeUpdated) byId.set(job.id, job);
  return [...byId.values()];
}

function isLocalHost(vps: VpsRecord): boolean {
  return vps.kind === "local" || vps.managedBy === "system";
}

const emptyOverview: DashboardOverview = {
  mode: "local",
  summary: {
    totalServers: 0,
    healthyServers: 0,
    warningServers: 0,
    unreachableServers: 0,
    runningJobs: 0,
  },
  servers: [],
  metrics: [],
  systemInfo: [],
  dockerMetrics: [],
  jobs: [],
  auditEvents: [],
  terminal: {
    label: "Terminal",
    networkAccess: "disabled",
    commands: [],
    sessions: [],
  },
  settings: {
    appMode: "local",
    webTerminalEnabled: false,
    terminalCommandGuardEnabled: false,
    realSshEnabled: false,
    authRequiredInLocalMode: true,
  },
};

// ── Provider ─────────────────────────────────────────────────────────

export function DashboardProvider({
  children,
  authRequired,
  onAfterLogout,
}: {
  children: ReactNode;
  authRequired: boolean;
  onAfterLogout?: () => void;
}) {
  const navigate = useNavigate();
  const [records, setRecords] = useState<VpsRecord[]>([]);
  const [overview, setOverview] = useState<DashboardOverview>(emptyOverview);
  const [createForm, setCreateForm] = useState(initialCreateForm);
  const [provisionPasswords, setProvisionPasswords] = useState<
    Record<string, string>
  >({});
  const [serverSearch, setServerSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({
    message: "Loading VPS list...",
    kind: "default",
  });
  const [liveState, setLiveState] = useState<LiveConnectionState>({
    status: "connecting",
  });
  const [pendingHostKeyTrust, setPendingHostKeyTrust] =
    useState<PendingHostKeyTrust | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const recordsRef = useRef(records);
  const loadSequenceRef = useRef(0);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [refreshToastVisible, setRefreshToastVisible] = useState(false);
  const refreshToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const dockerInvalidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  // ── Data loading ───────────────────────────────────────────────────

  async function loadVps(message?: string) {
    const sequence = ++loadSequenceRef.current;
    const [dashboard, servers, jobs, metrics, auditEvents] = await Promise.all([
      getDashboardOverview(),
      listVps(),
      listJobs(),
      listMetrics(),
      listAuditEvents(),
    ]);
    if (sequence !== loadSequenceRef.current) return;
    const mergedJobs = mergeJobs(dashboard.jobs ?? [], jobs);
    setOverview({
      ...dashboard,
      servers,
      jobs: mergedJobs,
      metrics,
      systemInfo: dashboard.systemInfo ?? [],
      dockerMetrics: dashboard.dockerMetrics ?? [],
      auditEvents,
      summary: {
        ...dashboard.summary,
        totalServers: servers.length,
        healthyServers: servers.filter((s) => s.status === "healthy").length,
        warningServers: servers.filter((s) => s.status === "warning").length,
        unreachableServers: servers.filter((s) => s.status === "unreachable")
          .length,
        runningJobs: mergedJobs.filter((j) => j.status === "running").length,
      },
    });
    setRecords(servers);
    if (message) setStatus({ message, kind: "success" });
  }

  async function runAction<T>(
    loadingMessage: string,
    action: () => Promise<T>,
    options?: { rethrow?: boolean },
  ): Promise<T | undefined> {
    if (busy) {
      if (options?.rethrow) {
        throw new Error("Another action is still running.");
      }
      return undefined;
    }
    setBusy(true);
    setStatus({ message: loadingMessage, kind: "default" });
    try {
      const result = await action();
      try {
        await loadVps("Dashboard state synced.");
      } catch {
        // Background refresh failure does not invalidate the successful action
      }
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Request failed";
      setStatus({
        message,
        kind: "destructive",
      });
      if (options?.rethrow) {
        throw error instanceof Error ? error : new Error(message);
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  // ── Initial data load on mount ─────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    loadVps()
      .then(() => {
        if (!cancelled) {
          setInitialLoadDone(true);
          setStatus(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInitialLoadDone(true);
          setStatus({
            message: "Failed to load VPS data.",
            kind: "destructive",
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (refreshToastTimerRef.current)
        clearTimeout(refreshToastTimerRef.current);
      if (dockerInvalidationTimerRef.current)
        clearTimeout(dockerInvalidationTimerRef.current);
    };
  }, []);

  // ── SSE monitoring subscription ───────────────────────────────────

  useEffect(() => {
    const unsubscribe = subscribeMonitoring({
      onSnapshot: (payload) => {
        if ("refreshRequired" in payload) {
          void loadVps().catch(() => {
            setStatus({
              message: "Failed to refresh dashboard data.",
              kind: "destructive",
            });
          });
          return;
        }
        setOverview((prev) => ({
          ...prev,
          ...payload.overview,
          servers: payload.servers,
          jobs: payload.jobs,
          metrics: payload.metrics,
          systemInfo: payload.overview.systemInfo ?? [],
          dockerMetrics: payload.overview.dockerMetrics ?? [],
          auditEvents: payload.auditEvents,
        }));
        setRecords(payload.servers);
      },
      onMetricsUpdated: (payload) => {
        setOverview((prev) => {
          const updatedMetrics = mergeMetrics(prev.metrics, payload.metrics);
          const dockerMetrics =
            payload.dockerMetrics !== undefined
              ? payload.dockerMetrics
              : (prev.dockerMetrics ?? []);
          return {
            ...prev,
            metrics: updatedMetrics,
            dockerMetrics,
            systemInfo: payload.systemInfo ?? prev.systemInfo,
            servers: payload.servers ?? prev.servers,
          };
        });
        if (payload.servers) setRecords(payload.servers);
      },
      onJobsUpdated: (payload) => {
        setOverview((prev) => ({
          ...prev,
          jobs: mergeJobs(prev.jobs, payload.jobs),
        }));
        // Lifecycle status comes from the API; jobs only provide progress.
        if (payload.jobs.some((job) =>
          (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") &&
          (job.type === "install-agent" || job.type === "uninstall-agent" || job.type === "upgrade-agent" || job.type === "restart-agent" || job.type === "rotate-agent")
        )) {
          void loadVps().catch(() => {
            setStatus({ message: "Failed to refresh agent status.", kind: "destructive" });
          });
        }
      },
      onDockerEventsAvailable: (payload) => {
        if (!payload || (payload.vpsId && !recordsRef.current.some((vps) => vps.id === payload.vpsId))) return;
        if (dockerInvalidationTimerRef.current) return;
        dockerInvalidationTimerRef.current = setTimeout(() => {
          dockerInvalidationTimerRef.current = null;
          void loadVps().catch(() => {
            // Live invalidation is best effort; keep the existing dashboard visible.
          });
        }, 250);
      },
      onDockerAlertsUpdated: (payload) => {
        if (!payload || (payload.vpsId && !recordsRef.current.some((vps) => vps.id === payload.vpsId))) return;
        if (dockerInvalidationTimerRef.current) return;
        dockerInvalidationTimerRef.current = setTimeout(() => {
          dockerInvalidationTimerRef.current = null;
          void loadVps().catch(() => {
            // Live invalidation is best effort; keep the existing dashboard visible.
          });
        }, 250);
      },
      onDockerInvalidation: (payload) => {
        if (payload?.vpsIds && !payload.vpsIds.some((id) => recordsRef.current.some((vps) => vps.id === id))) return;
        if (dockerInvalidationTimerRef.current) return;
        dockerInvalidationTimerRef.current = setTimeout(() => {
          dockerInvalidationTimerRef.current = null;
          void loadVps().catch(() => {
            // Live invalidation is best effort; keep the existing dashboard visible.
          });
        }, 250);
      },
      onHeartbeat: (_payload) => {},
      onError: (_payload) => {
        setLiveState({ status: "stale", latestEventAt: undefined });
      },
      onConnectionChange: (state: LiveConnectionState) => {
        setLiveState(state);
      },
    });

    unsubscribeRef.current = unsubscribe;
    return () => {
      unsubscribe();
      unsubscribeRef.current = null;
    };
  }, []);

  // ── Action handlers ────────────────────────────────────────────────

  async function handleLogout() {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setLiveState({ status: "connecting" });
    try {
      await logoutDashboard();
    } finally {
      setRecords([]);
      setOverview(emptyOverview);
      setStatus({
        message: "Signed out. Enter the dashboard password to return.",
        kind: "default",
      });
    }
    onAfterLogout?.();
  }

  async function handleRefresh() {
    if (busy) return;
    setBusy(true);
    setStatus({ message: "Refreshing VPS list...", kind: "default" });
    setRefreshToastVisible(false);
    if (refreshToastTimerRef.current)
      clearTimeout(refreshToastTimerRef.current);
    try {
      await loadVps();
      setStatus(null);
      setRefreshToastVisible(true);
      refreshToastTimerRef.current = setTimeout(() => {
        setRefreshToastVisible(false);
        refreshToastTimerRef.current = null;
      }, 2500);
    } catch {
      setStatus({
        message: "⚠ VPS list could not be refreshed",
        kind: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = createForm.password;
    const payload = {
      name: createForm.name.trim(),
      displayName: createForm.displayName.trim(),
      host: createForm.host.trim(),
      port: Number(createForm.port || 22),
      username: createForm.username.trim(),
    };

    const created = await runAction("Creating VPS...", async () => {
      const result = await createVps(payload);
      const resultLabel = vpsDisplayName(result);
      if (password) {
        setStatus({
          message: `Created ${resultLabel}. Installing SSH key...`,
          kind: "default",
        });
        try {
          await provisionKey(result.id, password);
        } catch (error) {
          const trust = getHostKeyTrustRequired(error);
          if (trust) {
            setPendingHostKeyTrust({
              vpsId: result.id,
              vpsName: resultLabel,
              host: trust.host,
              port: trust.port,
              fingerprint: trust.fingerprint,
              keyType: trust.keyType,
              password,
              afterTrustPath: `/vps/${encodeURIComponent(result.id)}`,
            });
            setStatus({
              message: `Created ${resultLabel}. Trust the SSH host key to continue provisioning.`,
              kind: "default",
            });
            return result;
          }
          throw error;
        }
        setStatus({
          message: `Created VPS and installed key for ${resultLabel}. Password was not stored.`,
          kind: "success",
        });
      } else {
        setStatus({
          message: `Created VPS ${resultLabel}. You can install the key from the list.`,
          kind: "success",
        });
      }
      setCreateForm(initialCreateForm);
      return result;
    });

    if (created) {
      navigate(`/vps/${encodeURIComponent(created.id)}`);
    }
  }

  async function handleProvision(vps: VpsRecord) {
    const password = provisionPasswords[vps.id] || "";
    const label = vpsDisplayName(vps);
    if (!password) {
      setStatus({
        message: "Enter the one-time password to install the SSH key.",
        kind: "destructive",
      });
      return;
    }

    await runAction(`Installing key for ${label}...`, async () => {
      try {
        await provisionKey(vps.id, password);
      } catch (error) {
        const trust = getHostKeyTrustRequired(error);
        if (trust) {
          setPendingHostKeyTrust({
            vpsId: vps.id,
            vpsName: label,
            host: trust.host,
            port: trust.port,
            fingerprint: trust.fingerprint,
            keyType: trust.keyType,
            password,
          });
          setStatus({
            message: `Trust the SSH host key for ${label} to continue provisioning.`,
            kind: "default",
          });
          return;
        }
        throw error;
      }
      setProvisionPasswords((current) => ({ ...current, [vps.id]: "" }));
      setStatus({
        message: `Installed SSH key for ${label}. Password was not stored.`,
        kind: "success",
      });
    });
  }

  async function confirmHostKeyTrust() {
    const pending = pendingHostKeyTrust;
    if (!pending?.fingerprint) return;
    await runAction(
      `Trusting SSH host key for ${pending.vpsName}...`,
      async () => {
        await trustSshHostKey(pending.vpsId, {
          fingerprint: pending.fingerprint!,
          keyType: pending.keyType,
        });
        await provisionKey(pending.vpsId, pending.password);
        setProvisionPasswords((current) => ({
          ...current,
          [pending.vpsId]: "",
        }));
        setPendingHostKeyTrust(null);
        setCreateForm(initialCreateForm);
        setStatus({
          message: `Trusted host key and installed SSH key for ${pending.vpsName}. Password was not stored.`,
          kind: "success",
        });
        if (pending.afterTrustPath) navigate(pending.afterTrustPath);
      },
    );
  }

  function cancelHostKeyTrust() {
    setPendingHostKeyTrust(null);
    setStatus({
      message:
        "SSH host key was not trusted. The VPS remains created; provisioning can be retried later.",
      kind: "destructive",
    });
  }

  async function handleVerify(vps: VpsRecord) {
    const label = vpsDisplayName(vps);
    await runAction(`Verifying key for ${label}...`, async () => {
      await verifyKey(vps.id);
      setStatus({ message: `Key verified for ${label}.`, kind: "success" });
    });
  }

  async function handleInstallAgent(vps: VpsRecord) {
    const password = provisionPasswords[vps.id] || "";
    const label = vpsDisplayName(vps);
    await runAction(`Starting agent install for ${label}...`, async () => {
      const result = await installAgent(vps.id, password || undefined);
      setOverview((current) => ({
        ...current,
        jobs: mergeJobs(current.jobs, [
          {
            id: result.jobId,
            vpsId: vps.id,
            type: "install-agent",
            status: "queued",
            step: "queued",
            progress: 0,
          },
        ]),
      }));
      setRecords((current) =>
        current.map((record) =>
          record.id === vps.id
            ? {
                ...record,
                agentStatus: "installing",
                lastAgentInstallJobId: result.jobId,
              }
            : record,
        ),
      );
      if (password) {
        setProvisionPasswords((current) => ({ ...current, [vps.id]: "" }));
      }
      setStatus({
        message: `Agent install queued for ${label}. Job ${result.jobId} is running in the background.`,
        kind: "success",
      });
    });
  }

  async function handleUninstallAgent(vps: VpsRecord) {
    const label = vpsDisplayName(vps);
    await runAction(`Starting agent removal for ${label}...`, async () => {
      const result = await uninstallAgent(vps.id);
      setOverview((current) => ({
        ...current,
        jobs: mergeJobs(current.jobs, [
          {
            id: result.jobId,
            vpsId: vps.id,
            type: "uninstall-agent",
            status: "queued",
            step: "queued",
            progress: 0,
          },
        ]),
      }));
      setRecords((current) =>
        current.map((record) =>
          record.id === vps.id
            ? {
                ...record,
                agentStatus: "installing",
                lastAgentInstallJobId: result.jobId,
              }
            : record,
        ),
      );
      setStatus({
        message: `Agent removal queued for ${label}.`,
        kind: "success",
      });
    });
  }

  async function handleRestartAgent(vps: VpsRecord) {
    const label = vpsDisplayName(vps);
    await runAction(`Starting agent restart for ${label}...`, async () => {
      const result = await restartAgent(vps.id);
      setOverview((current) => ({
        ...current,
        jobs: mergeJobs(current.jobs, [
          {
            id: result.jobId,
            vpsId: vps.id,
            type: "restart-agent",
            status: "queued",
            step: "queued",
            progress: 0,
          },
        ]),
      }));
      setRecords((current) =>
        current.map((record) =>
          record.id === vps.id
            ? { ...record, lastAgentInstallJobId: result.jobId }
            : record,
        ),
      );
      setStatus({
        message: `Agent restart queued for ${label}. Job ${result.jobId} is running in the background.`,
        kind: "success",
      });
    });
  }

  async function handleRotateAgent(vps: VpsRecord) {
    const label = vpsDisplayName(vps);
    await runAction(`Starting agent credential rotation for ${label}...`, async () => {
      const result = await rotateAgent(vps.id);
      setOverview((current) => ({
        ...current,
        jobs: mergeJobs(current.jobs, [
          {
            id: result.jobId,
            vpsId: vps.id,
            type: "rotate-agent",
            status: "queued",
            step: "queued",
            progress: 0,
          },
        ]),
      }));
      setRecords((current) =>
        current.map((record) =>
          record.id === vps.id
            ? { ...record, lastAgentInstallJobId: result.jobId }
            : record,
        ),
      );
      setStatus({
        message: `Agent credential rotation queued for ${label}. Job ${result.jobId} is running in the background.`,
        kind: "success",
      });
    });
  }

  async function handleToggleDockerMetrics(vps: VpsRecord) {
    const nextEnabled = !vps.dockerMetricsEnabled;
    const label = vpsDisplayName(vps);
    await runAction(
      `${nextEnabled ? "Enabling" : "Disabling"} Docker metrics for ${label}...`,
      async () => {
        await updateVps(vps.id, { dockerMetricsEnabled: nextEnabled });
        setStatus({
          message: `Docker metrics ${nextEnabled ? "enabled" : "disabled"} for ${label}.`,
          kind: "success",
        });
      },
    );
  }

  async function handleEdit(vps: VpsRecord, payload: UpdateVpsPayload) {
    if (busy) throw new Error("Another action is still running.");
    if (overview.mode === "demo")
      throw new Error("Editing is unavailable in demo mode.");
    setBusy(true);
    try {
      await updateVps(vps.id, payload);
      await loadVps(`Updated ${payload.displayName || vpsDisplayName(vps)}.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not update server.";
      setStatus({ message, kind: "destructive" });
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateSettings(
    payload: UpdateDashboardSettingsPayload,
  ): Promise<DashboardSettingsResponse> {
    const result = await updateDashboardSettings(payload);
    setOverview((current) => ({
      ...current,
      settings: {
        ...current.settings,
        ...result,
      },
    }));
    try {
      await loadVps("Dashboard state synced.");
    } catch {
      // Background re-fetch failed, local overview is already updated
    }
    return result;
  }

  async function handleDelete(vps: VpsRecord) {
    const label = vpsDisplayName(vps);
    const removed = await runAction(
      `Removing ${label}... Cleaning up the monitoring agent, backend data and SSH keys (this can take a minute or two).`,
      async () => {
        await deleteVps(vps.id);
        return true;
      },
    );
    if (removed) {
      setStatus({
        message: `Removed ${label}. Monitoring agent, backend data and SSH keys removed where present. Containers and apps were left untouched.`,
        kind: "success",
      });
    }
  }

  // ── Derived state ─────────────────────────────────────────────────

  const visibleRecords = records.filter((vps) => {
    const haystack = [
      vps.displayName,
      vps.name,
      vps.host,
      vps.username,
      vps.provider,
      vps.city,
      vps.country,
      vps.notes,
      ...(vps.tags || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesSearch = haystack.includes(serverSearch.trim().toLowerCase());
    const keyState =
      isLocalHost(vps) || vps.keyProvisionedAt ? "ready" : "pending";
    return (
      matchesSearch &&
      (statusFilter === "all" ||
        vps.status === statusFilter ||
        keyState === statusFilter)
    );
  });

  const statusAlert = status ? (
    <Alert
      variant={status.kind}
      className="rounded-none px-3 py-2 text-sm font-normal"
    >
      {status.message}
    </Alert>
  ) : null;

  const mode = overview.mode;

  const ctx: DashboardCtx = {
    records,
    visibleRecords,
    overview,
    statusAlert,
    serverSearch,
    statusFilter,
    busy,
    provisionPasswords,
    createForm,
    metrics: overview.metrics,
    systemInfo: overview.systemInfo,
    dockerMetrics: overview.dockerMetrics,
    jobs: overview.jobs,
    auditEvents: overview.auditEvents,
    terminal: overview.terminal,
    settings: overview.settings,
    liveState,
    mode,
    loaded: initialLoadDone,
    onLogout: authRequired ? handleLogout : undefined,
    onRefresh: handleRefresh,
    onUpdateSettings: handleUpdateSettings,
    onSearchChange: setServerSearch,
    onStatusFilterChange: setStatusFilter,
    onCreateFormChange: setCreateForm,
    onCreate: handleCreate,
    onPasswordChange: (id, value) =>
      setProvisionPasswords((current) => ({ ...current, [id]: value })),
    onProvision: handleProvision,
    onVerify: handleVerify,
    onInstallAgent: handleInstallAgent,
    onUninstallAgent: handleUninstallAgent,
    onRestartAgent: handleRestartAgent,
    onRotateAgent: handleRotateAgent,
    onToggleDockerMetrics: handleToggleDockerMetrics,
    onEdit: handleEdit,
    onDelete: handleDelete,
  };

  return (
    <DashboardContext.Provider value={ctx}>
      {children}
      {refreshToastVisible ? (
        <div
          role="status"
          aria-label="VPS list refreshed"
          aria-live="polite"
          aria-atomic="true"
          className="fixed right-4 top-4 z-50 max-w-[calc(100vw-2rem)] border border-white/10 bg-[#111318] px-4 py-3 text-sm font-medium text-white shadow-2xl shadow-black/40 sm:right-6 sm:top-6"
        >
          <span aria-hidden="true" className="mr-2 text-emerald-400">
            ✓
          </span>
          <span>VPS list refreshed</span>
        </div>
      ) : null}
      <AlertDialog
        open={Boolean(pendingHostKeyTrust)}
        onOpenChange={(open) => {
          if (!open) cancelHostKeyTrust();
        }}
      >
        <AlertDialogContent className="border-white/10 bg-[#111318] text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Trust SSH host key?</AlertDialogTitle>
            <AlertDialogDescription className="text-white/60">
              Only trust this fingerprint if it matches your VPS provider
              console or your own ssh-keyscan result.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingHostKeyTrust ? (
            <div className="grid gap-3 rounded-none border border-white/10 bg-white/[0.03] p-4 text-sm">
              <div>
                <div className="text-xs uppercase tracking-[0.14em] text-white/40">
                  Host
                </div>
                <div className="mt-1 font-mono text-white">
                  {pendingHostKeyTrust.host}:{pendingHostKeyTrust.port}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.14em] text-white/40">
                  Fingerprint
                </div>
                <div className="mt-1 break-all font-mono text-white">
                  {pendingHostKeyTrust.fingerprint || "Unavailable"}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.14em] text-white/40">
                  Key type
                </div>
                <div className="mt-1 font-mono text-white">
                  {pendingHostKeyTrust.keyType || "Unknown"}
                </div>
              </div>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelHostKeyTrust}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!pendingHostKeyTrust?.fingerprint || busy}
              onClick={(event) => {
                event.preventDefault();
                void confirmHostKeyTrust();
              }}
            >
              Trust and continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardContext.Provider>
  );
}
