import { useState } from "react";
import {
  Clock,
  History,
  LoaderCircle,
  MessageSquare,
  Trash2,
} from "lucide-react";
import type { AiConversation } from "../../../lib/ai-api";

export type AssistantHistoryColumnProps = {
  conversations: AiConversation[];
  onSelectConversation: (conv: AiConversation) => void;
  onDeleteConversation: (convId: string) => Promise<void>;
  loading?: boolean;
  activeConversationId?: string | null;
};

export function AssistantHistoryColumn({
  conversations,
  onSelectConversation,
  onDeleteConversation,
  loading = false,
  activeConversationId,
}: AssistantHistoryColumnProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(convId: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (deletingId) return;
    setDeletingId(convId);
    try {
      await onDeleteConversation(convId);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <nav
      aria-label="Conversation history"
      className="flex h-full min-h-0 min-w-0 flex-col border border-line bg-panel"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <History className="h-3.5 w-3.5 text-signal" aria-hidden="true" />
        <span className="text-xs font-semibold uppercase tracking-wider text-dim">
          History
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-width:thin]">
        {loading ? (
          <div className="flex h-24 items-center justify-center text-xs text-dim">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin text-signal" aria-hidden="true" />
            <span>Loading…</span>
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex h-24 flex-col items-center justify-center px-3 text-center text-xs text-dim">
            <MessageSquare className="mb-2 h-6 w-6 text-dim/60" aria-hidden="true" />
            <p>No past conversations for this host.</p>
          </div>
        ) : (
          <ul className="space-y-1">
            {conversations.map((conv) => {
              const isActive = conv.id === activeConversationId;
              const isDeleting = deletingId === conv.id;

              return (
                <li key={conv.id}>
                  <div
                    onClick={() => onSelectConversation(conv)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectConversation(conv);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-current={isActive ? "true" : undefined}
                    className={`group flex cursor-pointer items-center justify-between gap-2 border p-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal ${
                      isActive
                        ? "border-signal/50 bg-raised/40"
                        : "border-transparent hover:bg-raised/30"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-text">
                        {conv.title || "Untitled session"}
                      </div>
                      <div className="tnum mt-0.5 flex items-center gap-1 text-[10px] text-dim">
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        <span>{new Date(conv.updatedAt).toLocaleDateString()}</span>
                        <span>{new Date(conv.updatedAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Delete conversation"
                      disabled={isDeleting}
                      onClick={(e) => void handleDelete(conv.id, e)}
                      className="p-1 text-dim opacity-0 transition-opacity hover:text-crit focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal group-hover:opacity-100"
                      title="Delete conversation"
                    >
                      {isDeleting ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin text-crit" aria-hidden="true" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
