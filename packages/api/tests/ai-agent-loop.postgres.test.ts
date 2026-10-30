import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { createPostgresAiRepository } from "../src/persistence/repositories/ai.repository.js";
import {
  AiPersistenceConflictError,
  type AiRepository,
} from "../src/persistence/repositories/ai.persistence.js";
import type {
  AiPlan,
  AiPlanStep,
  AiTask,
  AiTaskObservation,
} from "../src/ai/ai.models.js";

function resolveDatabaseUrl(): string | undefined {
  if (process.env.VPS_MANAGER_TEST_POSTGRES_URL) {
    return process.env.VPS_MANAGER_TEST_POSTGRES_URL;
  }
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  try {
    const composePath = join(
      process.cwd(),
      ".server",
      "loop-smoke",
      "docker-compose.yml",
    );
    if (existsSync(composePath)) {
      const content = readFileSync(composePath, "utf8");
      const user = content.match(/POSTGRES_USER:\s*([^\s]+)/)?.[1] ?? "postgres";
      const pass = content.match(/POSTGRES_PASSWORD:\s*([^\s]+)/)?.[1];
      const db = content.match(/POSTGRES_DB:\s*([^\s]+)/)?.[1] ?? "loop_smoke";
      const port = content.match(/127\.0\.0\.1:(\d+):5432/)?.[1] ?? "55433";
      if (pass) {
        return `postgres://${user}:${pass}@127.0.0.1:${port}/${db}`;
      }
    }
  } catch {
    // Return undefined when loop-smoke config is absent
  }
  return undefined;
}

const databaseUrl = resolveDatabaseUrl();

describe.skipIf(!databaseUrl)(
  "PostgreSQL AI Agent Multi-Turn Execution Loop persistence integration",
  () => {
    let admin: pg.Pool;
    let pool: pg.Pool;
    let schema: string;
    let scopedUrlString: string;
    let repo: AiRepository;

    const makePlanStep = (stepId: string, tool = "docker_action"): AiPlanStep => ({
      stepId,
      tool,
      version: 1,
      args: { action: "restart", target: { containerKey: "app-service" } },
      resourceKeys: ["docker:app-service"],
      inputDigests: {},
      description: `Step ${stepId}`,
      timeoutSeconds: 30,
    });

    const makePlan = (
      taskId: string,
      vpsId: string,
      planVersion: number,
      planDigest: string,
      status: "pending" | "approved" | "consumed" = "pending",
    ): AiPlan => ({
      planId: `plan-${planVersion}-${randomUUID().slice(0, 8)}`,
      taskId,
      vpsId,
      planVersion,
      planDigest,
      status,
      steps: [makePlanStep(`step-${planVersion}`)],
      preconditions: [],
      createdAt: new Date().toISOString(),
    });

    beforeEach(async () => {
      schema = `ai_loop_pg_${randomUUID().replaceAll("-", "")}`;
      admin = new pg.Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);

      const scopedUrl = new URL(databaseUrl!);
      scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
      scopedUrlString = scopedUrl.toString();
      pool = new pg.Pool({ connectionString: scopedUrlString });

      await runMigrations(pool);
      repo = createPostgresAiRepository(pool);
    });

    afterEach(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 1. Turn Lease: exclusive claim, renewal, and stale worker rejection
    // ─────────────────────────────────────────────────────────────────────────────
    describe("turn lease exclusive claim and stale worker rejection", () => {
      it("exclusive turn claim rejects competing worker during active lease and allows owner renewal", async () => {
        const vpsId = "vps-lease-1";
        const conv = await repo.createConversation(vpsId, "Lease Conv");
        const { task } = await repo.createTask({
          id: randomUUID(),
          conversationId: conv.id,
          vpsId,
          state: "planning",
          requestSummary: "Exclusive lease test",
          idempotencyKey: "lease-exclusive-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
          },
        });

        expect(task.loop?.turn).toBe(0);
        const initialToken = task.loop?.leaseToken;
        expect(initialToken).toBeDefined();

        const t0 = "2026-10-30T10:00:00.000Z";

        // Worker 1 claims turn 0 -> turn 1 with 10s lease
        const worker1Task = await repo.claimTurn({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-1",
          leaseSeconds: 10,
          expectedTurn: 0,
          now: t0,
        });

        expect(worker1Task.loop?.turn).toBe(1);
        expect(worker1Task.loop?.turnLeaseOwnerInstanceId).toBe("worker-1");
        expect(worker1Task.loop?.turnLeaseExpiresAt).toBe(
          "2026-10-30T10:00:10.000Z",
        );
        const worker1Token = worker1Task.loop!.leaseToken!;
        expect(worker1Token).not.toBe(initialToken);

        // Competing Worker 2 attempts claim while lease is active: rejected with task_conflict
        await expect(
          repo.claimTurn({
            taskId: task.id,
            vpsId,
            ownerInstanceId: "worker-2",
            leaseSeconds: 15,
            expectedTurn: 1,
            now: "2026-10-30T10:00:05.000Z",
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        // Worker 1 renews active lease before expiry
        const renewedTask = await repo.renewTurnLease({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-1",
          leaseSeconds: 20,
          expectedLeaseToken: worker1Token,
          now: "2026-10-30T10:00:05.000Z",
        });

        expect(renewedTask.loop?.turnLeaseExpiresAt).toBe(
          "2026-10-30T10:00:25.000Z",
        );
        expect(renewedTask.loop?.turnLeaseOwnerInstanceId).toBe("worker-1");

        // Competing worker cannot renew lease
        await expect(
          repo.renewTurnLease({
            taskId: task.id,
            vpsId,
            ownerInstanceId: "worker-2",
            leaseSeconds: 20,
            expectedLeaseToken: worker1Token,
            now: "2026-10-30T10:00:06.000Z",
          }),
        ).rejects.toThrow(AiPersistenceConflictError);
      });

      it("stale worker cannot commit or release turn after lease expires and competing worker advances turn", async () => {
        const vpsId = "vps-lease-2";
        const conv = await repo.createConversation(vpsId, "Stale Worker Conv");
        const { task } = await repo.createTask({
          id: randomUUID(),
          conversationId: conv.id,
          vpsId,
          state: "planning",
          requestSummary: "Stale worker commit test",
          idempotencyKey: "stale-worker-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
          },
        });

        const t0 = "2026-10-30T10:00:00.000Z";
        const tExpiry = "2026-10-30T10:00:15.000Z";

        // Worker 1 claims turn with 10s lease at t0
        const worker1Task = await repo.claimTurn({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-1",
          leaseSeconds: 10,
          now: t0,
        });
        const staleToken = worker1Task.loop!.leaseToken!;
        const staleRevision = worker1Task.revision;

        // At tExpiry (past the 10s lease), Worker 2 claims the expired turn
        const worker2Task = await repo.claimTurn({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-2",
          leaseSeconds: 60,
          now: tExpiry,
        });
        expect(worker2Task.loop?.turn).toBe(2);
        expect(worker2Task.loop?.turnLeaseOwnerInstanceId).toBe("worker-2");
        expect(worker2Task.loop?.leaseToken).not.toBe(staleToken);

        // Late Worker 1 attempting releaseOrCommitTurn past expiry must be rejected with task_conflict
        await expect(
          repo.releaseOrCommitTurn({
            taskId: task.id,
            vpsId,
            expectedRevision: staleRevision,
            expectedLeaseToken: staleToken,
            ownerInstanceId: "worker-1",
            state: "succeeded",
            now: tExpiry,
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        // Even without competitor claim, an expired lease blocks releaseOrCommitTurn
        await expect(
          repo.releaseOrCommitTurn({
            taskId: task.id,
            vpsId,
            expectedRevision: worker2Task.revision,
            expectedLeaseToken: worker2Task.loop!.leaseToken!,
            ownerInstanceId: "worker-2",
            state: "succeeded",
            now: "2026-10-30T10:02:00.000Z", // Past worker 2's 60s lease
          }),
        ).rejects.toThrow(AiPersistenceConflictError);
      });

      it("concurrent turn claim race across separate PostgreSQL pools grants lease to exactly one worker", async () => {
        const pool2 = new pg.Pool({ connectionString: scopedUrlString });
        const repo2 = createPostgresAiRepository(pool2);

        try {
          const vpsId = "vps-lease-race";
          const conv = await repo.createConversation(vpsId, "Race Conv");
          const { task } = await repo.createTask({
            id: randomUUID(),
            conversationId: conv.id,
            vpsId,
            state: "planning",
            requestSummary: "Race claim test",
            idempotencyKey: "race-claim-test",
            initiatingSessionId: "admin-session",
            executionVersion: 2,
            executionMode: "manual",
            loop: {
              mode: "manual",
              deadlineAt: new Date(Date.now() + 60000).toISOString(),
            },
          });

          const results = await Promise.allSettled([
            repo.claimTurn({
              taskId: task.id,
              vpsId,
              ownerInstanceId: "worker-race-A",
              leaseSeconds: 30,
              expectedTurn: 0,
            }),
            repo2.claimTurn({
              taskId: task.id,
              vpsId,
              ownerInstanceId: "worker-race-B",
              leaseSeconds: 30,
              expectedTurn: 0,
            }),
          ]);

          const fulfilled = results.filter((r) => r.status === "fulfilled");
          const rejected = results.filter((r) => r.status === "rejected");

          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);

          const winner = (
            fulfilled[0] as PromiseFulfilledResult<AiTask>
          ).value;
          expect(winner.loop?.turn).toBe(1);
          expect(winner.loop?.turnLeaseOwnerInstanceId).toMatch(
            /^worker-race-[AB]$/,
          );

          const loserError = (
            rejected[0] as PromiseRejectedResult
          ).reason;
          expect(loserError).toBeInstanceOf(AiPersistenceConflictError);
          expect(loserError.code).toBe("task_conflict");
        } finally {
          await pool2.end();
        }
      });

      it("rejects claimTurn with mismatched expectedTurn or mismatched expectedLeaseToken", async () => {
        const vpsId = "vps-lease-mismatch";
        const conv = await repo.createConversation(vpsId, "Mismatch Conv");
        const { task } = await repo.createTask({
          id: randomUUID(),
          conversationId: conv.id,
          vpsId,
          state: "planning",
          requestSummary: "Mismatch test",
          idempotencyKey: "mismatch-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
          },
        });

        // Claim turn initially
        await repo.claimTurn({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-1",
          leaseSeconds: 30,
        });

        // Wrong turn
        await expect(
          repo.claimTurn({
            taskId: task.id,
            vpsId,
            ownerInstanceId: "worker-1",
            leaseSeconds: 30,
            expectedTurn: 99,
          }),
        ).rejects.toThrow(AiPersistenceConflictError);
        // Wrong token
        await expect(
          repo.claimTurn({
            taskId: task.id,
            vpsId,
            ownerInstanceId: "worker-1",
            leaseSeconds: 30,
            expectedLeaseToken: "invalid-token-uuid",
          }),
        ).rejects.toThrow(AiPersistenceConflictError);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 2. Monotonic Plan History and Exact Approvals
    // ─────────────────────────────────────────────────────────────────────────────
    describe("monotonic plan history and exact approvals", () => {
      it("requires exact planVersion and planDigest for approval and strictly rejects stale replay", async () => {
        const vpsId = "vps-plan-1";
        const conv = await repo.createConversation(vpsId, "Plan Approval Conv");
        const { task } = await repo.createTask({
          id: randomUUID(),
          conversationId: conv.id,
          vpsId,
          state: "planning",
          requestSummary: "Plan approval test",
          idempotencyKey: "plan-approval-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
          },
        });

        const turn1 = await repo.claimTurn({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-plan",
          leaseSeconds: 30,
          expectedTurn: 0,
        });

        const plan1Digest = "a1".repeat(32);
        const plan1 = makePlan(task.id, vpsId, 1, plan1Digest, "pending");

        // Propose Plan 1
        const committed = await repo.releaseOrCommitTurn({
          taskId: task.id,
          vpsId,
          expectedRevision: turn1.revision,
          expectedLeaseToken: turn1.loop!.leaseToken!,
          ownerInstanceId: "worker-plan",
          state: "awaiting_approval",
          plan: plan1,
          releaseTurnLease: true,
        });

        expect(committed.plan?.planVersion).toBe(1);
        expect(committed.plan?.status).toBe("pending");
        expect(committed.loop?.planHistory).toHaveLength(1);
        expect(committed.loop?.planHistory[0].planDigest).toBe(plan1Digest);

        // Stale / mismatched approval attempts throw approval_conflict
        await expect(
          repo.approve({
            taskId: task.id,
            planVersion: 99,
            planDigest: plan1Digest,
            approvedSessionId: "admin-session",
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        await expect(
          repo.approve({
            taskId: task.id,
            planVersion: 1,
            planDigest: "f0".repeat(32),
            approvedSessionId: "admin-session",
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        // Exact approval succeeds
        const approvedPlan = await repo.approve({
          taskId: task.id,
          planVersion: 1,
          planDigest: plan1Digest,
          approvedSessionId: "admin-session",
        });

        expect(approvedPlan.status).toBe("consumed");
        expect(approvedPlan.approvedSessionId).toBe("admin-session");
        expect(approvedPlan.consumedAt).toBeDefined();

        const taskAfterApproval = await repo.getTask(vpsId, task.id);
        expect(taskAfterApproval?.plan?.status).toBe("consumed");
        expect(taskAfterApproval?.loop?.planHistory[0].status).toBe("consumed");

        // Replaying same approval must throw approval_conflict (already consumed)
        await expect(
          repo.approve({
            taskId: task.id,
            planVersion: 1,
            planDigest: plan1Digest,
            approvedSessionId: "admin-session-replay",
          }),
        ).rejects.toThrow(AiPersistenceConflictError);
      });

      it("enforces strictly monotonic plan versions and immutable history across sequential mutation turns", async () => {
        const vpsId = "vps-plan-monotonic";
        const conv = await repo.createConversation(vpsId, "Monotonic Conv");
        const { task } = await repo.createTask({
          id: randomUUID(),
          conversationId: conv.id,
          vpsId,
          state: "planning",
          requestSummary: "Monotonic plan history test",
          idempotencyKey: "plan-monotonic-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
          },
        });

        // Turn 1: Propose Plan 1 and approve it
        const turn1 = await repo.claimTurn({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-1",
          leaseSeconds: 30,
        });

        const digest1 = "11".repeat(32);
        const plan1 = makePlan(task.id, vpsId, 1, digest1, "pending");
        await repo.releaseOrCommitTurn({
          taskId: task.id,
          vpsId,
          expectedRevision: turn1.revision,
          expectedLeaseToken: turn1.loop!.leaseToken!,
          ownerInstanceId: "worker-1",
          state: "awaiting_approval",
          plan: plan1,
          releaseTurnLease: true,
        });
        await repo.approve({
          taskId: task.id,
          planVersion: 1,
          planDigest: digest1,
          approvedSessionId: "session-1",
        });
        const approvedTask = await repo.getTask(vpsId, task.id);
        // After plan execution completes in the loop runtime, task transitions back to planning
        await repo.updateTask({
          id: task.id,
          expectedRevision: approvedTask!.revision,
          state: "planning",
        });

        // Turn 2: Worker claims turn
        const taskV1 = (await repo.getTask(vpsId, task.id))!;
        const turn2 = await repo.claimTurn({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-2",
          leaseSeconds: 30,
          expectedTurn: 1,
        });

        // Attempting to append non-increasing planVersion (<= 1) must throw task_conflict
        const nonMonotonicPlan = makePlan(task.id, vpsId, 1, "99".repeat(32));
        await expect(
          repo.releaseOrCommitTurn({
            taskId: task.id,
            vpsId,
            expectedRevision: turn2.revision,
            expectedLeaseToken: turn2.loop!.leaseToken!,
            ownerInstanceId: "worker-2",
            plan: nonMonotonicPlan,
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        // Attempting to mutate past immutable plan in history must throw task_conflict
        const tamperedPlan1 = {
          ...taskV1.loop!.planHistory[0],
          planDigest: "88".repeat(32), // tampered digest
        };
        await expect(
          repo.releaseOrCommitTurn({
            taskId: task.id,
            vpsId,
            expectedRevision: turn2.revision,
            expectedLeaseToken: turn2.loop!.leaseToken!,
            ownerInstanceId: "worker-2",
            loopPatch: { appendPlan: tamperedPlan1 },
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        // Attempting to demote Plan 1 status backward (consumed -> pending) must throw task_conflict
        const demotedPlan1 = {
          ...taskV1.loop!.planHistory[0],
          status: "pending" as const,
        };
        await expect(
          repo.releaseOrCommitTurn({
            taskId: task.id,
            vpsId,
            expectedRevision: turn2.revision,
            expectedLeaseToken: turn2.loop!.leaseToken!,
            ownerInstanceId: "worker-2",
            loopPatch: { appendPlan: demotedPlan1 },
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        // Valid Plan 2 with strictly monotonic version 2
        const digest2 = "22".repeat(32);
        const plan2 = makePlan(task.id, vpsId, 2, digest2, "pending");
        const committedPlan2 = await repo.releaseOrCommitTurn({
          taskId: task.id,
          vpsId,
          expectedRevision: turn2.revision,
          expectedLeaseToken: turn2.loop!.leaseToken!,
          ownerInstanceId: "worker-2",
          state: "awaiting_approval",
          plan: plan2,
          releaseTurnLease: true,
          loopPatch: { countersDelta: { mutationPlans: 1 } },
        });

        expect(committedPlan2.plan?.planVersion).toBe(2);
        expect(committedPlan2.loop?.planHistory).toHaveLength(2);

        // Replaying digest1 against Plan 2 version throws approval_conflict
        await expect(
          repo.approve({
            taskId: task.id,
            planVersion: 2,
            planDigest: digest1,
            approvedSessionId: "session-2",
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        // Exact approval of Plan 2 succeeds
        await repo.approve({
          taskId: task.id,
          planVersion: 2,
          planDigest: digest2,
          approvedSessionId: "session-2",
        });

        const finalTask = (await repo.getTask(vpsId, task.id))!;
        expect(finalTask.loop?.planHistory).toHaveLength(2);
        expect(finalTask.loop?.planHistory[0].planVersion).toBe(1);
        expect(finalTask.loop?.planHistory[0].status).toBe("consumed");
        expect(finalTask.loop?.planHistory[1].planVersion).toBe(2);
        expect(finalTask.loop?.planHistory[1].status).toBe("consumed");
        expect(finalTask.loop?.counters.mutationPlans).toBe(1);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 3. Atomic Observation Deduplication and Continuation Signaling
    // ─────────────────────────────────────────────────────────────────────────────
    describe("atomic observation deduplication and continuation signaling", () => {
      it("idempotently deduplicates observations by id and (commandId, stepId) while enforcing lease fencing", async () => {
        const vpsId = "vps-obs-dedup";
        const conv = await repo.createConversation(vpsId, "Obs Conv");
        const { task } = await repo.createTask({
          id: randomUUID(),
          conversationId: conv.id,
          vpsId,
          state: "planning",
          requestSummary: "Obs dedup test",
          idempotencyKey: "obs-dedup-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
          },
        });

        const turn1 = await repo.claimTurn({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-obs",
          leaseSeconds: 30,
        });
        const leaseToken = turn1.loop!.leaseToken!;

        const obs1: AiTaskObservation = {
          id: "obs-item-1",
          turn: 1,
          tool: "service_status",
          source: "host_receipt",
          status: "succeeded",
          outputPreview: "docker running",
          createdAt: new Date().toISOString(),
        };

        // First recording: created = true
        const res1 = await repo.recordObservation({
          taskId: task.id,
          vpsId,
          observation: obs1,
          expectedLeaseToken: leaseToken,
        });
        expect(res1.created).toBe(true);
        expect(res1.task.loop?.observations).toHaveLength(1);

        // Duplicate recording with same id: created = false, no duplicate stored
        const res1Dup = await repo.recordObservation({
          taskId: task.id,
          vpsId,
          observation: obs1,
          expectedLeaseToken: leaseToken,
        });
        expect(res1Dup.created).toBe(false);
        expect(res1Dup.task.loop?.observations).toHaveLength(1);

        // Observation with unique id but duplicate (commandId, stepId) is deduplicated
        const obsWithCommand: AiTaskObservation = {
          id: "obs-cmd-1",
          commandId: "cmd-fixed-uuid",
          stepId: "step-fixed-uuid",
          turn: 1,
          tool: "docker_action",
          source: "host_receipt",
          status: "succeeded",
          outputPreview: "container started",
          createdAt: new Date().toISOString(),
        };

        const resCmd1 = await repo.recordObservation({
          taskId: task.id,
          vpsId,
          observation: obsWithCommand,
          expectedLeaseToken: leaseToken,
        });
        expect(resCmd1.created).toBe(true);
        expect(resCmd1.task.loop?.observations).toHaveLength(2);

        const obsWithSameCommandDiffId: AiTaskObservation = {
          id: "obs-cmd-2", // different id
          commandId: "cmd-fixed-uuid", // identical commandId
          stepId: "step-fixed-uuid", // identical stepId
          turn: 1,
          tool: "docker_action",
          source: "host_receipt",
          status: "succeeded",
          outputPreview: "container started replay",
          createdAt: new Date().toISOString(),
        };

        const resCmd2 = await repo.recordObservation({
          taskId: task.id,
          vpsId,
          observation: obsWithSameCommandDiffId,
          expectedLeaseToken: leaseToken,
        });
        expect(resCmd2.created).toBe(false);
        expect(resCmd2.task.loop?.observations).toHaveLength(2);

        // Lease token mismatch is strictly rejected
        await expect(
          repo.recordObservation({
            taskId: task.id,
            vpsId,
            observation: {
              id: "obs-unauthorized",
              turn: 1,
              tool: "service_status",
              source: "host_receipt",
              status: "succeeded",
              outputPreview: "ok",
              createdAt: new Date().toISOString(),
            },
            expectedLeaseToken: "invalid-token",
          }),
        ).rejects.toThrow(AiPersistenceConflictError);
      });

      it("concurrent observation race across separate PostgreSQL connections dedups atomically", async () => {
        const pool2 = new pg.Pool({ connectionString: scopedUrlString });
        const repo2 = createPostgresAiRepository(pool2);

        try {
          const vpsId = "vps-obs-race";
          const conv = await repo.createConversation(vpsId, "Obs Race Conv");
          const { task } = await repo.createTask({
            id: randomUUID(),
            conversationId: conv.id,
            vpsId,
            state: "planning",
            requestSummary: "Obs race test",
            idempotencyKey: "obs-race-test",
            initiatingSessionId: "admin-session",
            executionVersion: 2,
            executionMode: "manual",
            loop: {
              mode: "manual",
              deadlineAt: new Date(Date.now() + 60000).toISOString(),
            },
          });

          const obs: AiTaskObservation = {
            id: "obs-concurrent-race-1",
            turn: 0,
            tool: "service_status",
            source: "host_receipt",
            status: "succeeded",
            outputPreview: "healthy",
            createdAt: new Date().toISOString(),
          };

          const [res1, res2] = await Promise.all([
            repo.recordObservation({
              taskId: task.id,
              vpsId,
              observation: obs,
            }),
            repo2.recordObservation({
              taskId: task.id,
              vpsId,
              observation: obs,
            }),
          ]);

          const createdCount = [res1, res2].filter((r) => r.created).length;
          const dedupCount = [res1, res2].filter((r) => !r.created).length;

          expect(createdCount).toBe(1);
          expect(dedupCount).toBe(1);

          const finalTask = await repo.getTask(vpsId, task.id);
          expect(finalTask?.loop?.observations).toHaveLength(1);
          expect(finalTask?.loop?.observations[0].id).toBe(
            "obs-concurrent-race-1",
          );
        } finally {
          await pool2.end();
        }
      });

      it("signals continuationReady and atomically claims pending continuation without duplication", async () => {
        const vpsId = "vps-continuation";
        const conv = await repo.createConversation(vpsId, "Continuation Conv");
        const { task } = await repo.createTask({
          id: randomUUID(),
          conversationId: conv.id,
          vpsId,
          state: "planning",
          requestSummary: "Continuation claim test",
          idempotencyKey: "continuation-claim-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
          },
        });

        // Record observation with continuationReady = true
        const obsRes = await repo.recordObservation({
          taskId: task.id,
          vpsId,
          observation: {
            id: "obs-cont-1",
            turn: 0,
            tool: "service_status",
            source: "host_receipt",
            status: "succeeded",
            outputPreview: "ready for next turn",
            createdAt: new Date().toISOString(),
          },
          state: "planning",
          continuationReady: true,
        });

        expect(obsRes.task.loop?.continuationReady).toBe(true);
        expect(obsRes.task.loop?.phase).toBe("continuation_ready");

        // Worker claims pending continuation
        const continuation = await repo.claimPendingContinuation({
          ownerInstanceId: "worker-continuation-owner",
          leaseSeconds: 30,
          vpsId,
        });

        expect(continuation).toBeDefined();
        expect(continuation?.id).toBe(task.id);
        expect(continuation?.loop?.turn).toBe(1);
        expect(continuation?.loop?.turnLeaseOwnerInstanceId).toBe(
          "worker-continuation-owner",
        );
        expect(continuation?.loop?.continuationReady).toBe(false);
        expect(continuation?.loop?.phase).toBe("planning");

        // Competing continuation claim immediately returns undefined
        const nextClaim = await repo.claimPendingContinuation({
          ownerInstanceId: "worker-competing",
          leaseSeconds: 30,
          vpsId,
        });
        expect(nextClaim).toBeUndefined();
      });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 4. Cancellation Fence
    // ─────────────────────────────────────────────────────────────────────────────
    describe("cancellation fence", () => {
      it("cancelling task strips continuation readiness and fences continuation claiming", async () => {
        const vpsId = "vps-cancel-fence-1";
        const conv = await repo.createConversation(vpsId, "Cancel Conv");
        const { task } = await repo.createTask({
          id: randomUUID(),
          conversationId: conv.id,
          vpsId,
          state: "planning",
          requestSummary: "Cancel fence test",
          idempotencyKey: "cancel-fence-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
          },
        });

        // Signal continuation ready
        const readyTask = await repo.recordObservation({
          taskId: task.id,
          vpsId,
          observation: {
            id: "obs-pre-cancel",
            turn: 0,
            tool: "service_status",
            source: "host_receipt",
            status: "succeeded",
            outputPreview: "ok",
            createdAt: new Date().toISOString(),
          },
          continuationReady: true,
        });
        expect(readyTask.task.loop?.continuationReady).toBe(true);

        // Cancel the task
        const cancelled = await repo.updateTask({
          id: task.id,
          expectedRevision: readyTask.task.revision,
          state: "cancelled",
        });

        expect(cancelled.state).toBe("cancelled");
        // Cancellation must clear continuationReady in persistence
        expect(cancelled.loop?.continuationReady).toBe(false);

        // claimPendingContinuation must return undefined
        const continuation = await repo.claimPendingContinuation({
          ownerInstanceId: "worker-any",
          leaseSeconds: 30,
          vpsId,
        });
        expect(continuation).toBeUndefined();

        // cancel_requested also fences continuation
        const convReq = await repo.createConversation(
          "vps-cancel-fence-req",
          "Cancel Req Conv",
        );
        const { task: cancelReqTask } = await repo.createTask({
          id: randomUUID(),
          conversationId: convReq.id,
          vpsId: "vps-cancel-fence-req",
          state: "planning",
          requestSummary: "Cancel requested fence test",
          idempotencyKey: "cancel-req-fence-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
          },
        });

        const reqObs = await repo.recordObservation({
          taskId: cancelReqTask.id,
          vpsId: "vps-cancel-fence-req",
          observation: {
            id: "obs-pre-cancel-req",
            turn: 0,
            tool: "service_status",
            source: "host_receipt",
            status: "succeeded",
            outputPreview: "ok",
            createdAt: new Date().toISOString(),
          },
          continuationReady: true,
        });

        await repo.updateTask({
          id: cancelReqTask.id,
          expectedRevision: reqObs.task.revision,
          state: "cancel_requested",
        });

        const cancelReqClaim = await repo.claimPendingContinuation({
          ownerInstanceId: "worker-any",
          leaseSeconds: 30,
          vpsId: "vps-cancel-fence-req",
        });
        expect(cancelReqClaim).toBeUndefined();
      });

      it("fences all worker turn operations (commit, claim, renew, reserve) on cancelled task", async () => {
        const vpsId = "vps-cancel-ops";
        const conv = await repo.createConversation(vpsId, "Cancel Ops Conv");
        const { task } = await repo.createTask({
          id: randomUUID(),
          conversationId: conv.id,
          vpsId,
          state: "planning",
          requestSummary: "Cancel ops fence test",
          idempotencyKey: "cancel-ops-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
          },
        });

        // Worker claims active turn lease
        const turnClaim = await repo.claimTurn({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-cancelled-turn",
          leaseSeconds: 60,
        });
        const leaseToken = turnClaim.loop!.leaseToken!;
        const preCancelRevision = turnClaim.revision;

        // Task is cancelled asynchronously
        const cancelled = await repo.updateTask({
          id: task.id,
          expectedRevision: preCancelRevision,
          state: "cancelled",
        });
        expect(cancelled.state).toBe("cancelled");

        // 1. Late worker attempting releaseOrCommitTurn on cancelled task throws task_conflict
        await expect(
          repo.releaseOrCommitTurn({
            taskId: task.id,
            vpsId,
            expectedRevision: cancelled.revision,
            expectedLeaseToken: leaseToken,
            ownerInstanceId: "worker-cancelled-turn",
            state: "succeeded",
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        // 2. Worker attempting claimTurn on cancelled task throws task_conflict (not eligible)
        await expect(
          repo.claimTurn({
            taskId: task.id,
            vpsId,
            ownerInstanceId: "worker-another",
            leaseSeconds: 30,
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        // 3. Worker attempting renewTurnLease on cancelled task throws task_conflict (terminal)
        await expect(
          repo.renewTurnLease({
            taskId: task.id,
            vpsId,
            ownerInstanceId: "worker-cancelled-turn",
            leaseSeconds: 30,
            expectedLeaseToken: leaseToken,
          }),
        ).rejects.toThrow(AiPersistenceConflictError);

        // 4. Worker attempting reserveProviderCall on cancelled task throws task_conflict (terminal)
        await expect(
          repo.reserveProviderCall({
            taskId: task.id,
            vpsId,
            expectedRevision: cancelled.revision,
            expectedLeaseToken: leaseToken,
          }),
        ).rejects.toThrow(AiPersistenceConflictError);
      });

      it("resumeTask preserves accumulated counters and plan history without reset", async () => {
        const vpsId = "vps-resume-test";
        const conv = await repo.createConversation(vpsId, "Resume Conv");
        const { task } = await repo.createTask({
          id: randomUUID(),
          conversationId: conv.id,
          vpsId,
          state: "planning",
          requestSummary: "Resume test",
          idempotencyKey: "resume-test",
          initiatingSessionId: "admin-session",
          executionVersion: 2,
          executionMode: "manual",
          loop: {
            mode: "manual",
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
            counters: {
              providerCalls: 4,
              readCalls: 2,
              mutationPlans: 1,
              verificationAttempts: 1,
              toolCalls: 5,
            },
          },
        });

        // Propose and approve Plan 1
        const turn1 = await repo.claimTurn({
          taskId: task.id,
          vpsId,
          ownerInstanceId: "worker-1",
          leaseSeconds: 30,
        });

        const digest = "cc".repeat(32);
        const plan1 = makePlan(task.id, vpsId, 1, digest, "pending");
        await repo.releaseOrCommitTurn({
          taskId: task.id,
          vpsId,
          expectedRevision: turn1.revision,
          expectedLeaseToken: turn1.loop!.leaseToken!,
          ownerInstanceId: "worker-1",
          state: "awaiting_approval",
          plan: plan1,
          releaseTurnLease: true,
        });
        await repo.approve({
          taskId: task.id,
          planVersion: 1,
          planDigest: digest,
          approvedSessionId: "admin-session",
        });

        // Pause task into awaiting_input
        const prePause = (await repo.getTask(vpsId, task.id))!;
        const paused = await repo.updateTask({
          id: task.id,
          expectedRevision: prePause.revision,
          state: "awaiting_input",
          clarificationPrompt: "Need confirmation",
        });
        expect(paused.state).toBe("awaiting_input");

        // Resume task
        const resumed = await repo.resumeTask({
          taskId: task.id,
          vpsId,
          expectedRevision: paused.revision,
          reason: "User responded with clarification",
        });

        expect(resumed.state).toBe("planning");
        expect(resumed.loop?.counters.providerCalls).toBe(4);
        expect(resumed.loop?.counters.readCalls).toBe(2);
        expect(resumed.loop?.counters.mutationPlans).toBe(1);
        expect(resumed.loop?.counters.toolCalls).toBe(5);
        expect(resumed.loop?.planHistory).toHaveLength(1);
        expect(resumed.loop?.planHistory[0].status).toBe("consumed");
        expect(resumed.loop?.continuationReady).toBe(true);
      });
    });
  },
);
