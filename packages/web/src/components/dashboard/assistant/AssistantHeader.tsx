import { Bot, History, Layers, RefreshCw, Settings, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import type { AiCapability, AiPolicy, AiProviderSettings, AiTask } from "../../../lib/ai-api";
import type { VpsRecord } from "../../../lib/api";
import { vpsDisplayName } from "../../../lib/dashboard-formatters";

export type AssistantHeaderProps = {
  vps: VpsRecord;
  providerSettings: AiProviderSettings | null;
  policy: AiPolicy | null;
  capability: AiCapability | null;
  activeTask: AiTask | null;
  onOpenSettings: () => void;
  onOpenHistory: () => void;
  historyOpen?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  onNewConversation?: () => void;
};

export function AssistantHeader({
  vps,
  providerSettings,
  capability,
  onOpenSettings,
  onOpenHistory,
  historyOpen,
  onRefresh,
  refreshing = false,
  onNewConversation,
}: AssistantHeaderProps) {
  const supported = capability?.supported === true;
  const hasProvider = Boolean(providerSettings?.endpoint && providerSettings?.model);

  return (
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-4 py-1">
      <div className="min-w-0 space-y-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text">
          <Bot className="h-5 w-5 shrink-0 text-signal" aria-hidden="true" />
          <span>Assistant <span className="font-normal text-dim">for {vpsDisplayName(vps)}</span></span>
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-dim">
          {hasProvider && providerSettings ? (
            <span className="inline-flex min-w-0 items-center gap-1.5" title={providerSettings.model}>
              <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="break-all">{providerSettings.model}</span>
            </span>
          ) : <span className="text-warn">Provider not configured</span>}
          {capability ? (
            <Badge variant="outline" className="max-w-full border-line bg-transparent text-dim normal-case tracking-normal" title={capability.reason || (supported ? "Execution supported" : "Execution unavailable")}>
              {supported ? <ShieldCheck className="mr-1 h-3 w-3 shrink-0" /> : <ShieldAlert className="mr-1 h-3 w-3 shrink-0" />}
              {supported ? "Execution supported" : "Execution unavailable"}
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onNewConversation ? (
          <Button type="button" size="sm" onClick={onNewConversation} className="min-h-9 text-xs font-semibold">
            <Bot className="mr-1.5 h-3.5 w-3.5" />New Chat
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenHistory}
          aria-expanded={historyOpen}
          aria-controls="assistant-history-column"
          className="min-h-9 text-xs"
        >
          <History className="mr-1.5 h-3.5 w-3.5" />History
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onOpenSettings} className="min-h-9 text-xs">
          <Settings className="mr-1.5 h-3.5 w-3.5" />Settings
        </Button>
        {onRefresh ? (
          <Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing} aria-label="Refresh" title="Refresh assistant" className="h-9 w-9 px-0">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} />
          </Button>
        ) : null}
      </div>
    </header>
  );
}
