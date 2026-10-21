import {
  Activity,
  Bot,
  Clock,
  History,
  Layers,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import type {
  AiCapability,
  AiPolicy,
  AiProviderSettings,
  AiTask,
} from "../../../lib/ai-api";
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
  onRefresh?: () => void;
  refreshing?: boolean;
  onNewConversation?: () => void;
};

export function AssistantHeader({
  vps,
  providerSettings,
  policy,
  capability,
  activeTask,
  onOpenSettings,
  onOpenHistory,
  onRefresh,
  refreshing = false,
  onNewConversation,
}: AssistantHeaderProps) {
  const isSupported = capability?.supported === true;
  const hasProvider =
    providerSettings &&
    providerSettings.endpoint.length > 0 &&
    providerSettings.model.length > 0;

  const usage = activeTask?.usage;

  return (
    <header className="border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Host identity & status badges */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-signal" />
            <h1 className="text-base font-semibold tracking-tight text-text">
              AI Assistant
            </h1>
            <span className="text-xs text-dim">for {vpsDisplayName(vps)}</span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pl-2">
            {/* Capability badge */}
            {capability ? (
              <Badge
                variant="outline"
                className={
                  isSupported
                    ? "border-signal/40 bg-signal/10 text-signal"
                    : "border-crit/40 bg-crit/10 text-crit"
                }
                title={capability.reason || (isSupported ? "Execution supported" : "Execution unavailable")}
              >
                {isSupported ? (
                  <ShieldCheck className="mr-1 h-3 w-3" />
                ) : (
                  <ShieldAlert className="mr-1 h-3 w-3" />
                )}
                {isSupported ? "Supported" : "Unsupported"}
              </Badge>
            ) : null}

            {/* Provider model badge */}
            {hasProvider ? (
              <Badge
                variant="outline"
                className="border-line bg-raised/30 text-dim font-mono text-[11px]"
                title={`Endpoint: ${providerSettings.endpoint}`}
              >
                <Layers className="mr-1 h-3 w-3 text-text" />
                {providerSettings.model}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-warn/40 bg-warn/10 text-warn text-[11px]"
              >
                Provider Unconfigured
              </Badge>
            )}

            {/* Active task indicator */}
            {activeTask ? (
              <Badge
                variant="outline"
                className={
                  activeTask.state === "executing" || activeTask.state === "planning"
                    ? "border-signal/40 bg-signal/10 text-signal animate-pulse"
                    : activeTask.state === "awaiting_approval"
                      ? "border-warn/40 bg-warn/10 text-warn"
                      : activeTask.state === "uncertain"
                        ? "border-crit/40 bg-crit/10 text-crit"
                        : "border-line bg-raised/40 text-text"
                }
              >
                <Activity className="mr-1 h-3 w-3" />
                Task: {activeTask.state.replace("_", " ")}
              </Badge>
            ) : null}
          </div>
        </div>

        {/* Telemetry usage & action triggers */}
        <div className="flex flex-wrap items-center gap-2">
          {usage ? (
            <div
              className="flex items-center gap-3 border border-line bg-ink/50 px-3 py-1.5 font-mono text-xs text-dim"
              title={usage.estimated ? "Usage figures are conservative estimates" : "Exact provider usage"}
            >
              <div className="flex items-center gap-1.5">
                <Clock className="h-3 w-3 text-text" />
                <span>
                  Tokens:{" "}
                  <strong className="text-text font-normal">
                    {usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()} out
                    {usage.estimated ? " ~" : ""}
                  </strong>
                </span>
              </div>
              <span className="text-line">|</span>
              <span>
                Calls:{" "}
                <strong className="text-text font-normal">
                  {usage.toolCalls} ({usage.rounds} rds)
                </strong>
              </span>
            </div>
          ) : null}

          {onRefresh ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={refreshing}
              className="text-xs"
            >
              <RefreshCw
                className={`mr-1.5 h-3.5 w-3.5 ${
                  refreshing ? "animate-spin text-signal" : ""
                }`}
              />
              Refresh
            </Button>
          ) : null}

          {onNewConversation ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onNewConversation}
              className="text-xs"
            >
              <Bot className="mr-1.5 h-3.5 w-3.5" />
              New Chat
            </Button>
          ) : null}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenHistory}
            className="text-xs"
          >
            <History className="mr-1.5 h-3.5 w-3.5" />
            History
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenSettings}
            className="text-xs"
          >
            <Settings className="mr-1.5 h-3.5 w-3.5" />
            Settings
          </Button>
        </div>
      </div>
    </header>
  );
}
