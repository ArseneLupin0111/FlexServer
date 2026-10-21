//go:build linux

package applications

// Deploy path: verified canonical model, exact digest pins, authorized
// mutation on the canonical-hash handshake, app-data-root bind revalidation,
// and owned removed-service teardown (stop then delete, volumes preserved).
// Terminal results are persisted durably before replay.
import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/vps-manager/agent/internal/commands"
)

type approvedDeployPreview struct {
	Digest               string            `json:"digest"`
	CanonicalModelJSON   string            `json:"canonicalModelJson"`
	ImageDigests         map[string]string `json:"imageDigests"`
	RemovedServiceIDs    []string          `json:"removedServiceIds"`
	Removals             []previewRemoval  `json:"removals"`
	OwnershipBinding     ownershipBinding  `json:"ownershipBinding"`
	InventoryFingerprint string            `json:"inventoryFingerprint"`
	ObservedFingerprint  string            `json:"observedFingerprint"`
	SecretVersions       map[string]int    `json:"secretVersions"`
	CredentialVersions   map[string]int    `json:"credentialVersions"`
	RevisionSeq          int               `json:"revisionSeq"`
}
type previewRemoval struct {
	ServiceName   string   `json:"serviceName"`
	ContainerKeys []string `json:"containerKeys"`
}
type ownershipBinding struct {
	AgentInstanceID string `json:"agentInstanceId"`
	DaemonEpoch     string `json:"daemonEpoch"`
	ProjectName     string `json:"projectName"`
}
type deployRevision struct {
	Seq             int               `json:"seq"`
	ComposeYaml     string            `json:"composeYaml"`
	Variables       map[string]string `json:"variables"`
	OneShotServices []string          `json:"oneShotServices"`
	Profiles        []string          `json:"profiles"`
}
type deployServiceModel struct {
	Profiles []string            `json:"profiles"`
	Image    string              `json:"image"`
	Volumes  []deployVolumeModel `json:"volumes,omitempty"`
	Deploy   struct {
		Replicas *int `json:"replicas"`
	} `json:"deploy"`
}
type deployVolumeModel struct {
	Bind struct {
		CreateHostPath *bool `json:"create_host_path"`
	} `json:"bind"`
	Type   string `json:"type"`
	Source string `json:"source"`
	Target string `json:"target"`
}
type deployComposeModel struct {
	Services map[string]deployServiceModel `json:"services"`
}
type registryCredential struct {
	ID       string `json:"id"`
	Host     string `json:"host"`
	Username string `json:"username"`
	Value    string `json:"value"`
	Version  int    `json:"version"`
}

func deployEnv(rev deployRevision, secrets []json.RawMessage) ([]byte, map[string]int, error) {
	values := make(map[string]string, len(rev.Variables)+len(secrets))
	for k, v := range rev.Variables {
		values[k] = v
	}
	versions := make(map[string]int, len(secrets))
	for _, raw := range secrets {
		var s struct {
			Name    string `json:"name"`
			Version int    `json:"version"`
			Value   string `json:"value"`
		}
		if strictDecodeJSON(raw, &s) != nil || s.Name == "" || !validEnvName(s.Name) {
			return nil, nil, fmt.Errorf("invalid secret metadata")
		}
		values[s.Name] = s.Value
		versions[s.Name] = s.Version
	}
	keys := make([]string, 0, len(values))
	for k := range values {
		if !validEnvName(k) {
			return nil, nil, fmt.Errorf("invalid environment key")
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(dotenvValue(values[k]))
		b.WriteByte('\n')
	}
	return []byte(b.String()), versions, nil
}
func dotenvValue(value string) string {
	b := strings.Builder{}
	b.Grow(len(value) + 2)
	b.WriteByte('\'')
	for _, r := range value {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '\'':
			b.WriteString(`\'`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('\'')
	return b.String()
}
func secretValues(secrets []json.RawMessage) []string {
	values := make([]string, 0, len(secrets))
	for _, raw := range secrets {
		var s struct {
			Value string `json:"value"`
		}
		if strictDecodeJSON(raw, &s) == nil && s.Value != "" {
			values = append(values, s.Value)
		}
	}
	return values
}
func validEnvName(s string) bool {
	if s == "" {
		return false
	}
	for i, c := range s {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c == '_' || i > 0 && c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
func prepareRegistryAuth(r *composeRunner, rawCredentials []json.RawMessage, approved map[string]int) (map[string]int, error) {
	byHost := make(map[string]map[string]string, len(rawCredentials))
	versions := make(map[string]int, len(rawCredentials))
	for _, raw := range rawCredentials {
		var c registryCredential
		if strictDecodeJSON(raw, &c) != nil || c.ID == "" || c.Host == "" || c.Username == "" || c.Value == "" || c.Version <= 0 {
			return nil, fmt.Errorf("invalid registry credential")
		}
		u, err := url.Parse("https://" + c.Host)
		if err != nil || u.Host != c.Host || u.User != nil || u.Path != "" || u.RawQuery != "" {
			return nil, fmt.Errorf("invalid registry host")
		}
		if _, exists := byHost[c.Host]; exists {
			return nil, fmt.Errorf("duplicate registry host")
		}
		byHost[c.Host] = map[string]string{"auth": base64.StdEncoding.EncodeToString([]byte(c.Username + ":" + c.Value))}
		versions[c.ID] = c.Version
	}
	if approved != nil {
		if len(versions) != len(approved) {
			return nil, fmt.Errorf("registry credential version mismatch")
		}
		for id, v := range versions {
			if approved[id] != v {
				return nil, fmt.Errorf("registry credential version mismatch")
			}
		}
	}
	b, err := json.Marshal(map[string]any{"auths": byHost})
	if err != nil {
		return nil, err
	}
	if err = writePrivateFile(filepath.Join(r.authDir, "config.json"), b, 0600); err != nil {
		return nil, err
	}
	return versions, nil
}
func deployPinnedModel(data []byte, p *approvedDeployPreview) (deployComposeModel, error) {
	var model deployComposeModel
	if p == nil || len(data) == 0 || json.Unmarshal(data, &model) != nil || len(model.Services) == 0 {
		return model, fmt.Errorf("invalid approved canonical model")
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != p.Digest {
		return model, fmt.Errorf("approved canonical model digest mismatch")
	}
	for name, svc := range model.Services {
		if name == "" || svc.Image == "" {
			return model, fmt.Errorf("approved model missing image")
		}
		pin := p.ImageDigests[name]
		if pin == "" || !strings.Contains(pin, "@sha256:") || !strings.Contains(svc.Image, "@sha256:") {
			return model, fmt.Errorf("image digest pin missing")
		}
		if svc.Image != pin {
			return model, fmt.Errorf("approved image digest mismatch")
		}
	}
	return model, nil
}
func deployArgs(profiles []string, args ...string) []string {
	out := make([]string, 0, len(profiles)*2+len(args))
	for _, profile := range profiles {
		if profile == "" {
			continue
		}
		out = append(out, "--profile", profile)
	}
	return append(out, args...)
}

func (w *operationWorker) runDeploy(ctx context.Context, r *workerReceipt, work *OperationWork) error {
	scope := "project:" + work.VpsID + "|" + work.App.DaemonEpoch + "|" + work.App.Project
	if err := acquireScope(scope, "compose-operation", work.OperationID, false, 0); err != nil {
		return w.fail(ctx, r, "scope_busy", err)
	}
	defer func() {
		if r.State != "uncertain" {
			_ = releaseScope(scope, "compose-operation", work.OperationID)
		}
	}()

	var rev deployRevision
	var preview approvedDeployPreview
	if strictDecodeJSON(work.Revision, &rev) != nil || rev.ComposeYaml == "" || strictDecodeJSON(work.ApprovedPreview, &preview) != nil || preview.Digest == "" || preview.RevisionSeq != rev.Seq || work.ApprovedDigest != preview.Digest {
		return w.fail(ctx, r, ErrMalformed, fmt.Errorf("invalid approved revision binding"))
	}
	if preview.CanonicalModelJSON == "" {
		return w.fail(ctx, r, ErrMalformed, fmt.Errorf("missing canonical model"))
	}
	model, err := deployPinnedModel([]byte(preview.CanonicalModelJSON), &preview)
	if err != nil {
		return w.fail(ctx, r, "preview_digest_mismatch", err)
	}
	model = selectedDeployModel(model, rev.Profiles)
	if len(work.OneShotServices) == 0 {
		work.OneShotServices = rev.OneShotServices
	}
	env, secretVersions, err := deployEnv(rev, work.Secrets)
	if err != nil {
		return w.fail(ctx, r, ErrMalformed, err)
	}
	if !equalIntMap(secretVersions, preview.SecretVersions) {
		return w.fail(ctx, r, "preview_version_mismatch", fmt.Errorf("secret versions changed"))
	}
	if e := w.progress(ctx, r, 2, "preflight", "started", ""); e != nil {
		return e
	}
	rt, err := DetectRuntime()
	if err != nil || rt.Mode != ModePlugin {
		return w.fail(ctx, r, ErrRuntimeUnavailable, fmt.Errorf("plugin_only_runtime_required"))
	}
	runner, err := newComposeRunner(rt, work.App.ID, work.OperationID)
	if err != nil {
		return w.fail(ctx, r, "workspace_prepare_failed", err)
	}
	defer runner.close()
	if preview.CredentialVersions == nil && len(work.RegistryCredentials) > 0 {
		return w.fail(ctx, r, ErrMalformed, fmt.Errorf("registry credential approval missing"))
	}
	_, err = prepareRegistryAuth(runner, work.RegistryCredentials, preview.CredentialVersions)
	if err != nil {
		return w.fail(ctx, r, ErrMalformed, err)
	}
	composeArgs := deployArgs(rev.Profiles)
	composeY := []byte(preview.CanonicalModelJSON)
	if _, _, err = runner.runStdout(ctx, 5*time.Minute, MaxComposeOutputBytes, work.App.Project, composeY, env, append(append([]string{}, composeArgs...), "config", "--format", "json")...); err != nil {
		return w.fail(ctx, r, "preview_resolution_failed", fmt.Errorf("canonical model rejected"))
	}
	removedSorted := append([]string{}, preview.RemovedServiceIDs...)
	sort.Strings(removedSorted)
	var resolvedAny deployComposeModel
	if json.Unmarshal(composeY, &resolvedAny) != nil || len(resolvedAny.Services) == 0 {
		return w.fail(ctx, r, ErrMalformed, fmt.Errorf("canonical model unavailable"))
	}
	if err = verifyAppBindSources(resolvedAny, work.App.ID, 256); err != nil {
		return w.fail(ctx, r, "bind_source_rejected", err)
	}
	if err = w.importAdoptionOwnership(ctx, work, preview.ObservedFingerprint); err != nil {
		return w.fail(ctx, r, "adoption_ownership_failed", err)
	}
	var removalIDs map[string]string
	inventoryFP := ""
	if len(preview.RemovedServiceIDs) > 0 || len(preview.Removals) > 0 {
		removalIDs, inventoryFP, err = captureRemovedOwnership(ctx, w.engine, w.keyForID, preview, work.App.ID, w.agentInstanceID(), work.App.DaemonEpoch, work.App.Project)
		if err != nil {
			return w.fail(ctx, r, "removed_service_ownership_mismatch", err)
		}
		if preview.InventoryFingerprint == "" || preview.InventoryFingerprint != inventoryFP {
			return w.fail(ctx, r, "removed_service_inventory_changed", fmt.Errorf("inventory fingerprint mismatch"))
		}
		r.OwnerInstanceID = preview.OwnershipBinding.AgentInstanceID
		r.OwnerDaemonEpoch = preview.OwnershipBinding.DaemonEpoch
		r.OwnerProject = preview.OwnershipBinding.ProjectName
		r.OwnedContainers = r.OwnedContainers[:0]
		for id := range removalIDs {
			r.OwnedContainers = append(r.OwnedContainers, id)
		}
		sort.Strings(r.OwnedContainers)
		if err = w.save(r); err != nil {
			return err
		}
	} else if len(preview.RemovedServiceIDs) != 0 || len(preview.Removals) != 0 {
		return w.fail(ctx, r, "removed_service_manifest_incomplete", fmt.Errorf("removal manifest mismatch"))
	}
	pairs := [][2]any{{"appId", work.App.ID}, {"approvedDigest", preview.Digest}, {"daemonEpoch", work.App.DaemonEpoch}, {"generation", work.App.Generation}, {"kind", work.Kind}, {"operationId", work.OperationID}, {"removedServiceIds", removedSorted}, {"removals", preview.Removals}, {"ownershipBinding", preview.OwnershipBinding}, {"inventoryFingerprint", preview.InventoryFingerprint}}
	payload, err := canonicalHashJSON(pairs...)
	if err != nil || payload == "" {
		return w.fail(ctx, r, ErrMalformed, fmt.Errorf("canonical hash failed"))
	}
	if e := w.progress(ctx, r, 2, "preflight", "ok", ""); e != nil {
		return e
	}
	if e := w.progress(ctx, r, 3, "pull", "started", ""); e != nil {
		return e
	}
	pullTimeout := time.Duration(max(work.PullTimeoutSeconds, 0)) * time.Second
	if pullTimeout == 0 {
		pullTimeout = 10 * time.Minute
	}
	if _, _, err = runner.runStdout(ctx, pullTimeout, MaxComposeOutputBytes, work.App.Project, composeY, env, append(append([]string{}, composeArgs...), "pull")...); err != nil {
		return w.fail(ctx, r, "pull_failed", fmt.Errorf("image pull failed"))
	}
	if e := w.progress(ctx, r, 3, "pull", "ok", ""); e != nil {
		return e
	}
	currentFP, checkErr := runtimeFingerprint(ctx, w.engine, w.keyForID, work.App.Project)
	if checkErr != nil || preview.ObservedFingerprint == "" || currentFP != preview.ObservedFingerprint {
		return w.fail(ctx, r, "observed_fingerprint_mismatch", fmt.Errorf("runtime changed before apply"))
	}
	if err = verifyAppBindSources(resolvedAny, work.App.ID, 256); err != nil {
		return w.fail(ctx, r, "bind_source_rejected", err)
	}
	if err = w.authorize(ctx, r, payload); err != nil {
		return err
	}
	if err = markMutating(scope, "compose-operation", work.OperationID); err != nil {
		return err
	}
	if e := w.progress(ctx, r, 4, "apply", "started", ""); e != nil {
		return e
	}
	if len(removalIDs) > 0 {
		// Pulling images can take minutes; revalidate the approved inventory
		// immediately before Compose mutates the project.
		_, currentFP, checkErr := captureRemovedOwnership(ctx, w.engine, w.keyForID, preview, work.App.ID, w.agentInstanceID(), work.App.DaemonEpoch, work.App.Project)
		if checkErr != nil || currentFP != preview.InventoryFingerprint {
			return w.fail(ctx, r, "removed_service_inventory_changed", fmt.Errorf("inventory changed before apply"))
		}
	}
	jobIDs, jobErr := captureJobReplacement(ctx, w.engine, work, model, w.agentInstanceID())
	if jobErr != nil {
		return w.fail(ctx, r, "job_replacement_ownership_failed", jobErr)
	}
	r.Executed = true
	if err = w.save(r); err != nil {
		return err
	}
	runner.onStart = w.trackChild(r, "apply")
	if len(removalIDs) > 0 {
		if err = teardownRemovedServices(ctx, w.engine, w.control, removalIDs, work.App.Project, func(seq uint64, stage, service, status, reason string) error {
			return w.progress(ctx, r, seq, stage, status, reason)
		}); err != nil {
			return w.fail(ctx, r, ErrApplyFailed, err)
		}
	}
	if len(jobIDs) > 0 {
		if err = teardownRemovedServices(ctx, w.engine, w.control, jobIDs, work.App.Project, nil); err != nil {
			return w.fail(ctx, r, "job_replacement_failed", err)
		}
	}
	if _, _, err = runner.runStdout(ctx, 15*time.Minute, MaxComposeOutputBytes, work.App.Project, composeY, env, append(append([]string{}, deployArgs(rev.Profiles)...), "up", "-d", "--no-build", "--pull", "never")...); err != nil {
		if ctx.Err() != nil {
			r.State = "uncertain"
			return w.report(ctx, r, "uncertain", r.Executed, "apply_interrupted")
		}
		if ownErr := w.saveOwnership(ctx, work, model); ownErr != nil {
			r.State = "uncertain"
			return w.report(ctx, r, "uncertain", r.Executed, "apply_ownership_uncertain")
		}
		outcomes, ownership, observeErr := w.deployEvidence(ctx, work, model)
		if observeErr != nil {
			return w.fail(ctx, r, ErrApplyFailed, observeErr)
		}
		return w.finish(ctx, r, "failed", r.Executed, ErrApplyFailed, []any{map[string]any{"serviceOutcomes": outcomes, "ownership": ownership}})
	}
	runner.onStart = nil
	if err = w.saveOwnership(ctx, work, model); err != nil {
		r.State = "uncertain"
		return w.report(ctx, r, "uncertain", r.Executed, "ownership_persist_failed")
	}
	if e := w.progress(ctx, r, 4, "apply", "ok", ""); e != nil {
		return e
	}
	if e := w.progress(ctx, r, 5, "observe", "started", ""); e != nil {
		return e
	}
	readyCtx, cancel := context.WithTimeout(ctx, deployReadinessTimeout(work.ReadinessSeconds))
	defer cancel()
	if err = waitDeployReady(readyCtx, w.engine, model, work.App.Project, work.OneShotServices); err != nil {
		outcomes, ownership, observeErr := w.deployEvidence(ctx, work, model)
		if observeErr != nil {
			return w.fail(ctx, r, ErrReadinessTimeout, err)
		}
		return w.finish(ctx, r, "failed", r.Executed, ErrReadinessTimeout, []any{map[string]any{"serviceOutcomes": outcomes, "ownership": ownership}})
	}
	if err = w.saveOwnership(ctx, work, model); err != nil {
		return w.fail(ctx, r, "ownership_persist_failed", err)
	}
	outcomes, ownership, outcomeErr := w.deployEvidence(ctx, work, model)
	if outcomeErr != nil {
		return w.fail(ctx, r, "observation_failed", outcomeErr)
	}
	return w.finish(ctx, r, "succeeded", r.Executed, "", []any{map[string]any{"serviceOutcomes": outcomes, "ownership": ownership}})
}
func mustJSONValue(raw json.RawMessage) any { var v any; _ = json.Unmarshal(raw, &v); return v }
func equalIntMap(a, b map[string]int) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func waitDeployReady(ctx context.Context, e *engineClient, model deployComposeModel, project string, oneshots []string) error {
	one := map[string]bool{}
	for _, s := range oneshots {
		one[s] = true
	}
	for {
		ids, err := e.listAllIDs(ctx)
		if err != nil {
			return fmt.Errorf("container inventory unavailable")
		}
		counts := make(map[string]int)
		ready := make(map[string]int)
		for _, id := range ids {
			snap, err := e.InspectContainer(ctx, id)
			if err != nil {
				continue
			}
			svc := snap.Labels["com.docker.compose.service"]
			if snap.Labels["com.docker.compose.project"] != project || svc == "" {
				continue
			}
			counts[svc]++
			if ObserveReadiness(snap, one[svc]).Ready {
				ready[svc]++
			}
		}
		all := true
		for name, svc := range model.Services {
			want := 1
			if svc.Deploy.Replicas != nil {
				want = *svc.Deploy.Replicas
			}
			if want < 0 || counts[name] != want || ready[name] != want {
				all = false
				break
			}
		}
		if all {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

// finish persists the durable terminal receipt BEFORE the result is
// reported, so a crash between report and receipt cleanup replays the
// exact terminal evidence on next start. A non-empty observed payload is
// reported via reportObserved; an empty one via the plain status report.
func (w *operationWorker) finish(ctx context.Context, r *workerReceipt, finalState string, executed bool, err string, observed ...any) error {
	r.State = finalState
	r.Error = err
	if e := w.save(r); e != nil {
		return e
	}
	var rErr error
	if len(observed) > 0 {
		rErr = w.reportObserved(ctx, r, finalState, executed, observed[0], err)
	} else {
		rErr = w.report(ctx, r, finalState, executed, err)
	}
	if rErr != nil {
		return rErr
	}
	return w.clearReceipt()
}

// agentInstanceID exposes the agent-scoped observation identity exactly as
// the operation worker received it; the observed-fingerprint pair the API
// and preview agree on is (agentInstanceId, daemonEpoch).
func (w *operationWorker) agentInstanceID() string { return w.client.instance }

// verifyComposeBindSources revalidates every bind mount of the resolved
// model before any mutation: only a real, no-follow-opened source beneath
// the agent's app-data root is ever allowed to reach Compose. Named
// volumes remain untouched; foreign or symlinked sources fail closed.
func verifyAppBindSources(model deployComposeModel, appID string, maxBinds int) error {
	if maxBinds < 0 || maxBinds > 256 {
		return fmt.Errorf("%s", ErrMalformed)
	}
	if safeDirComponent(appID) != nil {
		return fmt.Errorf("app_bind_identity_required")
	}
	root := filepath.Join(workRoot(), appID, "data")
	binds := 0
	for name, svc := range model.Services {
		if name == "" {
			return fmt.Errorf("%s", ErrMalformed)
		}
		for _, vol := range svc.Volumes {
			switch vol.Type {
			case "", "volume":
				if vol.Source != "" && filepath.IsAbs(vol.Source) {
					return fmt.Errorf("bind_requires_type_bind:%s", name)
				}
			case "bind":
				if vol.Bind.CreateHostPath == nil || *vol.Bind.CreateHostPath {
					return fmt.Errorf("bind_implicit_creation_forbidden:%s", name)
				}
				binds++
				if vol.Source == "" || !filepath.IsAbs(vol.Source) {
					return fmt.Errorf("bind_source_absolute_required:%s", name)
				}
				f, err := secureOpenNoFollow(vol.Source)
				if err != nil {
					return fmt.Errorf("bind_source_unsafe:%s", name)
				}
				info, serr := f.Stat()
				if serr != nil {
					_ = f.Close()
					return fmt.Errorf("bind_source_identity:%s", name)
				}
				if !info.IsDir() && !info.Mode().IsRegular() {
					_ = f.Close()
					return fmt.Errorf("bind_source_type:%s", name)
				}
				rel, relErr := filepath.Rel(root, filepath.Clean(vol.Source))
				_ = f.Close()
				if relErr != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
					return fmt.Errorf("bind_source_outside_root:%s", name)
				}
			default:
				return fmt.Errorf("unsupported_mount:%s", name)
			}
		}
	}
	if binds > maxBinds {
		return fmt.Errorf("too_many_binds")
	}
	return nil
}

type removalInventoryRow struct {
	ContainerKey string `json:"containerKey"`
	Project      string `json:"project"`
	Service      string `json:"service"`
	Slot         int    `json:"slot"`
	State        string `json:"state"`
}

func captureRemovedOwnership(ctx context.Context, e *engineClient, keyForID func(string) string, p approvedDeployPreview, appID, instance, epoch, project string) (map[string]string, string, error) {
	if keyForID == nil || p.OwnershipBinding.AgentInstanceID != instance || p.OwnershipBinding.DaemonEpoch != epoch || p.OwnershipBinding.ProjectName != project || project == "" {
		return nil, "", fmt.Errorf("ownership_binding_mismatch")
	}
	ids, err := e.listAllIDs(ctx)
	if err != nil {
		return nil, "", err
	}
	if len(ids) > MaxInventoryContainers {
		return nil, "", fmt.Errorf("%s", ReasonOverTotal)
	}
	rows := make([]removalInventoryRow, 0, len(ids))
	keyToID := make(map[string]string, len(ids))
	for _, id := range ids {
		snap, er := e.InspectContainer(ctx, id)
		if er != nil {
			return nil, "", fmt.Errorf("inventory_incomplete")
		}
		key := keyForID(id)
		if len(key) != 32 || keyToID[key] != "" {
			return nil, "", fmt.Errorf("duplicate_or_invalid_container_key")
		}
		keyToID[key] = id
		if snap.Labels["com.docker.compose.project"] != project {
			continue
		}
		slot := 0
		if n, parseErr := strconv.Atoi(snap.Labels["com.docker.compose.container-number"]); parseErr == nil && n >= 0 {
			slot = n
		}
		rows = append(rows, removalInventoryRow{ContainerKey: key, Project: snap.Labels["com.docker.compose.project"], Service: snap.Labels["com.docker.compose.service"], Slot: slot, State: snap.State})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ContainerKey < rows[j].ContainerKey })
	encoded, err := json.Marshal(rows)
	if err != nil {
		return nil, "", err
	}
	fingerprint := removalInventoryFingerprint(encoded)
	if len(p.Removals) != len(p.RemovedServiceIDs) {
		return nil, "", fmt.Errorf("removal_manifest_mismatch")
	}
	removed := make(map[string]bool, len(p.RemovedServiceIDs))
	for _, s := range p.RemovedServiceIDs {
		if s == "" || removed[s] {
			return nil, "", fmt.Errorf("invalid_removed_service")
		}
		removed[s] = true
	}
	result := make(map[string]string)
	seenKeys := make(map[string]bool)
	seenServices := make(map[string]bool)
	for _, item := range p.Removals {
		if !removed[item.ServiceName] || seenServices[item.ServiceName] || len(item.ContainerKeys) == 0 {
			return nil, "", fmt.Errorf("invalid_removal_manifest")
		}
		seenServices[item.ServiceName] = true
		for _, key := range item.ContainerKeys {
			id := keyToID[key]
			if id == "" || seenKeys[key] {
				return nil, "", fmt.Errorf("missing_or_duplicate_owned_container")
			}
			seenKeys[key] = true
			snap, er := e.InspectContainer(ctx, id)
			if er != nil || snap.Labels["com.docker.compose.project"] != project || snap.Labels["com.docker.compose.service"] != item.ServiceName {
				return nil, "", fmt.Errorf("owned_container_mismatch")
			}
			result[id] = item.ServiceName
		}
	}
	expected := make(map[string]string)
	for _, row := range rows {
		if row.Project == project && removed[row.Service] {
			expected[row.ContainerKey] = row.Service
		}
	}
	if len(expected) != len(seenKeys) {
		return nil, "", fmt.Errorf("removed_service_manifest_incomplete")
	}
	for key, service := range expected {
		if !seenKeys[key] || keyToID[key] == "" {
			return nil, "", fmt.Errorf("removed_service_manifest_incomplete")
		}
		if _, ok := result[keyToID[key]]; !ok || service == "" {
			return nil, "", fmt.Errorf("removed_service_manifest_incomplete")
		}
	}
	if len(seenServices) != len(removed) {
		return nil, "", fmt.Errorf("removed_service_manifest_incomplete")
	}
	if len(result) > 0 {
		if err := verifyDurableOwnership(appID, instance, epoch, project, result); err != nil {
			return nil, "", err
		}
	}
	return result, fingerprint, nil
}

// teardownRemovedServices stops and deletes only IDs selected by the approved
// opaque-key manifest. DeleteContainer never requests volume removal.
func teardownRemovedServices(ctx context.Context, e *engineClient, control *commands.DockerControl, ids map[string]string, project string, progress func(seq uint64, stage, service, status, reason string) error) error {
	ordered := make([]string, 0, len(ids))
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	services := make([]string, 0, len(ids))
	for _, id := range ordered {
		snap, err := e.InspectContainer(ctx, id)
		if err != nil || snap.ID != id || snap.Labels["com.docker.compose.project"] != project || snap.Labels["com.docker.compose.service"] != ids[id] {
			return fmt.Errorf("owned_container_changed")
		}
		services = append(services, ids[id])
	}
	for _, id := range ordered {
		snap, err := e.InspectContainer(ctx, id)
		if err != nil {
			return fmt.Errorf("owned_container_changed")
		}
		if snap.Running {
			res := control.Act(ctx, "stop", id, false)
			if res.Uncertain || res.ErrorCode != "" && res.ErrorCode != commands.ErrCodeContainerNotFound {
				return fmt.Errorf("removed_stop_failed")
			}
		}
	}
	for _, id := range ordered {
		if err := e.DeleteContainer(ctx, id); err != nil {
			return fmt.Errorf("removed_delete_failed")
		}
	}
	sort.Strings(services)
	if progress != nil {
		for _, service := range services {
			if err := progress(7, "apply", service, "ok", ""); err != nil {
				return err
			}
		}
	}
	return nil
}

func deployReadinessTimeout(seconds int) time.Duration {
	if seconds < 30 || seconds > 3600 {
		seconds = 300
	}
	return time.Duration(seconds) * time.Second
}
func selectedDeployModel(model deployComposeModel, profiles []string) deployComposeModel {
	enabled := map[string]bool{}
	for _, p := range profiles {
		enabled[p] = true
	}
	out := deployComposeModel{Services: map[string]deployServiceModel{}}
	for name, svc := range model.Services {
		selected := len(svc.Profiles) == 0
		for _, p := range svc.Profiles {
			if enabled[p] {
				selected = true
			}
		}
		if selected {
			out.Services[name] = svc
		}
	}
	return out
}

func captureJobReplacement(ctx context.Context, e *engineClient, work *OperationWork, model deployComposeModel, instance string) (map[string]string, error) {
	jobs := map[string]bool{}
	for _, name := range work.OneShotServices {
		if _, ok := model.Services[name]; ok {
			jobs[name] = true
		}
	}
	result := map[string]string{}
	if len(jobs) == 0 {
		return result, nil
	}
	ids, err := e.listAllIDs(ctx)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		snap, err := e.InspectContainer(ctx, id)
		if err != nil {
			return nil, err
		}
		svc := snap.Labels["com.docker.compose.service"]
		if snap.Labels["com.docker.compose.project"] == work.App.Project && jobs[svc] {
			result[id] = svc
		}
	}
	if len(result) > 0 {
		if err = verifyDurableOwnership(work.App.ID, instance, work.App.DaemonEpoch, work.App.Project, result); err != nil {
			return nil, err
		}
	}
	return result, nil
}
