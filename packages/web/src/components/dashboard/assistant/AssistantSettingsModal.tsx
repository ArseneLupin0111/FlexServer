import { useState, useEffect, useRef } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  HardDrive,
  Layers,
  LoaderCircle,
  Lock,
  RefreshCw,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";
import type {
  AiCapability,
  AiPolicy,
  AiProviderSettings,
  UpdateAiPolicy,
  UpdateAiSettings,
} from "../../../lib/ai-api";

export type AssistantSettingsModalProps = {
  open: boolean;
  onClose: () => void;
  vpsId: string;
  providerSettings: AiProviderSettings | null;
  policy: AiPolicy | null;
  capability: AiCapability | null;
  onSaveProviderSettings: (patch: UpdateAiSettings) => Promise<void>;
  onSavePolicy: (patch: UpdateAiPolicy) => Promise<void>;
  onCheckProvider: () => Promise<void>;
  busy?: boolean;
};

type ActiveTab = "provider" | "policy" | "capability";

export function AssistantSettingsModal({
  open,
  onClose,
  vpsId,
  providerSettings,
  policy,
  capability,
  onSaveProviderSettings,
  onSavePolicy,
  onCheckProvider,
  busy = false,
}: AssistantSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("provider");

  // Provider state
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerSuccess, setProviderSuccess] = useState<string | null>(null);

  // Check state
  const [checkingProvider, setCheckingProvider] = useState(false);
  const [checkResult, setCheckResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const checkRunIdRef = useRef(0);

  // Policy state
  const [aiEnabled, setAiEnabled] = useState(false);
  const [readEnabled, setReadEnabled] = useState(false);
  const [dockerEnabled, setDockerEnabled] = useState(false);
  const [composeEnabled, setComposeEnabled] = useState(false);
  const [shellEnabled, setShellEnabled] = useState(false);
  const [sendLogs, setSendLogs] = useState(false);
  const [sendFiles, setSendFiles] = useState(false);
  const [readScopesText, setReadScopesText] = useState("");
  const [writeScopesText, setWriteScopesText] = useState("");
  const [profilesText, setProfilesText] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policySuccess, setPolicySuccess] = useState<string | null>(null);

  // Sync state on open/load. A pending check belongs to the previous
  // lifecycle/config snapshot and must not repaint a result afterwards.
  useEffect(() => {
    checkRunIdRef.current += 1;
    setCheckResult(null);
    if (providerSettings) {
      setEndpoint(providerSettings.endpoint || "");
      setModel(providerSettings.model || "");
      setAllowPrivate(providerSettings.allowPrivateEndpoint === true);
      setApiKey("");
      setProviderError(null);
      setProviderSuccess(null);
    }
  }, [providerSettings, open]);
  // No late check response may land after unmount.
  useEffect(() => () => { checkRunIdRef.current += 1; }, []);
  useEffect(() => {
    if (open) {
      setActiveTab("provider");
    }
  }, [open]);


  useEffect(() => {
    if (policy) {
      setAiEnabled(policy.aiEnabled === true);
      setReadEnabled(policy.readEnabled === true);
      setDockerEnabled(policy.dockerActionsEnabled === true);
      setComposeEnabled(policy.composeActionsEnabled === true);
      setShellEnabled(policy.shellEnabled === true);
      setSendLogs(policy.sendLogsToProvider === true);
      setSendFiles(policy.sendFilesToProvider === true);
      setReadScopesText((policy.fileReadScopes || []).join("\n"));
      setWriteScopesText((policy.fileWriteScopes || []).join("\n"));
      setProfilesText((policy.serviceProfileIds || []).join("\n"));
      setPolicyError(null);
      setPolicySuccess(null);
    }
  }, [policy, open]);
  const hasExistingConnection = Boolean(
    providerSettings &&
      (providerSettings.hasApiKey ||
        (providerSettings.endpoint && providerSettings.endpoint.trim().length > 0)),
  );

  // Checks use saved settings only — never unsaved drafts or credentials.
  const savedConfigComplete = Boolean(
    providerSettings &&
      providerSettings.endpoint.trim().length > 0 &&
      providerSettings.model.trim().length > 0 &&
      providerSettings.hasApiKey === true,
  );
  const draftMatchesSaved = Boolean(
    providerSettings &&
      endpoint.trim() === providerSettings.endpoint.trim() &&
      model.trim() === providerSettings.model.trim() &&
      allowPrivate === (providerSettings.allowPrivateEndpoint === true) &&
      apiKey.trim().length === 0,
  );
  const canCheckProvider = savedConfigComplete && draftMatchesSaved;

  if (!open) return null;

  // Supersedes any in-flight check so a late response cannot repaint a stale result.
  function invalidateCheckResult() {
    checkRunIdRef.current += 1;
    setCheckResult(null);
  }

  async function handleSaveProvider() {
    if (savingProvider || busy) return;
    setSavingProvider(true);
    setProviderError(null);
    setProviderSuccess(null);
    invalidateCheckResult();
    try {
      const patch: UpdateAiSettings = {
        endpoint: endpoint.trim(),
        model: model.trim(),
        allowPrivateEndpoint: allowPrivate,
      };
      if (apiKey.trim().length > 0) {
        patch.apiKey = apiKey.trim();
      }
      await onSaveProviderSettings(patch);
      setApiKey("");
      setProviderSuccess("Global provider settings updated successfully.");
    } catch (err) {
      setProviderError(
        err instanceof Error ? err.message : "Failed to update provider settings.",
      );
    } finally {
      setSavingProvider(false);
    }
  }

  async function handleCheckProvider() {
    if (checkingProvider || busy || !canCheckProvider) return;
    const runId = ++checkRunIdRef.current;
    setCheckingProvider(true);
    setCheckResult(null);
    try {
      await onCheckProvider();
      if (checkRunIdRef.current !== runId) return;
      setCheckResult({
        ok: true,
        message: "Synthetic tool check succeeded. Endpoint is operational.",
      });
    } catch (err) {
      if (checkRunIdRef.current !== runId) return;
      setCheckResult({
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : "Synthetic tool check failed. Check endpoint and credentials.",
      });
    } finally {
      setCheckingProvider(false);
    }
  }

  async function handleSavePolicy() {
    if (savingPolicy || busy) return;
    setSavingPolicy(true);
    setPolicyError(null);
    setPolicySuccess(null);
    try {
      const readScopes = readScopesText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const writeScopes = writeScopesText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const serviceProfiles = profilesText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const patch: UpdateAiPolicy = {
        aiEnabled,
        readEnabled,
        dockerActionsEnabled: dockerEnabled,
        composeActionsEnabled: composeEnabled,
        shellEnabled,
        sendLogsToProvider: sendLogs,
        sendFilesToProvider: sendFiles,
        fileReadScopes: readScopes,
        fileWriteScopes: writeScopes,
        serviceProfileIds: serviceProfiles,
      };
      await onSavePolicy(patch);
      setPolicySuccess("VPS AI policy updated. Any pending plans were invalidated.");
    } catch (err) {
      setPolicyError(
        err instanceof Error ? err.message : "Failed to update VPS policy.",
      );
    } finally {
      setSavingPolicy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col border border-line bg-panel text-text shadow-none">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line p-4">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-signal" />
            <h2 className="text-base font-semibold text-text">
              AI Assistant Settings & Policy
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-dim hover:text-text p-1"
            title="Close dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-line bg-ink/40 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab("provider")}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 font-medium transition-colors ${
              activeTab === "provider"
                ? "border-signal bg-raised/30 text-signal font-semibold"
                : "border-transparent text-dim hover:text-text"
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            <span>Provider</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("policy")}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 font-medium transition-colors ${
              activeTab === "policy"
                ? "border-signal bg-raised/30 text-signal font-semibold"
                : "border-transparent text-dim hover:text-text"
            }`}
          >
            <Server className="h-3.5 w-3.5" />
            <span>Advanced permissions</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("capability")}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2.5 font-medium transition-colors ${
              activeTab === "capability"
                ? "border-signal bg-raised/30 text-signal font-semibold"
                : "border-transparent text-dim hover:text-text"
            }`}
          >
            <Cpu className="h-3.5 w-3.5" />
            <span>Host execution</span>
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-5 text-xs [scrollbar-width:thin]">
          {/* TAB 1: GLOBAL PROVIDER SETTINGS */}
          {activeTab === "provider" ? (
            <div className="space-y-4">
              <div className="border border-line bg-ink/40 p-3 text-xs text-dim">
                <span className="font-semibold text-text">Scope: System-Wide (All Hosts).</span>{" "}
                Configures the active LLM provider endpoint. API keys are write-only,
                encrypted on disk with dedicated AI keyring, and never returned in responses.
              </div>

              {providerSuccess ? (
                <div className="flex items-center gap-2 border border-signal/40 bg-signal/10 p-3 text-xs text-signal">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{providerSuccess}</span>
                </div>
              ) : null}

              {providerError ? (
                <div className="flex items-center gap-2 border border-crit/40 bg-crit/10 p-3 text-xs text-crit">
                  <XCircle className="h-4 w-4 shrink-0" />
                  <span>{providerError}</span>
                </div>
              ) : null}

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs text-text">Endpoint Base URL</Label>
                  <Input
                    type="url"
                    value={endpoint}
                    onChange={(e) => {
                      setEndpoint(e.target.value);
                      invalidateCheckResult();
                    }}
                    placeholder="https://api.openai.com"
                    className="h-8 font-mono text-xs"
                  />
                  <p className="text-[11px] text-dim">
                    OpenAI-compatible chat completion endpoint. Must be HTTPS for remote hosts.
                  </p>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-text">Model Identifier</Label>
                  <Input
                    type="text"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      invalidateCheckResult();
                    }}
                    placeholder="gpt-4o"
                    className="h-8 font-mono text-xs"
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-text">API Key</Label>
                    {providerSettings?.hasApiKey ? (
                      <span className="text-[11px] text-signal font-mono">
                        Key configured
                      </span>
                    ) : (
                      <span className="text-[11px] text-dim font-mono">
                        No key set
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    <Input
                      type={showApiKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        invalidateCheckResult();
                      }}
                      placeholder={
                        providerSettings?.hasApiKey
                          ? "•••••••••••••••••••••••• (Leave blank to keep current)"
                          : "Enter provider API key"
                      }
                      className="h-8 pr-8 font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2 top-2 text-dim hover:text-text"
                    >
                      {showApiKey ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between border border-line bg-ink/30 p-3">
                  <div className="space-y-0.5 pr-4">
                    <div className="text-xs font-semibold text-text">
                      Allow Private / Loopback Endpoint
                    </div>
                    <div className="text-[11px] text-dim">
                      Permits local staging loopback (127.0.0.1 / [::1]). Link-local and
                      cloud metadata (169.254.x.x) remain strictly blocked.
                    </div>
                  </div>
                  <Switch
                    checked={allowPrivate}
                    onCheckedChange={(next) => {
                      setAllowPrivate(next);
                      invalidateCheckResult();
                    }}
                    aria-label="Allow private endpoint"
                  />
                </div>
              </div>

              {/* Provider Check box */}
              <div className="border border-line bg-ink/30 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-text">
                      Synthetic Endpoint Verification
                    </div>
                    <div className="text-[11px] text-dim">
                      Sends a synthetic tool call without VPS context to verify provider credentials and protocol.
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={checkingProvider || busy || !canCheckProvider}
                    onClick={() => void handleCheckProvider()}
                    className="text-xs"
                  >
                    {checkingProvider ? (
                      <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Check Endpoint
                  </Button>
                </div>

                {!canCheckProvider ? (
                  <div className="text-[11px] text-warn">
                    {savedConfigComplete
                      ? "The check runs against the saved configuration, not this draft. Save your changes first (leave the API key blank to keep the stored key)."
                      : "A complete saved configuration (endpoint, model, and API key) is required before a check can run."}
                  </div>
                ) : null}

                {checkResult ? (
                  <div
                    className={`flex items-center gap-2 border p-2 text-[11px] ${
                      checkResult.ok
                        ? "border-signal/40 bg-signal/10 text-signal"
                        : "border-crit/40 bg-crit/10 text-crit"
                    }`}
                  >
                    {checkResult.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span>{checkResult.message}</span>
                  </div>
                ) : null}
              </div>

              <div className="flex justify-end pt-2">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={savingProvider || busy}
                  onClick={() => void handleSaveProvider()}
                  className="text-xs font-semibold"
                >
                  {savingProvider ? (
                    <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {hasExistingConnection ? "Update connection" : "Connect provider"}
                </Button>
              </div>
            </div>
          ) : null}

          {/* TAB 2: HOST POLICY & SCOPES */}
          {activeTab === "policy" ? (
            <div className="space-y-4">
              <div className="border border-line bg-ink/40 p-3 text-xs text-dim">
                <span className="font-semibold text-text">Scope: Per-VPS Isolation (Optional).</span>{" "}
                Controls tool invocation boundaries and egress disclosure for this host.
                Modifying policy immediately invalidates all active pending plans.
              </div>

              {policySuccess ? (
                <div className="flex items-center gap-2 border border-signal/40 bg-signal/10 p-3 text-xs text-signal">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{policySuccess}</span>
                </div>
              ) : null}

              {policyError ? (
                <div className="flex items-center gap-2 border border-crit/40 bg-crit/10 p-3 text-xs text-crit">
                  <XCircle className="h-4 w-4 shrink-0" />
                  <span>{policyError}</span>
                </div>
              ) : null}

              <div className="space-y-3">
                {/* Master Switch */}
                <div className="flex items-center justify-between border border-line bg-ink/30 p-3">
                  <div>
                    <div className="font-semibold text-text">Enable AI Assistant on VPS</div>
                    <div className="text-[11px] text-dim">
                      Master kill switch for assistant interaction with this host.
                    </div>
                  </div>
                  <Switch
                    checked={aiEnabled}
                    onCheckedChange={setAiEnabled}
                    aria-label="Enable AI Assistant on VPS"
                  />
                </div>

                {/* Tool Scopes */}
                <h3 className="text-xs font-semibold uppercase tracking-wider text-dim pt-2">
                  Tool Capability Permissions
                </h3>

                <div className="space-y-2">
                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div>
                      <div className="font-semibold text-text">Read-Only Tools</div>
                      <div className="text-[11px] text-dim">
                        Query metrics, inspect inventory, and read event histories.
                      </div>
                    </div>
                    <Switch
                      checked={readEnabled}
                      onCheckedChange={setReadEnabled}
                      aria-label="Read-only tools"
                    />
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div>
                      <div className="font-semibold text-text">Docker Mutation Tools</div>
                      <div className="text-[11px] text-dim">
                        Start, stop, restart, or inspect container state (requires exact approval).
                      </div>
                    </div>
                    <Switch
                      checked={dockerEnabled}
                      onCheckedChange={setDockerEnabled}
                      aria-label="Docker mutation tools"
                    />
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div>
                      <div className="font-semibold text-text">Compose Mutation Tools</div>
                      <div className="text-[11px] text-dim">
                        Deploy, update, or restart Compose stacks (requires exact approval).
                      </div>
                    </div>
                    <Switch
                      checked={composeEnabled}
                      onCheckedChange={setComposeEnabled}
                      aria-label="Compose mutation tools"
                    />
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div>
                      <div className="font-semibold text-text">Shell Execution Tools</div>
                      <div className="text-[11px] text-dim">
                        Run bounded commands in confined executor container (requires exact approval).
                      </div>
                    </div>
                    <Switch
                      checked={shellEnabled}
                      onCheckedChange={setShellEnabled}
                      aria-label="Shell execution tools"
                    />
                  </div>
                </div>

                {/* Data Egress */}
                <h3 className="text-xs font-semibold uppercase tracking-wider text-dim pt-2">
                  Data Egress Disclosures
                </h3>

                <div className="space-y-2">
                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div>
                      <div className="font-semibold text-text">Send Logs to Provider</div>
                      <div className="text-[11px] text-dim">
                        Permit redacted container log excerpts in context turns.
                      </div>
                    </div>
                    <Switch
                      checked={sendLogs}
                      onCheckedChange={setSendLogs}
                      aria-label="Send logs to provider"
                    />
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div>
                      <div className="font-semibold text-text">Send File Excerpts to Provider</div>
                      <div className="text-[11px] text-dim">
                        Permit text file inspection snippets within allowed paths.
                      </div>
                    </div>
                    <Switch
                      checked={sendFiles}
                      onCheckedChange={setSendFiles}
                      aria-label="Send files to provider"
                    />
                  </div>
                </div>

                {/* Path Scopes */}
                <h3 className="text-xs font-semibold uppercase tracking-wider text-dim pt-2">
                  Path & Profile Allowances
                </h3>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-text">File Read Path Scopes</Label>
                    <textarea
                      value={readScopesText}
                      onChange={(e) => setReadScopesText(e.target.value)}
                      placeholder="/etc/nginx&#10;/var/log"
                      rows={3}
                      className="w-full resize-none border border-line bg-ink p-2 font-mono text-xs text-text focus:border-signal focus:outline-none"
                    />
                    <p className="text-[10px] text-dim">One path prefix per line.</p>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-text">File Write Path Scopes</Label>
                    <textarea
                      value={writeScopesText}
                      onChange={(e) => setWriteScopesText(e.target.value)}
                      placeholder="/tmp&#10;/var/www"
                      rows={3}
                      className="w-full resize-none border border-line bg-ink p-2 font-mono text-xs text-text focus:border-signal focus:outline-none"
                    />
                    <p className="text-[10px] text-dim">Protected files remain rejected.</p>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-text">Authorized Service Profiles</Label>
                  <textarea
                    value={profilesText}
                    onChange={(e) => setProfilesText(e.target.value)}
                    placeholder="systemd&#10;docker"
                    rows={2}
                    className="w-full resize-none border border-line bg-ink p-2 font-mono text-xs text-text focus:border-signal focus:outline-none"
                  />
                  <p className="text-[10px] text-dim">
                    Named root-helper service profiles available to the assistant.
                  </p>
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={savingPolicy || busy}
                  onClick={() => void handleSavePolicy()}
                  className="text-xs font-semibold"
                >
                  {savingPolicy ? (
                    <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Save Host Policy
                </Button>
              </div>
            </div>
          ) : null}

          {/* TAB 3: HOST CAPABILITY */}
          {activeTab === "capability" ? (
            <div className="space-y-4">
              <div className="border border-line bg-ink/40 p-3 text-xs text-dim">
                <span className="font-semibold text-text">Host Confinement & Runtime Telemetry (Optional).</span>{" "}
                Reported by the installed agent daemon and verified before dispatching plan operations.
              </div>

              {capability ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between border border-line bg-panel p-3">
                    <span className="font-semibold text-text">Execution Support</span>
                    <Badge
                      variant="outline"
                      className={
                        capability.supported
                          ? "border-signal/40 bg-signal/10 text-signal font-semibold"
                          : "border-crit/40 bg-crit/10 text-crit font-semibold"
                      }
                    >
                      {capability.supported ? (
                        <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                      ) : (
                        <ShieldAlert className="mr-1 h-3.5 w-3.5" />
                      )}
                      {capability.supported ? "Supported" : "Unsupported"}
                    </Badge>
                  </div>

                  {capability.reason ? (
                    <div className="border border-line bg-ink/30 p-3 text-xs">
                      <div className="text-[11px] uppercase tracking-wider text-dim">
                        Reason:
                      </div>
                      <div className="mt-1 text-text">{capability.reason}</div>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <div className="border border-line bg-panel p-3">
                      <div className="text-[11px] text-dim">cgroup v2</div>
                      <div className="mt-1 font-mono font-semibold text-text">
                        {capability.cgroupV2Available ? "Available" : "Missing"}
                      </div>
                    </div>
                    <div className="border border-line bg-panel p-3">
                      <div className="text-[11px] text-dim">Namespaces</div>
                      <div className="mt-1 font-mono font-semibold text-text">
                        {capability.namespacesAvailable ? "Available" : "Missing"}
                      </div>
                    </div>
                    <div className="border border-line bg-panel p-3">
                      <div className="text-[11px] text-dim">Seccomp</div>
                      <div className="mt-1 font-mono font-semibold text-text">
                        {capability.seccompAvailable ? "Available" : "Missing"}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2 border border-line bg-panel p-3 font-mono text-xs">
                    <div className="flex justify-between">
                      <span className="text-dim">Protocol Version:</span>
                      <span className="text-text">{capability.protocolVersion}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-dim">Agent Version:</span>
                      <span className="text-text">{capability.agentVersion || "Unknown"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-dim">Rootfs Digest:</span>
                      <span className="text-text select-all">
                        {capability.rootfsDigest
                          ? `${capability.rootfsDigest.slice(0, 24)}…`
                          : "None"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-dim">Freshness:</span>
                      <span className="text-text">
                        {new Date(capability.freshness).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {capability.profiles && capability.profiles.length > 0 ? (
                    <div className="border border-line bg-panel p-3">
                      <div className="text-[11px] uppercase tracking-wider text-dim">
                        Available Service Profiles:
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {capability.profiles.map((p) => (
                          <span
                            key={p}
                            className="border border-line bg-raised/50 px-2 py-0.5 font-mono text-[11px] text-text"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="p-6 text-center text-xs text-dim">
                  Capability information not yet collected for this VPS.
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-line p-3">
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
