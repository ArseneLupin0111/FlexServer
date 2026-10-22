package updater

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/vps-manager/agent/internal/version"
)

// Sentinel errors surfaced by the API client.
var (
	ErrStaleLease   = errors.New("stale_lease: fencing token rejected — halt, never mutate after swap")
	ErrJobTerminal  = errors.New("job_terminal")
	ErrUnauthorized = errors.New("credential rejected (401)")
	ErrForbidden    = errors.New("credential scope rejected (403)")
)

// FlexTime accepts RFC3339 strings (with or without fractional seconds) as
// well as epoch seconds/milliseconds, so a server-side date format change can
// never silently drop a deadline.
type FlexTime struct{ time.Time }

func (t *FlexTime) UnmarshalJSON(raw []byte) error {
	s := strings.Trim(string(raw), `"`)
	if s == "" || s == "null" {
		t.Time = time.Time{}
		return nil
	}
	if n, err := strconv.ParseFloat(s, 64); err == nil && (strings.ContainsAny(s, "eE") || len(s) >= 10 && !strings.Contains(s, "-")) {
		if n > 1e12 { // epoch milliseconds
			n /= 1000
		}
		t.Time = time.Unix(int64(n), 0).UTC()
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z07:00", "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, s); err == nil {
			t.Time = parsed.UTC()
			return nil
		}
	}
	return fmt.Errorf("unrecognized time %q", s)
}

// ClaimedJob is the server's view of the one in-flight upgrade job.
type ClaimedJob struct {
	JobID               string   `json:"jobId"`
	Phase               string   `json:"phase"`
	State               string   `json:"state"`
	FencingToken        int64    `json:"fencingToken"`
	ManifestRaw         string   `json:"manifestRaw"`
	RequiresReconcile   bool     `json:"requiresReconcile"`
	TargetURL           string   `json:"targetUrl"`
	TargetSha256        string   `json:"targetSha256"`
	TargetSizeBytes     int64    `json:"targetSizeBytes"`
	LeaseExpiresAt      FlexTime    `json:"leaseExpiresAt"`
	PhaseDeadlineAt     FlexTime    `json:"phaseDeadlineAt"`
	DeadlineAt          FlexTime    `json:"deadlineAt"`
	BaselineHeartbeatAt FlexTime    `json:"baselineHeartbeatAt"`
	Progress            *int        `json:"progress"`
	Error               *string     `json:"error"`
	Release             ReleaseInfo `json:"release"`
}

type ReleaseInfo struct {
	ReleaseID    string `json:"releaseId"`
	Version      string `json:"version"`
	BuildID      string `json:"buildId"`
	TargetSha256 string `json:"targetSha256"`
}

// EffectivePhase prefers `phase` and falls back to `state`.
func (j *ClaimedJob) EffectivePhase() string {
	if j.Phase != "" {
		return j.Phase
	}
	return j.State
}

func (j *ClaimedJob) terminal() (string, bool) {
	switch p := j.EffectivePhase(); p {
	case "succeeded", "rolled_back", "rollback_unverified", "failed", "superseded", "deferred":
		return p, true
	}
	return "", false
}

// Client talks to the local-updater API with the scoped bearer credential.
type Client struct {
	cfg        *Config
	base       string
	credential string
	http       *http.Client
}

// NewClient builds the API client from config.
func NewClient(cfg *Config) *Client {
	return &Client{
		cfg:        cfg,
		base:       strings.TrimRight(cfg.APIBase, "/"),
		credential: cfg.Credential,
		http: &http.Client{
			Timeout: cfg.HTTPTimeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return fmt.Errorf("redirects are forbidden")
			},
		},
	}
}

type envelope struct {
	Data  json.RawMessage `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Claim tries to claim the in-flight job, sending protocol 3 evidence (version, platform, idle, AI health).
func (c *Client) Claim(ctx context.Context) (*ClaimedJob, error) {
	req := &ClaimRequest{
		UpdaterVersion: version.Identity(),
		Platform: PlatformInfo{
			OS:   runtime.GOOS,
			Arch: runtime.GOARCH,
		},
	}
	if c.cfg != nil {
		req.Idle, req.BusyReason = DetectHostIdle(c.cfg)
		req.AIHealth = DetectAIHealth(c.cfg)
	} else {
		req.Idle = true
	}
	return c.ClaimWithEvidence(ctx, req)
}

// ClaimWithEvidence issues a claim request with explicit evidence payload.
func (c *Client) ClaimWithEvidence(ctx context.Context, req *ClaimRequest) (*ClaimedJob, error) {
	var out struct {
		Job *ClaimedJob `json:"job"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/local-updater/jobs/claim", req, &out); err != nil {
		return nil, err
	}
	return out.Job, nil
}

// Progress reports a phase change. progress may be nil; message is capped at
// 160 chars by the server contract.
func (c *Client) Progress(ctx context.Context, jobID string, token int64, phase string, progress *int, message string) (*ClaimedJob, error) {
	body := map[string]any{"fencingToken": token, "phase": phase}
	if progress != nil {
		body["progress"] = *progress
	}
	if message != "" {
		if len(message) > 160 {
			message = message[:160]
		}
		body["message"] = message
	}
	var out struct {
		Job *ClaimedJob `json:"job"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/local-updater/jobs/"+jobID+"/progress", body, &out); err != nil {
		return nil, err
	}
	return out.Job, nil
}

// Result reports the final outcome of a job.
func (c *Client) Result(ctx context.Context, jobID string, token int64, outcome, reportedBuildID, reason string) (*ClaimedJob, bool, error) {
	body := map[string]any{"fencingToken": token, "outcome": outcome}
	if reportedBuildID != "" {
		body["reportedBuildId"] = reportedBuildID
	}
	if reason != "" {
		if len(reason) > 160 {
			reason = reason[:160]
		}
		body["reason"] = reason
	}
	var out struct {
		Job            *ClaimedJob `json:"job"`
		AwaitHeartbeat bool        `json:"awaitHeartbeat"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/local-updater/jobs/"+jobID+"/result", body, &out); err != nil {
		return nil, false, err
	}
	return out.Job, out.AwaitHeartbeat, nil
}

// Get fetches the current server view of a job (never rate-limited).
func (c *Client) Get(ctx context.Context, jobID string) (*ClaimedJob, error) {
	var out struct {
		Job *ClaimedJob `json:"job"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/local-updater/jobs/"+jobID, nil, &out); err != nil {
		return nil, err
	}
	return out.Job, nil
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.credential)
	req.Header.Set("User-Agent", "vps-updater/3")
	req.Header.Set("X-Updater-Protocol-Version", "3")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("api %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("api %s %s: read body: %w", method, path, err)
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		if resp.StatusCode != http.StatusOK {
			return classifyStatus(resp.StatusCode, path)
		}
		return fmt.Errorf("api %s %s: bad envelope: %w", method, path, err)
	}
	if env.Error != nil {
		switch env.Error.Code {
		case "stale_lease":
			return ErrStaleLease
		case "job_terminal":
			return ErrJobTerminal
		}
	}
	if err := classifyStatus(resp.StatusCode, path); err != nil {
		if env.Error != nil {
			return fmt.Errorf("api %s: %s", env.Error.Code, env.Error.Message)
		}
		return err
	}
	if env.Error != nil {
		return fmt.Errorf("api error %s: %s", env.Error.Code, env.Error.Message)
	}
	if len(env.Data) == 0 {
		return fmt.Errorf("api %s %s: empty data", method, path)
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return fmt.Errorf("api %s %s: decode data: %w", method, path, err)
	}
	return nil
}

func classifyStatus(status int, path string) error {
	switch status {
	case http.StatusOK:
		return nil
	case http.StatusUnauthorized:
		return ErrUnauthorized
	case http.StatusForbidden:
		return ErrForbidden
	case http.StatusConflict:
		return fmt.Errorf("api 409 on %s: %w", path, ErrStaleLease)
	}
	return fmt.Errorf("api %s returned status %d", path, status)
}
