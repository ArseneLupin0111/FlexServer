package ai

import (
	"bytes"
	"context"
	"strings"
	"unicode/utf8"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/vps-manager/agent/internal/config"
)

const (
	claimPath        = "/api/agent/ai/claim"
	heartbeatPath    = "/api/agent/ai/heartbeat"
	outputPath       = "/api/agent/ai/output"
	resultPath       = "/api/agent/ai/result"
	cancelStatusPath = "/api/agent/ai/cancel-status"
)

// ErrAuth represents a 401 or 403 HTTP response.
type ErrAuth struct {
	StatusCode int
	Body       string
}

func (e *ErrAuth) Error() string {
	return fmt.Sprintf("ai client auth failed (HTTP %d)", e.StatusCode)
}

// ErrFatal represents an unretryable 400 or 404 HTTP response.
type ErrFatal struct {
	StatusCode int
	Body       string
}

func (e *ErrFatal) Error() string {
	return fmt.Sprintf("ai client fatal error (HTTP %d): %s", e.StatusCode, e.Body)
}

// ErrConflict represents a 409 conflict.
type ErrConflict struct {
	StatusCode int
	Body       string
}

func (e *ErrConflict) Error() string {
	return fmt.Sprintf("ai client conflict (HTTP %d): %s", e.StatusCode, e.Body)
}

// ErrRetryable represents a transient network or 5xx error.
type ErrRetryable struct {
	StatusCode int
	Err        error
}

func (e *ErrRetryable) Error() string {
	return fmt.Sprintf("ai client retryable error (HTTP %d): %v", e.StatusCode, e.Err)
}

func (e *ErrRetryable) Unwrap() error {
	return e.Err
}

// IsFatal checks if an error is non-retryable.
func IsFatal(err error) bool {
	var a *ErrAuth
	if errors.As(err, &a) {
		return true
	}
	var f *ErrFatal
	return errors.As(err, &f)
}

// IsConflict checks if an error is a 409 conflict.
func IsConflict(err error) bool {
	var c *ErrConflict
	return errors.As(err, &c)
}

// Client handles authenticated transport to the AI backend endpoints.
type Client struct {
	backendURL string
	token      string
	httpClient *http.Client
}

// NewClient creates a new Client from agent config.
func NewClient(cfg *config.Config) *Client {
	timeout := time.Duration(cfg.RequestTimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &Client{
		backendURL: cfg.BackendUrl,
		token:      cfg.Token,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// NewClientWithHTTP creates a new Client with a custom HTTP client (for testing).
func NewClientWithHTTP(backendURL, token string, hc *http.Client) *Client {
	return &Client{
		backendURL: backendURL,
		token:      token,
		httpClient: hc,
	}
}

func extractInstanceID(body any) string {
	switch r := body.(type) {
	case *ClaimRequest:
		if r != nil {
			return r.AgentInstanceID
		}
	case ClaimRequest:
		return r.AgentInstanceID
	case *HeartbeatRequest:
		if r != nil {
			return r.AgentInstanceID
		}
	case HeartbeatRequest:
		return r.AgentInstanceID
	case *OutputChunkRequest:
		if r != nil {
			return r.AgentInstanceID
		}
	case OutputChunkRequest:
		return r.AgentInstanceID
	case *ResultRequest:
		if r != nil {
			return r.AgentInstanceID
		}
	case ResultRequest:
		return r.AgentInstanceID
	case *CancelStatusRequest:
		if r != nil {
			return r.AgentInstanceID
		}
	case CancelStatusRequest:
		return r.AgentInstanceID
	}
	return ""
}

func (c *Client) postJSON(ctx context.Context, path string, body any, maxRespBytes int64) (int, []byte, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return 0, nil, fmt.Errorf("marshal json payload: %w", err)
	}

	target, err := url.JoinPath(c.backendURL, path)
	if err != nil {
		return 0, nil, fmt.Errorf("invalid backend url path: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(raw))
	if err != nil {
		return 0, nil, fmt.Errorf("create http request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	if instanceID := extractInstanceID(body); instanceID != "" {
		req.Header.Set("x-agent-instance", instanceID)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, nil, &ErrRetryable{StatusCode: 0, Err: fmt.Errorf("request failed: %w", err)}
	}
	defer resp.Body.Close()

	if maxRespBytes <= 0 {
		maxRespBytes = MaxClaimResponseBytes
	}
	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, maxRespBytes+1))
	if err != nil {
		return resp.StatusCode, nil, &ErrRetryable{StatusCode: resp.StatusCode, Err: fmt.Errorf("reading response: %w", err)}
	}

	return resp.StatusCode, respBytes, nil
}

func mapStatus(status int, body []byte) error {
	sanitized := SanitizeLog(string(body))
	if len(sanitized) > 200 {
		sanitized = sanitized[:200] + "..."
	}
	switch {
	case status >= 200 && status < 300:
		return nil
	case status == 401 || status == 403:
		return &ErrAuth{StatusCode: status, Body: sanitized}
	case status == 409:
		return &ErrConflict{StatusCode: status, Body: sanitized}
	case status == 400 || status == 404:
		return &ErrFatal{StatusCode: status, Body: sanitized}
	default:
		return &ErrRetryable{StatusCode: status, Err: fmt.Errorf("status %d: %s", status, sanitized)}
	}
}

// Claim asks for the next pending command for this agent instance.
func (c *Client) Claim(ctx context.Context, req *ClaimRequest) (*Command, error) {
	if req == nil {
		return nil, errors.New("claim request is nil")
	}
	if req.Version <= 0 {
		req.Version = ProtocolVersion
	}

	status, body, err := c.postJSON(ctx, claimPath, req, MaxClaimResponseBytes)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNoContent {
		return nil, nil
	}
	if err := mapStatus(status, body); err != nil {
		return nil, err
	}

	var resp ClaimResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, &ErrFatal{StatusCode: status, Body: fmt.Sprintf("invalid claim response JSON: %v", err)}
	}

	return resp.Data.Command, nil
}

// Heartbeat sends a liveness ping and checks if cancellation has been requested.
func (c *Client) Heartbeat(ctx context.Context, req *HeartbeatRequest) (*HeartbeatResponse, error) {
	if req == nil {
		return nil, errors.New("heartbeat request is nil")
	}
	if req.Version <= 0 {
		req.Version = ProtocolVersion
	}
	if req.Timestamp == "" {
		req.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	status, body, err := c.postJSON(ctx, heartbeatPath, req, 4096)
	if err != nil {
		return nil, err
	}
	if err := mapStatus(status, body); err != nil {
		return nil, err
	}

	var resp HeartbeatResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, &ErrFatal{StatusCode: status, Body: fmt.Sprintf("invalid heartbeat response: %v", err)}
	}
	return &resp, nil
}

// Output sends a chunk of streaming output. If req.Chunk exceeds MaxOutputChunkBytes,
// it streams contiguous UTF-8 safe slices sequentially without dropping remainder bytes.
func (c *Client) Output(ctx context.Context, req *OutputChunkRequest) (*OutputChunkResponse, error) {
	if req == nil {
		return nil, errors.New("output chunk request is nil")
	}
	if req.Version <= 0 {
		req.Version = ProtocolVersion
	}
	if req.Sequence < 0 {
		req.Sequence = 0
	}

	raw := req.Chunk
	if !utf8.ValidString(raw) {
		raw = strings.ToValidUTF8(raw, "")
	}

	if len(raw) <= MaxOutputChunkBytes {
		reqCopy := *req
		reqCopy.Chunk = raw
		status, body, err := c.postJSON(ctx, outputPath, &reqCopy, 4096)
		if err != nil {
			return nil, err
		}
		if err := mapStatus(status, body); err != nil {
			return nil, err
		}
		var resp OutputChunkResponse
		if err := json.Unmarshal(body, &resp); err != nil {
			return nil, &ErrFatal{StatusCode: status, Body: fmt.Sprintf("invalid output response: %v", err)}
		}
		return &resp, nil
	}

	remaining := raw
	seq := req.Sequence
	var lastResp *OutputChunkResponse

	for len(remaining) > 0 {
		piece := TruncateUTF8ToBytes(remaining, MaxOutputChunkBytes)
		if len(piece) == 0 {
			piece = remaining[:1]
		}
		remaining = remaining[len(piece):]
		isEndPiece := req.IsEnd && len(remaining) == 0

		subReq := OutputChunkRequest{
			Version:         req.Version,
			AgentInstanceID: req.AgentInstanceID,
			TaskID:          req.TaskID,
			CommandID:       req.CommandID,
			StreamID:        req.StreamID,
			Sequence:        seq,
			Chunk:           piece,
			IsGap:           req.IsGap,
			IsEnd:           isEndPiece,
		}
		seq++

		status, body, err := c.postJSON(ctx, outputPath, &subReq, 4096)
		if err != nil {
			return nil, err
		}
		if err := mapStatus(status, body); err != nil {
			return nil, err
		}
		var resp OutputChunkResponse
		if err := json.Unmarshal(body, &resp); err != nil {
			return nil, &ErrFatal{StatusCode: status, Body: fmt.Sprintf("invalid output response: %v", err)}
		}
		lastResp = &resp
	}

	return lastResp, nil
}

// Result reports the final command execution outcome to the backend.
func (c *Client) Result(ctx context.Context, req *ResultRequest) (*ResultResponse, error) {
	if req == nil {
		return nil, errors.New("result request is nil")
	}
	if req.Version <= 0 {
		req.Version = ProtocolVersion
	}
	if req.PlanVersion < 0 {
		return nil, fmt.Errorf("result request invalid planVersion (%d): must be >= 0", req.PlanVersion)
	}
	if len(req.PlanDigest) < MinPlanDigestLen || len(req.PlanDigest) > MaxPlanDigestLen {
		return nil, fmt.Errorf("result request invalid planDigest length (%d): must be between %d and %d", len(req.PlanDigest), MinPlanDigestLen, MaxPlanDigestLen)
	}
	if req.ErrorCode != "" {
		req.ErrorCode = TruncateUTF8ToBytes(req.ErrorCode, MaxErrorCodeLen)
	}
	if req.ErrorMessage != "" {
		req.ErrorMessage = TruncateUTF8ToBytes(req.ErrorMessage, MaxErrorMessageLen)
	}
	if req.OutputPreview != "" {
		req.OutputPreview = TruncateUTF8ToBytes(req.OutputPreview, MaxOutputPreviewBytes)
	}

	status, body, err := c.postJSON(ctx, resultPath, req, 4096)
	if err != nil {
		return nil, err
	}
	if err := mapStatus(status, body); err != nil {
		return nil, err
	}

	var resp ResultResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, &ErrFatal{StatusCode: status, Body: fmt.Sprintf("invalid result response: %v", err)}
	}
	return &resp, nil
}

// CancelStatus reports whether cancellation was acknowledged and the scope was terminated.
func (c *Client) CancelStatus(ctx context.Context, req *CancelStatusRequest) (*CancelStatusResponse, error) {
	if req == nil {
		return nil, errors.New("cancel status request is nil")
	}
	if req.Version <= 0 {
		req.Version = ProtocolVersion
	}

	status, body, err := c.postJSON(ctx, cancelStatusPath, req, 4096)
	if err != nil {
		return nil, err
	}
	if err := mapStatus(status, body); err != nil {
		return nil, err
	}

	var resp CancelStatusResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, &ErrFatal{StatusCode: status, Body: fmt.Sprintf("invalid cancel-status response: %v", err)}
	}
	return &resp, nil
}

// TruncateUTF8ToBytes returns the longest prefix of s that is at most maxBytes in length,
// does not cut across a multi-byte UTF-8 rune (e.g. Vietnamese diacritics), and is valid UTF-8.
func TruncateUTF8ToBytes(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) > maxBytes {
		i := maxBytes
		for i > 0 && !utf8.RuneStart(s[i]) {
			i--
		}
		if i == maxBytes {
			s = s[:maxBytes]
		} else {
			s = s[:i]
		}
	}
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
		if len(s) > maxBytes {
			return TruncateUTF8ToBytes(s, maxBytes)
		}
	}
	return s
}
