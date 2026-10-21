import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../ui/alert-dialog";
import {
  getVpsComposeApplication,
  listComposeOperations,
  listComposeRevisions,
  createComposePreview,
  getComposePreview,
  confirmComposePreview,
  requestComposeLifecycle,
  verifyComposeSource,
  adoptComposeApplication,
  unmanageComposeApplication,
  cancelComposeOperation,
  recheckComposeOperation,
  listComposeSecrets,
  setComposeSecret,
  deleteComposeSecret,
  listComposeRegistryCredentials,
  setComposeRegistryCredential,
  deleteComposeRegistryCredential,
  getVpsComposeOperation,
  optInComposeExternalControl,
  getComposeAdoptionPreview,
  updateComposeApplicationReadiness,
  loadComposeDraft,
  saveComposeDraft,
  clearComposeDraft,
  loadCachedComposeDetail,
  saveCachedComposeDetail,
  detectWildcardPortBindings,
  composeFinding,
  composeFindingKey,
  type ComposeAppDetail,
  type ComposeOperation,
  type ComposeRevisionMeta,
  type ComposePreview,
  type ComposeRegistryCredential,
  type ComposeUnsupportedField,
  type ComposeFindingLike,
  type ComposeAdoptionPreview,
  type ComposeSecretMeta,
  composeOperationIsActive,
  COMPOSE_STALE_PREVIEW_ERROR_CODES,
  vpsComposeModeLabel,
} from "../../../../lib/compose-applications";

type Phase =
  | { kind: "idle" }
  | { kind: "preview"; id: string; expiresAt?: string }
  | { kind: "operation"; id: string };

function variableNames(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([name]) => name)
      : [];
  } catch {
    return [];
  }
}

function validVariableObject(text: string): Record<string, string> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((x) => typeof x !== "string")
    ) {
      return null;
    }
    return value as Record<string, string>;
  } catch {
    return null;
  }
}

function stalePreviewMessage(code: string): string {
  const readable = code.replace(/_/g, " ");
  return `This preview no longer matches the observed state (${readable}). The draft is kept; validate again to obtain a fresh approval digest.`;
}

function parseAdoptionPreview(value: ComposeAdoptionPreview) {
  const differences: ComposeUnsupportedField[] = (value.differences ?? []).map((row) =>
    composeFinding(row as ComposeFindingLike),
  );
  const warnings: ComposeUnsupportedField[] = (value.warnings ?? []).map((row) =>
    composeFinding(row as ComposeFindingLike),
  );
  return {
    differences,
    warnings,
    runtimeReady: value.runtimeReady === true,
    digest: value.digest,
  };
}

export function ComposeApplicationDetail({
  vpsId,
  appId,
  onBack,
}: {
  vpsId: string;
  appId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<ComposeAppDetail | null>(null);
  const [operations, setOperations] = useState<ComposeOperation[]>([]);
  const [operationsCursor, setOperationsCursor] = useState<string | undefined>();
  const [loadingOlderOps, setLoadingOlderOps] = useState(false);
  const [revisions, setRevisions] = useState<ComposeRevisionMeta[]>([]);
  const [active, setActive] = useState<ComposeOperation | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [draftRestored, setDraftRestored] = useState(false);

  // Form states
  const [sourcePath, setSourcePath] = useState("");
  const [yaml, setYaml] = useState("");
  const [profileText, setProfileText] = useState("");
  const [credentialIds, setCredentialIds] = useState("");
  const [variableText, setVariableText] = useState("{}");
  const [secretNameToggles, setSecretNameToggles] = useState<string[]>([]);
  const [oneShotServices, setOneShotServices] = useState<string[]>([]);

  // Secrets & registry credentials
  const [secrets, setSecrets] = useState<ComposeSecretMeta[]>([]);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [registryCredentials, setRegistryCredentials] = useState<ComposeRegistryCredential[]>([]);
  const [registryHost, setRegistryHost] = useState("");
  const [registryUsername, setRegistryUsername] = useState("");
  const [registryPassword, setRegistryPassword] = useState("");
  const [registryCredentialId, setRegistryCredentialId] = useState("");

  // Readiness timeout state
  const [readinessInput, setReadinessInput] = useState("300");
  const [readinessSavedNotice, setReadinessSavedNotice] = useState<string | null>(null);

  // Operational states
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ComposePreview | null>(null);
  const [previewIssue, setPreviewIssue] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [redeploySeq, setRedeploySeq] = useState<number | null>(null);

  const requestGeneration = useRef(0);
  const scope = `${vpsId}\u0000${appId}`;
  const [loadedScope, setLoadedScope] = useState(scope);
  const currentScope = useRef(scope);
  currentScope.current = scope;

  // Track online/offline status
  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false);
      void load();
    };
    const handleOffline = () => {
      setIsOffline(true);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Autosave draft on edits (excluding secret values)
  useEffect(() => {
    if (yaml || profileText || credentialIds || variableText !== "{}" || oneShotServices.length) {
      saveComposeDraft(vpsId, appId, {
        yaml,
        variableText,
        profileText,
        credentialIds,
        oneShotServices,
        secretNameToggles,
      });
    }
  }, [vpsId, appId, yaml, variableText, profileText, credentialIds, oneShotServices, secretNameToggles]);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (!navigator.onLine) {
      const cached = loadCachedComposeDetail(vpsId, appId);
      if (cached) {
        setDetail(cached.detail);
        setOperations(cached.operations);
        setReadinessInput(String(cached.detail.readinessSeconds ?? 300));
        setIsOffline(true);
        setLoadedScope(scope);
        return;
      }
    }

    try {
      const [app, ops, revs, secretList, registryList] = await Promise.all([
        getVpsComposeApplication(vpsId, appId),
        listComposeOperations(vpsId, appId),
        listComposeRevisions(vpsId, appId),
        listComposeSecrets(vpsId, appId),
        listComposeRegistryCredentials(vpsId),
      ]);
      if (generation !== requestGeneration.current) return;
      setDetail(app);
      setOperations(ops.items);
      setOperationsCursor(ops.nextCursor);
      setRevisions(revs.items);
      setSecrets(secretList);
      setRegistryCredentials(registryList);
      setReadinessInput(String(app.readinessSeconds ?? 300));
      setIsOffline(false);
      saveCachedComposeDetail(vpsId, appId, app, ops.items);

      const currentActive = ops.items.find((op) => composeOperationIsActive(op.status));
      setActive(currentActive);
      if (currentActive) setPhase({ kind: "operation", id: currentActive.id });
      setLoadedScope(scope);
    } catch (e) {
      if (generation !== requestGeneration.current) return;
      const cached = loadCachedComposeDetail(vpsId, appId);
      if (cached) {
        setDetail(cached.detail);
        setOperations(cached.operations);
        setReadinessInput(String(cached.detail.readinessSeconds ?? 300));
        setIsOffline(true);
        setError(null);
        setLoadedScope(scope);
      } else {
        setError(e instanceof Error ? e.message : "Unable to load application.");
      }
    }
  }, [vpsId, appId, scope]);

  useEffect(() => {
    requestGeneration.current++;
    setDetail(null);
    setOperations([]);
    setOperationsCursor(undefined);
    setRevisions([]);
    setActive(undefined);
    setPreview(null);
    setPreviewIssue(null);
    setPhase({ kind: "idle" });
    setError(null);
    setRedeploySeq(null);
    setSourcePath("");
    setYaml("");
    setProfileText("");
    setCredentialIds("");
    setVariableText("{}");
    setSecretName("");
    setSecretValue("");
    setRegistryHost("");
    setRegistryUsername("");
    setRegistryPassword("");
    setRegistryCredentialId("");
    setSecretNameToggles([]);
    setOneShotServices([]);
    setDraftRestored(false);

    // Restore the pending local draft for this application, if any. Drafts
    // never contain secret values, so they are safe to persist in session
    // storage and replay into the editors after the reset above.
    const draft = loadComposeDraft(vpsId, appId);
    if (draft) {
      setYaml(draft.yaml ?? "");
      setVariableText(draft.variableText ?? "{}");
      setProfileText(draft.profileText ?? "");
      setCredentialIds(draft.credentialIds ?? "");
      setOneShotServices(draft.oneShotServices ?? []);
      setSecretNameToggles(draft.secretNameToggles ?? []);
      setDraftRestored(
        Boolean(draft.yaml || draft.profileText || draft.credentialIds) ||
          draft.variableText !== "{}" ||
          (draft.oneShotServices?.length ?? 0) > 0,
      );
    }

    void load();
    return () => {
      requestGeneration.current++;
    };
  }, [load, scope]);

  useEffect(() => {
    if (phase.kind === "idle" || isOffline) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled || document.hidden) return;
      void (async () => {
        try {
          if (phase.kind === "preview") {
            const current = await getComposePreview(vpsId, appId, phase.id);
            if (cancelled) return;
            setPreview(current);
            if (current.status !== "pending" && current.status !== "claimed") {
              setPhase({ kind: "idle" });
              if (current.status !== "ready") {
                setPreviewIssue(`Preview is ${current.status}. Create a fresh preview before approval.`);
              }
            } else if (phase.expiresAt && Date.now() >= Date.parse(phase.expiresAt)) {
              setPhase({ kind: "idle" });
              setPreviewIssue("Preview validation is still pending beyond its expiry window. Create a fresh preview before approval.");
            }
          } else {
            const current = await getVpsComposeOperation(vpsId, phase.id);
            if (cancelled) return;
            setOperations((items) => items.map((item) => (item.id === current.id ? current : item)));
            setActive(composeOperationIsActive(current.status) ? current : undefined);
            if (!composeOperationIsActive(current.status)) {
              setPhase({ kind: "idle" });
              await load();
            }
          }
        } catch (e) {
          if (!cancelled) {
            setPhase({ kind: "idle" });
            setError(e instanceof Error ? e.message : "Unable to refresh operation status.");
          }
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, vpsId, appId, load, isOffline]);

  async function perform(fn: () => Promise<unknown>) {
    if (busy || isOffline) return;
    if (currentScope.current !== scope) return;
    const scopeGeneration = requestGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (currentScope.current !== scope || requestGeneration.current !== scopeGeneration) return;
      if (result && typeof result === "object" && "id" in result && "status" in result && "kind" in result) {
        const operation = result as ComposeOperation;
        setOperations((items) => [operation, ...items.filter((item) => item.id !== operation.id)]);
        if (composeOperationIsActive(operation.status)) {
          setActive(operation);
          setPhase({ kind: "operation", id: operation.id });
        }
      }
      await load();
    } catch (e) {
      if (currentScope.current !== scope || requestGeneration.current !== scopeGeneration) return;
      if (
        e !== null &&
        typeof e === "object" &&
        "code" in e &&
        typeof e.code === "string" &&
        (COMPOSE_STALE_PREVIEW_ERROR_CODES as readonly string[]).includes(e.code)
      ) {
        setPreviewIssue(stalePreviewMessage(e.code));
      } else {
        setError(e instanceof Error ? e.message : "The request could not be completed.");
      }
    } finally {
      if (currentScope.current === scope && requestGeneration.current === scopeGeneration) {
        setBusy(false);
      }
    }
  }

  async function makePreview(seq?: number) {
    if (currentScope.current !== scope || isOffline) return;
    const variables = validVariableObject(variableText);
    if (variables === null) {
      setError("Variables must be a JSON object containing string values.");
      return;
    }
    const scopeGeneration = requestGeneration.current;
    await perform(async () => {
      const created = await createComposePreview(vpsId, appId, {
        composeYaml: yaml,
        revisionSeq: seq,
        variables: { nonSecretValues: variables, secretNameToggles },
        profiles: profileText
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        registryCredentialIds: credentialIds
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        oneShotServices,
      });
      if (currentScope.current !== scope || requestGeneration.current !== scopeGeneration) return;
      const latest = await getComposePreview(vpsId, appId, created.previewId);
      if (currentScope.current !== scope || requestGeneration.current !== scopeGeneration) return;
      setPreview(latest);
      setPreviewIssue(null);
      setPhase(
        latest.status === "pending" || latest.status === "claimed"
          ? { kind: "preview", id: created.previewId, expiresAt: latest.expiresAt }
          : { kind: "idle" },
      );
      if (seq !== undefined) {
        setRedeploySeq(null);
        setYaml("");
      }
    });
  }

  async function handleLoadOlderOperations() {
    if (!operationsCursor || loadingOlderOps || isOffline) return;
    setLoadingOlderOps(true);
    try {
      const older = await listComposeOperations(vpsId, appId, { cursor: operationsCursor });
      setOperations((prev) => {
        const existingIds = new Set(prev.map((o) => o.id));
        const added = older.items.filter((o) => !existingIds.has(o.id));
        return [...prev, ...added];
      });
      setOperationsCursor(older.nextCursor);
    } catch {
      // Ignore cursor pagination error
    } finally {
      setLoadingOlderOps(false);
    }
  }

  async function handleSaveReadiness() {
    const val = Number(readinessInput);
    if (Number.isNaN(val) || val < 30 || val > 3600 || isOffline) return;
    await perform(async () => {
      const updated = await updateComposeApplicationReadiness(vpsId, appId, val);
      setDetail(updated);
      setReadinessSavedNotice("Readiness timeout updated.");
      setTimeout(() => setReadinessSavedNotice(null), 3000);
    });
  }

  function handleDiscardDraft() {
    clearComposeDraft(vpsId, appId);
    setYaml("");
    setVariableText("{}");
    setProfileText("");
    setCredentialIds("");
    setOneShotServices([]);
    setSecretNameToggles([]);
    setDraftRestored(false);
  }

  if (!detail || loadedScope !== scope) {
    return (
      <section className="space-y-3 border border-line bg-panel p-4" aria-label="Application details">
        <Button size="sm" variant="outline" onClick={onBack}>
          Back to applications
        </Button>
        <p role={error ? "alert" : "status"} className="text-sm text-dim">
          {error ?? "Loading application…"}
        </p>
      </section>
    );
  }

  const manageable = detail.mode === "managed" || detail.mode === "external_control";
  const variableNameList = variableNames(variableText);
  const observedOneShot = (detail.observed?.services ?? [])
    .filter((service) => service.kind === "oneshot")
    .map((service) => service.service);
  const selectedOneShot = Array.from(
    new Set([
      ...observedOneShot.filter((name) => oneShotServices.includes(name)),
      ...oneShotServices.filter((name) => !observedOneShot.includes(name)),
    ]),
  ).sort();
  const replaceTarget = registryCredentialId
    ? registryCredentials.find((credential) => credential.id === registryCredentialId)
    : undefined;

  return (
    <section
      className="min-w-0 space-y-4 border border-line bg-panel p-4"
      aria-label={`${detail.displayName} application details`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
        <div>
          <Button size="sm" variant="outline" onClick={onBack}>
            Back to applications
          </Button>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{detail.displayName}</h3>
            <span className="rounded border border-line bg-raised px-2 py-0.5 text-xs text-dim">
              {vpsComposeModeLabel(detail.mode)}
            </span>
            {detail.projectName !== detail.displayName ? (
              <span className="text-xs text-dim">Project: {detail.projectName}</span>
            ) : null}
            {detail.daemonEpoch ? (
              <span className="text-xs text-dim" title="Daemon epoch">
                Epoch: {detail.daemonEpoch.slice(0, 8)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(["start", "stop", "restart"] as const).map((action) => (
            <Button
              key={action}
              size="sm"
              variant="outline"
              disabled={!manageable || !!active || busy || isOffline}
              onClick={() => void perform(() => requestComposeLifecycle(vpsId, appId, action))}
            >
              {action[0].toUpperCase() + action.slice(1)}
            </Button>
          ))}

          {manageable ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" disabled={!!active || busy || isOffline}>
                  Unmanage
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Unmanage application</AlertDialogTitle>
                  <AlertDialogDescription>
                    Unmanaging this application stops FlexServer management while preserving all running host workloads. Running containers, named volumes, networks, and host files are NOT stopped or removed. The application will revert to detected read-only mode.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={busy || isOffline}
                    onClick={() => void perform(() => unmanageComposeApplication(vpsId, appId))}
                  >
                    Confirm unmanage
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </header>

      {/* Offline banner */}
      {isOffline ? (
        <div role="status" className="border border-line bg-raised p-3 text-xs text-dim">
          <strong className="text-text">Offline mode:</strong> Displaying cached application state and local draft. Live mutations and command queueing are disabled until reconnection.
        </div>
      ) : null}

      {/* Draft restored notice */}
      {draftRestored ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 border border-line bg-raised p-2 text-xs text-dim">
          <span>Local draft restored from session storage. Secret values are never stored in drafts.</span>
          <Button size="sm" variant="outline" onClick={handleDiscardDraft}>
            Discard draft
          </Button>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-sm text-crit">{error}</p> : null}

      {previewIssue ? (
        <div role="alert" className="space-y-1 border border-warn bg-raised p-3 text-xs text-warn">
          <p>{previewIssue}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || isOffline}
            onClick={() => {
              setPreviewIssue(null);
              setSecretValue("");
              setRegistryPassword("");
              void makePreview();
            }}
          >
            Refresh preview
          </Button>
        </div>
      ) : null}

      {preview ? (
        <PreviewPanel
          preview={preview}
          busy={busy}
          isOffline={isOffline}
          yamlText={yaml}
          onDeploy={(removedServiceIds) => {
            setSecretValue("");
            setRegistryPassword("");
            void perform(() =>
              confirmComposePreview(vpsId, appId, preview.id, {
                approvedDigest: preview.digest ?? "",
                removedServiceIds,
              }),
            );
          }}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Observed Services */}
        <section className="space-y-2">
          <h4 className="text-sm font-semibold">Observed services</h4>
          {detail.observed?.services?.length ? (
            detail.observed.services.map((service) => (
              <div key={service.service} className="border border-line p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium">{service.service}</p>
                  <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-dim">
                    {service.kind === "oneshot" ? "One-shot job" : "Long-lived service"}
                  </span>
                </div>
                {service.replicas?.length && detail.agentInstanceId ? (
                  <div className="mt-1 flex flex-wrap gap-2">
                    {service.replicas.map((replica) => (
                      <Link
                        key={replica.containerKey}
                        className="text-xs underline"
                        to={`/vps/${encodeURIComponent(vpsId)}/docker/containers/${encodeURIComponent(
                          detail.agentInstanceId!,
                        )}/${encodeURIComponent(replica.containerKey)}`}
                        title="Open container investigation"
                      >
                        {replica.containerKey} · {replica.state}
                        {replica.health ? ` (${replica.health})` : ""}
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-dim">No running container replicas reported.</p>
                )}
              </div>
            ))
          ) : (
            <p className="text-xs text-dim">No observed services reported in project scan.</p>
          )}
        </section>

        {/* Operation History Timeline */}
        <section className="space-y-2" aria-label="Operation history">
          <h4 className="text-sm font-semibold">Operations</h4>
          {operations.length ? (
            operations.map((op) => (
              <div key={op.id} className="space-y-1.5 border border-line p-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-text">
                    {op.kind} · <span className={op.status === "succeeded" ? "text-signal" : op.status === "failed" ? "text-crit" : op.status === "uncertain" ? "text-warn" : "text-dim"}>{op.status}</span>
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {composeOperationIsActive(op.status) &&
                    !op.authorization &&
                    op.status !== "applying" &&
                    op.status !== "uncertain" &&
                    !op.mutationStarted ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || isOffline}
                        onClick={() => void perform(() => cancelComposeOperation(vpsId, appId, op.id))}
                      >
                        Cancel
                      </Button>
                    ) : null}
                    {op.status === "uncertain" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || isOffline}
                        onClick={() => void perform(() => recheckComposeOperation(vpsId, appId, op.id))}
                      >
                        Recheck
                      </Button>
                    ) : null}
                  </div>
                </div>

                {/* Metadata row */}
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dim">
                  <span>Triggered by: {op.actor ? `${op.actor.kind}${op.actor.id ? ` · ${op.actor.id}` : ""}` : "Operator"}</span>
                  <span>Created: {new Date(op.createdAt).toLocaleString()}</span>
                  {op.mutationStarted ? (
                    <span className="text-warn">
                      {op.mutationStartedAt
                        ? `Mutation started at ${new Date(op.mutationStartedAt).toLocaleTimeString()}`
                        : "Mutation started"}
                    </span>
                  ) : (
                    <span>Pre-mutation phase</span>
                  )}
                  {op.revisionSeq ? <span>Revision #{op.revisionSeq}</span> : null}
                  {op.approvedDigest ? (
                    <span title={op.approvedDigest}>Digest: {op.approvedDigest.slice(0, 12)}…</span>
                  ) : null}
                </div>

                {/* Progress stages */}
                {op.progress?.items?.length ? (
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                    {op.progress.items.map((item) => (
                      <span
                        key={item.stage}
                        className="rounded border border-line bg-raised px-1 py-0.5 text-dim"
                      >
                        {item.stage}: {item.status}
                        {item.reason ? ` (${item.reason})` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}

                {/* Outcomes */}
                {op.result?.outcome ? (
                  <p className="mt-1 text-[11px] font-medium text-text">
                    Outcome: <span className="font-mono">{op.result.outcome}</span>
                    {op.result.installPerformed !== undefined ? (
                      <span className="ml-2 font-normal text-dim">
                        (runtime {op.result.installPerformed ? "installed" : "reused"})
                      </span>
                    ) : null}
                  </p>
                ) : null}

                {op.result?.serviceOutcomes?.length ? (
                  <div className="space-y-0.5 text-[11px] text-dim">
                    <p className="font-medium text-text">Service outcomes:</p>
                    {op.result.serviceOutcomes.map((so) => (
                      <p key={so.service}>
                        <span className="font-medium text-text">{so.service}</span>: {so.outcome}
                        {so.reason ? ` (${so.reason})` : ""}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <p className="text-xs text-dim">No operations recorded yet.</p>
          )}

          {operationsCursor ? (
            <Button
              size="sm"
              variant="outline"
              disabled={loadingOlderOps || isOffline}
              onClick={() => void handleLoadOlderOperations()}
              className="w-full"
            >
              {loadingOlderOps ? "Loading older operations…" : "Load older operations"}
            </Button>
          ) : null}
        </section>
      </div>

      {/* Revisions */}
      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Revisions</h4>
        {revisions.map((rev) => (
          <div key={rev.seq} className="flex flex-wrap items-center justify-between gap-2 border border-line p-2 text-xs">
            <span>Revision {rev.seq} · {new Date(rev.createdAt).toLocaleString()}</span>
            {manageable && rev.seq !== detail.latestRevisionSeq ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !!active || isOffline || !validVariableObject(variableText)}
                onClick={() => {
                  setRedeploySeq(rev.seq);
                  setPreview(null);
                  setPreviewIssue(`Preparing a new preview from revision ${rev.seq}. It will not deploy until you approve it.`);
                }}
              >
                Prepare redeploy preview
              </Button>
            ) : null}
          </div>
        ))}
      </section>

      {/* Compose Configuration & Editor */}
      {manageable ? (
        <section className="space-y-3 border-t border-line pt-3">
          <h4 className="text-sm font-semibold">Compose configuration</h4>

          {/* Configurable readiness */}
          <div className="flex flex-wrap items-end gap-3 border border-line p-3">
            <div className="space-y-1">
              <Label htmlFor={`compose-readiness-${appId}`} className="text-xs font-medium">
                Readiness timeout (seconds)
              </Label>
              <Input
                id={`compose-readiness-${appId}`}
                type="number"
                min={30}
                max={3600}
                value={readinessInput}
                onChange={(e) => {
                  setReadinessInput(e.target.value);
                  setReadinessSavedNotice(null);
                }}
                className="w-32 min-h-9 text-xs"
                aria-label="Readiness timeout in seconds"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                isOffline ||
                Number.isNaN(Number(readinessInput)) ||
                Number(readinessInput) < 30 ||
                Number(readinessInput) > 3600 ||
                Number(readinessInput) === (detail.readinessSeconds ?? 300)
              }
              onClick={() => void handleSaveReadiness()}
            >
              Save readiness
            </Button>
            {readinessSavedNotice ? (
              <span role="status" className="text-xs text-signal font-medium">
                {readinessSavedNotice}
              </span>
            ) : null}
            <p className="w-full text-[11px] text-dim">
              Allowed range: 30 to 3600 seconds (default: 300s). Defines maximum duration allowed for containers and health checks to reach ready status during deployment.
            </p>
          </div>

          {redeploySeq !== null ? (
            <p className="text-xs text-warn">
              Preparing a new preview for revision {redeploySeq}; no deployment has started.{" "}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setRedeploySeq(null);
                  setPreviewIssue(null);
                }}
              >
                Cancel
              </Button>{" "}
              <Button
                size="sm"
                disabled={busy || isOffline || !validVariableObject(variableText)}
                onClick={() => {
                  setSecretValue("");
                  setRegistryPassword("");
                  void makePreview(redeploySeq);
                }}
              >
                Create preview
              </Button>
            </p>
          ) : (
            <>
              <div className="space-y-1">
                <Label htmlFor={`compose-yaml-${appId}`} className="text-xs font-medium">
                  Compose YAML
                </Label>
                <textarea
                  id={`compose-yaml-${appId}`}
                  aria-label="Compose YAML"
                  className="min-h-40 w-full border border-line bg-panel p-2 font-mono text-xs text-text placeholder:text-dim"
                  value={yaml}
                  onChange={(e) => setYaml(e.target.value)}
                  placeholder={"services:\n  web:\n    image: nginx:latest\n    ports:\n      - 80:80"}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor={`compose-variables-${appId}`} className="text-xs font-medium">
                  Variables (JSON object of strings)
                </Label>
                <Input
                  id={`compose-variables-${appId}`}
                  aria-label="Variables JSON"
                  value={variableText}
                  onChange={(e) => setVariableText(e.target.value)}
                  placeholder='{"PORT": "8080"}'
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor={`compose-profiles-${appId}`} className="text-xs font-medium">
                  Profiles (comma-separated)
                </Label>
                <Input
                  id={`compose-profiles-${appId}`}
                  aria-label="Profiles"
                  value={profileText}
                  onChange={(e) => setProfileText(e.target.value)}
                  placeholder="frontend, background"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor={`compose-credentials-${appId}`} className="text-xs font-medium">
                  Registry credential IDs (comma-separated)
                </Label>
                <Input
                  id={`compose-credentials-${appId}`}
                  aria-label="Registry credentials"
                  value={credentialIds}
                  onChange={(e) => setCredentialIds(e.target.value)}
                  placeholder="cred-1, cred-2"
                />
              </div>

              {/* One-shot services selection */}
              <div className="space-y-1">
                <Label className="text-xs font-medium">One-shot job designations</Label>
                <p className="text-[11px] text-dim">
                  One-shot services run once to exit code 0 during deployment, and are not restarted on stack restarts.
                </p>
                <div className="flex flex-wrap gap-2">
                  {selectedOneShot.map((name) => (
                    <label key={name} className="flex items-center gap-1.5 text-xs text-text">
                      <input
                        type="checkbox"
                        checked={oneShotServices.includes(name)}
                        onChange={(e) => {
                          if (e.target.checked) setOneShotServices((prev) => [...prev, name]);
                          else setOneShotServices((prev) => prev.filter((x) => x !== name));
                        }}
                      />
                      <span>{name}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Secret name toggles */}
              {variableNameList.length ? (
                <div className="space-y-1">
                  <Label className="text-xs font-medium">Interpolate write-only secrets into variables</Label>
                  <div className="flex flex-wrap gap-2">
                    {variableNameList.map((name) => (
                      <label key={name} className="flex items-center gap-1.5 text-xs text-text">
                        <input
                          type="checkbox"
                          checked={secretNameToggles.includes(name)}
                          onChange={(e) => {
                            if (e.target.checked) setSecretNameToggles((prev) => [...prev, name]);
                            else setSecretNameToggles((prev) => prev.filter((x) => x !== name));
                          }}
                        />
                        <span>{name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              <Button
                size="sm"
                disabled={busy || isOffline || !yaml.trim() || !validVariableObject(variableText)}
                onClick={() => {
                  setSecretValue("");
                  setRegistryPassword("");
                  void makePreview();
                }}
              >
                Create preview
              </Button>
            </>
          )}
        </section>
      ) : null}

      {/* Secrets management */}
      {detail.mode === "managed" ? <section className="space-y-2 border-t border-line pt-3">
        <h4 className="text-sm font-semibold">Secrets</h4>
        <p className="text-xs text-dim">
          Secrets are encrypted and write-only. Values cannot be viewed or exported after saving.
        </p>
        {secrets.map((s) => (
          <div key={s.name} className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="min-w-0 break-words font-medium">
              {s.name} · version {s.version}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || isOffline}
              onClick={() => void perform(() => deleteComposeSecret(vpsId, appId, s.name))}
            >
              Delete
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Input
            value={secretName}
            onChange={(e) => setSecretName(e.target.value)}
            placeholder="Secret name"
            aria-label="Secret name"
            className="w-40 text-xs"
          />
          <Input
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            placeholder="Secret value"
            type="password"
            aria-label="Secret value"
            className="w-48 text-xs"
          />
          <Button
            size="sm"
            disabled={busy || isOffline || !secretName || !secretValue}
            onClick={() =>
              void perform(async () => {
                await setComposeSecret(vpsId, appId, secretName, secretValue);
                setSecretName("");
                setSecretValue("");
              })
            }
          >
            Save secret
          </Button>
        </div>
      </section> : null}

      {/* Registry credentials management */}
      <section className="space-y-2 border-t border-line pt-3">
        <h4 className="text-sm font-semibold">Registry credentials</h4>
        {replaceTarget ? (
          <p className="text-xs text-warn">
            Replacing credential {replaceTarget.id} ({replaceTarget.host.toLowerCase().trim()} · {replaceTarget.username}). Enter the new password and save; the host is preserved.
          </p>
        ) : null}
        {registryCredentials.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="min-w-0 break-words font-medium">
              {c.host.toLowerCase().trim()} · {c.username}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || isOffline}
                onClick={() => {
                  setRegistryCredentialId(c.id);
                  setRegistryHost(c.host);
                  setRegistryUsername(c.username);
                  setRegistryPassword("");
                }}
              >
                Replace
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || isOffline}
                onClick={() => void perform(() => deleteComposeRegistryCredential(vpsId, c.id))}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Input
            value={registryHost}
            onChange={(e) => setRegistryHost(e.target.value)}
            placeholder="Registry host (e.g. docker.io)"
            aria-label="Registry host"
            disabled={Boolean(registryCredentialId)}
            className="w-40 text-xs"
          />
          <Input
            value={registryUsername}
            onChange={(e) => setRegistryUsername(e.target.value)}
            placeholder="Username"
            aria-label="Registry username"
            disabled={Boolean(registryCredentialId)}
            className="w-32 text-xs"
          />
          <Input
            value={registryPassword}
            onChange={(e) => setRegistryPassword(e.target.value)}
            placeholder="Password or token"
            type="password"
            aria-label="Registry password"
            className="w-36 text-xs"
          />
          <Button
            size="sm"
            disabled={
              busy ||
              isOffline ||
              !registryHost ||
              !registryUsername ||
              !registryPassword
            }
            onClick={() =>
              void perform(async () => {
                await setComposeRegistryCredential(vpsId, {
                  credentialId: registryCredentialId || undefined,
                  host: registryHost,
                  username: registryUsername,
                  password: registryPassword,
                });
                setRegistryHost("");
                setRegistryUsername("");
                setRegistryPassword("");
                setRegistryCredentialId("");
              })
            }
          >
            {registryCredentialId ? "Update password" : "Add credential"}
          </Button>
          {registryCredentialId ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setRegistryCredentialId("");
                setRegistryHost("");
                setRegistryUsername("");
                setRegistryPassword("");
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </section>

      {/* External source verification for detected stacks */}
      {detail.mode === "detected_readonly" ? (
        <section className="space-y-2 border-t border-line pt-3">
          <h4 className="text-sm font-semibold">External source</h4>
          <p className="text-xs text-dim">
            Specify the absolute path to the compose file on the host to verify and bind this stack.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder="/opt/app/docker-compose.yml"
              aria-label="External compose source path"
              className="w-80 text-xs"
            />
            <Button
              size="sm"
              disabled={busy || isOffline || !sourcePath.trim()}
              onClick={() => {
                const scopeGeneration = requestGeneration.current;
                void perform(async () => {
                  const op = await verifyComposeSource(vpsId, appId, { sourcePath, oneShotServices });
                  if (currentScope.current !== scope || requestGeneration.current !== scopeGeneration) return;
                  const current = await getVpsComposeOperation(vpsId, op.operationId);
                  if (currentScope.current !== scope || requestGeneration.current !== scopeGeneration) return;
                  setOperations((items) => [current, ...items.filter((item) => item.id !== current.id)]);
                  if (composeOperationIsActive(current.status)) {
                    setActive(current);
                    setPhase({ kind: "operation", id: current.id });
                  }
                });
              }}
            >
              Verify source
            </Button>
            {detail.source?.verified ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || isOffline}
                onClick={() => void perform(() => optInComposeExternalControl(vpsId, appId))}
              >
                Opt in to external stack control
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Adoption Flow */}
      {detail.mode === "external_control" || detail.mode === "detected_readonly" ? (
        <AdoptionFlow
          key={`${vpsId}\u0000${appId}\u0000${sourcePath || detail.source?.path || ""}`}
          vpsId={vpsId}
          appId={appId}
          initialSourcePath={sourcePath || detail.source?.path || ""}
          onDone={load}
          disabled={busy || isOffline}
        />
      ) : null}
    </section>
  );
}

function PreviewPanel({
  preview,
  busy,
  isOffline,
  yamlText,
  onDeploy,
}: {
  preview: ComposePreview;
  busy: boolean;
  isOffline: boolean;
  yamlText: string;
  onDeploy: (ids: string[]) => void;
}) {
  const removed = preview.removedServices ?? preview.result?.removedServiceIds ?? [];
  const oneShotJobs = preview.result?.oneShotJobs ?? [];
  const wildcardWarnings = detectWildcardPortBindings(yamlText, preview.result?.redactedModel);

  return (
    <section className="space-y-3 border border-line bg-raised p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Preview · {preview.status}</h4>
        <p className="text-xs text-dim">
          {preview.digest ? `Approval digest: ${preview.digest}` : "Approval digest pending"}
        </p>
      </div>

      {/* Downtime & recreate notice */}
      <div role="alert" className="space-y-1 border border-warn bg-panel p-3 text-xs text-warn">
        <p className="font-semibold">Downtime & recreate notice</p>
        <p>
          Docker Compose deployments recreate updated and dependent containers. Services do not guarantee zero-downtime during replacement. Running workloads may be temporarily interrupted.
        </p>
      </div>

      {/* Wildcard exposure warnings */}
      {wildcardWarnings.length > 0 ? (
        <div role="alert" className="space-y-1 border border-warn bg-panel p-3 text-xs text-warn">
          <p className="font-semibold">Wildcard port exposure warning</p>
          <ul className="list-disc pl-5">
            {wildcardWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p className="text-[11px] text-dim">
            Binding to 0.0.0.0 or omitting a host IP exposes ports to public host interfaces. Ensure your server firewall blocks unauthorized traffic.
          </p>
        </div>
      ) : null}

      {/* Removed service warning */}
      {removed.length > 0 ? (
        <div role="alert" className="space-y-1 border border-warn bg-panel p-3 text-xs text-warn">
          <p className="font-semibold">Container removal warning</p>
          <p>This deployment will stop and remove containers for: {removed.join(", ")}. Associated named volumes are preserved.</p>
        </div>
      ) : null}

      {/* Approved one-shot jobs */}
      {oneShotJobs.length > 0 ? (
        <div className="text-xs text-dim">
          <p className="font-semibold text-text">Approved one-shot jobs:</p>
          <ul className="list-disc pl-5 mt-0.5">
            {oneShotJobs.map((job) => (
              <li key={job}>{job} — will run to exit 0 once during deployment (not rerun on restart)</li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview.result?.redactedModel ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-text">Verified model preview</p>
          <pre className="max-h-64 overflow-auto border border-line bg-panel p-2 text-xs font-mono">
            {JSON.stringify(preview.result.redactedModel, null, 2)}
          </pre>
        </div>
      ) : null}

      {preview.status === "ready" ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button disabled={busy || isOffline}>Deploy stack</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm deployment</AlertDialogTitle>
              <AlertDialogDescription>
                This will deploy the application using the verified approval digest. Dependent containers will be recreated.
                {removed.length ? ` Containers for ${removed.join(", ")} will be removed.` : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy || isOffline}
                onClick={() => onDeploy(removed)}
              >
                Confirm and deploy
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  );
}

function AdoptionFlow({
  vpsId,
  appId,
  initialSourcePath,
  onDone,
  disabled,
}: {
  vpsId: string;
  appId: string;
  initialSourcePath: string;
  onDone: () => void;
  disabled: boolean;
}) {
  const [sourcePath, setSourcePath] = useState(initialSourcePath);
  const [adoptionYaml, setAdoptionYaml] = useState("");
  const [adoptionVariables, setAdoptionVariables] = useState("{}");
  const [secretKey, setSecretKey] = useState("");
  const [secretVal, setSecretVal] = useState("");
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [previewDifferences, setPreviewDifferences] = useState<ComposeUnsupportedField[]>([]);
  const [previewWarnings, setPreviewWarnings] = useState<ComposeUnsupportedField[]>([]);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [digest, setDigest] = useState<string | undefined>();
  const [approvedDifferences, setApprovedDifferences] = useState<Set<string>>(new Set());
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const scope = `${vpsId}\u0000${appId}\u0000${sourcePath}`;
  const scopeRef = useRef(scope);
  const generationRef = useRef(0);
  scopeRef.current = scope;

  useEffect(() => {
    const generation = ++generationRef.current;
    return () => {
      if (generationRef.current === generation) generationRef.current++;
    };
  }, [scope]);

  async function loadAdoptionPreview(): Promise<void> {
    const scopeHere = scope;
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const vars = validVariableObject(adoptionVariables);
      const payload = {
        sourcePath: sourcePath.trim() || undefined,
        composeYaml: adoptionYaml.trim() || undefined,
        variables: vars ?? undefined,
        secretValues: Object.keys(secretValues).length ? secretValues : undefined,
      };
      const value = await getComposeAdoptionPreview(vpsId, appId, payload);
      if (scopeRef.current !== scopeHere || generationRef.current !== generation) return;
      const parsed = parseAdoptionPreview(value);
      setPreviewDifferences(parsed.differences);
      setPreviewWarnings(parsed.warnings);
      setRuntimeReady(parsed.runtimeReady);
      setDigest(parsed.digest);
      setApprovedDifferences(new Set());
      setPreviewLoaded(true);
    } catch (e) {
      if (scopeRef.current !== scopeHere || generationRef.current !== generation) return;
      setError(e instanceof Error ? e.message : "Unable to prepare adoption.");
    } finally {
      if (scopeRef.current === scopeHere && generationRef.current === generation) {
        setLoading(false);
      }
    }
  }

  function toggleDifferenceApproval(key: string) {
    setApprovedDifferences((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleApproveAllDifferences() {
    const allKeys = previewDifferences.map((row) => composeFindingKey(row));
    setApprovedDifferences(new Set(allKeys));
  }

  function handleAddSecret() {
    if (!secretKey.trim() || !secretVal) return;
    setSecretValues((prev) => ({ ...prev, [secretKey.trim()]: secretVal }));
    setSecretKey("");
    setSecretVal("");
  }

  function handleRemoveSecret(k: string) {
    setSecretValues((prev) => {
      const copy = { ...prev };
      delete copy[k];
      return copy;
    });
  }

  async function adopt(): Promise<void> {
    const scopeHere = scope;
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const vars = validVariableObject(adoptionVariables);
      await adoptComposeApplication(vpsId, appId, {
        sourcePath: sourcePath.trim() || undefined,
        composeYaml: adoptionYaml.trim() || undefined,
        variables: vars ?? undefined,
        secretValues: Object.keys(secretValues).length ? secretValues : undefined,
        adoptionDigest: digest,
        approvedDifferences: Array.from(approvedDifferences),
      });
      if (scopeRef.current !== scopeHere || generationRef.current !== generation) return;
      setPreviewDifferences([]);
      setPreviewWarnings([]);
      setRuntimeReady(false);
      setDigest(undefined);
      setPreviewLoaded(false);
      onDone();
    } catch (e) {
      if (scopeRef.current !== scopeHere || generationRef.current !== generation) return;
      setError(e instanceof Error ? e.message : "Adoption failed.");
    } finally {
      if (scopeRef.current === scopeHere && generationRef.current === generation) {
        setLoading(false);
      }
    }
  }

  const allDifferencesApproved =
    previewDifferences.length === 0 || approvedDifferences.size === previewDifferences.length;

  return (
    <section className="space-y-3 border-t border-line pt-3">
      <h4 className="text-sm font-semibold">Adopt into managed configuration</h4>
      <p className="text-xs text-dim">
        Adoption imports the verified source file into this application and creates durable FlexServer ownership while preserving running containers. It does not deploy; first deployment requires a separate preview and approval.
      </p>

      {/* Optional config / secrets input */}
      <div className="space-y-2 border border-line p-3 text-xs">
        <p className="font-medium text-text">Adoption configuration & write-only secrets</p>
        <div className="space-y-1">
          <Label htmlFor={`adopt-source-${appId}`} className="text-[11px] font-medium">Source path on host</Label>
          <Input
            id={`adopt-source-${appId}`}
            value={sourcePath}
            onChange={(e) => setSourcePath(e.target.value)}
            placeholder="/opt/app/docker-compose.yml"
            className="text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`adopt-yaml-${appId}`} className="text-[11px] font-medium">Or paste Compose YAML (optional if source path provided)</Label>
          <textarea
            id={`adopt-yaml-${appId}`}
            value={adoptionYaml}
            onChange={(e) => setAdoptionYaml(e.target.value)}
            placeholder="services: ..."
            className="min-h-20 w-full border border-line bg-panel p-2 font-mono text-xs text-text placeholder:text-dim"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`adopt-vars-${appId}`} className="text-[11px] font-medium">Variables JSON (optional)</Label>
          <Input
            id={`adopt-vars-${appId}`}
            value={adoptionVariables}
            onChange={(e) => setAdoptionVariables(e.target.value)}
            placeholder='{"ENV": "production"}'
            className="text-xs"
          />
        </div>

        {/* Secret values to import */}
        <div className="space-y-1 pt-1">
          <p className="text-[11px] font-medium text-text">Write-only secrets for adopted stack</p>
          {Object.keys(secretValues).length > 0 ? (
            <div className="space-y-1">
              {Object.keys(secretValues).map((k) => (
                <div key={k} className="flex items-center justify-between text-xs">
                  <span>{k} (••••••••)</span>
                  <Button size="sm" variant="outline" onClick={() => handleRemoveSecret(k)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Input
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder="Secret name"
              className="w-36 text-xs"
              aria-label="Adoption secret name"
            />
            <Input
              value={secretVal}
              onChange={(e) => setSecretVal(e.target.value)}
              placeholder="Secret value"
              type="password"
              className="w-40 text-xs"
              aria-label="Adoption secret value"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!secretKey.trim() || !secretVal}
              onClick={handleAddSecret}
            >
              Add secret
            </Button>
          </div>
        </div>
      </div>

      <Button
        size="sm"
        variant="outline"
        disabled={disabled || loading || (!sourcePath.trim() && !adoptionYaml.trim())}
        onClick={() => void loadAdoptionPreview()}
      >
        {loading ? "Checking differences…" : "Review adoption differences"}
      </Button>

      {previewLoaded ? (
        <div className="space-y-3 border border-line bg-raised p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-text">Adoption review</p>
            <p className="text-dim">Runtime ready: {runtimeReady ? "yes" : "no"}</p>
          </div>

          {digest ? <p className="text-[11px] text-dim">Adoption digest: {digest}</p> : null}

          {/* Differences checklist */}
          {previewDifferences.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="font-medium text-warn">
                  Differences detected ({approvedDifferences.size}/{previewDifferences.length} confirmed):
                </p>
                <Button size="sm" variant="outline" onClick={handleApproveAllDifferences}>
                  Approve all differences
                </Button>
              </div>
              <ul className="space-y-1.5" aria-label="Adoption differences checklist">
                {previewDifferences.map((row) => {
                  const key = composeFindingKey(row);
                  const field = row.field || row.paramPath?.join(".");
                  return (
                    <li key={key} className="flex items-start gap-2 border border-line bg-panel p-2">
                      <input
                        type="checkbox"
                        id={`diff-check-${key}`}
                        checked={approvedDifferences.has(key)}
                        onChange={() => toggleDifferenceApproval(key)}
                        className="mt-0.5"
                        aria-label={`Confirm difference: ${field ?? row.reason}`}
                      />
                      <label htmlFor={`diff-check-${key}`} className="text-xs text-text cursor-pointer">
                        {field ? <span className="font-semibold">{field}: </span> : null}
                        {row.reason}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="text-dim">Differences: none — the verified source imports without differences.</p>
          )}

          {/* Warnings */}
          {previewWarnings.length > 0 ? (
            <div className="space-y-1">
              <p className="font-medium text-warn">Warnings:</p>
              <ul className="list-disc pl-5">
                {previewWarnings.map((row) => {
                  const field = row.field || row.paramPath?.join(".");
                  return (
                    <li key={composeFindingKey(row)}>
                      {field ? <span className="font-medium">{field}: </span> : null}
                      {row.reason}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <Button
            size="sm"
            disabled={disabled || loading || !runtimeReady || !allDifferencesApproved}
            onClick={() => void adopt()}
          >
            Confirm adoption (no deployment)
          </Button>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-xs text-crit">{error}</p> : null}
    </section>
  );
}
