import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
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
  authorizeAiProviderOauth,
  cancelVpsAiTask,
  checkAiProviderProfile,
  createAiProvider,
  createVpsAiTask,
  deleteAiProvider,
  deleteVpsAiConversation,
  denyVpsAiTask,
  exchangeAiProviderOauth,
  fetchAiProviderModels,
  getAiSettings,
  getVpsAiCapability,
  getVpsAiConversation,
  getVpsAiPolicy,
  getVpsAiTask,
  listAiProviders,
  listVpsAiConversations,
  listVpsAiTasks,
  patchVpsAiPolicy,
  reconcileVpsAiTask,
  submitVpsAiTaskInput,
  updateAiProvider,
  type AiCapability,
  type AiConversation,
  type AiConversationMessage,
  type AiPlanStep,
  type AiPolicy,
  type AiProviderProfile,
  type AiProviderSelection,
  type AiProviderSettings,
  type AiTask,
  type CreateAiTaskRequest,
  type ProviderProfileWrite,
  type UpdateAiPolicy,
} from "../../../lib/ai-api";
import { useAiTaskStream } from "../../../lib/ai-stream";
import { AssistantHeader } from "./AssistantHeader";
import { AssistantChat } from "./AssistantChat";
import { AssistantTaskPanel } from "./AssistantTaskPanel";
import { AssistantApprovalDialog } from "./AssistantApprovalDialog";
import { AssistantSettingsModal } from "./AssistantSettingsModal";
import { AssistantHistoryColumn } from "./AssistantHistoryColumn";
import { Button } from "../../ui/button";

export type AssistantPanelProps = {
  vps: VpsRecord;
};

// Q16 selection resolution: a selection is usable only when it names an
// enabled provider that still lists the model. A stale selection resolves to
// null so the send omits providerId/model and the server applies its own
// tier order (last selection, then the default profile), failing closed when
// nothing resolves.
function resolveUsableSelection(
  selection: AiProviderSelection | null | undefined,
  providerList: AiProviderProfile[],
): AiProviderSelection | null {
  if (!selection) return null;
  const profile = providerList.find((p) => p.id === selection.providerId);
  if (!profile || !profile.enabled || !profile.models.includes(selection.model)) {
    return null;
  }
  return { providerId: profile.id, model: selection.model };
}

function conversationSelection(
  conversation: AiConversation | null | undefined,
  providerList: AiProviderProfile[],
): AiProviderSelection | null {
  if (!conversation?.selectedProviderId || !conversation.selectedModel) return null;
  return resolveUsableSelection(
    {
      providerId: conversation.selectedProviderId,
      model: conversation.selectedModel,
    },
    providerList,
  );
}

function defaultProfileSelection(
  providerList: AiProviderProfile[],
): AiProviderSelection | null {
  const fallback = providerList.find(
    (p) => p.isDefault && p.enabled && p.models.length > 0,
  );
  if (!fallback) return null;
  const model =
    fallback.defaultModel && fallback.models.includes(fallback.defaultModel)
      ? fallback.defaultModel
      : fallback.models[0];
  return { providerId: fallback.id, model };
}

export function AssistantPanel({ vps }: AssistantPanelProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Writing ?taskId= (task selection/creation) must not retrigger the full
  // initial load: read the param through a ref so loadInitialData only
  // re-runs when the host changes, preserving the active conversation.
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  // Async race guards: a slower load for a superseded host/refresh, or a
  // conversation detail fetch for a superseded selection, must never
  // clobber newer panel state.
  const loadSeqRef = useRef(0);
  const convSeqRef = useRef(0);

  // Mirrors activeConversationId including explicit null (New Chat) so
  // refresh keeps the user's selection instead of falling back to the
  // latest conversation. undefined = nothing selected yet this host.
  const activeConversationRef = useRef<string | null | undefined>(undefined);

  // Root state
  const [providerSettings, setProviderSettings] = useState<AiProviderSettings | null>(null);
  const [providers, setProviders] = useState<AiProviderProfile[]>([]);
  const [lastSelection, setLastSelection] = useState<AiProviderSelection | null>(null);
  // Composer model pick (Q16 tier 1); null = let the server resolve.
  const [modelSelection, setModelSelection] = useState<AiProviderSelection | null>(null);
  const [selectionWarnDismissed, setSelectionWarnDismissed] = useState(false);
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
  const [olderMessagesAvailable, setOlderMessagesAvailable] = useState(false);
  const [oldestMessageOffset, setOldestMessageOffset] = useState(0);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);

  // Dialogs
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  // Conversation history: persistent column left of the chat on wide
  // screens; on narrow screens it becomes a slide-over drawer (OpenAI-style
  // mobile chat), so the chat itself keeps the full viewport height.
  const [historyOpen, setHistoryOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 80rem)").matches,
  );
  const [taskDetailsOpen, setTaskDetailsOpen] = useState(false);

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

  // Keeps the cached conversation list aligned with the loaded detail so the
  // selection-pin warning reads fresh selectedProviderId/selectedModel data.
  const mergeConversation = useCallback((conversation: AiConversation) => {
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === conversation.id);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...conversation };
      return next;
    });
  }, []);

  // Load all initial data for this host. Re-runs only when the host changes;
  // manual refresh reuses the same seq-guarded path without a full reload.
  const loadInitialData = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    const seq = ++loadSeqRef.current;
    if (mode === "initial") convSeqRef.current += 1;
    // Captured before any await: a conversation action (history select /
    // New Chat) during the fetches supersedes this load's selection.
    const convSeq = convSeqRef.current;
    setRootError(null);
    if (mode === "initial") {
      // Drop any previous host's task/conversation state before loading.
      setTasks([]);
      setConversations([]);
      setActiveTaskId(null);
      setActiveTask(null);
      setActiveConversationId(null);
      setMessages([]);
      setOlderMessagesAvailable(false);
      setOldestMessageOffset(0);
      setLoadingOlderMessages(false);
      setProviders([]);
      setLastSelection(null);
      setModelSelection(null);
      setSelectionWarnDismissed(false);
      activeConversationRef.current = undefined;
    }
    try {
      const [provRes, provListRes, polRes, capRes, tasksRes, convRes] = await Promise.all([
        getAiSettings().catch(() => null),
        listAiProviders().catch(() => null),
        getVpsAiPolicy(vps.id).catch(() => null),
        getVpsAiCapability(vps.id).catch(() => null),
        listVpsAiTasks(vps.id).catch(() => [] as AiTask[]),
        listVpsAiConversations(vps.id).catch(() => [] as AiConversation[]),
      ]);

      // A newer load (host switch / refresh) superseded this response set.
      if (seq !== loadSeqRef.current) return;

      if (provRes) setProviderSettings(provRes);
      const providerList = provListRes?.providers ?? [];
      if (provListRes) {
        setProviders(provListRes.providers);
        setLastSelection(provListRes.lastSelection ?? null);
      }
      if (polRes) setPolicy(polRes);
      if (capRes) setCapability(capRes);
      if (tasksRes) {
        setTasks(tasksRes);
        // The refreshed list must not be shadowed by a stale activeTask
        // snapshot in the chat projection; never regress a newer live one.
        setActiveTask((prev) => {
          if (!prev) return prev;
          const fresh = tasksRes.find((t) => t.id === prev.id);
          return fresh && fresh.revision >= prev.revision ? fresh : prev;
        });
      }
      if (convRes) setConversations(convRes);

      if (convSeqRef.current !== convSeq) return;

      // Determine active task (initial only; refresh keeps the user's
      // selection): URL query param takes precedence, then first active
      // executing/planning/approval task
      let selectedTask: AiTask | null = null;
      if (mode === "initial") {
        const urlTaskId = searchParamsRef.current.get("taskId");

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
      }

      // Conversation selection: refresh keeps the user's exact choice
      // (explicit null = New Chat stays empty — never fall through to the
      // latest conversation); initial load prefers the deep-linked/selected
      // task's conversation, then the latest conversation.
      // Q16 tiers 2/3 for the composer pick: the admin's last used selection,
      // then the default enabled profile. Only fills in when nothing more
      // specific set a usable pick (no conversation, or an unresolvable pin).
      const fallbackSelection =
        resolveUsableSelection(provListRes?.lastSelection, providerList) ??
        defaultProfileSelection(providerList);

      const preferredConvId =
        mode === "refresh"
          ? (activeConversationRef.current ?? null)
          : (selectedTask?.conversationId ?? (convRes || [])[0]?.id ?? null);

      if (preferredConvId) {
        setActiveConversationId(preferredConvId);
        if (mode === "initial") activeConversationRef.current = preferredConvId;
        const first = await getVpsAiConversation(vps.id, preferredConvId, undefined, 0, 1).catch(() => null);
        let start = first ? Math.max(0, (first.total ?? first.messages.length) - 200) : 0;
        let detail = first ? await getVpsAiConversation(vps.id, preferredConvId, undefined, start).catch(() => null) : null;
        if (detail?.remaining) {
          start += detail.remaining;
          detail = await getVpsAiConversation(vps.id, preferredConvId, undefined, start).catch(() => null);
        }
        // Superseded by a newer load, a conversation selection, or New Chat.
        if (seq !== loadSeqRef.current || convSeqRef.current !== convSeq) return;
        if (detail) {
          setMessages(detail.messages || []);
          setOlderMessagesAvailable(start > 0);
          setOldestMessageOffset(start);
          mergeConversation(detail.conversation);
          // Conversation pin wins when it still resolves; an unresolvable pin
          // keeps the current pick so the warning can offer a swap.
          const convSelection = conversationSelection(detail.conversation, providerList);
          if (convSelection) {
            setModelSelection(convSelection);
          } else {
            setModelSelection((prev) => prev ?? fallbackSelection);
          }
        } else {
          setModelSelection((prev) => prev ?? fallbackSelection);
        }
      } else {
        // New Chat / no conversations yet.
        setModelSelection((prev) => prev ?? fallbackSelection);
      }
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Failed to load assistant configuration.",
      );
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [vps.id, mergeConversation]);

  useEffect(() => {
    setLoading(true);
    void loadInitialData("initial");
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

  // Composer model pick; also retires the selection-pin warning because
  // picking another model is exactly what the warning asks for.
  const handleSelectModel = useCallback((selection: AiProviderSelection) => {
    setModelSelection(selection);
    setSelectionWarnDismissed(true);
  }, []);

  // Send new instruction
  async function handleSendMessage(requestText: string) {
    if (actionBusy) return;
    setActionBusy(true);
    setRootError(null);
    setBusyTaskId(null);

    // Optimistically add user turn to local chat
    const optimisticId = `local-${Date.now()}`;
    const optimisticMessage: AiConversationMessage = {
      id: optimisticId,
      conversationId: activeConversationId || "pending",
      role: "user",
      content: requestText,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      const idempotencyKey = crypto.randomUUID();
      // Q16 tier 1: bind the picked provider/model only when it still
      // resolves against an enabled profile; a stale pick is omitted so the
      // server applies its fallback order and fails closed if unusable.
      const sendSelection = resolveUsableSelection(modelSelection, providers);
      const body: CreateAiTaskRequest = {
        request: requestText,
        idempotencyKey,
        conversationId: activeConversationId || undefined,
      };
      if (sendSelection) {
        body.providerId = sendSelection.providerId;
        body.model = sendSelection.model;
      }
      const newTask = await createVpsAiTask(vps.id, body);

      // Reconcile the optimistic turn with server truth: adopt the task's
      // server-side timestamp and task binding. Otherwise client clock skew
      // can sort the operator's question after the task's synthesized
      // summary, and the requestSummary fallback cannot dedupe by taskId.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticId
            ? { ...m, taskId: newTask.id, createdAt: newTask.createdAt }
            : m,
        ),
      );

      // Switch to new task
      setTasks((prev) => [newTask, ...prev]);
      setActiveTaskId(newTask.id);
      setActiveTask(newTask);
      // The created task pins the conversation for this chat session; adopt
      // it so projected summaries and follow-ups target the right
      // conversation even before it appears in list refreshes.
      setActiveConversationId(newTask.conversationId);
      activeConversationRef.current = newTask.conversationId;
      if (sendSelection) {
        // Mirror the server: the sent selection becomes the conversation pin
        // and the admin's last used selection.
        setLastSelection(sendSelection);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === newTask.conversationId
              ? {
                  ...c,
                  selectedProviderId: sendSelection.providerId,
                  selectedModel: sendSelection.model,
                }
              : c,
          ),
        );
      }
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
    const optimisticId = `local-${Date.now()}`;
    const optimisticMessage: AiConversationMessage = {
      id: optimisticId,
      conversationId: activeConversationId || activeTask?.conversationId || "pending",
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
      // Server-side timestamp keeps the answer ordered before the reply it
      // triggers even when the client clock runs ahead of the server.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticId
            ? { ...m, taskId: updated.id, createdAt: updated.updatedAt }
            : m,
        ),
      );
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

  // Provider profile mutations refresh both the profile list and the legacy
  // settings projection, which derives the effective default profile.
  async function refreshProviderData() {
    const [listRes, settingsRes] = await Promise.all([
      listAiProviders().catch(() => null),
      getAiSettings().catch(() => null),
    ]);
    if (listRes) {
      setProviders(listRes.providers);
      setLastSelection(listRes.lastSelection ?? null);
    }
    if (settingsRes) setProviderSettings(settingsRes);
  }

  async function handleCreateProvider(body: ProviderProfileWrite) {
    setActionBusy(true);
    setRootError(null);
    try {
      await createAiProvider(body);
      await refreshProviderData();
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Failed to create provider profile.",
      );
      // Modal caller surfaces its own error state; never report false success.
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  async function handleUpdateProvider(id: string, body: ProviderProfileWrite) {
    setActionBusy(true);
    setRootError(null);
    try {
      await updateAiProvider(id, body);
      await refreshProviderData();
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Failed to update provider profile.",
      );
      // Modal caller surfaces its own error state; never report false success.
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDeleteProvider(id: string) {
    setActionBusy(true);
    setRootError(null);
    try {
      await deleteAiProvider(id);
      await refreshProviderData();
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Failed to delete provider profile.",
      );
      // Modal caller surfaces its own error state; never report false success.
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  // Check targets the saved profile row; it mutates nothing, so no refresh.
  async function handleCheckProviderProfile(id: string) {
    try {
      await checkAiProviderProfile(id);
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Provider check failed.",
      );
      // Modal caller surfaces its own error state; never report false success.
      throw err;
    }
  }

  async function handleFetchProviderModels(id: string) {
    setActionBusy(true);
    setRootError(null);
    try {
      await fetchAiProviderModels(id);
      await refreshProviderData();
    } catch (err) {
      setRootError(
        err instanceof Error ? err.message : "Failed to fetch provider models.",
      );
      // Modal caller surfaces its own error state; never report false success.
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  // OAuth paste-back flow (plan Q10): authorize builds the URL server-side
  // (PKCE state stays in-memory there; no profile mutation, so no refresh).
  async function handleAuthorizeProviderOauth(id: string): Promise<string> {
    setActionBusy(true);
    setRootError(null);
    try {
      const { authorizeUrl } = await authorizeAiProviderOauth(id);
      return authorizeUrl;
    } catch (err) {
      setRootError(
        err instanceof Error
          ? err.message
          : "Failed to start the OAuth authorization.",
      );
      // Modal caller surfaces its own error state; never report false success.
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  // Exchange stores the token envelope server-side; the refreshed provider
  // list carries the new tokenState and the timestamps flow back to the modal.
  async function handleExchangeProviderOauth(
    id: string,
    callbackUrl: string,
  ): Promise<{ expiresAt: string; lastRefreshedAt: string }> {
    setActionBusy(true);
    setRootError(null);
    try {
      const result = await exchangeAiProviderOauth(id, callbackUrl);
      await refreshProviderData();
      return {
        expiresAt: result.expiresAt,
        lastRefreshedAt: result.lastRefreshedAt,
      };
    } catch (err) {
      setRootError(
        err instanceof Error
          ? err.message
          : "Failed to connect the ChatGPT OAuth login.",
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

  // Select history conversation
  async function handleSelectConversation(conv: AiConversation) {
    const seq = ++convSeqRef.current;
    setActiveConversationId(conv.id);
    activeConversationRef.current = conv.id;
    setMessages([]);
    setOlderMessagesAvailable(false);
    setOldestMessageOffset(0);
    setLoadingOlderMessages(false);
    try {
      const first = await getVpsAiConversation(vps.id, conv.id, undefined, 0, 1);
      let start = Math.max(0, (first.total ?? first.messages.length) - 200);
      let detail = await getVpsAiConversation(vps.id, conv.id, undefined, start);
      if (detail.remaining) {
        start += detail.remaining;
        detail = await getVpsAiConversation(vps.id, conv.id, undefined, start);
      }
      // A newer selection (or "New Chat") superseded this fetch.
      if (seq !== convSeqRef.current) return;
      setMessages(detail.messages || []);
      setOlderMessagesAvailable(start > 0);
      setOldestMessageOffset(start);
      mergeConversation(detail.conversation);
      // A conversation pin that still resolves takes over the model pick;
      // one that does not keeps the current pick (warning banner handles it).
      const convSelection = conversationSelection(detail.conversation, providers);
      if (convSelection) {
        setModelSelection(convSelection);
      }
      const lastMsgWithTask = [...detail.messages].reverse().find((m) => m.taskId);
      if (lastMsgWithTask?.taskId) {
        handleSelectTask(lastMsgWithTask.taskId);
      }
    } catch {
      // Ignored
    }
  }

  async function handleLoadOlderMessages() {
    if (!activeConversationId || !olderMessagesAvailable || loadingOlderMessages) return;
    const conversationId = activeConversationId;
    const seq = convSeqRef.current;
    setLoadingOlderMessages(true);
    try {
      const start = Math.max(0, oldestMessageOffset - 200);
      const page = await getVpsAiConversation(vps.id, conversationId, undefined, start, oldestMessageOffset - start);
      if (seq !== convSeqRef.current || activeConversationRef.current !== conversationId) return;
      setMessages(previous => {
        const known = new Set(previous.map(message => message.id));
        return [...page.messages.filter(message => !known.has(message.id)), ...previous];
      });
      setOlderMessagesAvailable(start > 0);
      setOldestMessageOffset(start);
    } catch (error) {
      if (seq === convSeqRef.current && activeConversationRef.current === conversationId) {
        setRootError(error instanceof Error ? error.message : "Could not load older messages.");
      }
    } finally {
      if (seq === convSeqRef.current) setLoadingOlderMessages(false);
    }
  }

  // Start new empty conversation
  function handleNewConversation() {
    // Invalidate any in-flight history selection so it cannot resurrect
    // its conversation after the user explicitly started a new chat.
    convSeqRef.current += 1;
    setActiveConversationId(null);
    activeConversationRef.current = null;
    setMessages([]);
    setOlderMessagesAvailable(false);
    setOldestMessageOffset(0);
    setLoadingOlderMessages(false);
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
    if (activeConversationRef.current === convId) {
      convSeqRef.current += 1;
      setActiveConversationId(null);
      activeConversationRef.current = null;
      setMessages([]);
      setOlderMessagesAvailable(false);
      setOldestMessageOffset(0);
      setLoadingOlderMessages(false);
      setActiveTaskId(null);
      setActiveTask(null);
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

  useEffect(() => {
    if (activeTask && ["awaiting_approval", "uncertain", "failed", "cancel_requested"].includes(activeTask.state)) {
      setTaskDetailsOpen(true);
    }
  }, [activeTask?.id, activeTask?.state]);

  const providerReady = Boolean(
    providerSettings &&
      providerSettings.endpoint.trim().length > 0 &&
      providerSettings.model.trim().length > 0 &&
      providerSettings.hasApiKey === true,
  );
  const aiEnabled = policy?.aiEnabled === true;
  const readEnabled = policy?.readEnabled === true;

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  // Mirror of the server's fail-closed rule (Q10/Q16): a conversation pinned
  // to a provider that no longer resolves (disabled, deleted, or model
  // removed) refuses sends until another model is picked.
  const selectionWarning = useMemo(() => {
    const providerId = activeConversation?.selectedProviderId;
    const model = activeConversation?.selectedModel;
    if (!providerId || !model) return null;
    const pinned = providers.find((p) => p.id === providerId);
    if (!pinned || !pinned.enabled) {
      return "The provider this conversation was using is disabled or removed. Pick another model before sending.";
    }
    if (!pinned.models.includes(model)) {
      return "The model this conversation was using is no longer available. Pick another model before sending.";
    }
    return null;
  }, [activeConversation, providers]);

  // A different conversation may carry a different pin; the dismissal is
  // per-conversation and re-arms whenever the selection changes.
  useEffect(() => {
    setSelectionWarnDismissed(false);
  }, [activeConversationId]);

  // Chat projection: persisted messages plus synthesized turns for the
  // active conversation only. Final task summaries (from the task list or a
  // live SSE snapshot) and the selected task's request must be readable in
  // the chat even when the persisted message list omits them, without
  // duplicating content the conversation already carries. One projected
  // summary per task id; an earlier assistant turn with different content
  // never suppresses the final result.
  const chatMessages = useMemo(() => {
    if (!activeConversationId) return messages;

    const tasksById = new Map<string, AiTask>();
    for (const t of tasks) tasksById.set(t.id, t);
    if (activeTask) tasksById.set(activeTask.id, activeTask);

    const projected: AiConversationMessage[] = [];

    const selectedTask =
      activeTask && activeTask.conversationId === activeConversationId ? activeTask : null;
    if (selectedTask && selectedTask.requestSummary.trim().length > 0) {
      const requestText = selectedTask.requestSummary.trim();
      const hasUserTurn =
        messages.some((m) => m.role === "user" && m.taskId === selectedTask.id) ||
        messages.some((m) => m.role === "user" && m.content.trim() === requestText);
      if (!hasUserTurn) {
        projected.push({
          id: `request-${selectedTask.id}`,
          conversationId: selectedTask.conversationId,
          taskId: selectedTask.id,
          role: "user",
          content: selectedTask.requestSummary,
          createdAt: selectedTask.createdAt,
        });
      }
    }

    const summaries: AiConversationMessage[] = [];
    for (const t of tasksById.values()) {
      if (t.conversationId !== activeConversationId) continue;
      const summaryText = t.summary?.trim();
      if (!summaryText) continue;
      const alreadyPersisted = messages.some(
        (m) => m.role === "assistant" && m.taskId === t.id && m.content.trim() === summaryText,
      );
      if (alreadyPersisted) continue;
      summaries.push({
        id: `summary-${t.id}`,
        conversationId: t.conversationId,
        taskId: t.id,
        role: "assistant",
        content: summaryText,
        createdAt: t.updatedAt,
      });
    }

    if (projected.length === 0 && summaries.length === 0) return messages;
    // Chronological merge so an old task's summary never jumps past later
    // turns; synthesized turns carry the task's own createdAt/updatedAt.
    const merged = [...messages, ...projected, ...summaries];
    merged.sort((a, b) => {
      const byTime = a.createdAt.localeCompare(b.createdAt);
      if (byTime !== 0) return byTime;
      // Identical timestamps: the operator's turn precedes the reply.
      if (a.role !== b.role) return a.role === "user" ? -1 : 1;
      return 0;
    });
    return merged;
  }, [messages, tasks, activeTask, activeConversationId]);

  // Fill the panel from its real position to the viewport bottom instead of
  // a magic 100dvh offset: surrounding chrome (workspace tabs, banner,
  // status rows) differs per section and shifts the panel's top edge.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [isWide, setIsWide] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 80rem)").matches,
  );

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const BOTTOM_GAP = 16;
    // Wide screens keep a generous floor; narrow (app-like chat) screens fit
    // the viewport exactly with only a small degenerate-height floor.
    const MIN_HEIGHT = isWide ? 32 * 16 : 18 * 16;
    const update = () => {
      const docTop = el.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(window.innerHeight - docTop - BOTTOM_GAP, MIN_HEIGHT);
      setPanelHeight((prev) => (prev === next ? prev : next));
    };
    update();
    window.addEventListener("resize", update);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(document.documentElement);
    }
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [loading, isWide]);

  // Below xl the chat and the task inspector stack naturally instead of
  // being forced into one viewport height. Crossing the breakpoint also
  // resets the history surface to its per-mode default (column vs drawer).
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 80rem)");
    const apply = () => {
      setIsWide(query.matches);
      setHistoryOpen(query.matches);
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  if (loading) {
    return (
      <div className="flex h-96 flex-col items-center justify-center space-y-3 p-8 text-center text-xs text-dim">
        <LoaderCircle className="h-8 w-8 animate-spin text-signal" />
        <div>Connecting to AI Assistant subsystem...</div>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      style={
        panelHeight !== null && !(taskDetailsOpen && activeTask && !isWide)
          ? { height: `${panelHeight}px` }
          : undefined
      }
      className="flex min-h-[32rem] min-w-0 flex-col gap-3"
    >
      {/* Global Header */}
      <AssistantHeader
        vps={vps}
        providerSettings={providerSettings}
        policy={policy}
        capability={capability}
        activeTask={activeTask}
        onOpenSettings={() => setSettingsModalOpen(true)}
        onOpenHistory={() => setHistoryOpen((open) => !open)}
        historyOpen={historyOpen}
        onRefresh={() => {
          setRefreshing(true);
          void loadInitialData("refresh");
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

      {activeTask ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line pb-2 text-xs">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={`font-medium ${activeTask.state === "failed" || activeTask.state === "uncertain" ? "text-crit" : activeTask.state === "awaiting_approval" ? "text-warn" : "text-dim"}`}>
              {activeTask.state.replace(/_/g, " ")}
            </span>
            {activeTask.compacting === true ? (
              <span
                role="status"
                className="inline-flex items-center gap-1 text-dim"
              >
                <LoaderCircle
                  className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Auto-compact
              </span>
            ) : null}
            {activeTask.state === "awaiting_approval" ? (
              <Button size="sm" onClick={() => setApprovalDialogOpen(true)} className="text-xs">Review Plan</Button>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="sm" aria-expanded={taskDetailsOpen} aria-controls="assistant-task-details" onClick={() => setTaskDetailsOpen((open) => !open)} className="text-xs">
            <Terminal className="mr-1.5 h-3.5 w-3.5" />{taskDetailsOpen ? "Hide task details" : "Task details"}
          </Button>
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 xl:flex-row">
        {/* Wide screens: persistent conversation column left of the chat */}
        {historyOpen && isWide ? (
          <div id="assistant-history-column" className="min-h-0 w-60 shrink-0">
            <AssistantHistoryColumn
              conversations={conversations}
              onSelectConversation={handleSelectConversation}
              onDeleteConversation={handleDeleteConversation}
              activeConversationId={activeConversationId}
            />
          </div>
        ) : null}

        {/* Narrow screens: the history column becomes a slide-over drawer
            so the chat keeps the full viewport height (mobile chat layout) */}
        {historyOpen && !isWide ? (
          <div
            className="fixed inset-0 z-40 xl:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Conversation history"
          >
            <button
              type="button"
              aria-label="Close history"
              onClick={() => setHistoryOpen(false)}
              className="absolute inset-0 bg-ink/80"
            />
            <div
              id="assistant-history-column"
              className="absolute bottom-0 left-0 top-0 flex w-[85%] max-w-xs flex-col bg-panel"
            >
              <AssistantHistoryColumn
                conversations={conversations}
                onSelectConversation={(conv) => {
                  void handleSelectConversation(conv);
                  setHistoryOpen(false);
                }}
                onDeleteConversation={handleDeleteConversation}
                activeConversationId={activeConversationId}
              />
            </div>
          </div>
        ) : null}

        <div className={`grid min-h-0 min-w-0 flex-1 gap-3 ${taskDetailsOpen && activeTask ? "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]" : "grid-cols-1"}`}>
          <div className={`flex min-h-0 min-w-0 flex-col ${taskDetailsOpen && activeTask ? "h-[32rem] xl:h-full" : "h-full"}`}>
            {/* Privileged execution keeps running while the chat is open; the
                warning must stay visible above the conversation (plan Q4). */}
            {policy?.execMode === "privileged" ? (
              <div
                data-testid="privileged-exec-banner"
                className="flex shrink-0 items-start gap-2 border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  Privileged execution is on for this host: AI shell commands
                  run as root on the host, outside the sandbox. Every command
                  still requires manual approval.
                </span>
              </div>
            ) : null}
            {selectionWarning && !selectionWarnDismissed ? (
              <div className="flex shrink-0 items-center justify-between gap-3 border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{selectionWarning}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectionWarnDismissed(true)}
                  className="text-xs hover:underline"
                >
                  Dismiss
                </button>
              </div>
            ) : null}
            {olderMessagesAvailable ? (
              <Button type="button" variant="ghost" size="sm" disabled={loadingOlderMessages} onClick={() => void handleLoadOlderMessages()} className="shrink-0 self-center text-xs">
                {loadingOlderMessages ? "Loading…" : "Load older messages"}
              </Button>
            ) : null}
            <div className="min-h-0 flex-1">
            <AssistantChat
              messages={chatMessages}
              activeTask={activeTask}
              onSendMessage={handleSendMessage}
              onSubmitClarification={handleSubmitClarification}
              onSelectBusyTask={handleSelectTask}
              busyTaskId={busyTaskId}
              busy={actionBusy}
              aiEnabled={aiEnabled}
              providerReady={providerReady}
              providers={providers}
              modelSelection={modelSelection}
              onSelectModel={handleSelectModel}
            />
            </div>
          </div>

          <div id="assistant-task-details" hidden={!taskDetailsOpen || !activeTask} className="h-[28rem] min-h-0 min-w-0 xl:h-full">
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
        providers={providers}
        policy={policy}
        capability={capability}
        onCreateProvider={handleCreateProvider}
        onUpdateProvider={handleUpdateProvider}
        onDeleteProvider={handleDeleteProvider}
        onCheckProviderProfile={handleCheckProviderProfile}
        onFetchProviderModels={handleFetchProviderModels}
        onAuthorizeProviderOauth={handleAuthorizeProviderOauth}
        onExchangeProviderOauth={handleExchangeProviderOauth}
        onSavePolicy={handleSavePolicy}
        busy={actionBusy}
      />
    </div>
  );
}
