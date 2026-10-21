import { useState } from "react";
import {
  Clock,
  History,
  LoaderCircle,
  MessageSquare,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../../ui/button";
import type { AiConversation } from "../../../lib/ai-api";

export type AssistantHistoryDrawerProps = {
  open: boolean;
  onClose: () => void;
  conversations: AiConversation[];
  onSelectConversation: (conv: AiConversation) => void;
  onDeleteConversation: (convId: string) => Promise<void>;
  loading?: boolean;
  activeConversationId?: string | null;
};

export function AssistantHistoryDrawer({
  open,
  onClose,
  conversations,
  onSelectConversation,
  onDeleteConversation,
  loading = false,
  activeConversationId,
}: AssistantHistoryDrawerProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (!open) return null;

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
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/80">
      <div className="flex h-full w-full max-w-md flex-col border-l border-line bg-panel text-text shadow-none">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line p-4">
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-signal" />
            <h2 className="text-base font-semibold text-text">
              Assistant History
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-dim hover:text-text p-1"
            title="Close drawer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 [scrollbar-width:thin]">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-xs text-dim">
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin text-signal" />
              <span>Loading conversation history...</span>
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center text-center text-xs text-dim">
              <MessageSquare className="h-8 w-8 text-dim/60 mb-2" />
              <p>No past conversations found for this host.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {conversations.map((conv) => {
                const isActive = conv.id === activeConversationId;
                const isDeleting = deletingId === conv.id;

                return (
                  <div
                    key={conv.id}
                    onClick={() => {
                      onSelectConversation(conv);
                      onClose();
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectConversation(conv);
                        onClose();
                      }
                    }}
                    className={`group relative flex cursor-pointer flex-col gap-1.5 border p-3 text-xs transition-colors ${
                      isActive
                        ? "border-signal/50 bg-raised/40"
                        : "border-line bg-panel hover:bg-raised/20"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-text truncate">
                        {conv.title || "Untitled Session"}
                      </span>
                      <button
                        type="button"
                        aria-label="Delete conversation"
                        disabled={isDeleting}
                        onClick={(e) => void handleDelete(conv.id, e)}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 text-dim hover:text-crit transition-opacity"
                        title="Delete conversation"
                      >
                        {isDeleting ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-crit" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-dim">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        <span>{new Date(conv.updatedAt).toLocaleDateString()}</span>
                        <span>{new Date(conv.updatedAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-line p-3 text-right">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            className="text-xs"
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
