//go:build linux

package applications

// The local Engine reader used by operations: bounded inspect/list on the
// fixed socket, never a user-supplied URL, and every identifier is a full
// 64-char hex ID (never a name or label).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// engineClient is the only local Engine reader used by operations.
type engineClient struct{ http *http.Client }

// NewEngineClient dials the fixed socket with a bounded per-request timeout.
func NewEngineClient(timeout time.Duration) (*engineClient, error) {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &engineClient{http: &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{Timeout: timeout}).DialContext(ctx, "unix", "/var/run/docker.sock")
			},
		},
	}}, nil
}

// EngineContainerSnapshot is the bounded inspect projection.
type EngineContainerSnapshot struct {
	ID string
	// State is running|exited|paused|created|dead|restarting.
	State string
	// Health is none|starting|healthy|unhealthy; "none" when absent.
	Health   string
	ExitCode int
	Running  bool
	Labels   map[string]string
}

// InspectContainer returns the bounded snapshot of exactly one container.
func (e *engineClient) InspectContainer(ctx context.Context, fullID string) (*EngineContainerSnapshot, error) {
	if len(fullID) != 64 {
		return nil, fmt.Errorf("invalid container id")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/containers/"+fullID+"/json", nil)
	if err != nil {
		return nil, err
	}
	resp, err := e.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s", ErrReadinessTimeout)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, fmt.Errorf("container_not_found")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("%s", ErrRuntimeUnavailable)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024+1))
	if err != nil || len(raw) > 256*1024 {
		return nil, fmt.Errorf("engine_response_over_limit")
	}
	var body struct {
		ID    string `json:"Id"`
		State struct {
			Status  string `json:"Status"`
			Running bool   `json:"Running"`
			Health  *struct {
				Status string `json:"Status"`
			} `json:"Health"`
			ExitCode int `json:"ExitCode"`
		} `json:"State"`
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.ID != fullID {
		return nil, fmt.Errorf("engine_malformed")
	}
	snap := &EngineContainerSnapshot{
		ID: body.ID, State: body.State.Status, Running: body.State.Running,
		ExitCode: body.State.ExitCode, Labels: body.Config.Labels,
	}
	if body.State.Health != nil {
		snap.Health = body.State.Health.Status
	} else {
		snap.Health = "none"
	}
	return snap, nil
}

// PingEngine returns nil only when the fixed Engine endpoint answers /_ping.
func (e *engineClient) PingEngine(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/_ping", nil)
	if err != nil {
		return err
	}
	resp, err := e.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s", ErrReadinessTimeout)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s", ErrRuntimeUnavailable)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 256))
	return nil
}

// listAllIDs returns every full container ID once (bounded read path).
func (e *engineClient) listAllIDs(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/containers/json?all=1&size=false", nil)
	if err != nil {
		return nil, err
	}
	resp, err := e.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s", ErrRuntimeUnavailable)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("%s", ErrRuntimeUnavailable)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxInventoryBodyBytes+1))
	if err != nil || len(raw) > MaxInventoryBodyBytes {
		return nil, fmt.Errorf("engine_response_over_limit")
	}
	var rows []struct {
		ID string `json:"Id"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, fmt.Errorf("engine_malformed")
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		if len(r.ID) == 64 {
			ids = append(ids, r.ID)
		}
	}
	return ids, nil
}

// InspectImage returns the immutable full reference "name@sha256:..." that
// the engine observed for one image reference. Never a tag, never a label.
func (e *engineClient) InspectImage(ctx context.Context, image string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/images/"+url.PathEscape(image)+"/json", nil)
	if err != nil {
		return "", err
	}
	resp, err := e.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s", ErrRuntimeUnavailable)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("%s", ErrRuntimeUnavailable)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxInventoryBodyBytes+1))
	if err != nil || len(raw) > MaxInventoryBodyBytes {
		return "", fmt.Errorf("engine_response_over_limit")
	}
	var row struct {
		ID          string   `json:"Id"`
		RepoDigests []string `json:"RepoDigests"`
	}
	if err := json.Unmarshal(raw, &row); err != nil {
		return "", fmt.Errorf("engine_malformed")
	}
	for _, d := range row.RepoDigests {
		if i := strings.Index(d, "@sha256:"); i > 0 && imageRepository(d) == imageRepository(image) {
			if j := strings.Index(image, "@"); j >= 0 && image[j:] != d[i:] {
				continue
			}
			return d, nil
		}
	}
	return "", fmt.Errorf("image_digest_unobserved")
}

// DeleteContainer removes exactly one container by its full daemon identity:
// DELETE /containers/{fullID}?v=False. Volumes are never removed here; the
// caller owns the removed-service manifest that produced the ID.
func (e *engineClient) DeleteContainer(ctx context.Context, fullID string) error {
	if len(fullID) != 64 {
		return fmt.Errorf("invalid container id")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, "http://docker/containers/"+fullID+"?v=False&force=False&link=False", nil)
	if err != nil {
		return err
	}
	resp, err := e.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s", ErrRuntimeUnavailable)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300, resp.StatusCode == 404:
		return nil
	default:
		return fmt.Errorf("%s", engineDeleteDenied)
	}
}

const engineDeleteDenied = "container_delete_denied"

// Ready describes one readiness observation.
type Ready struct {
	Ready    bool
	TimedOut bool
	ExitOk   bool
	Detail   string
}

// ObserveReadiness decides a single service's readiness from one inspect:
// long-lived services become ready when running (and healthy when a
// healthcheck exists); one-shot services become ready on exit 0 and fail on
// a nonzero exit. It never stops or deletes resources on timeout.
func ObserveReadiness(snap *EngineContainerSnapshot, oneShot bool) Ready {
	if snap == nil {
		return Ready{Detail: "missing_snapshot"}
	}
	if oneShot {
		if snap.State == "running" {
			return Ready{Detail: "running"}
		}
		if snap.State == "exited" {
			if snap.ExitCode == 0 {
				return Ready{Ready: true, ExitOk: true, Detail: "completed"}
			}
			return Ready{Detail: fmt.Sprintf("exit_%d", snap.ExitCode)}
		}
		return Ready{Detail: "state_" + snap.State}
	}
	if !snap.Running {
		return Ready{Detail: "not_running"}
	}
	if snap.Health == "starting" {
		return Ready{Detail: "health_starting"}
	}
	if snap.Health == "unhealthy" {
		return Ready{Detail: "health_unhealthy"}
	}
	if snap.Health == "none" || snap.Health == "" {
		return Ready{Ready: true, Detail: "running_without_healthcheck"}
	}
	return Ready{Ready: true, Detail: "healthy"}
}

func imageRepository(image string) string {
	name := strings.SplitN(image, "@", 2)[0]
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		name = name[:i]
	}
	parts := strings.Split(name, "/")
	if len(parts) == 1 {
		return "docker.io/library/" + name
	}
	if !strings.ContainsAny(parts[0], ".:") && parts[0] != "localhost" {
		return "docker.io/" + name
	}
	name = strings.TrimPrefix(name, "index.docker.io/")
	if name != image && !strings.Contains(name, "/") {
		return "docker.io/library/" + name
	}
	if parts[0] == "index.docker.io" {
		return "docker.io/" + strings.Join(parts[1:], "/")
	}
	return name
}
