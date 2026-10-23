import { useState, useEffect, useRef } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  LoaderCircle,
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
            <span>Permissions</span>
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
            <span>Execution</span>
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-5 text-xs [scrollbar-width:thin]">
          {/* TAB 1: GLOBAL PROVIDER SETTINGS */}
          {activeTab === "provider" ? (
            <div className="space-y-4">
              <p className="text-[11px] text-dim">
                Applies to every host. Keys are encrypted at rest and never
                displayed again.
              </p>

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
                  <Label className="text-xs text-text">Endpoint</Label>
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
                    OpenAI-compatible. HTTPS for remote hosts.
                  </p>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-text">Model</Label>
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
                    <Label className="text-xs text-text">API key</Label>
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
                      aria-label={showApiKey ? "Hide API key" : "Show API key"}
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
                      Allow private endpoint
                    </div>
                    <div className="text-[11px] text-dim">
                      Loopback (127.0.0.1) allowed; cloud metadata IPs stay
                      blocked.
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

              {!canCheckProvider ? (
                <div className="flex items-start gap-1.5 text-[11px] text-warn">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {savedConfigComplete
                      ? "The check runs against the saved configuration — save your changes first."
                      : "A complete saved configuration (endpoint, model, and key) is required."}
                  </span>
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

              <div className="flex items-center justify-end gap-2 pt-1">
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
              <p className="text-[11px] text-dim">
                Applies to this host. Saving invalidates pending plans.
              </p>

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

              <div className="space-y-2">
                {/* Master Switch */}
                <div className="flex items-center justify-between border border-line bg-ink/30 p-3">
                  <div>
                    <div className="font-semibold text-text">Enable AI Assistant</div>
                    <div className="text-[11px] text-dim">
                      Turns the Assistant on or off for this host.
                    </div>
                  </div>
                  <Switch
                    checked={aiEnabled}
                    onCheckedChange={setAiEnabled}
                    aria-label="Enable AI Assistant on VPS"
                  />
                </div>

                <h3 className="pt-2 text-xs font-semibold uppercase tracking-wider text-dim">
                  Tools
                </h3>

                <div className="space-y-2">
                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div className="font-semibold text-text">Read-only inspection</div>
                    <Switch
                      checked={readEnabled}
                      onCheckedChange={setReadEnabled}
                      aria-label="Read-only tools"
                    />
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div className="font-semibold text-text">Docker actions</div>
                    <Switch
                      checked={dockerEnabled}
                      onCheckedChange={setDockerEnabled}
                      aria-label="Docker mutation tools"
                    />
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div className="font-semibold text-text">Compose actions</div>
                    <Switch
                      checked={composeEnabled}
                      onCheckedChange={setComposeEnabled}
                      aria-label="Compose mutation tools"
                    />
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div className="font-semibold text-text">Shell execution</div>
                    <Switch
                      checked={shellEnabled}
                      onCheckedChange={setShellEnabled}
                      aria-label="Shell execution tools"
                    />
                  </div>
                </div>

                <p className="text-[11px] text-dim">
                  Docker, Compose, and shell actions run only after you approve
                  the exact plan.
                </p>

                <h3 className="pt-2 text-xs font-semibold uppercase tracking-wider text-dim">
                  Data egress
                </h3>

                <div className="space-y-2">
                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div className="font-semibold text-text">Send logs to provider</div>
                    <Switch
                      checked={sendLogs}
                      onCheckedChange={setSendLogs}
                      aria-label="Send logs to provider"
                    />
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-2.5">
                    <div className="font-semibold text-text">
                      Send file contents to provider
                    </div>
                    <Switch
                      checked={sendFiles}
                      onCheckedChange={setSendFiles}
                      aria-label="Send files to provider"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-dim">
                  Both stay off unless enabled; content is redacted before it
                  leaves the API.
                </p>

                {/* Advanced scopes behind progressive disclosure */}
                <details className="group border border-line bg-panel">
                  <summary className="flex cursor-pointer select-none items-center justify-between p-2.5 font-semibold text-dim transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal list-none [&::-webkit-details-marker]:hidden">
                    <span>Path scopes &amp; service profiles</span>
                    <ChevronDown
                      className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-open:rotate-180"
                      aria-hidden="true"
                    />
                  </summary>
                  <div className="space-y-3 border-t border-line p-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label className="text-xs text-text">File read paths</Label>
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
                        <Label className="text-xs text-text">File write paths</Label>
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
                      <Label className="text-xs text-text">Service profiles</Label>
                      <textarea
                        value={profilesText}
                        onChange={(e) => setProfilesText(e.target.value)}
                        placeholder="systemd&#10;docker"
                        rows={2}
                        className="w-full resize-none border border-line bg-ink p-2 font-mono text-xs text-text focus:border-signal focus:outline-none"
                      />
                      <p className="text-[10px] text-dim">
                        Named root-helper profiles the assistant may manage.
                      </p>
                    </div>
                  </div>
                </details>
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
                  Save permissions
                </Button>
              </div>
            </div>
          ) : null}

          {/* TAB 3: HOST CAPABILITY */}
          {activeTab === "capability" ? (
            <div className="space-y-3">
              <p className="text-[11px] text-dim">Reported by the host agent.</p>

              {capability ? (
                <>
                  <div className="flex items-center justify-between border border-line bg-panel p-3">
                    <span className="font-semibold text-text">Execution support</span>
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
                    <div className="text-xs text-dim">{capability.reason}</div>
                  ) : null}

                  <div className="flex flex-wrap gap-x-5 gap-y-1.5 border border-line bg-panel p-3 text-xs">
                    <span className="text-dim">
                      cgroup v2{" "}
                      <span className="font-semibold text-text">
                        {capability.cgroupV2Available ? "available" : "missing"}
                      </span>
                    </span>
                    <span className="text-dim">
                      Namespaces{" "}
                      <span className="font-semibold text-text">
                        {capability.namespacesAvailable ? "available" : "missing"}
                      </span>
                    </span>
                    <span className="text-dim">
                      Seccomp{" "}
                      <span className="font-semibold text-text">
                        {capability.seccompAvailable ? "available" : "missing"}
                      </span>
                    </span>
                  </div>

                  <details className="group border border-line bg-panel">
                    <summary className="flex cursor-pointer select-none items-center justify-between p-2.5 font-semibold text-dim transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal list-none [&::-webkit-details-marker]:hidden">
                      <span>Runtime details</span>
                      <ChevronDown
                        className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-open:rotate-180"
                        aria-hidden="true"
                      />
                    </summary>
                    <div className="space-y-3 border-t border-line p-3 font-mono text-xs">
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-dim">Protocol</span>
                          <span className="text-text">{capability.protocolVersion}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-dim">Agent</span>
                          <span className="text-text">{capability.agentVersion || "Unknown"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-dim">Rootfs</span>
                          <span className="select-all text-text">
                            {capability.rootfsDigest
                              ? `${capability.rootfsDigest.slice(0, 24)}…`
                              : "None"}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-dim">Freshness</span>
                          <span className="text-text">
                            {new Date(capability.freshness).toLocaleString()}
                          </span>
                        </div>
                      </div>

                      {capability.profiles && capability.profiles.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5 font-sans">
                          {capability.profiles.map((p) => (
                            <span
                              key={p}
                              className="border border-line bg-raised/50 px-2 py-0.5 font-mono text-[11px] text-text"
                            >
                              {p}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </details>
                </>
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
