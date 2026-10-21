//go:build linux

package applications

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/vps-manager/agent/internal/commands"
)

// Lifecycle dependency-order execution on exact captured container IDs.
//
// Rules (plan §1/§2 and decisions 27/29/30):
//   - Start never runs Compose up and never creates a container; a missing
//     long-lived container refuses the whole plan (missing_container).
//   - Restart stops long-lived services in reverse dependency order, then
//     starts forward with readiness gates; completed one-shots are never
//     rerun.
//   - A never-completed eligible task dependency is awaited only when needed
//     by the selected dependency graph; previously failed tasks are not
//     auto-retried (they remain a refusal for this cycle).
//   - Every mutation is fenced by the durable receipt + authorization
//     handshake from worker.go; per-scope host locks protect against the
//     legacy container worker.

type LifecyclePlan struct {
	Mode      string                 `json:"mode"` // lifecycle_start|lifecycle_stop|lifecycle_restart
	AppID     string                 `json:"app"`
	Project   string                 `json:"project"`
	Epoch     int64                  `json:"daemonEpoch"`
	Order     []string               `json:"order"`
	Selected  []string               `json:"selected"`
	OneShots  map[string]OneShotPlan `json:"oneShots"`
	StopGrace time.Duration
}

// OneShotPlan is one explicitly classified one-shot service.
type OneShotPlan struct {
	// NeverRerun when a prior successful completion is known (verified from
	// the inspected container's exited-0 state at plan time).
	NeverRerun bool
	// Awaitable when the plan may start/await this task as a dependency.
	Awaitable bool
	// Failed previously means it can change only with a deploy, never here.
	Failed bool
	// Status from the current snapshot.
	State        string
	ExitCode     int
	ContainerKey string
}

// ValidatePlan re-verifies structural invariants before any mutation.
func (p *LifecyclePlan) ValidatePlan() error {
	if p.Mode != "lifecycle_start" && p.Mode != "lifecycle_stop" && p.Mode != "lifecycle_restart" {
		return fmt.Errorf("%s", ErrUnsupportedOper)
	}
	if p.AppID == "" || p.Project == "" {
		return fmt.Errorf("%s", ErrMalformed)
	}
	for _, s := range p.Selected {
		if !safeMetadata(s, MaxServiceNameBytes) {
			return fmt.Errorf("%s", ErrMalformed)
		}
	}
	for name := range p.OneShots {
		if !safeMetadata(name, MaxServiceNameBytes) {
			return fmt.Errorf("%s", ErrMalformed)
		}
	}
	// Dependency integrity: every occurred dependency must be in selected
	// when it changes state, caught by orderGraph at parse time.
	return nil
}

// reverseOrder returns services ordered last dependency first.
func reverseOrder(order []string) []string {
	out := make([]string, 0, len(order))
	for i := len(order) - 1; i >= 0; i-- {
		out = append(out, order[i])
	}
	return out
}

// planMissingContainers refuses the whole plan when an expected long-lived
// service container is absent from the observed inventory: recovery stays
// explicit via deploy/adoption.
func planMissingContainers(containersByService map[string][]string, plan *LifecyclePlan) error {
	for _, svc := range plan.Selected {
		if plan.oneShot(svc) {
			continue
		}
		if len(containersByService[svc]) == 0 {
			return fmt.Errorf("missing_container:%s", svc)
		}
	}
	return nil
}

func (p *LifecyclePlan) oneShot(name string) bool {
	o, ok := p.OneShots[name]
	return ok && (o.NeverRerun || o.Awaitable)
}

func dependencyReady(snap *EngineContainerSnapshot, svc LifecycleWorkService) bool {
	if svc.Kind == "oneshot" {
		return ObserveReadiness(snap, true).Ready
	}
	if snap == nil || !snap.Running {
		return false
	}
	switch svc.Condition {
	case "healthy", "service_healthy":
		return snap.Health == "healthy"
	case "completed", "service_completed_successfully":
		return false
	default:
		return true
	}
}

// RunLifecycle executes allowed lifecycle on verified exact containers with
// accumulated per-service progress. `resolve` maps opaque container keys to
// full IDs through the existing allowlisted resolver (never labels).
func RunLifecycle(
	ctx context.Context,
	work *LifecycleWorkPlan,
	stopGrace time.Duration,
	control *commands.DockerControl,
	engine *engineClient,
	resolve commands.TargetResolver,
	progress func(seq uint64, stage, service, status, reason string) error,
	beforeMutation func() error,
) (string, string, error) {
	if work == nil || control == nil || engine == nil || resolve == nil || progress == nil || beforeMutation == nil || (work.Action != "start" && work.Action != "stop" && work.Action != "restart") {
		return "failed", ErrMalformed, fmt.Errorf("%s", ErrMalformed)
	}
	if work.SourcePath == "" || work.SourceDigest == "" {
		return "failed", "source_binding_missing", fmt.Errorf("source_binding_missing")
	}
	source, err := ReadSource(work.SourcePath)
	if err != nil || source.Digest != work.SourceDigest {
		return "failed", ErrSourceDrift, fmt.Errorf("%s", ErrSourceDrift)
	}
	if source.Anchor == nil {
		return "failed", ErrSourceDrift, fmt.Errorf("%s", ErrSourceDrift)
	}
	if _, err = RecheckSource(*source.Anchor); err != nil {
		return "failed", ErrSourceDrift, fmt.Errorf("%s", ErrSourceDrift)
	}
	mutationAuthorized := false
	authorizeMutation := func() error {
		if mutationAuthorized {
			return nil
		}
		if _, e := RecheckSource(*source.Anchor); e != nil {
			return fmt.Errorf("%s", ErrSourceDrift)
		}
		if e := beforeMutation(); e != nil {
			return e
		}
		mutationAuthorized = true
		return nil
	}
	selected := make([]LifecycleWorkService, 0, len(work.Services))
	byName := make(map[string]LifecycleWorkService, len(work.Services))
	for _, svc := range work.Services {
		if !safeMetadata(svc.Name, MaxServiceNameBytes) || (svc.Kind != "longlived" && svc.Kind != "oneshot") {
			return "failed", ErrMalformed, fmt.Errorf("%s", ErrMalformed)
		}
		byName[svc.Name] = svc
		if svc.Selected {
			selected = append(selected, svc)
		}
	}
	seenOrder := map[string]bool{}
	for _, name := range work.Order {
		svc, ok := byName[name]
		if !ok || seenOrder[name] {
			return "failed", ErrMalformed, fmt.Errorf("invalid_dependency_order")
		}
		for _, dep := range svc.DependsOn {
			if !seenOrder[dep] {
				return "failed", ErrMalformed, fmt.Errorf("invalid_dependency_order")
			}
		}
		seenOrder[name] = true
	}
	for _, svc := range selected {
		if !seenOrder[svc.Name] {
			return "failed", ErrMalformed, fmt.Errorf("missing_dependency_order")
		}
	}
	if len(work.Order) == 0 {
		return "failed", ErrMalformed, fmt.Errorf("%s", ErrMalformed)
	}
	resolved := make(map[string]string)
	for _, svc := range work.Services {
		if !svc.Selected {
			continue
		}
		for _, rep := range svc.Replicas {
			id, ok := resolve(rep.ContainerKey)
			if !ok {
				return "failed", "missing_container:" + svc.Name, fmt.Errorf("missing_container:%s", svc.Name)
			}
			snap, e := engine.InspectContainer(ctx, id)
			if e != nil {
				return "failed", "observation_failed", e
			}
			if rep.State != "" && snap.State != rep.State {
				return "failed", "observation_changed", fmt.Errorf("observation_changed:%s", svc.Name)
			}
			if rep.Health != "" && snap.Health != rep.Health {
				return "failed", "observation_changed", fmt.Errorf("observation_changed:%s", svc.Name)
			}
			if svc.Kind == "oneshot" {
				observed := "never_started"
				if snap.State == "running" {
					observed = "running"
				} else if snap.State == "exited" && snap.ExitCode == 0 {
					observed = "succeeded"
				} else if snap.State == "exited" {
					observed = "failed"
				}
				if rep.OneShotStatus != "" && observed != rep.OneShotStatus {
					return "failed", "observation_changed", fmt.Errorf("observation_changed:%s", svc.Name)
				}
			}
			resolved[rep.ContainerKey] = id
		}
	}
	targetResolve := resolve
	resolve = func(key string) (string, bool) {
		if id, ok := resolved[key]; ok {
			return id, true
		}
		return targetResolve(key)
	}
	for _, svc := range selected {
		if len(svc.Replicas) == 0 && svc.Kind == "longlived" {
			return "failed", "missing_container:" + svc.Name, fmt.Errorf("missing_container:%s", svc.Name)
		}
	}
	seq := uint64(2)
	step := func(stage, service, status, reason string) error {
		seq++
		return progress(seq, stage, service, status, reason)
	}
	if work.Action == "stop" || work.Action == "restart" {
		order := reverseOrder(work.Order)
		for _, name := range order {
			svc, ok := byName[name]
			if !ok || !svc.Selected || svc.Kind == "oneshot" {
				continue
			}
			for _, rep := range svc.Replicas {
				id, ok := resolve(rep.ContainerKey)
				if !ok {
					return "failed", "missing_container:" + name, fmt.Errorf("missing_container:%s", name)
				}
				if err := authorizeMutation(); err != nil {
					return "failed", ErrBindUnauthorized, err
				}
				if err := step("apply", name, "started", ""); err != nil {
					return "uncertain", "progress_unavailable", err
				}
				grace := int(stopGrace.Seconds())
				if grace < 1 {
					grace = 10
				}
				if grace > 120 {
					grace = 120
				}
				res := control.Act(ctx, "stop", id, false)
				if res.Uncertain {
					return "uncertain", res.ErrorCode, fmt.Errorf("%s", res.ErrorCode)
				}
				if res.ErrorCode != "" && res.ErrorCode != "container_not_found" {
					return "failed", res.ErrorCode, fmt.Errorf("%s", res.ErrorCode)
				}
				if err := step("apply", name, "ok", ""); err != nil {
					return "uncertain", "progress_unavailable", err
				}
			}
		}
		if work.Action == "stop" {
			return "succeeded", "", nil
		}
	}
	for _, name := range work.Order {
		svc, ok := byName[name]
		if !ok || !svc.Selected {
			continue
		}
		for _, dep := range svc.DependsOn {
			depSvc, exists := byName[dep]
			if !exists {
				return "failed", ErrMalformed, fmt.Errorf("%s", ErrMalformed)
			}
			for _, rep := range depSvc.Replicas {
				id, found := resolve(rep.ContainerKey)
				if !found {
					return "failed", "missing_container:" + dep, fmt.Errorf("missing_container:%s", dep)
				}
				snap, e := engine.InspectContainer(ctx, id)
				if e != nil {
					return "failed", ErrDependencyUnready, e
				}
				if rep.OneShotStatus == "succeeded" {
					continue
				}
				condition := svc.DependencyConditions[dep]
				if condition == "" {
					// Compose contract: an edge without a condition is the
					// started handoff. Never borrow the dependency's own
					// head condition for an edge it does not carry.
					condition = "started"
				}
				depSvc.Condition = condition
				if !dependencyReady(snap, depSvc) {
					return "failed", ErrDependencyUnready, fmt.Errorf("%s:%s", ErrDependencyUnready, dep)
				}
			}
		}
		if svc.Kind == "oneshot" {
			if len(svc.Replicas) == 0 {
				return "failed", "missing_container:" + name, fmt.Errorf("missing_container:%s", name)
			}
			if svc.Replicas[0].OneShotStatus == "succeeded" {
				continue
			}
			if svc.Replicas[0].OneShotStatus == "failed" {
				return "failed", "oneshot_failed_requires_deploy", fmt.Errorf("oneshot_failed_requires_deploy")
			}
		}
		if svc.Kind == "longlived" && len(svc.Replicas) == 0 {
			return "failed", "missing_container:" + name, fmt.Errorf("missing_container:%s", name)
		}
		for _, rep := range svc.Replicas {
			id, found := resolve(rep.ContainerKey)
			if !found {
				return "failed", "missing_container:" + name, fmt.Errorf("missing_container:%s", name)
			}
			if svc.Kind == "oneshot" && rep.OneShotStatus == "succeeded" {
				continue
			}
			snap, e := engine.InspectContainer(ctx, id)
			if e != nil {
				return "failed", e.Error(), e
			}
			if snap.Running {
				continue
			}
			if err := authorizeMutation(); err != nil {
				return "failed", ErrBindUnauthorized, err
			}
			if err := step("apply", name, "started", ""); err != nil {
				return "uncertain", "progress_unavailable", err
			}
			action := "start"
			if work.Action == "restart" && snap.State == "running" {
				action = "restart"
			}
			res := control.Act(ctx, action, id, false)
			if res.Uncertain {
				return "uncertain", res.ErrorCode, fmt.Errorf("%s", res.ErrorCode)
			}
			if res.ErrorCode != "" {
				return "failed", res.ErrorCode, fmt.Errorf("%s", res.ErrorCode)
			}
			if err := step("apply", name, "ok", ""); err != nil {
				return "uncertain", "progress_unavailable", err
			}
		}
		deadline := time.Now().Add(300 * time.Second)
		for {
			all := true
			for _, rep := range svc.Replicas {
				id, found := resolve(rep.ContainerKey)
				if !found {
					return "failed", "missing_container:" + name, fmt.Errorf("missing_container:%s", name)
				}
				snap, e := engine.InspectContainer(ctx, id)
				if e != nil {
					all = false
					break
				}
				if !dependencyReady(snap, svc) {
					all = false
					break
				}
			}
			if all {
				break
			}
			if time.Now().After(deadline) {
				return "failed", ErrReadinessTimeout, fmt.Errorf("%s", ErrReadinessTimeout)
			}
			select {
			case <-ctx.Done():
				return "uncertain", ctx.Err().Error(), ctx.Err()
			case <-time.After(time.Second):
			}
		}
	}
	return "succeeded", "", nil
}

// planFailedOneShots detects previously exited tasks that require explicit
// approval; verdict is returned so the API may surface them before any
// retry (completed tasks never rerun).
func planFailedOneShots(plan *LifecyclePlan) []string {
	var failed []string
	for name, o := range plan.OneShots {
		if o.State == "exited" && o.ExitCode != 0 {
			failed = append(failed, name)
		}
	}
	sort.Strings(failed)
	return failed
}

var _ = json.Marshal
var _ = strings.TrimSpace
