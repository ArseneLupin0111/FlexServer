import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CornerDownLeft,
  HelpCircle,
  Info,
  LoaderCircle,
  Send,
  User,
} from "lucide-react";
import { Button } from "../../ui/button";
import type {
  AiConversationMessage,
  AiConversationMessageEvidence,
  AiTask,
} from "../../../lib/ai-api";

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

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, activeTask?.state]);

  const isAwaitingInput = activeTask?.state === "awaiting_input";
  const clarificationPrompt = activeTask?.clarificationPrompt;

  const isTaskRunning =
    activeTask &&
    (activeTask.state === "planning" ||
      activeTask.state === "executing" ||
      activeTask.state === "verifying");

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

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handleClarificationKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSendClarification();
    }
  }

  return (
    <div className="flex h-full flex-col border border-line bg-panel">
      {/* Messages Timeline */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4 [scrollbar-width:thin]">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[16rem] flex-col items-center justify-center p-6 text-center">
            <Bot className="h-10 w-10 text-signal opacity-60" />
            <h2 className="mt-3 text-sm font-semibold text-text">
              How can the Assistant help?
            </h2>
            <p className="mt-1 max-w-md text-xs text-dim">
              Connect provider to use metrics/inventory. Changes require approval; shell/files advanced.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 text-xs ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              {msg.role !== "user" ? (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center border border-line bg-raised text-signal">
                  <Bot className="h-4 w-4" />
                </div>
              ) : null}

              <div
                className={`max-w-[85%] space-y-2 border p-3.5 ${
                  msg.role === "user"
                    ? "border-line bg-raised/50 text-text"
                    : msg.role === "system"
                      ? "border-line bg-ink/40 text-dim italic"
                      : "border-line bg-ink/70 text-text"
                }`}
              >
                <div className="flex items-center justify-between gap-3 text-[11px] text-dim">
                  <span className="font-semibold uppercase tracking-wider">
                    {msg.role === "user"
                      ? "Operator"
                      : msg.role === "system"
                        ? "System Notice"
                        : "Assistant"}
                  </span>
                  <span className="font-mono">
                    {new Date(msg.createdAt).toLocaleTimeString()}
                  </span>
                </div>

                <div className="whitespace-pre-wrap break-words text-xs leading-relaxed">
                  {msg.content}
                </div>

                {/* Evidence attachments */}
                {msg.evidence && msg.evidence.length > 0 ? (
                  <div className="mt-2 space-y-1.5 border-t border-line/60 pt-2">
                    <div className="text-[10px] uppercase tracking-wider text-dim">
                      Observed Evidence:
                    </div>
                    {msg.evidence.map((ev, i) => (
                      <div
                        key={i}
                        className="border border-line bg-panel p-2 font-mono text-[11px]"
                      >
                        <div className="flex items-center justify-between gap-2 text-text">
                          <span className="font-semibold">{ev.title}</span>
                          <span className="text-dim text-[10px]">
                            {ev.type} • {new Date(ev.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        {ev.data ? (
                          <pre className="mt-1 max-h-24 overflow-x-auto text-[10px] text-dim">
                            {JSON.stringify(ev.data, null, 2)}
                          </pre>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {msg.role === "user" ? (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center border border-line bg-raised text-text">
                  <User className="h-4 w-4" />
                </div>
              ) : null}
            </div>
          ))
        )}

        {/* Clarification Input Box if awaiting input */}
        {isAwaitingInput ? (
          <div className="border border-info/40 bg-info/10 p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-info">
              <HelpCircle className="h-4 w-4 shrink-0" />
              <span>Clarification Required</span>
            </div>
            <p className="text-xs text-text leading-relaxed">
              {clarificationPrompt ||
                "The assistant requires clarification before proceeding with the task."}
            </p>
            <div className="space-y-2">
              <textarea
                value={clarificationText}
                onChange={(e) => setClarificationText(e.target.value)}
                onKeyDown={handleClarificationKeyDown}
                placeholder="Type your clarification answer..."
                rows={2}
                disabled={sendingClarification || busy}
                className="w-full resize-none border border-line bg-ink p-2 text-xs text-text placeholder:text-dim focus:border-signal focus:outline-none"
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
                    <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CornerDownLeft className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Submit Answer
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <div ref={messagesEndRef} />
      </div>

      {/* Busy Task Notice */}
      {busyTaskId ? (
        <div className="flex items-center justify-between gap-3 border-t border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
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
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Chat error display */}
      {chatError ? (
        <div className="border-t border-crit/40 bg-crit/10 p-3 text-xs text-crit">
          {chatError}
        </div>
      ) : null}

      {/* Disabled / Provider Banner */}
      {!aiEnabled ? (
        <div className="border-t border-line bg-raised/30 p-3 text-xs text-dim">
          AI Assistant is explicitly disabled by policy on this VPS. Enable it in Settings to
          submit instructions.
        </div>
      ) : !providerReady ? (
        <div className="border-t border-line bg-raised/30 p-3 text-xs text-dim">
          Connect a provider (endpoint, model, and API key) in Settings to enable the Assistant.
        </div>
      ) : null}

      {/* Composer Input Area */}
      <div className="border-t border-line bg-panel p-3">
        <div className="relative">
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
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
            rows={3}
            maxLength={32768}
            className="w-full resize-none border border-line bg-ink p-3 pb-8 text-xs text-text placeholder:text-dim focus:border-signal focus:outline-none disabled:opacity-50 [scrollbar-width:thin]"
          />

          <div className="absolute bottom-2 right-2 flex items-center gap-2">
            <span className="font-mono text-[10px] text-dim">
              {inputText.length.toLocaleString()}/32,768
            </span>
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
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              <span className="ml-1.5">Send</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
