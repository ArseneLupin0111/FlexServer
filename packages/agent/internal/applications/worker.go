//go:build linux

package applications

import (
	"errors"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vps-manager/agent/internal/commands"
	"github.com/vps-manager/agent/internal/config"
)

const maxOperationBytes = 512 * 1024

type LifecycleWorkPlan struct {
	Action              string                 `json:"action"`
	SourcePath          string                 `json:"sourcePath"`
	SourceDigest        string                 `json:"sourceDigest"`
	ObservedFingerprint string                 `json:"observedFingerprint"`
	Order               []string               `json:"order"`
	Services            []LifecycleWorkService `json:"services"`
}
type LifecycleWorkService struct {
	Name                 string                 `json:"name"`
	Kind                 string                 `json:"kind"`
	DependencyConditions map[string]string      `json:"dependencyConditions,omitempty"`
	Condition            string                 `json:"condition"`
	DependsOn            []string               `json:"dependsOn"`
	Selected             bool                   `json:"selected"`
	DesiredCount         *int                   `json:"desiredCount"`
	Replicas             []LifecycleWorkReplica `json:"replicas"`
}
type LifecycleWorkReplica struct {
	ContainerKey  string `json:"containerKey"`
	State         string `json:"state"`
	Health        string `json:"health,omitempty"`
	OneShotStatus string `json:"oneShotStatus"`
}
type PreviewWork struct {
	PreviewID           string            `json:"previewId"`
	Digest              string            `json:"digest"`
	CanonicalModelJSON  string            `json:"canonicalModelJson"`
	RedactedModel       json.RawMessage   `json:"redactedModel"`
	ImageDigests        map[string]string `json:"imageDigests"`
	RemovedServiceIDs   []string          `json:"removedServiceIds"`
	ObservedFingerprint string            `json:"observedFingerprint"`
	SecretVersions      map[string]int    `json:"secretVersions"`
	CredentialVersions  map[string]int    `json:"credentialVersions"`
}
type OperationWork struct {
	AdoptionOwnership *adoptionOwnership `json:"adoptionOwnership,omitempty"`
	Kind              string             `json:"kind"`
	VpsID             string             `json:"vpsId"`
	App               struct {
		ID          string          `json:"id"`
		Project     string          `json:"project"`
		DaemonEpoch string          `json:"daemonEpoch"`
		Generation  int64           `json:"generation"`
		Mode        string          `json:"mode"`
		Source      json.RawMessage `json:"source,omitempty"`
	} `json:"app"`
	Revision            json.RawMessage    `json:"revision,omitempty"`
	SourcePath          string             `json:"sourcePath,omitempty"`
	OneShotServices     []string           `json:"oneShotServices"`
	Secrets             []json.RawMessage  `json:"secrets,omitempty"`
	RegistryCredentials []json.RawMessage  `json:"registryCredentials,omitempty"`
	ApprovedDigest      string             `json:"approvedDigest,omitempty"`
	Stages              json.RawMessage    `json:"stages,omitempty"`
	ReadinessSeconds    int                `json:"readinessSeconds,omitempty"`
	PullTimeoutSeconds  int                `json:"pullTimeoutSeconds,omitempty"`
	StopGraceSeconds    int                `json:"stopGraceSeconds,omitempty"`
	LifecyclePlan       *LifecycleWorkPlan `json:"lifecyclePlan,omitempty"`
	Preview             *PreviewWork       `json:"preview,omitempty"`
	ApprovedPreview     json.RawMessage    `json:"approvedPreview,omitempty"`
	RuntimePrep         *RuntimePrepWork   `json:"runtimePrep"`
	ClaimToken          string             `json:"claimToken"`
	OperationID         string             `json:"operationId"`
}
type RuntimePrepWork struct {
	PluginRequired bool   `json:"pluginRequired"`
	ComposeVersion string `json:"composeVersion,omitempty"`
}
type workerReceipt struct {
	OperationID        string          `json:"operationId"`
	AppID              string          `json:"appId"`
	Generation         int64           `json:"generation"`
	Kind               string          `json:"kind"`
	ClaimToken         string          `json:"claimToken"`
	State              string          `json:"state"`
	ChildPID           int             `json:"childPid,omitempty"`
	ChildStart         string          `json:"childStart,omitempty"`
	ChildGroup         int             `json:"childGroup,omitempty"`
	ChildStage         string          `json:"childStage,omitempty"`
	Executed           bool            `json:"executed"`
	MutationAuthorized bool            `json:"mutationAuthorized"`
	PayloadDigest      string          `json:"payloadDigest,omitempty"`
	Authorization      json.RawMessage `json:"authorization,omitempty"`
	OwnedContainers    []string        `json:"ownedContainers,omitempty"`
	OwnerInstanceID    string          `json:"ownerInstanceId,omitempty"`
	OwnerDaemonEpoch   string          `json:"ownerDaemonEpoch,omitempty"`
	OwnerProject       string          `json:"ownerProject,omitempty"`
	Error              string          `json:"error,omitempty"`
	Report             json.RawMessage `json:"report,omitempty"`
	ProgressSeq        uint64          `json:"progressSeq,omitempty"`
}
type operationClient struct {
	base, token, instance string
	http                  *http.Client
}

func newOperationClient(cfg *config.Config, instance string) (*operationClient, error) {
	base, e := url.JoinPath(cfg.BackendUrl, "/api/agent/applications")
	if e != nil {
		return nil, e
	}
	return &operationClient{base: base, token: cfg.Token, instance: instance, http: &http.Client{Timeout: time.Duration(cfg.RequestTimeoutSeconds) * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *operationClient) call(ctx context.Context, path string, in, out any) error {
	b, e := json.Marshal(in)
	if e != nil {
		return e
	}
	if len(b) > maxOperationBytes {
		return fmt.Errorf("applications: request exceeds limit")
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(b))
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("x-agent-instance", c.instance)
	req.Header.Set("Content-Type", "application/json")
	resp, e := c.http.Do(req)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	body, e := io.ReadAll(io.LimitReader(resp.Body, maxOperationBytes+1))
	if e != nil || len(body) > maxOperationBytes {
		return fmt.Errorf("applications: invalid response")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("applications: operation HTTP %d", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil || len(envelope.Data) == 0 {
		return fmt.Errorf("applications: malformed response")
	}
	return json.Unmarshal(envelope.Data, out)
}

type operationWorker struct {
	client      *operationClient
	receiptPath string
	resolver    commands.TargetResolver
	control     *commands.DockerControl
	engine      *engineClient
	keyForID    func(string) string
	mu          sync.Mutex
}

func newOperationWorker(cfg *config.Config, instance, path string, keyForID func(string) string) (*operationWorker, error) {
	c, e := newOperationClient(cfg, instance)
	if e != nil {
		return nil, e
	}
	resolver, e := commands.NewDockerTargetResolver("", time.Duration(cfg.RequestTimeoutSeconds)*time.Second, keyForID)
	if e != nil {
		return nil, e
	}
	control, e := commands.DefaultDockerControl("", 70*time.Second)
	if e != nil {
		return nil, e
	}
	engine, e := NewEngineClient(time.Duration(cfg.RequestTimeoutSeconds) * time.Second)
	if e != nil {
		return nil, e
	}
	return &operationWorker{client: c, receiptPath: path, resolver: resolver, keyForID: keyForID, control: control, engine: engine}, nil
}
func (w *operationWorker) load() (*workerReceipt, error) {
	b, e := os.ReadFile(w.receiptPath)
	if os.IsNotExist(e) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var r workerReceipt
	if json.Unmarshal(b, &r) != nil || r.OperationID == "" || r.ClaimToken == "" {
		return nil, fmt.Errorf("applications: corrupt receipt preserved")
	}
	return &r, nil
}
func (w *operationWorker) save(r *workerReceipt) error {
	b, e := json.Marshal(r)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(w.receiptPath), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(w.receiptPath), ".compose-receipt-")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(name, w.receiptPath); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(w.receiptPath))
	if e == nil {
		e = d.Sync()
		_ = d.Close()
	}
	return e
}

func (w *operationWorker) clearReceipt() error {
	if err := os.Remove(w.receiptPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	d, err := os.Open(filepath.Dir(w.receiptPath))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func (w *operationWorker) fail(ctx context.Context, r *workerReceipt, reason string, cause error) error {
	state := "failed"
	if r.MutationAuthorized && r.Executed {
		state = "failed"
	}
	return w.finish(ctx, r, state, r.Executed, reason)
}
func (w *operationWorker) report(ctx context.Context, r *workerReceipt, status string, executed bool, err string) error {
	return w.reportObserved(ctx, r, status, executed, nil, err)
}
func (w *operationWorker) reportObserved(ctx context.Context, r *workerReceipt, status string, executed bool, observed any, err string) error {
	payload := map[string]any{"claimToken": r.ClaimToken, "status": status, "executed": executed, "mutationAuthorized": r.MutationAuthorized, "partial": executed && status != "succeeded", "error": err}
	if observed != nil {
		payload["observed"] = observed
	}
	encoded, encodeErr := json.Marshal(payload)
	if encodeErr != nil {
		return encodeErr
	}
	r.Report = encoded
	if saveErr := w.save(r); saveErr != nil {
		return saveErr
	}
	if reportErr := w.client.call(ctx, "/"+url.PathEscape(r.OperationID)+"/result", r.Report, nil); reportErr != nil {
		return reportErr
	}
	if r.State == "uncertain" {
		return nil
	}
	return w.clearReceipt()
}

func (w *operationWorker) authorize(ctx context.Context, r *workerReceipt, payloadDigest string) error {
	var grant struct {
		RevisionAuthorizationID string `json:"revisionAuthorizationId"`
		Nonce                   string `json:"nonce"`
	}
	err := w.client.call(ctx, "/"+url.PathEscape(r.OperationID)+"/authorize", map[string]string{"claimToken": r.ClaimToken, "payloadDigest": payloadDigest}, &grant)
	if err != nil {
		r.State = "uncertain"
		r.MutationAuthorized = true
		if saveErr := w.save(r); saveErr != nil {
			return fmt.Errorf("applications: authorization outcome uncertain (%v); receipt save failed: %w", err, saveErr)
		}
		return fmt.Errorf("applications: authorization outcome uncertain: %w", err)
	}
	if grant.RevisionAuthorizationID == "" || grant.Nonce == "" {
		return fmt.Errorf("applications: malformed authorization")
	}
	r.PayloadDigest = payloadDigest
	r.Authorization, _ = json.Marshal(grant)
	r.MutationAuthorized = true
	r.State = "authorized"
	if err := w.save(r); err != nil {
		r.State = "uncertain"
		return err
	}
	return nil
}
func (w *operationWorker) ProcessOne(ctx context.Context, instance string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	r, e := w.load()
	if e != nil {
		return e
	}
	if r != nil {
		if len(r.Report) > 0 {
			if e = w.client.call(ctx, "/"+url.PathEscape(r.OperationID)+"/result", r.Report, nil); e != nil {
				return e
			}
			if r.State == "uncertain" {
				return nil
			}
			return w.clearReceipt()
		}
		if r.MutationAuthorized {
			if r.State != "uncertain" {
				r.State = "uncertain"
				if e = w.save(r); e != nil {
					return e
				}
			}
			return w.recoverAuthorized(ctx, r)
		}
		if e = w.report(ctx, r, r.State, false, r.Error); e != nil {
			return e
		}
		return w.clearReceipt()
	}
	var claimed struct {
		Work *OperationWork `json:"work"`
	}
	if e = w.client.call(ctx, "/claim", map[string]string{"agentInstanceId": instance}, &claimed); e != nil {
		return e
	}
	if claimed.Work == nil {
		return nil
	}
	work := claimed.Work
	if work.OperationID == "" || work.ClaimToken == "" || (work.App.ID == "" && work.Kind != "runtime_prep") {
		return fmt.Errorf("applications: malformed claimed work")
	}
	r = &workerReceipt{OwnerInstanceID: instance, OwnerDaemonEpoch: work.App.DaemonEpoch, OwnerProject: work.App.Project, OperationID: work.OperationID, AppID: work.App.ID, Generation: work.App.Generation, Kind: work.Kind, ClaimToken: work.ClaimToken, State: "claimed"}
	if e = w.save(r); e != nil {
		return e
	}
	return w.execute(ctx, r, work)
}
func (w *operationWorker) progress(ctx context.Context, r *workerReceipt, seq uint64, stage, status, reason string) error {
	if seq <= r.ProgressSeq {
		seq = r.ProgressSeq + 1
	}
	r.ProgressSeq = seq
	if err := w.save(r); err != nil {
		return err
	}
	return w.client.call(ctx, "/"+url.PathEscape(r.OperationID)+"/progress", map[string]any{"claimToken": r.ClaimToken, "seq": seq, "at": time.Now().UTC().Format(time.RFC3339Nano), "items": []any{map[string]any{"stage": stage, "status": status, "reason": reason}}}, nil)
}
func (w *operationWorker) execute(ctx context.Context, r *workerReceipt, work *OperationWork) error {
	if e := w.progress(ctx, r, 1, "claim", "ok", ""); e != nil {
		return e
	}
	if work.Kind == "runtime_prep" {
		return w.runRuntimePrep(ctx, r, work)
	}
	if work.Kind == "verify_source" {
		if work.SourcePath == "" {
			r.State = "failed"
			r.Error = "source_path_required"
			if e := w.save(r); e != nil {
				return e
			}
			return w.report(ctx, r, "failed", false, r.Error)
		}
		if e := w.progress(ctx, r, 2, "preflight", "started", ""); e != nil {
			return e
		}
		source, e := ReadSource(work.SourcePath)
		if e != nil {
			r.State = "failed"
			r.Error = "source_verification_failed"
			if se := w.save(r); se != nil {
				return se
			}
			if pe := w.progress(ctx, r, 2, "preflight", "failed", r.Error); pe != nil {
				return pe
			}
			return w.report(ctx, r, "failed", false, r.Error)
		}
		if source.Anchor == nil {
			return fmt.Errorf("applications: source anchor missing")
		}
		if _, e = RecheckSource(*source.Anchor); e != nil {
			r.State = "failed"
			r.Error = "source_changed"
			if se := w.save(r); se != nil {
				return se
			}
			return w.report(ctx, r, "failed", false, r.Error)
		}
		if work.OneShotServices == nil {
			r.State = "failed"
			r.Error = "unsupported_operation"
			if se := w.save(r); se != nil {
				return se
			}
			if pe := w.progress(ctx, r, 2, "preflight", "failed", "source_one_shot_classification_required"); pe != nil {
				return pe
			}
			return w.report(ctx, r, "failed", false, "source_one_shot_classification_required")
		}
		oneShot := make(map[string]bool, len(work.OneShotServices))
		missing := make([]string, 0)
		for _, name := range work.OneShotServices {
			if name == "" || oneShot[name] {
				return w.fail(ctx, r, ErrMalformed, fmt.Errorf("invalid one-shot classification"))
			}
			if _, ok := source.Services[name]; ok {
				oneShot[name] = true
			} else {
				missing = append(missing, name)
			}
		}
		sort.Strings(missing)
		if len(missing) > 0 {
			return w.fail(ctx, r, ErrMalformed, fmt.Errorf("one-shot services do not exist in source"))
		}
		if source.Project != "" && work.App.Project != "" && source.Project != work.App.Project {
			return w.fail(ctx, r, ErrSourceDrift, fmt.Errorf("source project does not match application binding"))
		}
		project := source.Project
		if project == "" {
			project = work.App.Project
		}
		services := make([]map[string]any, 0, len(source.Services))
		graph := make([]map[string]any, 0, len(source.Services))
		for name, svc := range source.Services {
			kind := "longlived"
			if oneShot[name] {
				kind = "oneshot"
			}
			services = append(services, map[string]any{"name": name, "kind": kind, "profiles": svc.Profiles, "healthcheck": svc.Healthcheck})
			deps := make([]string, 0, len(svc.DependsOn))
			for dep := range svc.DependsOn {
				deps = append(deps, dep)
			}
			sort.Strings(deps)
			conditions := map[string]string{}
			for dep, edge := range svc.DependsOn {
				condition := "started"
				if edge.Condition == "service_healthy" {
					condition = "healthy"
				}
				if edge.Condition == "service_completed_successfully" {
					condition = "completed"
				}
				conditions[dep] = condition
			}
			graph = append(graph, map[string]any{"service": name, "dependsOn": deps, "dependencyConditions": conditions})
		}
		sort.Slice(services, func(i, j int) bool { return services[i]["name"].(string) < services[j]["name"].(string) })
		sort.Slice(graph, func(i, j int) bool { return graph[i]["service"].(string) < graph[j]["service"].(string) })
		observed := map[string]any{"path": work.SourcePath, "verified": true, "digest": source.Digest, "project": project, "services": services, "dependenciesGraph": graph, "unsupported": []string{}}
		r.State = "succeeded"
		if e = w.save(r); e != nil {
			return e
		}
		if e = w.progress(ctx, r, 2, "preflight", "ok", ""); e != nil {
			return e
		}
		return w.reportObserved(ctx, r, "succeeded", false, []any{observed}, "")
	}
	if work.LifecyclePlan != nil && strings.HasPrefix(work.Kind, "lifecycle_") {
		if err := validateWorkLifecyclePlan(work); err != nil {
			return w.fail(ctx, r, ErrUnsupportedOper, err)
		}
		plan := work.LifecyclePlan
		plan.Action = strings.TrimPrefix(work.Kind, "lifecycle_")
		payloadDigest, hashErr := canonicalHashJSON([2]any{"appId", work.App.ID}, [2]any{"daemonEpoch", work.App.DaemonEpoch}, [2]any{"generation", work.App.Generation}, [2]any{"operationId", work.OperationID}, [2]any{"kind", work.Kind}, [2]any{"sourceDigest", plan.SourceDigest}, [2]any{"observedFingerprint", plan.ObservedFingerprint})
		if hashErr != nil {
			return w.fail(ctx, r, ErrMalformed, hashErr)
		}
		scope := "project:" + work.VpsID + "|" + work.App.DaemonEpoch + "|" + work.App.Project
		if err := acquireScope(scope, "compose-operation", work.OperationID, false, 0); err != nil {
			return w.fail(ctx, r, "scope_busy", err)
		}
		progressFn := func(seq uint64, stage, service, status, reason string) error {
			return w.progress(ctx, r, seq, stage, status, reason)
		}
		before := func() error {
			if err := w.authorize(ctx, r, payloadDigest); err != nil {
				return err
			}
			if err := markMutating(scope, "compose-operation", work.OperationID); err != nil {
				return err
			}
			r.Executed = true
			return w.save(r)
		}
		lifecycleCtx, cancelLifecycle := context.WithTimeout(ctx, deployReadinessTimeout(work.ReadinessSeconds))
		defer cancelLifecycle()
		status, reason, runErr := RunLifecycle(lifecycleCtx, plan, time.Duration(work.StopGraceSeconds)*time.Second, w.control, w.engine, w.resolver, progressFn, before)
		if runErr != nil && reason == "" {
			reason = "lifecycle_failed"
		}
		if r.State == "uncertain" {
			status = "uncertain"
		}
		r.State = status
		r.Error = reason
		if err := w.save(r); err != nil {
			return err
		}
		if status == "uncertain" {
			return w.report(ctx, r, "uncertain", r.Executed, reason)
		}
		if status != "succeeded" {
			_ = releaseScope(scope, "compose-operation", work.OperationID)
			return w.report(ctx, r, "failed", r.Executed, reason)
		}
		if err := w.report(ctx, r, "succeeded", r.Executed, ""); err != nil {
			return err
		}
		_ = releaseScope(scope, "compose-operation", work.OperationID)
		return w.clearReceipt()
	}
	var rev deployRevision
	if work.Kind == "preview_prepare" {
		if e := strictDecodeJSON(work.Revision, &rev); e != nil || rev.ComposeYaml == "" {
			return w.fail(ctx, r, ErrMalformed, fmt.Errorf("preview_prepare requires revision composeYaml"))
		}
		envY, secretVersions, err := deployEnv(rev, work.Secrets)
		if e := err; e != nil {
			return w.fail(ctx, r, ErrMalformed, e)
		}
		composeY := []byte(rev.ComposeYaml)
		fp, fpErr := runtimeFingerprint(ctx, w.engine, w.keyForID, work.App.Project)
		if fpErr != nil {
			return w.fail(ctx, r, "observation_failed", fpErr)
		}
		if work.Preview != nil && work.Preview.ObservedFingerprint != "" && work.Preview.ObservedFingerprint != fp {
			return w.fail(ctx, r, "observed_fingerprint_mismatch", fmt.Errorf("preview fingerprint mismatch"))
		}
		if e := w.progress(ctx, r, 2, "preflight", "started", ""); e != nil {
			return e
		}
		previewArgs := deployArgs(rev.Profiles, "config", "--format", "json")
		canonical, redacted, imageDigests, removed, removals, canDigest, inventoryFP, credentialVersions, perr := preparePreview(ctx, work.OperationID, composeY, envY, previewArgs, secretValues(work.Secrets), work.RegistryCredentials, w.engine, w.keyForID, work.App.Project, work.App.ID)
		if perr != nil {
			return w.fail(ctx, r, "preview_resolution_failed", fmt.Errorf("preview: %s", perr))
		}
		if len(canonical) == 0 || len(redacted) == 0 || canDigest == "" {
			return w.fail(ctx, r, "preview_resolution_failed", fmt.Errorf("preview: missing canonical model"))
		}
		// Fail closed on an invalid shared inventory identity: a removal set
		// can only be reported together with its ownership binding and a
		// fingerprint shared with the deploy-side capture format.
		ownership := ownershipBinding{AgentInstanceID: w.client.instance, DaemonEpoch: work.App.DaemonEpoch, ProjectName: work.App.Project}
		if len(removals) > 0 {
			if ownership.AgentInstanceID == "" || ownership.DaemonEpoch == "" || ownership.ProjectName == "" || inventoryFP == "" {
				return w.fail(ctx, r, "preview_result_invalid", fmt.Errorf("preview removal identity incomplete"))
			}
		}
		var canonicalRaw any
		var redactedRaw any
		if e := json.Unmarshal(canonical, &canonicalRaw); e != nil {
			return w.fail(ctx, r, "preview_resolution_failed", fmt.Errorf("preview: malformed canonical model"))
		}
		if e := json.Unmarshal(redacted, &redactedRaw); e != nil {
			return w.fail(ctx, r, "preview_resolution_failed", fmt.Errorf("preview: malformed redacted model"))
		}
		r.State = "succeeded"
		if e := w.save(r); e != nil {
			return e
		}
		versions := map[string]int{}
		for k, v := range secretVersions {
			versions[k] = v
		}
		observed := map[string]any{"digest": canDigest, "canonicalModelJson": string(canonical), "canonicalModel": canonicalRaw, "redactedModel": redactedRaw, "imageDigests": imageDigests, "removedServiceIds": removed, "removals": removals, "ownershipBinding": ownership, "inventoryFingerprint": inventoryFP, "observedFingerprint": fp, "secretVersions": versions, "credentialVersions": credentialVersions, "revisionSeq": rev.Seq}
		return w.reportObserved(ctx, r, "succeeded", false, []any{observed}, "")
	}
	if work.Kind == "deploy" {
		return w.runDeploy(ctx, r, work)
	}
	r.State = "failed"
	r.Error = "unsupported_operation"
	if e := w.save(r); e != nil {
		return e
	}
	if e := w.progress(ctx, r, 2, "preflight", "failed", r.Error); e != nil {
		return e
	}
	return w.report(ctx, r, "failed", false, r.Error)
}

type Worker struct {
	inner    *operationWorker
	instance string
}

func NewWorker(cfg *config.Config, instance, receiptPath string, keyForID func(string) string) (*Worker, error) {
	if instance == "" || receiptPath == "" || keyForID == nil {
		return nil, fmt.Errorf("applications: invalid worker identity or receipt path")
	}
	w, e := newOperationWorker(cfg, instance, receiptPath, keyForID)
	if e != nil {
		return nil, e
	}
	return &Worker{inner: w, instance: instance}, nil
}
func (w *Worker) ProcessOne(ctx context.Context) error { return w.inner.ProcessOne(ctx, w.instance) }

// Runtime preparation uses the separately confirmed endpoint and durable
// mutation authorization before installing the pinned official runtime.
func (w *operationWorker) runRuntimePrep(ctx context.Context, r *workerReceipt, work *OperationWork) error {
	if e := w.progress(ctx, r, 2, "preflight", "started", ""); e != nil {
		return e
	}
	rp := work.RuntimePrep
	if rp == nil {
		rp = &RuntimePrepWork{PluginRequired: false}
	}
	observed := map[string]any{"confirmedMode": "probe_only", "installPerformed": false, "pluginPath": "", "composeVersion": ""}
	rt, rtErr := DetectRuntime()
	if rtErr != nil || !compatibleComposeVersion(rt.Version) {
		if !rp.PluginRequired {
			return w.fail(ctx, r, ErrRuntimeUnavailable, fmt.Errorf("runtime installation not confirmed"))
		}
		payload, hashErr := canonicalHashJSON([2]any{"operationId", work.OperationID}, [2]any{"kind", work.Kind}, [2]any{"generation", work.App.Generation})
		if hashErr != nil {
			return w.fail(ctx, r, ErrMalformed, hashErr)
		}
		if err := w.authorize(ctx, r, payload); err != nil {
			return err
		}
		rt, rtErr = prepareRuntime(ctx)
		observed["installPerformed"] = rtErr == nil
	}
	if rtErr != nil {
		errCode := ErrRuntimeUnavailable
		var cliErr *DockerCLIMissingError
		if errors.As(rtErr, &cliErr) || strings.Contains(rtErr.Error(), ErrDockerCLIMissing) {
			errCode = ErrDockerCLIMissing
			observed["instructions"] = DockerCLIManualInstructions
			observed["unsupportedReason"] = ErrDockerCLIMissing
		}
		if e := w.progress(ctx, r, 2, "preflight", "failed", errCode); e != nil {
			return e
		}
		r.State = "failed"
		r.Error = errCode
		if e := w.save(r); e != nil {
			return e
		}
		return w.reportObserved(ctx, r, "failed", r.MutationAuthorized, []any{observed}, errCode)
	}
	observed["composeVersion"] = rt.Version
	observed["pluginPath"] = rt.Path
	if rt.Mode == ModePlugin {
		observed["confirmedMode"] = "plugin"
	} else {
		observed["confirmedMode"] = "standalone"
	}
	if rp.ComposeVersion != "" && rp.ComposeVersion != rt.Version {
		if e := w.progress(ctx, r, 2, "preflight", "failed", "compose_version_mismatch"); e != nil {
			return e
		}
		r.State = "failed"
		r.Error = "compose_version_mismatch"
		if e := w.save(r); e != nil {
			return e
		}
		return w.report(ctx, r, "failed", r.MutationAuthorized, r.Error)
	}
	if e := w.progress(ctx, r, 2, "preflight", "ok", ""); e != nil {
		return e
	}
	r.State = "succeeded"
	if e := w.save(r); e != nil {
		return e
	}
	return w.reportObserved(ctx, r, "succeeded", r.MutationAuthorized, []any{observed}, "")
}

// validateWorkLifecyclePlan refuses claim gaps the agent must never synthesize:
// a verified source digest, an explicit service order, an explicit dependsOn
// edge list, and explicit one-shot status whenever replica state is claimed.
func validateWorkLifecyclePlan(work *OperationWork) error {
	p := work.LifecyclePlan
	if p == nil || work.Kind == "" || p.SourcePath == "" || p.SourceDigest == "" || len(p.Order) == 0 || len(p.Services) == 0 {
		return fmt.Errorf("%s", ErrMalformed)
	}
	byName := make(map[string]LifecycleWorkService, len(p.Services))
	for _, svc := range p.Services {
		if svc.Name == "" || byName[svc.Name].Name != "" {
			return fmt.Errorf("%s", ErrMalformed)
		}
		byName[svc.Name] = svc
	}
	for _, name := range p.Order {
		svc, ok := byName[name]
		if !ok {
			return fmt.Errorf("%s", ErrMalformed)
		}
		for _, dep := range svc.DependsOn {
			dep2, ok := byName[dep]
			if !ok || !dep2.Selected {
				return fmt.Errorf("%s", ErrMalformed)
			}
		}
		for _, rep := range svc.Replicas {
			if rep.ContainerKey == "" || len(rep.ContainerKey) != 32 {
				return fmt.Errorf("%s", ErrMalformed)
			}
			switch rep.OneShotStatus {
			case "", "running", "never_started", "succeeded", "failed", "exited_0", "exited_1":
			default:
				return fmt.Errorf("%s", ErrMalformed)
			}
		}
	}
	return nil
}
