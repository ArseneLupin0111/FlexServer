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
      className="flex h-full min-h-0 min-w-0 flex-col border border-line bg-panel"
    >
      {/* Messages timeline: the only scrollable area of the chat */}
      <div
        ref={logRef}
        role="log"
        aria-label="Assistant messages"
        aria-live="polite"
        onScroll={handleLogScroll}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 [scrollbar-width:thin]"
      >
        {messages.length === 0 && !isAwaitingInput ? (
          <div className="flex h-full min-h-[14rem] flex-col items-center justify-center p-6 text-center">
            <Bot className="h-8 w-8 text-signal opacity-70" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold text-text">
              How can the Assistant help?
            </p>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-dim">
              Ask about metrics or inventory. Changes require plan approval; shell
              and file access stay off unless explicitly enabled.
            </p>
          </div>
        ) : null}

        {messages.map((msg) => (
          <article
            key={msg.id}
            className="mx-auto w-full min-w-0 max-w-3xl"
            aria-label={`${ROLE_LABELS[msg.role]} message`}
          >
            <div className="mb-1 flex items-baseline gap-2 text-[11px] text-dim">
              <span className="font-semibold uppercase tracking-[0.06em]">
                {ROLE_LABELS[msg.role]}
              </span>
              <time className="tnum" dateTime={msg.createdAt}>
                {new Date(msg.createdAt).toLocaleTimeString()}
              </time>
            </div>

            {msg.role === "user" ? (
              <div className="border border-line bg-raised/40 p-3">
                <AssistantMarkdown content={msg.content} />
              </div>
            ) : msg.role === "system" ? (
              <AssistantMarkdown content={msg.content} className="amd-quiet" />
            ) : (
              <AssistantMarkdown content={msg.content} />
            )}

            {msg.evidence && msg.evidence.length > 0 ? (
              <details className="group mt-1.5 border border-line bg-ink/30 text-xs">
                <summary className="flex cursor-pointer select-none items-center justify-between gap-2 p-2.5 font-medium text-dim transition-colors hover:bg-raised/40 hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal list-none [&::-webkit-details-marker]:hidden">
                  <span>
                    Observed evidence ({msg.evidence.length})
                  </span>
                  <ChevronDown
                    className="h-3.5 w-3.5 shrink-0 text-dim transition-transform duration-150 group-open:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <div className="space-y-2 border-t border-line p-2.5">
                  {msg.evidence.map((ev, i) => (
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
            ) : null}
          </article>
        ))}

        {/* Pending feedback while a task runs */}
        {isTaskRunning ? (
          <p className="flex items-center gap-2 text-xs text-dim">
            <LoaderCircle
              className="h-3.5 w-3.5 animate-spin text-signal"
              aria-hidden="true"
            />
            Assistant is working — execution details appear in the task inspector.
          </p>
        ) : null}

        {/* Clarification input when the task awaits operator input */}
        {isAwaitingInput ? (
          <div className="space-y-3 border border-info/40 bg-info/10 p-4">
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
                className="w-full resize-none border border-line bg-ink p-2 text-xs text-text placeholder:text-dim focus:border-signal focus:outline-none disabled:opacity-50"
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
      <div className="shrink-0 border-t border-line bg-panel p-3">
        <div className="relative mx-auto w-full max-w-3xl">
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
                    : "Ask the assistant or propose an operation (Shift+Enter for newline)..."
            }
            aria-label="Message"
            rows={3}
            maxLength={32768}
            className="w-full resize-none border border-line bg-ink p-3 pb-8 text-xs text-text placeholder:text-dim focus:border-signal focus:outline-none disabled:opacity-50 [scrollbar-width:thin]"
          />

          <div className="absolute bottom-2 right-2 flex items-center gap-2">
            {inputText.length > 0 ? <span className="tnum text-[10px] text-dim">
              {inputText.length.toLocaleString()}/32,768
            </span> : null}
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={() => void handleSend()}
              disabled={
                !inputText.trim() ||
                sending ||
                busy ||
                isTaskRunning ||
                !(aiEnabled && providerReady)
              }
              className="h-7 px-2.5 text-xs font-semibold"
            >
              {sending ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span className="ml-1.5">Send</span>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
