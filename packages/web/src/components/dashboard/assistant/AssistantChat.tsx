import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  ChevronDown,
  CornerDownLeft,
  HelpCircle,
  LoaderCircle,
  Send,
} from "lucide-react";
import { Button } from "../../ui/button";
import type {
  AiConversationMessage,
  AiProviderProfile,
  AiProviderSelection,
  AiTask,
} from "../../../lib/ai-api";
import { AssistantMarkdown } from "./AssistantMarkdown";

export type AssistantChatProps = {
  messages: AiConversationMessage[];
  activeTask: AiTask | null;
  onSendMessage: (text: string) => Promise<void>;
  onSubmitClarification: (text: string) => Promise<void>;
  onSelectBusyTask?: (taskId: string) => void;
  busyTaskId?: string | null;
  busy?: boolean;
  aiEnabled: boolean;
  providerReady: boolean;
  /** Enabled provider profiles for the model selector (grouped by provider). */
  providers?: AiProviderProfile[];
  modelSelection?: AiProviderSelection | null;
  onSelectModel?: (selection: AiProviderSelection) => void;
};

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const ROLE_LABELS: Record<AiConversationMessage["role"], string> = {
  user: "Operator",
  assistant: "Assistant",
  system: "System",
};

const SUGGESTIONS = [
  "Summarize host health",
  "List running containers",
  "Explain recent disk usage",
];

function EvidenceDisclosure({
  evidence,
}: {
  evidence: NonNullable<AiConversationMessage["evidence"]>;
}) {
  return (
    <details className="group mt-1.5 min-w-0 bg-ink/30 text-xs sm:border sm:border-line">
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 p-2.5 font-medium text-dim transition-colors hover:bg-raised/40 hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal list-none [&::-webkit-details-marker]:hidden">
        <span>Observed evidence ({evidence.length})</span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 text-dim transition-transform duration-150 group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-2 border-t border-line p-2.5">
        {evidence.map((ev, i) => (
          <div key={i}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-text">{ev.title}</span>
              <span className="tnum text-[10px] text-dim">
                {ev.type} • {new Date(ev.timestamp).toLocaleTimeString()}
              </span>
            </div>
            {ev.data ? (
              <pre className="mt-1 max-h-40 overflow-auto border border-line bg-ink p-2 font-mono text-[10px] leading-relaxed text-dim">
                {JSON.stringify(ev.data, null, 2)}
              </pre>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}

export function AssistantChat({
  messages,
  activeTask,
  onSendMessage,
  onSubmitClarification,
  onSelectBusyTask,
  busyTaskId,
  busy = false,
  aiEnabled,
  providerReady,
  providers = [],
  modelSelection,
  onSelectModel,
}: AssistantChatProps) {
  const [inputText, setInputText] = useState("");
  const [clarificationText, setClarificationText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendingClarification, setSendingClarification] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement | null>(null);
  // Stick-to-bottom: only follow new content while the operator is already
  // reading near the bottom. Never yank the view away from older messages.
  const pinnedToBottomRef = useRef(true);

  const isAwaitingInput = activeTask?.state === "awaiting_input";
  const clarificationPrompt = activeTask?.clarificationPrompt;

  const isTaskRunning =
    activeTask &&
    (activeTask.state === "planning" ||
      activeTask.state === "executing" ||
      activeTask.state === "verifying");

  useEffect(() => {
    const el = logRef.current;
    if (!el || !pinnedToBottomRef.current) return;
    // Scroll only the conversation container; the page never moves.
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [messages.length, activeTask?.state, isAwaitingInput, clarificationPrompt]);

  function handleLogScroll() {
    const el = logRef.current;
    if (!el) return;
    pinnedToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  const enabledProviders = providers.filter((profile) => profile.enabled && profile.models.length > 0);
  const selectionValue = modelSelection ? `${modelSelection.providerId}::${modelSelection.model}` : "";
  const providerNameById = new Map(providers.map((profile) => [profile.id, profile.name]));
  function handleSelectModel(value: string) {
    const separator = value.indexOf("::");
    if (separator <= 0 || !onSelectModel) return;
    onSelectModel({ providerId: value.slice(0, separator), model: value.slice(separator + 2) });
  }

  async function handleSend() {
    const trimmed = inputText.trim();
    if (!trimmed || sending || busy || isTaskRunning || !(aiEnabled && providerReady)) return;

    setSending(true);
    setChatError(null);
    try {
      await onSendMessage(trimmed);
      setInputText("");
    } catch (err) {
      setChatError(
        err instanceof Error ? err.message : "Failed to create assistant task.",
      );
    } finally {
      setSending(false);
    }
  }

  async function handleSendClarification() {
    const trimmed = clarificationText.trim();
    if (!trimmed || sendingClarification || busy) return;

    setSendingClarification(true);
    setChatError(null);
    try {
      await onSubmitClarification(trimmed);
      setClarificationText("");
    } catch (err) {
      setChatError(
        err instanceof Error ? err.message : "Failed to submit clarification.",
      );
    } finally {
      setSendingClarification(false);
    }
  }

  function submitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, submit: () => void) {
    // IME composition: Enter confirms the candidate string, not the message.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <section
      aria-label="Conversation"
      className="flex h-full min-h-0 min-w-0 flex-col sm:border sm:border-line sm:bg-panel"
    >
      {/* Messages timeline: the only scrollable area of the chat */}
      <div
        ref={logRef}
        role="log"
        aria-label="Assistant messages"
        aria-live="polite"
        onScroll={handleLogScroll}
        className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-1 py-5 sm:space-y-3 sm:px-4 [scrollbar-width:thin]"
      >
        {messages.length === 0 && !isAwaitingInput ? (
          <div className="flex h-full min-h-[14rem] flex-col items-center justify-center p-6 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-signal/30 bg-signal/10">
              <Bot className="h-6 w-6 text-signal" aria-hidden="true" />
            </div>
            <p className="mt-3 text-sm font-semibold text-text">
              How can the Assistant help?
            </p>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-dim">
              Ask about metrics or inventory. Changes follow host policy controls; shell
              and file access stay off unless explicitly enabled.
            </p>
            <div className="mt-4 flex max-w-lg flex-wrap items-center justify-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={!(aiEnabled && providerReady) || busy}
                  onClick={() => setInputText(suggestion)}
                  className="rounded-full border border-line bg-raised/50 px-3.5 py-2 text-xs text-dim transition-colors hover:border-signal/50 hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal disabled:opacity-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((msg) => (
          <article
            key={msg.id}
            className={`mx-auto flex w-full min-w-0 max-w-3xl ${
              msg.role === "user" ? "justify-end" : "gap-3"
            }`}
            aria-label={`${ROLE_LABELS[msg.role]} message`}
          >
            {msg.role === "user" ? (
              // Operator: right-aligned bubble; alignment identifies the
              // sender, so no name header is needed.
              <div className="flex min-w-0 w-fit max-w-[85%] flex-col items-end">
                <div className="w-full rounded-2xl rounded-br-[6px] bg-signal/15 px-4 py-2.5 sm:border sm:border-signal/30">
                  <AssistantMarkdown content={msg.content} />
                </div>
                {msg.evidence && msg.evidence.length > 0 ? (
                  <div className="w-full">
                    <EvidenceDisclosure evidence={msg.evidence} />
                  </div>
                ) : null}
                <time
                  className="tnum mt-1 text-[10px] text-dim"
                  dateTime={msg.createdAt}
                >
                  {new Date(msg.createdAt).toLocaleTimeString()}
                </time>
              </div>
            ) : msg.role === "system" ? (
              <div className="mx-auto min-w-0 w-fit max-w-xl rounded-[10px] bg-raised/30 px-3 py-2 text-xs sm:border sm:border-line">
                <AssistantMarkdown content={msg.content} className="amd-quiet" />
              </div>
            ) : (
              <>
                {/* Assistant: open text with a compact avatar marker; no
                    boxed card so long Markdown answers read at full width. */}
                <div
                  className="mt-4 hidden h-7 w-7 shrink-0 items-center justify-center rounded-[10px] border border-line bg-raised sm:flex"
                  aria-hidden="true"
                >
                  <Bot className="h-4 w-4 text-signal" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-baseline gap-2 text-[11px] text-dim">
                    <span className="font-semibold uppercase tracking-[0.06em]">
                      {ROLE_LABELS[msg.role]}
                    </span>
                    {msg.model ? (
                      <span className="truncate font-mono text-[10px]">
                        {msg.providerId ? (providerNameById.get(msg.providerId) ?? msg.providerId) : "provider"} · {msg.model}
                      </span>
                    ) : null}
                    <time className="tnum" dateTime={msg.createdAt}>
                      {new Date(msg.createdAt).toLocaleTimeString()}
                    </time>
                  </div>
                  <AssistantMarkdown content={msg.content} />
                  {msg.evidence && msg.evidence.length > 0 ? (
                    <EvidenceDisclosure evidence={msg.evidence} />
                  ) : null}
                </div>
              </>
            )}
          </article>
        ))}

        {/* Pending feedback while a task runs */}
        {isTaskRunning ? (
          <div className="mx-auto flex w-full min-w-0 max-w-3xl gap-3">
            <div
              className="mt-4 hidden h-7 w-7 shrink-0 items-center justify-center rounded-[10px] border border-line bg-raised sm:flex"
              aria-hidden="true"
            >
              <Bot className="h-4 w-4 text-signal" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-baseline gap-2 text-[11px] text-dim">
                <span className="font-semibold uppercase tracking-[0.06em]">Assistant</span>
              </div>
              <p className="flex items-center gap-2 text-xs text-dim">
                <LoaderCircle
                  className="h-3.5 w-3.5 animate-spin text-signal"
                  aria-hidden="true"
                />
                Assistant is working — execution details appear in the task inspector.
              </p>
            </div>
          </div>
        ) : null}

        {/* Clarification input when the task awaits operator input */}
        {isAwaitingInput ? (
          <div className="mx-auto w-full min-w-0 max-w-3xl space-y-3 rounded-2xl border border-info/40 bg-info/10 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-info">
              <HelpCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Clarification Required</span>
            </div>
            <AssistantMarkdown
              content={
                clarificationPrompt ||
                "The assistant requires clarification before proceeding with the task."
              }
            />
            <div className="space-y-2">
              <textarea
                value={clarificationText}
                onChange={(e) => setClarificationText(e.target.value)}
                onKeyDown={(e) =>
                  submitOnEnter(e, () => void handleSendClarification())
                }
                placeholder="Type your clarification answer..."
                aria-label="Clarification answer"
                rows={2}
                disabled={sendingClarification || busy}
                className="w-full resize-none rounded-[12px] border border-line bg-ink p-2.5 text-xs text-text placeholder:text-dim focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-50"
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  disabled={!clarificationText.trim() || sendingClarification || busy}
                  onClick={() => void handleSendClarification()}
                  className="text-xs"
                >
                  {sendingClarification ? (
                    <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <CornerDownLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  Submit Answer
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Busy task notice */}
      {busyTaskId ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Another task is currently running on this VPS.</span>
          </div>
          {onSelectBusyTask ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onSelectBusyTask(busyTaskId)}
              className="text-xs border-warn/40 text-warn hover:bg-warn/20"
            >
              <span>Switch to Active Task</span>
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Chat error display */}
      {chatError ? (
        <div className="shrink-0 border-t border-crit/40 bg-crit/10 p-3 text-xs text-crit" role="alert">
          {chatError}
        </div>
      ) : null}

      {/* Policy safeguards */}
      {!aiEnabled ? (
        <div className="shrink-0 border-t border-line bg-raised/30 p-3 text-xs text-dim">
          AI Assistant is explicitly disabled by policy on this VPS. Enable it in
          Settings to submit instructions.
        </div>
      ) : !providerReady ? (
        <div className="shrink-0 border-t border-line bg-raised/30 p-3 text-xs text-dim">
          Connect a provider (endpoint, model, and API key) in Settings to enable
          the Assistant.
        </div>
      ) : null}

      {/* Composer: never clipped; only the log above scrolls */}
      <div className="shrink-0 px-1 pb-1 pt-3 sm:border-t sm:border-line sm:bg-panel sm:px-4 sm:pb-4">
        <div className="mx-auto w-full max-w-3xl rounded-2xl bg-raised/50 px-3 pb-2 pt-2.5 sm:border sm:border-line">
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => submitOnEnter(e, () => void handleSend())}
            disabled={sending || busy || isTaskRunning || !(aiEnabled && providerReady)}
            placeholder={
              isTaskRunning
                ? "Task is currently executing..."
                : !aiEnabled
                  ? "AI Assistant is explicitly disabled by policy."
                  : !providerReady
                    ? "Connect a provider in Settings to enable the Assistant."
                    : "Ask the assistant or propose an operation..."
            }
            aria-label="Message"
            rows={2}
            maxLength={32768}
            className="w-full resize-none rounded-lg bg-transparent px-1 text-sm leading-relaxed text-text placeholder:text-dim focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-50 [scrollbar-width:thin]"
          />

          <div className="flex items-center justify-end gap-2 pt-1.5 sm:justify-between">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="tnum hidden text-[10px] text-dim sm:inline"
                aria-hidden="true"
              >
                {inputText.length > 0
                  ? `${inputText.length.toLocaleString()}/32,768`
                  : "Shift+Enter for newline"}
              </span>
              {enabledProviders.length > 0 && onSelectModel ? (
                <select
                  value={selectionValue}
                  onChange={(e) => handleSelectModel(e.target.value)}
                  // Boolean(): isTaskRunning is `boolean | null` and the DOM
                  // disabled attribute rejects null.
                  disabled={Boolean(sending || busy || isTaskRunning)}
                  aria-label="Model"
                  className="max-w-[11rem] truncate rounded-lg border border-line bg-ink px-2 py-1 font-mono text-[11px] text-text focus:outline-none disabled:opacity-50"
                >
                  {selectionValue === "" ? <option value="">Default model</option> : null}
                  {enabledProviders.map((profile) => (
                    <optgroup key={profile.id} label={profile.name}>
                      {profile.models.map((model) => (
                        <option key={`${profile.id}::${model}`} value={`${profile.id}::${model}`}>
                          {model}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={
                !inputText.trim() ||
                sending ||
                busy ||
                isTaskRunning ||
                !(aiEnabled && providerReady)
              }
              aria-label="Send"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-signal text-ink transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-40"
            >
              {sending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
