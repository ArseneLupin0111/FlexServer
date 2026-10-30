import "../../../test/setup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantTaskPanel } from "./AssistantTaskPanel";
import type { AiTask, AiPlan, AiPlanStep } from "../../../lib/ai-api";

vi.mock("../../../lib/ai-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ai-api")>();
  return {
    ...actual,
    getVpsAiTaskPreview: vi.fn(() =>
      Promise.resolve({
        planVersion: 2,
        planDigest: "sha256:targetdigest123",
        steps: [],
      }),
    ),
  };
});

afterEach(() => {
  cleanup();
});

function makeStep(overrides: Partial<AiPlanStep> = {}): AiPlanStep {
  return {
    stepId: "step-1",
    tool: "shell_exec",
    description: "Run diagnostic command",
    version: 1,
    args: { cmd: "docker ps" },
    resourceKeys: [],
    inputDigests: {},
    timeoutSeconds: 30,
    ...overrides,
  };
}

function makeTask(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: "task-100",
    vpsId: "vps-1",
    conversationId: "conv-1",
    requestSummary: "Diagnostic test request",
    revision: 3,
    state: "planning",
    executionMode: "manual",
    executionVersion: 2,
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:05:00.000Z",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      estimated: false,
      rounds: 1,
      toolCalls: 0,
    },
    planHistory: [],
    loop: {
      contractVersion: "loop_v1",
      mode: "manual",
      turn: 1,
      phase: "planning",
      continuationReady: false,
      counters: {
        providerCalls: 0,
        readCalls: 0,
        mutationPlans: 0,
        verificationAttempts: 0,
        toolCalls: 0,
        deadlineAt: "2026-10-30T11:00:00.000Z",
      },
      planHistory: [],
      observations: [],
      journal: [],
    },
    ...overrides,
  };
}

describe("AssistantTaskPanel multi-plan timeline, observations, completion and resume", () => {
  it("renders multi-plan timeline from planHistory and current plan", () => {
    const historicalPlan: AiPlan = {
      planId: "plan-old",
      planVersion: 1,
      taskId: "task-100",
      vpsId: "vps-1",
      agentInstanceId: "inst-1",
      providerRevision: 1,
      policyRevision: 1,
      capabilityRevision: 1,
      preconditions: [],
      planDigest: "sha256:abc123456789",
      expiresAt: "2026-10-30T11:00:00.000Z",
      status: "approved",
      steps: [makeStep({ stepId: "step-1", description: "Inspect service status" })],
    };

    const currentPlan: AiPlan = {
      planId: "plan-curr",
      planVersion: 2,
      taskId: "task-100",
      vpsId: "vps-1",
      agentInstanceId: "inst-1",
      providerRevision: 1,
      policyRevision: 1,
      capabilityRevision: 1,
      preconditions: [],
      planDigest: "sha256:def987654321",
      expiresAt: "2026-10-30T11:00:00.000Z",
      status: "pending",
      steps: [makeStep({ stepId: "step-2", description: "Restart container" })],
    };

    const task = makeTask({
      plan: currentPlan,
      planHistory: [historicalPlan, currentPlan],
    });

    render(
      <AssistantTaskPanel
        task={task}
        outputChunks={[]}
        streamState="idle"
        hasGap={false}
        isTruncated={false}
        vpsId="vps-1"
        onClearOutput={vi.fn()}
        onCancelTask={vi.fn()}
        onReconcileTask={vi.fn()}
        onApprovePlan={vi.fn()}
        onDenyPlan={vi.fn()}
      />,
    );

    expect(screen.getByText(/Plan History/i)).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("Inspect service status")).toBeInTheDocument();
    expect(screen.getByText("Restart container")).toBeInTheDocument();
  });

  it("renders loop observations and provenance information", () => {
    const task = makeTask({
      loop: {
        contractVersion: "loop_v1",
        mode: "manual",
        turn: 2,
        phase: "verifying",
        continuationReady: false,
        counters: {
          providerCalls: 1,
          readCalls: 1,
          mutationPlans: 0,
          verificationAttempts: 1,
          toolCalls: 1,
          deadlineAt: "2026-10-30T11:00:00.000Z",
        },
        planHistory: [],
        observations: [
          {
            id: "obs-1",
            turn: 1,
            tool: "docker_ps",
            source: "read_tool",
            status: "succeeded",
            outputPreview: "CONTAINER ID   IMAGE\na1b2c3d4   nginx:latest",
            restrictedSources: ["logs"],
            createdAt: "2026-10-30T10:01:00.000Z",
          },
        ],
        journal: [],
      },
    });

    render(
      <AssistantTaskPanel
        task={task}
        outputChunks={[]}
        streamState="idle"
        hasGap={false}
        isTruncated={false}
        vpsId="vps-1"
        onClearOutput={vi.fn()}
        onCancelTask={vi.fn()}
        onReconcileTask={vi.fn()}
        onApprovePlan={vi.fn()}
        onDenyPlan={vi.fn()}
      />,
    );

    expect(screen.getByText(/Loop Observations/i)).toBeInTheDocument();
    expect(screen.getByText("docker_ps")).toBeInTheDocument();
    expect(screen.getByText(/nginx:latest/)).toBeInTheDocument();
  });

  it("renders completion outcome card when task finishes with verified outcome", () => {
    const task = makeTask({
      state: "succeeded",
      completion: {
        kind: "verified",
        reasonCode: "goal_verified",
        message: "Container recovered and healthcheck passing",
        evidenceReferences: ["service:nginx", "log:/var/log/nginx/error.log"],
        completedAt: "2026-10-30T10:05:00.000Z",
      },
    });

    render(
      <AssistantTaskPanel
        task={task}
        outputChunks={[]}
        streamState="idle"
        hasGap={false}
        isTruncated={false}
        vpsId="vps-1"
        onClearOutput={vi.fn()}
        onCancelTask={vi.fn()}
        onReconcileTask={vi.fn()}
        onApprovePlan={vi.fn()}
        onDenyPlan={vi.fn()}
      />,
    );

    expect(screen.getByText(/Outcome: verified/i)).toBeInTheDocument();
    expect(
      screen.getByText("Container recovered and healthcheck passing"),
    ).toBeInTheDocument();
    expect(screen.getByText("service:nginx")).toBeInTheDocument();
    expect(screen.getByText("log:/var/log/nginx/error.log")).toBeInTheDocument();
  });

  it("shows cancellation alert and calls onCancelTask when Cancel Task button is clicked", () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const task = makeTask({
      state: "executing",
      executionMode: "yolo",
    });

    render(
      <AssistantTaskPanel
        task={task}
        outputChunks={[]}
        streamState="live"
        hasGap={false}
        isTruncated={false}
        vpsId="vps-1"
        onClearOutput={vi.fn()}
        onCancelTask={onCancel}
        onReconcileTask={vi.fn()}
        onApprovePlan={vi.fn()}
        onDenyPlan={vi.fn()}
      />,
    );

    const cancelBtn = screen.getByRole("button", { name: /cancel task/i });
    fireEvent.click(cancelBtn);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows cancellation pending alert when cancel_requested is active", () => {
    const task = makeTask({
      state: "cancel_requested",
    });

    render(
      <AssistantTaskPanel
        task={task}
        outputChunks={[]}
        streamState="live"
        hasGap={false}
        isTruncated={false}
        vpsId="vps-1"
        onClearOutput={vi.fn()}
        onCancelTask={vi.fn()}
        onReconcileTask={vi.fn()}
        onApprovePlan={vi.fn()}
        onDenyPlan={vi.fn()}
      />,
    );

    expect(screen.getByText("Cancellation Requested")).toBeInTheDocument();
  });

  it("renders ONLY Reconcile action and strictly NO Resume action for an uncertain task", () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    const onReconcile = vi.fn().mockResolvedValue(undefined);
    const task = makeTask({
      state: "uncertain",
      executionMode: "manual",
    });

    render(
      <AssistantTaskPanel
        task={task}
        outputChunks={[]}
        streamState="idle"
        hasGap={false}
        isTruncated={false}
        vpsId="vps-1"
        onClearOutput={vi.fn()}
        onCancelTask={vi.fn()}
        onReconcileTask={onReconcile}
        onResumeTask={onResume}
        onApprovePlan={vi.fn()}
        onDenyPlan={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /resume task/i })).toBeNull();

    const reconcileBtns = screen.getAllByRole("button", { name: /reconcile/i });
    expect(reconcileBtns.length).toBeGreaterThan(0);
    fireEvent.click(reconcileBtns[0]);
    expect(onReconcile).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("renders Resume action when task is paused by policy change", () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    const task = makeTask({
      state: "planning",
      executionMode: "manual",
      loop: {
        contractVersion: "loop_v1",
        mode: "manual",
        turn: 1,
        phase: "planning",
        continuationReady: false,
        pauseReason: "policy_changed",
        counters: {
          providerCalls: 1,
          readCalls: 0,
          mutationPlans: 0,
          verificationAttempts: 0,
          toolCalls: 0,
          deadlineAt: "2026-10-30T11:00:00.000Z",
        },
        planHistory: [],
        observations: [],
        journal: [],
      },
    });

    render(
      <AssistantTaskPanel
        task={task}
        outputChunks={[]}
        streamState="idle"
        hasGap={false}
        isTruncated={false}
        vpsId="vps-1"
        onClearOutput={vi.fn()}
        onCancelTask={vi.fn()}
        onReconcileTask={vi.fn()}
        onResumeTask={onResume}
        onApprovePlan={vi.fn()}
        onDenyPlan={vi.fn()}
      />,
    );

    const resumeBtns = screen.getAllByRole("button", { name: /resume task/i });
    expect(resumeBtns.length).toBeGreaterThan(0);
    fireEvent.click(resumeBtns[0]);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("approves plan with exact planVersion and planDigest", async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const plan: AiPlan = {
      planId: "plan-v2",
      planVersion: 2,
      planDigest: "sha256:targetdigest123",
      taskId: "task-100",
      vpsId: "vps-1",
      agentInstanceId: "inst-1",
      providerRevision: 1,
      policyRevision: 1,
      capabilityRevision: 1,
      preconditions: [],
      expiresAt: "2026-10-30T11:00:00.000Z",
      status: "pending",
      steps: [makeStep({ stepId: "s-1", tool: "docker_run" })],
    };
    const task = makeTask({
      state: "awaiting_approval",
      plan,
    });

    render(
      <AssistantTaskPanel
        task={task}
        outputChunks={[]}
        streamState="idle"
        hasGap={false}
        isTruncated={false}
        vpsId="vps-1"
        onClearOutput={vi.fn()}
        onCancelTask={vi.fn()}
        onReconcileTask={vi.fn()}
        onApprovePlan={onApprove}
        onDenyPlan={vi.fn()}
      />,
    );

    const approveBtn = await screen.findByRole("button", { name: /^approve$/i });
    fireEvent.click(approveBtn);
    expect(onApprove).toHaveBeenCalledWith(2, "sha256:targetdigest123");
  });
});
