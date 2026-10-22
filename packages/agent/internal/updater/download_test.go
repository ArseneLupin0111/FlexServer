package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownloadBundledArtifactSuccess(t *testing.T) {
	content := []byte("binary-content-1234567890")
	hash := sha256.Sum256(content)
	targetSha := hex.EncodeToString(hash[:])

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-credential" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Header.Get("X-Updater-Protocol-Version") != "3" {
			http.Error(w, "bad protocol", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(content)
	}))
	defer server.Close()

	destDir := t.TempDir()
	destPath := filepath.Join(destDir, "downloaded-agent")

	cfg := &Config{
		APIBase:    server.URL,
		Credential: "test-credential",
	}

	res, err := DownloadBundledArtifact(context.Background(), cfg, server.Client(), "/api/local-updater/jobs/123/artifact", targetSha, int64(len(content)), destPath)
	if err != nil {
		t.Fatalf("DownloadBundledArtifact: %v", err)
	}

	if res.SHA256 != targetSha {
		t.Fatalf("got sha %s, want %s", res.SHA256, targetSha)
	}
	if res.Size != int64(len(content)) {
		t.Fatalf("got size %d, want %d", res.Size, len(content))
	}

	read, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("read destination: %v", err)
	}
	if string(read) != string(content) {
		t.Fatalf("content mismatch")
	}
}

func TestDownloadBundledArtifactOriginCheck(t *testing.T) {
	cfg := &Config{
		APIBase:    "http://127.0.0.1:8080",
		Credential: "test-cred",
	}

	destPath := filepath.Join(t.TempDir(), "target")

	// Target URL on a different port or host must be rejected before any HTTP call
	badURLs := []string{
		"http://127.0.0.1:8081/artifact",
		"http://evil.com/artifact",
		"https://127.0.0.1:8080/artifact",
	}

	for _, badURL := range badURLs {
		_, err := DownloadBundledArtifact(context.Background(), cfg, nil, badURL, "sha", 100, destPath)
		if err == nil {
			t.Fatalf("expected origin mismatch error for %s", badURL)
		}
		if !strings.Contains(err.Error(), "does not match API origin") {
			t.Fatalf("unexpected error message: %v", err)
		}
	}
}

func TestDownloadBundledArtifactRejectsRedirects(t *testing.T) {
	// A server that returns a redirect (even on same origin)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, server.URL+"/target", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("redirected payload"))
	}))
	defer server.Close()

	cfg := &Config{
		APIBase:    server.URL,
		Credential: "test-cred",
	}

	destPath := filepath.Join(t.TempDir(), "target")
	_, err := DownloadBundledArtifact(context.Background(), cfg, server.Client(), "/redirect", "any-sha", 50, destPath)
	if err == nil {
		t.Fatal("expected error on redirect")
	}
	if !strings.Contains(err.Error(), "redirects are forbidden") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestDownloadBundledArtifactChecksumMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("hello world"))
	}))
	defer server.Close()

	cfg := &Config{
		APIBase:    server.URL,
		Credential: "test-cred",
	}

	destPath := filepath.Join(t.TempDir(), "target")
	_, err := DownloadBundledArtifact(context.Background(), cfg, server.Client(), "/artifact", "0000000000000000000000000000000000000000000000000000000000000000", 11, destPath)
	if err == nil {
		t.Fatal("expected sha256 mismatch error")
	}
	if !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("unexpected error message: %v", err)
	}

	// Partial/staging files must be cleaned up on failure
	if _, err := os.Stat(destPath); !os.IsNotExist(err) {
		t.Fatalf("destPath should not exist after failed download")
	}
}
