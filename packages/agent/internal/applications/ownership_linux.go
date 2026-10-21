//go:build linux

package applications

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type runtimeFingerprintRow struct {
	ContainerKey string `json:"containerKey"`
	Project      string `json:"project"`
	Service      string `json:"service"`
	Slot         int    `json:"slot"`
	State        string `json:"state"`
	Health       string `json:"health"`
}

func runtimeFingerprint(ctx context.Context, e *engineClient, keyForID func(string) string, project string) (string, error) {
	ids, err := e.listAllIDs(ctx)
	if err != nil {
		return "", err
	}
	if len(ids) > MaxInventoryContainers || keyForID == nil {
		return "", fmt.Errorf("inventory_incomplete")
	}
	rows := make([]runtimeFingerprintRow, 0)
	for _, id := range ids {
		snap, err := e.InspectContainer(ctx, id)
		if err != nil {
			return "", err
		}
		if snap.Labels["com.docker.compose.project"] != project {
			continue
		}
		slot, _ := strconv.Atoi(snap.Labels["com.docker.compose.container-number"])
		health := snap.Health
		if health == "none" {
			health = ""
		}
		rows = append(rows, runtimeFingerprintRow{keyForID(id), project, snap.Labels["com.docker.compose.service"], slot, snap.State, health})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ContainerKey < rows[j].ContainerKey })
	b, err := json.Marshal(rows)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

type durableOwnership struct {
	Binding    ownershipBinding  `json:"binding"`
	AppID      string            `json:"appId"`
	Containers map[string]string `json:"containers"`
}

func ownershipPath(appID string) string { return filepath.Join(workRoot(), appID, "ownership.json") }
func (w *operationWorker) saveOwnership(ctx context.Context, work *OperationWork, model deployComposeModel) error {
	manifest := durableOwnership{Binding: ownershipBinding{w.agentInstanceID(), work.App.DaemonEpoch, work.App.Project}, AppID: work.App.ID, Containers: map[string]string{}}
	ids, err := w.engine.listAllIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		snap, err := w.engine.InspectContainer(ctx, id)
		if err != nil {
			return err
		}
		svc := snap.Labels["com.docker.compose.service"]
		if snap.Labels["com.docker.compose.project"] == work.App.Project {
			if _, ok := model.Services[svc]; ok {
				manifest.Containers[id] = svc
			}
		}
	}
	b, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	dir := filepath.Dir(ownershipPath(work.App.ID))
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".ownership-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	ce := f.Close()
	if err == nil {
		err = ce
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, ownershipPath(work.App.ID)); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func verifyDurableOwnership(appID, instance, epoch, project string, ids map[string]string) error {
	b, err := os.ReadFile(ownershipPath(appID))
	if err != nil {
		return fmt.Errorf("durable_ownership_missing")
	}
	var m durableOwnership
	if json.Unmarshal(b, &m) != nil || m.AppID != appID || m.Binding.AgentInstanceID != instance || m.Binding.DaemonEpoch != epoch || m.Binding.ProjectName != project {
		return fmt.Errorf("durable_ownership_mismatch")
	}
	for id, svc := range ids {
		if m.Containers[id] != svc {
			return fmt.Errorf("durable_ownership_mismatch")
		}
	}
	return nil
}

// A PID alone is not a process identity: record kernel start ticks and group.
func processStartIdentity(pid int) (string, error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	end := strings.LastIndex(string(b), ")")
	if end < 0 {
		return "", fmt.Errorf("process_identity_unavailable")
	}
	fields := strings.Fields(string(b)[end+1:])
	if len(fields) < 20 {
		return "", fmt.Errorf("process_identity_unavailable")
	}
	return fields[19], nil
}
func (w *operationWorker) trackChild(r *workerReceipt, stage string) func(*exec.Cmd) error {
	return func(c *exec.Cmd) error {
		start, err := processStartIdentity(c.Process.Pid)
		if err != nil {
			return err
		}
		r.ChildPID = c.Process.Pid
		r.ChildGroup = c.Process.Pid
		r.ChildStart = start
		r.ChildStage = stage
		return w.save(r)
	}
}

func (w *operationWorker) deployEvidence(ctx context.Context, work *OperationWork, model deployComposeModel) ([]map[string]any, map[string]any, error) {
	ids, err := w.engine.listAllIDs(ctx)
	if err != nil {
		return nil, nil, err
	}
	one := map[string]bool{}
	for _, name := range work.OneShotServices {
		one[name] = true
	}
	outcomes := make([]map[string]any, 0)
	owned := make([]map[string]string, 0)
	for _, id := range ids {
		snap, err := w.engine.InspectContainer(ctx, id)
		if err != nil {
			return nil, nil, err
		}
		svc := snap.Labels["com.docker.compose.service"]
		if snap.Labels["com.docker.compose.project"] != work.App.Project {
			continue
		}
		if _, ok := model.Services[svc]; !ok {
			continue
		}
		ready := ObserveReadiness(snap, one[svc])
		outcomes = append(outcomes, map[string]any{"service": svc, "status": ready.Detail, "reason": "", "containerKeys": []string{w.keyForID(id)}})
		owned = append(owned, map[string]string{"containerKey": w.keyForID(id), "service": svc})
	}
	return outcomes, map[string]any{"agentInstanceId": w.agentInstanceID(), "daemonEpoch": work.App.DaemonEpoch, "projectName": work.App.Project, "containers": owned}, nil
}

// Recovery is observational only. A disappeared child cannot prove whether a
// daemon request committed; no uncertain lock is released and no step replayed.
func (w *operationWorker) recoverAuthorized(ctx context.Context, r *workerReceipt) error {
	childStatus := "not_recorded"
	if r.ChildPID > 0 {
		start, err := processStartIdentity(r.ChildPID)
		if err != nil {
			childStatus = "absent"
		} else if start != r.ChildStart {
			childStatus = "pid_reused"
		} else {
			childStatus = "running_identity_verified"
		}
	}
	observed := map[string]any{"recovery": map[string]any{"childStatus": childStatus, "childPid": r.ChildPID, "childGroup": r.ChildGroup, "childStage": r.ChildStage}, "serviceOutcomes": []any{}}
	if r.OwnerProject != "" {
		ids, err := w.engine.listAllIDs(ctx)
		if err == nil {
			outcomes := make([]map[string]any, 0)
			for _, id := range ids {
				snap, e := w.engine.InspectContainer(ctx, id)
				if e != nil {
					continue
				}
				if snap.Labels["com.docker.compose.project"] != r.OwnerProject {
					continue
				}
				outcomes = append(outcomes, map[string]any{"service": snap.Labels["com.docker.compose.service"], "status": snap.State, "reason": "recovery_observation_only", "containerKeys": []string{w.keyForID(id)}})
			}
			observed["serviceOutcomes"] = outcomes
		}
	}
	r.State = "uncertain"
	return w.reportObserved(ctx, r, "uncertain", r.Executed, []any{observed}, "worker_restarted_after_authorization")
}

type adoptionOwnership struct {
	AgentInstanceID string `json:"agentInstanceId"`
	DaemonEpoch     string `json:"daemonEpoch"`
	ProjectName     string `json:"projectName"`
	Containers      []struct {
		ContainerKey string `json:"containerKey"`
		Service      string `json:"service"`
	} `json:"containers"`
}

// Only the API's confirmed immutable adoption manifest can import ownership;
// an inventory label on its own never grants authority over a container.
func (w *operationWorker) importAdoptionOwnership(ctx context.Context, work *OperationWork, expectedFP string) error {
	m := work.AdoptionOwnership
	if m == nil {
		return nil
	}
	if m.AgentInstanceID != w.agentInstanceID() || m.DaemonEpoch != work.App.DaemonEpoch || m.ProjectName != work.App.Project || len(m.Containers) == 0 {
		return fmt.Errorf("adoption_binding_mismatch")
	}
	fp, err := runtimeFingerprint(ctx, w.engine, w.keyForID, work.App.Project)
	if err != nil || fp != expectedFP {
		return fmt.Errorf("adoption_runtime_changed")
	}
	model := deployComposeModel{Services: map[string]deployServiceModel{}}
	seen := map[string]bool{}
	for _, entry := range m.Containers {
		if seen[entry.ContainerKey] {
			return fmt.Errorf("adoption_duplicate_container")
		}
		seen[entry.ContainerKey] = true
		id, ok := w.resolver(entry.ContainerKey)
		if !ok {
			return fmt.Errorf("adoption_container_missing")
		}
		snap, err := w.engine.InspectContainer(ctx, id)
		if err != nil || snap.Labels["com.docker.compose.project"] != work.App.Project || snap.Labels["com.docker.compose.service"] != entry.Service {
			return fmt.Errorf("adoption_container_changed")
		}
		model.Services[entry.Service] = deployServiceModel{}
	}
	ids, err := w.engine.listAllIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		snap, err := w.engine.InspectContainer(ctx, id)
		if err != nil {
			return err
		}
		if snap.Labels["com.docker.compose.project"] == work.App.Project && !seen[w.keyForID(id)] {
			return fmt.Errorf("adoption_manifest_incomplete")
		}
	}
	return w.saveOwnership(ctx, work, model)
}
