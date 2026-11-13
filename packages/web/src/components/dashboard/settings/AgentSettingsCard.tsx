import { useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Bot, TerminalSquare } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { Switch } from "../../ui/switch";
import { getVpsAiPolicy, patchVpsAiPolicy, type AiPolicy } from "../../../lib/ai-api";
import { DashboardContext } from "../../../context/DashboardContext";
import { freshnessLabel } from "../../../lib/dashboard-formatters";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function ToggleRow({ icon, title, description, actionLabel, testId, enabled, pending, disabled, onToggle, error }: {
  icon: ReactNode; title: string; description: string; actionLabel: string; testId: string;
  enabled: boolean; pending: boolean; disabled: boolean; onToggle: () => void; error: string | null;
}) {
  return <div className="p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2.5">{icon}<div className="min-w-0"><h3 className="text-sm font-semibold text-text">{title}</h3><p className="mt-0.5 text-xs text-dim">{description}</p></div></div><Switch checked={enabled} pending={pending} disabled={disabled} aria-label={`${enabled ? "Disable" : "Enable"} ${actionLabel}`} data-testid={testId} onCheckedChange={onToggle} /></div>{error ? <div role="alert" className="mt-3 flex items-start gap-2 border border-crit/40 bg-crit/10 p-3 text-[13px] text-crit"><AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /><span>{error}</span></div> : null}</div>;
}

export function AgentSettingsCard({ vpsId }: { vpsId: string }) {
  const [policy, setPolicy] = useState<AiPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [aiPending, setAiPending] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [shellPending, setShellPending] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const dashboard = useContext(DashboardContext);
  const systemAgent = dashboard?.systemInfo?.find((sys) => sys.vpsId === vpsId);

  const loadPolicy = useCallback(async (signal?: AbortSignal) => {
    try { setPolicy(await getVpsAiPolicy(vpsId, signal)); setPolicyError(null); }
    catch (err) { if (!signal?.aborted) setPolicyError(errorMessage(err, "AI policy is unavailable.")); }
  }, [vpsId]);

  useEffect(() => { const controller = new AbortController(); void loadPolicy(controller.signal); return () => controller.abort(); }, [loadPolicy]);
  useEffect(() => { const onFocus = () => void loadPolicy(); window.addEventListener("focus", onFocus); return () => window.removeEventListener("focus", onFocus); }, [loadPolicy]);

  const togglePolicyFlag = async (field: "aiEnabled" | "shellEnabled") => {
    if (!policy) return;
    const isAi = field === "aiEnabled";
    const pending = isAi ? aiPending : shellPending;
    const setPending = isAi ? setAiPending : setShellPending;
    const setError = isAi ? setAiError : setShellError;
    if (pending) return;
    setPending(true); setError(null);
    try { setPolicy(await patchVpsAiPolicy(vpsId, { [field]: !policy[field] })); setPolicyError(null); }
    catch (err) { setError(errorMessage(err, isAi ? "Failed to update the AI setting." : "Failed to update the shell setting.")); }
    finally { setPending(false); }
  };

  const disabled = policy === null;
  return <Card className="min-w-0 overflow-hidden" data-testid="agent-settings-card" data-policy-revision={policy?.revision ?? ""}>
    <CardHeader className="border-b border-line p-4 pb-3"><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>Agent</CardTitle><span className="border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-dim">This host</span></div></CardHeader>
    <CardContent className="divide-y divide-line p-0">
      {policyError ? <div className="p-4"><div role="alert" className="flex items-start gap-2 border border-crit/40 bg-crit/10 p-3 text-[13px] text-crit"><AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /><span>{policyError}</span></div></div> : null}
      <ToggleRow icon={<Bot size={16} className="shrink-0 text-dim" aria-hidden="true" />} title="AI assistant" description="Assistant chat, plans, and tools for this host." actionLabel="AI assistant" testId="agent-ai-toggle" enabled={policy?.aiEnabled === true} pending={aiPending} disabled={disabled} onToggle={() => void togglePolicyFlag("aiEnabled")} error={aiError} />
      <ToggleRow icon={<TerminalSquare size={16} className="shrink-0 text-dim" aria-hidden="true" />} title="Shell commands" description="Lets the assistant run shell commands; every command still needs your approval." actionLabel="AI shell commands" testId="agent-shell-toggle" enabled={policy?.shellEnabled === true} pending={shellPending} disabled={disabled} onToggle={() => void togglePolicyFlag("shellEnabled")} error={shellError} />
      <div className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-0"><h3 className="text-sm font-semibold text-text">Agent version</h3><p className="mt-0.5 text-xs text-dim" data-testid="agent-version-line">{systemAgent?.agentVersion ? <span className="font-medium text-text">v{systemAgent.agentVersion}</span> : "Not reported yet"}{systemAgent?.collectedAt ? <span className="ml-1.5">· last check {freshnessLabel(systemAgent.collectedAt)}</span> : null}</p></div></div>
    </CardContent>
  </Card>;
}
