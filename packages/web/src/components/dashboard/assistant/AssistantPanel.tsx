import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  Bot,
  Cable,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import type { VpsRecord } from "../../../lib/api";
import {
  approveVpsAiTask,
  cancelVpsAiTask,
  checkAiProvider,
  createVpsAiTask,
  deleteVpsAiConversation,
  denyVpsAiTask,
  getAiSettings,
  getVpsAiCapability,
  getVpsAiConversation,
  getVpsAiPolicy,
  getVpsAiTask,
  listVpsAiConversations,
  listVpsAiTasks,
  patchAiSettings,
  patchVpsAiPolicy,
  reconcileVpsAiTask,
  submitVpsAiTaskInput,
  type AiCapability,
  type AiConversation,
  type AiConversationMessage,
  type AiPlanStep,
  type AiPolicy,
  type AiProviderSettings,
  type AiTask,
  type UpdateAiPolicy,
  type UpdateAiSettings,
} from "../../../lib/ai-api";
import { useAiTaskStream } from "../../../lib/ai-stream";
import { AssistantHeader } from "./AssistantHeader";
import { AssistantChat } from "./AssistantChat";
import { AssistantTaskPanel } from "./AssistantTaskPanel";
import { AssistantApprovalDialog } from "./AssistantApprovalDialog";
import { AssistantSettingsModal } from "./AssistantSettingsModal";
import { AssistantHistoryDrawer } from "./AssistantHistoryDrawer";
import { Button } from "../../ui/button";

export type AssistantPanelProps = {
  vps: VpsRecord;
};

export function AssistantPanel({ vps }: AssistantPanelProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Root state
  const [providerSettings, setProviderSettings] = useState<AiProviderSettings | null>(null);
  const [policy, setPolicy] = useState<AiPolicy | null>(null);
  const [capability, setCapability] = useState<AiCapability | null>(null);

  // Tasks & Messages
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<AiTask | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiConversationMessage[]>([]);

  // Dialogs
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);

  // Loading & Error
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // Dedicated bounded SSE stream for the active task
  const {
    streamState,
    outputChunks,
    hasGap,
    isTruncated,
    clearOutput,
    reconnect,
  } = useAiTaskStream({
    vpsId: vps.id,
    taskId: activeTaskId,
    enabled: Boolean(activeTaskId),
    onSnapshot: useCallback((taskSnapshot: AiTask) => {
      setActiveTask(taskSnapshot);
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === taskSnapshot.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = taskSnapshot;
          return next;
        }
        return [taskSnapshot, ...prev];
      });
      // If awaiting approval, pop the approval dialog open automatically once
      if (taskSnapshot.state === "awaiting_approval" && taskSnapshot.plan) {
        setApprovalDialogOpen(true);
      }
    }, []),
    onStepUpdate: useCallback((stepUpdate: AiPlanStep) => {
      setActiveTask((prev) => {
        if (!prev || !prev.plan || !prev.plan.steps) return prev;
        const nextSteps = prev.plan.steps.map((st) =>
          st.stepId === stepUpdate.stepId ? { ...st, ...stepUpdate } : st,
        );
        return { ...prev, plan: { ...prev.plan, steps: nextSteps } };
      });
    }, []),
  });

  // Load all initial data for this host
  const loadInitialData = useCallback(async () => {
    setRootError(null);
    try {
      const [provRes, polRes, capRes, tasksRes, convRes] = await Promise.all([
        getAiSettings().catch(() => null),
        getVpsAiPolicy(vps.id).catch(() => null),
        getVpsAiCapability(vps.id).catch(() => null),
        listVpsAiTasks(vps.id).catch(() => [] as AiTask[]),
        listVpsAiConversations(vps.id).catch(() => [] as AiConversation[]),
      ]);

      if (provRes) setProviderSettings(provRes);
      if (polRes) setPolicy(polRes);
      if (capRes) setCapability(capRes);
      if (tasksRes) setTasks(tasksRes);
      if (convRes) setConversations(convRes);

      // Determine active task: URL query param takes precedence, then first active executing/planning/approval task
      const urlTaskId = searchParams.get("taskId");
      let selectedTask: AiTask | null = null;

      if (urlTaskId && tasksRes) {
        selectedTask = tasksRes.find((t) => t.id === urlTaskId) || null;
      }

      if (!selectedTask && tasksRes && tasksRes.length > 0) {
        // Find first non-terminal task
        const active = tasksRes.find(
          (t) =>
            t.state === "planning" ||
            t.state === "awaiting_approval" ||
            t.state === "awaiting_input" ||
            t.state === "executing" ||
            t.state === "verifying",
        );
        selectedTask = active || tasksRes[0] || null;
      }

      if (selectedTask) {
        setActiveTaskId(selectedTask.id);
        setActiveTask(selectedTask);
      }

      // Populate conversation messages
      if (convRes && convRes.length > 0) {
        const latestConv = convRes[0];
        setActiveConversationId(latestConv.id);
        const detail = await getVpsAiConversation(vps.id, latestConv.id).catch(() => null);
        if (detail) {
          setMessages(detail.messages || []);
        }
      }
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Failed to load assistant configuration.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [vps.id, searchParams]);

  useEffect(() => {
    setLoading(true);
    void loadInitialData();
  }, [loadInitialData]);

  // When activeTaskId changes, sync with URL
  const handleSelectTask = useCallback(
    (taskId: string) => {
      setActiveTaskId(taskId);
      const found = tasks.find((t) => t.id === taskId);
      if (found) {
        setActiveTask(found);
      }
      clearOutput();
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("taskId", taskId);
          return next;
        },
        { replace: true },
      );
    },
    [tasks, clearOutput, setSearchParams],
  );

  // Send new instruction
  async function handleSendMessage(requestText: string) {
    if (actionBusy) return;
    setActionBusy(true);
    setRootError(null);
    setBusyTaskId(null);

    // Optimistically add user turn to local chat
    const optimisticMessage: AiConversationMessage = {
      id: `local-${Date.now()}`,
      conversationId: activeConversationId || "pending",
      role: "user",
      content: requestText,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      const idempotencyKey = crypto.randomUUID();
      const newTask = await createVpsAiTask(vps.id, {
        request: requestText,
        idempotencyKey,
        conversationId: activeConversationId || undefined,
      });

      // Switch to new task
      setTasks((prev) => [newTask, ...prev]);
      setActiveTaskId(newTask.id);
      setActiveTask(newTask);
      clearOutput();

      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("taskId", newTask.id);
          return next;
        },
        { replace: true },
      );
    } catch (err: unknown) {
      // Check for 409 busy error
      const maybeErr = err as {
        status?: number;
        code?: string;
        activeTaskId?: string;
        message?: string;
      };
      if (maybeErr.status === 409 || maybeErr.code === "task_busy") {
        if (maybeErr.activeTaskId) {
          setBusyTaskId(maybeErr.activeTaskId);
        }
      }
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  // Submit clarification input
  async function handleSubmitClarification(input: string) {
    if (!activeTaskId || actionBusy) return;
    setActionBusy(true);
    setRootError(null);

    // Optimistic user turn
    const optimisticMessage: AiConversationMessage = {
      id: `local-${Date.now()}`,
      conversationId: activeConversationId || "pending",
      role: "user",
      content: input,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      const updated = await submitVpsAiTaskInput(vps.id, activeTaskId, {
        input,
      });
      setActiveTask(updated);
    } finally {
      setActionBusy(false);
    }
  }

  // Exact Approval
  async function handleApprovePlan(planVersion: number, planDigest: string) {
    if (!activeTaskId || !activeTask?.plan || actionBusy) return;
    setActionBusy(true);
    setRootError(null);
    try {
      const updated = await approveVpsAiTask(vps.id, activeTaskId, {
        planVersion,
        planDigest,
      });
      setActiveTask(updated);
      setApprovalDialogOpen(false);
    } catch (err) {
      setRootError(err instanceof Error ? err.message : "Failed to approve plan.");
    } finally {
      setActionBusy(false);
    }
  }

  // Exact Deny
  async function handleDenyPlan() {
    if (!activeTaskId || !activeTask?.plan || actionBusy) return;
    setActionBusy(true);
    setRootError(null);
    try {
      const updated = await denyVpsAiTask(vps.id, activeTaskId);
      setActiveTask(updated);
      setApprovalDialogOpen(false);
    } catch (err) {
      setRootError(err instanceof Error ? err.message : "Failed to deny plan.");
    } finally {
      setActionBusy(false);
    }
  }
  // Cancel task
  async function handleCancelTask() {
    if (!activeTaskId || actionBusy) return;
    setActionBusy(true);
    setRootError(null);
    try {
      const updated = await cancelVpsAiTask(vps.id, activeTaskId);
      setActiveTask(updated);
    } catch (err) {
      setRootError(err instanceof Error ? err.message : "Failed to cancel task.");
    } finally {
      setActionBusy(false);
    }
  }

  // Reconcile task
  async function handleReconcileTask() {
    if (!activeTaskId || actionBusy) return;
    setActionBusy(true);
    setRootError(null);
    try {
      const updated = await reconcileVpsAiTask(vps.id, activeTaskId);
      setActiveTask(updated);
    } catch (err) {
      setRootError(err instanceof Error ? err.message : "Failed to reconcile task.");
    } finally {
      setActionBusy(false);
    }
  }

  // Save global settings
  async function handleSaveProviderSettings(patch: UpdateAiSettings) {
    setActionBusy(true);
    setRootError(null);
    try {
      const updated = await patchAiSettings(patch);
      setProviderSettings(updated);
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Failed to save provider settings.",
      );
      // Modal caller surfaces its own error state; never report false success.
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  // Save host policy
  async function handleSavePolicy(patch: UpdateAiPolicy) {
    setActionBusy(true);
    setRootError(null);
    try {
      const updated = await patchVpsAiPolicy(vps.id, patch);
      setPolicy(updated);
      // Invalidation of pending plans: refresh task
      if (activeTaskId) {
        const freshTask = await getVpsAiTask(vps.id, activeTaskId).catch(() => null);
        if (freshTask) setActiveTask(freshTask);
      }
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Failed to save VPS policy.",
      );
      // Modal caller surfaces its own error state; never report false success.
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  // Check provider connectivity
  async function handleCheckProvider() {
    try {
      await checkAiProvider();
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Provider check failed.",
      );
    }
  }

  // Select history conversation
  async function handleSelectConversation(conv: AiConversation) {
    setActiveConversationId(conv.id);
    setHistoryDrawerOpen(false);
    try {
      const detail = await getVpsAiConversation(vps.id, conv.id);
      setMessages(detail.messages || []);
      const lastMsgWithTask = [...detail.messages].reverse().find((m) => m.taskId);
      if (lastMsgWithTask?.taskId) {
        handleSelectTask(lastMsgWithTask.taskId);
      }
    } catch {
      // Ignored
    }
  }

  // Start new empty conversation
  function handleNewConversation() {
    setActiveConversationId(null);
    setMessages([]);
    setActiveTaskId(null);
    setActiveTask(null);
    clearOutput();
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("taskId");
      return next;
    });
  }

  async function handleDeleteConversation(convId: string) {
    await deleteVpsAiConversation(vps.id, convId);
    setConversations((prev) => prev.filter((c) => c.id !== convId));
    if (activeConversationId === convId) {
      setActiveConversationId(null);
      setMessages([]);
    }
  }

  // One-click enable: observation plus individually-approved managed actions only.
  async function handleEnableAssistant() {
    if (actionBusy) return;
    await handleSavePolicy({
      aiEnabled: true,
      readEnabled: true,
      dockerActionsEnabled: true,
      composeActionsEnabled: true,
    });
  }

  const providerReady = Boolean(
    providerSettings &&
      providerSettings.endpoint.trim().length > 0 &&
      providerSettings.model.trim().length > 0 &&
      providerSettings.hasApiKey === true,
  );
  const aiEnabled = policy?.aiEnabled === true;
  const readEnabled = policy?.readEnabled === true;

  if (loading) {
    return (
      <div className="flex h-96 flex-col items-center justify-center space-y-3 p-8 text-center text-xs text-dim">
        <LoaderCircle className="h-8 w-8 animate-spin text-signal" />
        <div>Connecting to AI Assistant subsystem...</div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-14rem)] min-h-[600px] flex-col space-y-3">
      {/* Global Header */}
      <AssistantHeader
        vps={vps}
        providerSettings={providerSettings}
        policy={policy}
        capability={capability}
        activeTask={activeTask}
        onOpenSettings={() => setSettingsModalOpen(true)}
        onOpenHistory={() => setHistoryDrawerOpen(true)}
        onRefresh={() => {
          setRefreshing(true);
          void loadInitialData();
        }}
        refreshing={refreshing}
        onNewConversation={handleNewConversation}
      />

      {/* Root error banner if present */}
      {rootError ? (
        <div className="flex items-center justify-between border border-crit/40 bg-crit/10 px-4 py-2 text-xs text-crit">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{rootError}</span>
          </div>
          <button
            type="button"
            onClick={() => setRootError(null)}
            className="text-xs hover:underline"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Provider setup gate: visible Connect action before any configured provider */}
      {!providerReady ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-warn/40 bg-warn/10 px-4 py-2.5 text-xs text-warn">
          <div className="flex items-center gap-2">
            <Cable className="h-4 w-4 shrink-0" />
            <span>
              No provider is configured (endpoint, model, and API key). Connect a provider to
              enable the Assistant on this host.
            </span>
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => setSettingsModalOpen(true)}
            disabled={actionBusy}
            className="text-xs font-semibold"
          >
            Connect Provider
          </Button>
        </div>
      ) : !(aiEnabled && readEnabled) ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-info/40 bg-info/10 px-4 py-2.5 text-xs text-info">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            <span>
              Provider is ready. Enabling grants read-only observation plus individually-approved
              managed Docker and Compose actions; shell execution and file egress stay off until
              explicitly approved in Settings.
            </span>
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => void handleEnableAssistant()}
            disabled={actionBusy}
            className="text-xs font-semibold"
          >
            Enable Assistant
          </Button>
        </div>
      ) : null}

      {/* Main 2-column layout: Left Chat / Right Task Execution Console */}
      <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-12 min-h-0">
        {/* Left Column: Chat & Clarifications (7 cols on lg) */}
        <div className="h-full min-h-0 lg:col-span-7">
          <AssistantChat
            messages={messages}
            activeTask={activeTask}
            onSendMessage={handleSendMessage}
            onSubmitClarification={handleSubmitClarification}
            onSelectBusyTask={handleSelectTask}
            busyTaskId={busyTaskId}
            busy={actionBusy}
            aiEnabled={aiEnabled}
            providerReady={providerReady}
          />
        </div>

        {/* Right Column: Active Task & Streaming Execution Panel (5 cols on lg) */}
        <div className="h-full min-h-0 lg:col-span-5">
          <AssistantTaskPanel
            task={activeTask}
            streamState={streamState}
            outputChunks={outputChunks}
            hasGap={hasGap}
            isTruncated={isTruncated}
            onClearOutput={clearOutput}
            onReconnectStream={reconnect}
            onOpenApproval={() => setApprovalDialogOpen(true)}
            onCancelTask={handleCancelTask}
            onReconcileTask={handleReconcileTask}
            busy={actionBusy}
          />
        </div>
      </div>

      {/* Exact Approval Dialog */}
      <AssistantApprovalDialog
        open={approvalDialogOpen}
        plan={activeTask?.plan || null}
        vpsId={vps.id}
        taskId={activeTaskId || activeTask?.id}
        busy={actionBusy}
        onApprove={handleApprovePlan}
        onDeny={handleDenyPlan}
        onClose={() => setApprovalDialogOpen(false)}
      />

      {/* Settings & Policy Modal */}
      <AssistantSettingsModal
        open={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        vpsId={vps.id}
        providerSettings={providerSettings}
        policy={policy}
        capability={capability}
        onSaveProviderSettings={handleSaveProviderSettings}
        onSavePolicy={handleSavePolicy}
        onCheckProvider={handleCheckProvider}
        busy={actionBusy}
      />

      {/* Conversation History Drawer */}
      <AssistantHistoryDrawer
        open={historyDrawerOpen}
        onClose={() => setHistoryDrawerOpen(false)}
        conversations={conversations}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        activeConversationId={activeConversationId}
      />
    </div>
  );
}
