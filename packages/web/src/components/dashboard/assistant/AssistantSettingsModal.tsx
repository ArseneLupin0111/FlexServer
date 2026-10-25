import { useState, useEffect, useRef } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Cpu,
  Download,
  Eye,
  EyeOff,
  Globe,
  LoaderCircle,
  Pencil,
  Plus,
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
  AiProviderProfile,
  ProviderProfileWrite,
  UpdateAiPolicy,
} from "../../../lib/ai-api";

export type AssistantSettingsModalProps = {
  open: boolean;
  onClose: () => void;
  vpsId: string;
  providers: AiProviderProfile[];
  policy: AiPolicy | null;
  capability: AiCapability | null;
  onCreateProvider: (body: ProviderProfileWrite) => Promise<void>;
  onUpdateProvider: (id: string, body: ProviderProfileWrite) => Promise<void>;
  onDeleteProvider: (id: string) => Promise<void>;
  onCheckProviderProfile: (id: string) => Promise<void>;
  onFetchProviderModels: (id: string) => Promise<void>;
  onSavePolicy: (patch: UpdateAiPolicy) => Promise<void>;
  busy?: boolean;
};

type ActiveTab = "provider" | "policy" | "capability";

type ProfileEditor =
  | { mode: "create" }
  | { mode: "edit"; profile: AiProviderProfile };

type RowAction = "check" | "fetch" | "toggle" | "delete";

function parseModelLines(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Row actions mutate the saved profile, so the write body is rebuilt from the
// public projection. Omitting apiKey keeps the stored key (blank keeps it).
function profileWriteFromProfile(
  profile: AiProviderProfile,
  enabled: boolean,
): ProviderProfileWrite {
  return {
    name: profile.name,
    endpoint: profile.endpoint,
    allowPrivateEndpoint: profile.allowPrivateEndpoint,
    models: profile.models,
    defaultModel: profile.defaultModel,
    enabled,
    isDefault: profile.isDefault,
  };
}

export function AssistantSettingsModal({
  open,
  onClose,
  vpsId,
  providers,
  policy,
  capability,
  onCreateProvider,
  onUpdateProvider,
  onDeleteProvider,
  onCheckProviderProfile,
  onFetchProviderModels,
  onSavePolicy,
  busy = false,
}: AssistantSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("provider");

  // Profile editor state
  const [editor, setEditor] = useState<ProfileEditor | null>(null);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [modelsText, setModelsText] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerSuccess, setProviderSuccess] = useState<string | null>(null);

  // Row action state
  const [rowBusy, setRowBusy] = useState<{ id: string; action: RowAction } | null>(
    null,
  );
  const [armDeleteId, setArmDeleteId] = useState<string | null>(null);
  const [checkResults, setCheckResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});
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

  // A new providers snapshot (or modal open) supersedes any in-flight per-row
  // check so a late response cannot repaint a stale result. Editor drafts and
  // success/error banners survive unrelated list refreshes.
  useEffect(() => {
    checkRunIdRef.current += 1;
    setCheckResults({});
    setArmDeleteId(null);
    if (open) {
      setEditor(null);
      setProviderError(null);
      setProviderSuccess(null);
    }
  }, [providers, open]);
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

  if (!open) return null;

  // Supersedes any in-flight check so a late response cannot repaint a stale result.
  function invalidateCheckResults() {
    checkRunIdRef.current += 1;
    setCheckResults({});
  }

  function openEditor(profile: AiProviderProfile | null) {
    setEditor(profile ? { mode: "edit", profile } : { mode: "create" });
    setArmDeleteId(null);
    setProviderError(null);
    setProviderSuccess(null);
    setShowApiKey(false);
    setApiKey("");
    if (profile) {
      setName(profile.name);
      setEndpoint(profile.endpoint);
      setModelsText(profile.models.join("\n"));
      setDefaultModel(profile.defaultModel ?? "");
      setAllowPrivate(profile.allowPrivateEndpoint);
      setEnabled(profile.enabled);
      setIsDefault(profile.isDefault);
    } else {
      setName("");
      setEndpoint("");
      setModelsText("");
      setDefaultModel("");
      setAllowPrivate(false);
      setEnabled(true);
      setIsDefault(false);
    }
  }

  async function handleSaveProvider() {
    if (savingProvider || busy || !editor) return;
    const trimmedName = name.trim();
    const trimmedEndpoint = endpoint.trim();
    const models = parseModelLines(modelsText);
    if (!trimmedName || !trimmedEndpoint || models.length === 0) {
      setProviderError("Name, endpoint, and at least one model are required.");
      return;
    }
    setSavingProvider(true);
    setProviderError(null);
    setProviderSuccess(null);
    invalidateCheckResults();
    try {
      const body: ProviderProfileWrite = {
        name: trimmedName,
        endpoint: trimmedEndpoint,
        allowPrivateEndpoint: allowPrivate,
        models,
        defaultModel: defaultModel.trim() || models[0],
        enabled,
        isDefault,
      };
      const key = apiKey.trim();
      if (key.length > 0) {
        body.apiKey = key;
      }
      if (editor.mode === "edit") {
        await onUpdateProvider(editor.profile.id, body);
      } else {
        await onCreateProvider(body);
      }
      setApiKey("");
      setProviderSuccess(
        editor.mode === "edit"
          ? "Provider profile updated."
          : "Provider profile created.",
      );
      setEditor(null);
    } catch (err) {
      setProviderError(
        err instanceof Error ? err.message : "Failed to save provider profile.",
      );
    } finally {
      setSavingProvider(false);
    }
  }

  // Checks always run against the saved profile row, never the editor draft.
  async function handleCheckProfile(profile: AiProviderProfile) {
    if (rowBusy || busy || !profile.hasApiKey) return;
    const runId = ++checkRunIdRef.current;
    setRowBusy({ id: profile.id, action: "check" });
    setProviderError(null);
    setProviderSuccess(null);
    setCheckResults((prev) => {
      if (!(profile.id in prev)) return prev;
      const next = { ...prev };
      delete next[profile.id];
      return next;
    });
    try {
      await onCheckProviderProfile(profile.id);
      if (checkRunIdRef.current !== runId) return;
      setCheckResults((prev) => ({
        ...prev,
        [profile.id]: {
          ok: true,
          message: "Provider check succeeded. Endpoint is operational.",
        },
      }));
    } catch (err) {
      if (checkRunIdRef.current !== runId) return;
      setCheckResults((prev) => ({
        ...prev,
        [profile.id]: {
          ok: false,
          message:
            err instanceof Error
              ? err.message
              : "Provider check failed. Check endpoint and credentials.",
        },
      }));
    } finally {
      setRowBusy((prev) =>
        prev && prev.id === profile.id && prev.action === "check" ? null : prev,
      );
    }
  }

  async function handleFetchModels(profile: AiProviderProfile) {
    if (rowBusy || busy || !profile.hasApiKey) return;
    setRowBusy({ id: profile.id, action: "fetch" });
    setProviderError(null);
    setProviderSuccess(null);
    try {
      await onFetchProviderModels(profile.id);
      setProviderSuccess(`Fetched the model list for ${profile.name}.`);
    } catch (err) {
      setProviderError(
        err instanceof Error ? err.message : "Failed to fetch provider models.",
      );
    } finally {
      setRowBusy((prev) =>
        prev && prev.id === profile.id && prev.action === "fetch" ? null : prev,
      );
    }
  }

  async function handleToggleEnabled(profile: AiProviderProfile) {
    if (rowBusy || busy) return;
    setRowBusy({ id: profile.id, action: "toggle" });
    setProviderError(null);
    setProviderSuccess(null);
    try {
      await onUpdateProvider(
        profile.id,
        profileWriteFromProfile(profile, !profile.enabled),
      );
    } catch (err) {
      setProviderError(
        err instanceof Error ? err.message : "Failed to update provider profile.",
      );
    } finally {
      setRowBusy((prev) =>
        prev && prev.id === profile.id && prev.action === "toggle" ? null : prev,
      );
    }
  }

  // Two-click arm-then-confirm; a profile referenced by conversations or
  // non-terminal tasks is rejected server-side and the reason is surfaced.
  async function handleDeleteProfile(profile: AiProviderProfile) {
    if (rowBusy || busy) return;
    if (armDeleteId !== profile.id) {
      setArmDeleteId(profile.id);
      return;
    }
    setRowBusy({ id: profile.id, action: "delete" });
    setProviderError(null);
    setProviderSuccess(null);
    try {
      await onDeleteProvider(profile.id);
      setArmDeleteId(null);
    } catch (err) {
      setArmDeleteId(null);
      setProviderError(
        err instanceof Error ? err.message : "Failed to delete provider profile.",
      );
    } finally {
      setRowBusy((prev) =>
        prev && prev.id === profile.id && prev.action === "delete" ? null : prev,
      );
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

  const editorModels = parseModelLines(modelsText);

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
            className="p-1 text-dim hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal"
            aria-label="Close settings"
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
          {/* TAB 1: PROVIDER PROFILES */}
          {activeTab === "provider" ? (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[11px] text-dim">
                  Applies to every host. Keys are encrypted at rest and never
                  displayed again.
                </p>
                {editor === null ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || rowBusy !== null}
                    onClick={() => openEditor(null)}
                    className="shrink-0 text-xs"
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add provider
                  </Button>
                ) : null}
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

              {editor === null ? (
                providers.length === 0 ? (
                  <div className="border border-line bg-ink/30 p-6 text-center text-xs text-dim">
                    No provider profiles yet. Add a provider to enable the
                    Assistant.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {providers.map((profile) => {
                      const rowCheck = checkResults[profile.id];
                      const rowAction = rowBusy?.id === profile.id ? rowBusy.action : null;
                      return (
                        <div
                          key={profile.id}
                          data-provider-id={profile.id}
                          className="border border-line bg-panel p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-xs font-semibold text-text">
                                  {profile.name}
                                </span>
                                {profile.isDefault ? (
                                  <Badge variant="ready">Default</Badge>
                                ) : null}
                                {!profile.enabled ? (
                                  <Badge variant="warning">Disabled</Badge>
                                ) : null}
                                {!profile.hasApiKey ? (
                                  <Badge variant="destructive">No key</Badge>
                                ) : null}
                              </div>
                              <div
                                className="truncate font-mono text-[11px] text-dim"
                                title={profile.endpoint}
                              >
                                {profile.endpoint}
                              </div>
                              <div className="text-[11px] text-dim">
                                {profile.models.length}{" "}
                                {profile.models.length === 1 ? "model" : "models"}
                                {profile.defaultModel
                                  ? ` · default ${profile.defaultModel}`
                                  : ""}
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={!profile.hasApiKey || busy || rowBusy !== null}
                                onClick={() => void handleCheckProfile(profile)}
                                aria-label={`Check provider ${profile.name}`}
                                title={
                                  profile.hasApiKey
                                    ? "Check the saved profile endpoint"
                                    : "Configure an API key first"
                                }
                                className="text-xs"
                              >
                                {rowAction === "check" ? (
                                  <LoaderCircle className="mr-1 h-3 w-3 animate-spin" />
                                ) : (
                                  <RefreshCw className="mr-1 h-3 w-3" />
                                )}
                                Check
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={!profile.hasApiKey || busy || rowBusy !== null}
                                onClick={() => void handleFetchModels(profile)}
                                aria-label={`Fetch models for ${profile.name}`}
                                title={
                                  profile.hasApiKey
                                    ? "Fetch the model list from the provider"
                                    : "Configure an API key first"
                                }
                                className="text-xs"
                              >
                                {rowAction === "fetch" ? (
                                  <LoaderCircle className="mr-1 h-3 w-3 animate-spin" />
                                ) : (
                                  <Download className="mr-1 h-3 w-3" />
                                )}
                                Fetch
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={busy || rowBusy !== null}
                                onClick={() => openEditor(profile)}
                                aria-label={`Edit ${profile.name}`}
                                className="text-xs"
                              >
                                <Pencil className="mr-1 h-3 w-3" />
                                Edit
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={busy || rowBusy !== null}
                                onClick={() => void handleToggleEnabled(profile)}
                                aria-label={`${profile.enabled ? "Disable" : "Enable"} provider ${profile.name}`}
                                className="text-xs"
                              >
                                {rowAction === "toggle" ? (
                                  <LoaderCircle className="mr-1 h-3 w-3 animate-spin" />
                                ) : null}
                                {profile.enabled ? "Disable" : "Enable"}
                              </Button>
                              {armDeleteId === profile.id ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={busy || rowBusy !== null}
                                  onClick={() => void handleDeleteProfile(profile)}
                                  aria-label={`Confirm delete ${profile.name}`}
                                  className="border-crit/40 text-xs text-crit hover:bg-crit/10"
                                >
                                  {rowAction === "delete" ? (
                                    <LoaderCircle className="mr-1 h-3 w-3 animate-spin" />
                                  ) : null}
                                  Confirm delete
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy || rowBusy !== null}
                                  onClick={() => void handleDeleteProfile(profile)}
                                  aria-label={`Delete provider ${profile.name}`}
                                  className="text-xs text-crit hover:bg-crit/10"
                                >
                                  Delete
                                </Button>
                              )}
                            </div>
                          </div>
                          {rowCheck ? (
                            <div
                              className={`mt-2 flex items-center gap-2 border p-2 text-[11px] ${
                                rowCheck.ok
                                  ? "border-signal/40 bg-signal/10 text-signal"
                                  : "border-crit/40 bg-crit/10 text-crit"
                              }`}
                            >
                              {rowCheck.ok ? (
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                              ) : (
                                <XCircle className="h-3.5 w-3.5 shrink-0" />
                              )}
                              <span>{rowCheck.message}</span>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )
              ) : (
                <div className="space-y-3 border border-line bg-ink/30 p-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-dim">
                      {editor.mode === "edit"
                        ? `Edit profile: ${editor.profile.name}`
                        : "New provider profile"}
                    </h3>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={savingProvider}
                      onClick={() => setEditor(null)}
                      className="text-xs"
                    >
                      Cancel
                    </Button>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-text">Name</Label>
                    <Input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Primary provider"
                      className="h-8 text-xs"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-text">Endpoint</Label>
                    <Input
                      type="url"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      placeholder="https://api.openai.com"
                      className="h-8 font-mono text-xs"
                    />
                    <p className="text-[11px] text-dim">
                      OpenAI-compatible. HTTPS for remote hosts.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-text">API key</Label>
                      {editor.mode === "edit" && editor.profile.hasApiKey ? (
                        <span className="font-mono text-[11px] text-signal">
                          Key configured
                        </span>
                      ) : null}
                    </div>
                    <div className="relative">
                      <Input
                        type={showApiKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={
                          editor.mode === "edit" && editor.profile.hasApiKey
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

                  <div className="space-y-1">
                    <Label className="text-xs text-text">Models</Label>
                    <textarea
                      value={modelsText}
                      onChange={(e) => setModelsText(e.target.value)}
                      placeholder={"gpt-4o\no4-mini"}
                      rows={4}
                      className="w-full resize-none border border-line bg-ink p-2 font-mono text-xs text-text focus:border-signal focus:outline-none"
                    />
                    <p className="text-[10px] text-dim">
                      One model name per line. Saved profiles can also fetch the
                      list from the provider.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-text">Default model</Label>
                    <Input
                      type="text"
                      value={defaultModel}
                      onChange={(e) => setDefaultModel(e.target.value)}
                      placeholder={editorModels[0] || "gpt-4o"}
                      className="h-8 font-mono text-xs"
                    />
                    <p className="text-[11px] text-dim">
                      Blank uses the first model.
                    </p>
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-3">
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
                      onCheckedChange={setAllowPrivate}
                      aria-label="Allow private endpoint"
                    />
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-3">
                    <div className="text-xs font-semibold text-text">Enabled</div>
                    <Switch
                      checked={enabled}
                      onCheckedChange={setEnabled}
                      aria-label="Provider enabled"
                    />
                  </div>

                  <div className="flex items-center justify-between border border-line bg-panel p-3">
                    <div className="space-y-0.5 pr-4">
                      <div className="text-xs font-semibold text-text">
                        Set as default
                      </div>
                      <div className="text-[11px] text-dim">
                        The default profile serves chats without an explicit
                        model pick.
                      </div>
                    </div>
                    <Switch
                      checked={isDefault}
                      onCheckedChange={setIsDefault}
                      aria-label="Set as default provider"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-1">
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
                      {editor.mode === "edit" ? "Save changes" : "Create provider"}
                    </Button>
                  </div>
                </div>
              )}
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
      </div>
    </div>
  );
}
