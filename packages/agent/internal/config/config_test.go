package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoad_Valid(t *testing.T) {
	cfg := writeTempConfig(t, `{
		"backendUrl": "http://localhost:3000",
		"vpsId": "vps_123",
		"token": "vma_test_token",
		"intervalSeconds": 5,
		"requestTimeoutSeconds": 10
	}`)

	if cfg.BackendUrl != "http://localhost:3000" {
		t.Errorf("BackendUrl = %q, want %q", cfg.BackendUrl, "http://localhost:3000")
	}
	if cfg.VpsId != "vps_123" {
		t.Errorf("VpsId = %q, want %q", cfg.VpsId, "vps_123")
	}
	if cfg.Token != "vma_test_token" {
		t.Errorf("Token = %q, want %q", cfg.Token, "vma_test_token")
	}
	if cfg.IntervalSeconds != 5 {
		t.Errorf("IntervalSeconds = %d, want %d", cfg.IntervalSeconds, 5)
	}
	if cfg.RequestTimeoutSeconds != 10 {
		t.Errorf("RequestTimeoutSeconds = %d, want %d", cfg.RequestTimeoutSeconds, 10)
	}
}

func TestLoad_MissingFile(t *testing.T) {
	_, err := Load("/nonexistent/path/config.json")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestLoad_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("{bad json}"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Load(path)
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		cfg     Config
		wantErr bool
	}{
		{
			name:    "valid",
			cfg:     Config{BackendUrl: "http://localhost:3000", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: false,
		},
		{
			name:    "empty backendUrl",
			cfg:     Config{BackendUrl: "", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: true,
		},
		{
			name:    "relative backendUrl",
			cfg:     Config{BackendUrl: "/relative", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: true,
		},
		{
			name:    "invalid backendUrl",
			cfg:     Config{BackendUrl: "://bad", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: true,
		},
		{
			name:    "empty vpsId",
			cfg:     Config{BackendUrl: "http://localhost:3000", VpsId: "", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: true,
		},
		{
			name:    "empty token",
			cfg:     Config{BackendUrl: "http://localhost:3000", VpsId: "vps_1", Token: "", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: true,
		},
		{
			name:    "interval 0",
			cfg:     Config{BackendUrl: "http://localhost:3000", VpsId: "vps_1", Token: "tok", IntervalSeconds: 0, RequestTimeoutSeconds: 1},
			wantErr: true,
		},
		{
			name:    "interval negative",
			cfg:     Config{BackendUrl: "http://localhost:3000", VpsId: "vps_1", Token: "tok", IntervalSeconds: -1, RequestTimeoutSeconds: 1},
			wantErr: true,
		},
		{
			name:    "timeout 0",
			cfg:     Config{BackendUrl: "http://localhost:3000", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 0},
			wantErr: true,
		},
		{
			name:    "timeout negative",
			cfg:     Config{BackendUrl: "http://localhost:3000", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: -1},
			wantErr: true,
		},
		{
			name:    "ftp scheme rejected",
			cfg:     Config{BackendUrl: "ftp://localhost:3000", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: true,
		},
		{
			name:    "file scheme rejected",
			cfg:     Config{BackendUrl: "file:///tmp/foo", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: true,
		},
		{
			name:    "https is accepted",
			cfg:     Config{BackendUrl: "https://api.example.com", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: false,
		},
		{
			name:    "http rejected for non-loopback host",
			cfg:     Config{BackendUrl: "http://api.example.com", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: true,
		},
		{
			name:    "http accepted for loopback literal",
			cfg:     Config{BackendUrl: "http://127.0.0.1:3000", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.Validate()
			if tt.wantErr && err == nil {
				t.Error("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

func TestValidate_TrailingSlashNormalized(t *testing.T) {
	cfg := Config{BackendUrl: "https://example.com/api/", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.BackendUrl != "https://example.com/api" {
		t.Errorf("BackendUrl = %q, want %q", cfg.BackendUrl, "https://example.com/api")
	}
}

func TestValidate_TrailingSlashNormalized_Multiple(t *testing.T) {
	cfg := Config{BackendUrl: "https://example.com///", VpsId: "vps_1", Token: "tok", IntervalSeconds: 1, RequestTimeoutSeconds: 1}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.BackendUrl != "https://example.com" {
		t.Errorf("BackendUrl = %q, want %q", cfg.BackendUrl, "https://example.com")
	}
}

func TestConfigStringRedactsToken(t *testing.T) {
	cfg := Config{BackendUrl: "http://localhost:3000", VpsId: "vps_1", Token: "super-secret-token"}
	s := cfg.String()
	if strings.Contains(s, "super-secret-token") {
		t.Error("String() should not contain the token")
	}
	if !strings.Contains(s, "[redacted]") {
		t.Error("String() should contain [redacted]")
	}
}

func TestValidate_AIDefaultOff(t *testing.T) {
	cfg := Config{
		BackendUrl:            "https://example.com",
		VpsId:                 "vps_1",
		Token:                 "tok",
		IntervalSeconds:       5,
		RequestTimeoutSeconds: 10,
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("unexpected error with default AI: %v", err)
	}
	if cfg.AI.Enabled {
		t.Error("AI should be disabled by default")
	}
}

func TestValidate_AIEnabled(t *testing.T) {
	validAI := AIConfig{
		Enabled:            true,
		ExecutionUID:       1001,
		ExecutionGID:       1001,
		HelperSocketPath:   "/run/flexserver-ai/helper.sock",
		ExecutorPath:       "/usr/local/sbin/ai-executor",
		ScratchRootPath:    "/var/lib/flexserver-ai/scratch",
		StatePath:          "/var/lib/flexserver-ai/ai-state.json",
		RootfsDirPath:      "/usr/local/share/flexserver-ai/rootfs",
		RootfsManifestPath: "/usr/local/share/flexserver-ai/rootfs.manifest.json",
		ProfilesDirPath:    "/etc/flexserver-ai/profiles",
		MaxConcurrentTasks: 2,
	}

	cfg := Config{
		BackendUrl:            "https://example.com",
		VpsId:                 "vps_1",
		Token:                 "tok",
		IntervalSeconds:       5,
		RequestTimeoutSeconds: 10,
		AI:                    validAI,
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid AI config failed: %v", err)
	}

	// Test each required field
	badUID := cfg
	badUID.AI.ExecutionUID = 0
	if err := badUID.Validate(); err == nil || !strings.Contains(err.Error(), "executionUid") {
		t.Errorf("expected executionUid error, got %v", err)
	}

	badGID := cfg
	badGID.AI.ExecutionGID = 0
	if err := badGID.Validate(); err == nil || !strings.Contains(err.Error(), "executionGid") {
		t.Errorf("expected executionGid error, got %v", err)
	}

	badSocket := cfg
	badSocket.AI.HelperSocketPath = ""
	if err := badSocket.Validate(); err == nil || !strings.Contains(err.Error(), "helperSocketPath") {
		t.Errorf("expected helperSocketPath error, got %v", err)
	}

	badExecutor := cfg
	badExecutor.AI.ExecutorPath = ""
	if err := badExecutor.Validate(); err == nil || !strings.Contains(err.Error(), "executorPath") {
		t.Errorf("expected executorPath error, got %v", err)
	}

	badTasks := cfg
	badTasks.AI.MaxConcurrentTasks = 0
	if err := badTasks.Validate(); err == nil || !strings.Contains(err.Error(), "maxConcurrentTasks") {
		t.Errorf("expected maxConcurrentTasks error, got %v", err)
	}
}

// writeTempConfig writes JSON content to a temp file and loads it.
func writeTempConfig(t *testing.T, content string) *Config {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return cfg
}
