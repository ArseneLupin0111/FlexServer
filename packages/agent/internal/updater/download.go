package updater

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// DownloadResult describes a completed, verified download.
type DownloadResult struct {
	Path   string
	Size   int64
	SHA256 string
}


// DownloadBundledArtifact fetches the agent binary directly from the local API endpoint:
//   - Origin matches the API origin (no cross-origin redirects);
//   - Uses local-updater bearer authentication;
//   - Final SHA256 must match targetSha;
//   - Streamed bytes capped at MaxArtifactBytes and targetSize (if positive);
//   - Written atomically with 0755 permissions.
func DownloadBundledArtifact(ctx context.Context, cfg *Config, client *http.Client, targetURL, targetSha string, targetSize int64, destPath string) (*DownloadResult, error) {
	apiURL, err := url.Parse(cfg.APIBase)
	if err != nil {
		return nil, fmt.Errorf("parse apiBase: %w", err)
	}
	fullURL := targetURL
	if strings.HasPrefix(targetURL, "/") {
		fullURL = strings.TrimRight(cfg.APIBase, "/") + targetURL
	}
	reqURL, err := url.Parse(fullURL)
	if err != nil {
		return nil, fmt.Errorf("parse target URL: %w", err)
	}
	if reqURL.Scheme != apiURL.Scheme || reqURL.Host != apiURL.Host || reqURL.Port() != apiURL.Port() {
		return nil, fmt.Errorf("artifact URL origin (%s://%s) does not match API origin (%s://%s)", reqURL.Scheme, reqURL.Host, apiURL.Scheme, apiURL.Host)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Credential)
	req.Header.Set("User-Agent", "vps-updater/2")
	req.Header.Set("X-Updater-Protocol-Version", "2")

	dlClient := client
	if dlClient == nil {
		dlClient = &http.Client{Timeout: cfg.HTTPTimeout}
	}
	customClient := *dlClient
	customClient.CheckRedirect = func(redirReq *http.Request, via []*http.Request) error {
		return fmt.Errorf("redirects are forbidden for artifact downloads")
	}
	resp, err := customClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download artifact: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download: status %d", resp.StatusCode)
	}

	limit := cfg.MaxArtifactBytes
	if limit <= 0 {
		limit = int64(defaultMaxArtifactBytes)
	}
	if targetSize > 0 && targetSize < limit {
		limit = targetSize
	}

	partPath := destPath + ".part"
	if err := os.MkdirAll(filepath.Dir(destPath), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(partPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create part file: %w", err)
	}
	defer func() {
		_ = f.Close()
		_ = os.Remove(partPath)
	}()

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("stream download: %w", err)
	}
	if n > limit {
		return nil, fmt.Errorf("download exceeded %d bytes bound", limit)
	}
	if targetSize > 0 && n != targetSize {
		return nil, fmt.Errorf("download size %d != expected size %d", n, targetSize)
	}
	if err := f.Sync(); err != nil {
		return nil, fmt.Errorf("fsync download: %w", err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("close download: %w", err)
	}

	got := fmt.Sprintf("%x", h.Sum(nil))
	if targetSha != "" && got != targetSha {
		return nil, fmt.Errorf("download sha256 %s does not match expected %s", got, targetSha)
	}
	if err := os.Chmod(partPath, 0o755); err != nil {
		return nil, fmt.Errorf("make staged artifact readable: %w", err)
	}
	if err := os.Rename(partPath, destPath); err != nil {
		return nil, fmt.Errorf("finalize download: %w", err)
	}
	return &DownloadResult{Path: destPath, Size: n, SHA256: got}, nil
}

// DownloadFleetArtifact fetches an external signed release artifact (e.g. from GitHub Releases):
//   - Strict HTTPS scheme, no userinfo, standard 443 port;
//   - Bounded credential-free redirects (up to 5 hops);
//   - Strips any Authorization header on all hops;
//   - Validates host against DefaultAllowedHosts on every hop;
//   - Caps download size at 512 MiB (or targetSize);
//   - Enforces exact size match (if targetSize > 0) and SHA256 match;
//   - Atomic write to destPath with requested file permissions.
func DownloadFleetArtifact(ctx context.Context, targetURL, targetSha string, targetSize int64, destPath string, perm os.FileMode) (*DownloadResult, error) {
	if err := validateArtifactURL(targetURL, DefaultAllowedHosts); err != nil {
		return nil, fmt.Errorf("validate target URL: %w", err)
	}

	client := &http.Client{
		Timeout: 10 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("stopped after 5 redirects")
			}
			if err := validateArtifactURL(req.URL.String(), DefaultAllowedHosts); err != nil {
				return fmt.Errorf("redirect target rejected: %w", err)
			}
			req.Header.Del("Authorization")
			return nil
		},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "vps-updater/3")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download fleet artifact: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download status %d", resp.StatusCode)
	}

	limit := int64(512 * 1024 * 1024)
	if targetSize > 0 && targetSize*2 < limit {
		limit = targetSize * 2
	}

	partPath := destPath + ".part"
	if err := os.MkdirAll(filepath.Dir(destPath), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(partPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create part file: %w", err)
	}
	defer func() {
		_ = f.Close()
		_ = os.Remove(partPath)
	}()

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("stream fleet download: %w", err)
	}
	if n > limit {
		return nil, fmt.Errorf("download exceeded limit of %d bytes", limit)
	}
	if targetSize > 0 && n != targetSize {
		return nil, fmt.Errorf("download size %d != expected %d", n, targetSize)
	}
	if err := f.Sync(); err != nil {
		return nil, fmt.Errorf("fsync download: %w", err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("close download: %w", err)
	}

	got := fmt.Sprintf("%x", h.Sum(nil))
	if targetSha != "" && got != targetSha {
		return nil, fmt.Errorf("download sha256 %s != expected %s", got, targetSha)
	}
	if err := os.Chmod(partPath, perm); err != nil {
		return nil, fmt.Errorf("chmod staged artifact: %w", err)
	}
	if err := os.Rename(partPath, destPath); err != nil {
		return nil, fmt.Errorf("finalize fleet download: %w", err)
	}
	return &DownloadResult{Path: destPath, Size: n, SHA256: got}, nil
}

// newHTTPClient returns the shared HTTP client for downloads: strict timeout,
// no redirects to unexpected hosts are prevented by re-validating each hop's
// URL — Go follows redirects internally, so we validate the *final* URL and
// cap redirects via CheckRedirect.
func newHTTPClient(cfg *Config) *http.Client {
	return &http.Client{
		Timeout: cfg.HTTPTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return fmt.Errorf("redirects are forbidden")
		},
	}
}
