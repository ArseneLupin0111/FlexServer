package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRequest(t *testing.T) {
	tests := []struct {
		name    string
		req     *RotationRequest
		wantErr bool
	}{
		{
			name:    "nil request",
			req:     nil,
			wantErr: true,
		},
		{
			name:    "empty vpsId",
			req:     &RotationRequest{VpsId: "", Token: "vma_valid_secret_123"},
			wantErr: true,
		},
		{
			name:    "invalid vpsId characters",
			req:     &RotationRequest{VpsId: "vps/invalid$id", Token: "vma_valid_secret_123"},
			wantErr: true,
		},
		{
			name:    "empty token",
			req:     &RotationRequest{VpsId: "vps_local_host", Token: ""},
			wantErr: true,
		},
		{
			name:    "token missing vma_ prefix",
			req:     &RotationRequest{VpsId: "vps_local_host", Token: "invalid_secret_123"},
			wantErr: true,
		},
		{
			name:    "valid request",
			req:     &RotationRequest{VpsId: "vps_local_host", Token: "vma_cred123_secret456"},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRequest(tt.req)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateRequest() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestUpdateAgentConfig_Success(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "config.json")

	initialConfig := map[string]interface{}{
		"vpsId":           "vps_local_host",
		"backendUrl":      "https://api.flexserver.tech",
		"intervalSeconds": 15,
		"token":           "vma_initial_old_token",
	}
	initialBytes, err := json.MarshalIndent(initialConfig, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, initialBytes, 0640); err != nil {
		t.Fatal(err)
	}

	req := RotationRequest{
		VpsId: "vps_local_host",
		Token: "vma_new_rotated_token_999",
	}

	// Use "none" as systemctlCmd to skip systemctl in unit test
	if err := UpdateAgentConfig(configPath, req, "none", "vps-manager-agent.service"); err != nil {
		t.Fatalf("UpdateAgentConfig failed: %v", err)
	}

	updatedBytes, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}

	var updatedConfig map[string]interface{}
	if err := json.Unmarshal(updatedBytes, &updatedConfig); err != nil {
		t.Fatal(err)
	}

	if updatedConfig["token"] != "vma_new_rotated_token_999" {
		t.Errorf("token not updated, got %v", updatedConfig["token"])
	}
	if updatedConfig["vpsId"] != "vps_local_host" {
		t.Errorf("vpsId changed, got %v", updatedConfig["vpsId"])
	}
	if updatedConfig["backendUrl"] != "https://api.flexserver.tech" {
		t.Errorf("backendUrl changed, got %v", updatedConfig["backendUrl"])
	}
	if int(updatedConfig["intervalSeconds"].(float64)) != 15 {
		t.Errorf("intervalSeconds changed, got %v", updatedConfig["intervalSeconds"])
	}
}

func TestUpdateAgentConfig_VpsIdMismatch(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "config.json")

	initialConfig := map[string]interface{}{
		"vpsId": "vps_local_host",
		"token": "vma_initial_old_token",
	}
	initialBytes, _ := json.Marshal(initialConfig)
	_ = os.WriteFile(configPath, initialBytes, 0640)

	req := RotationRequest{
		VpsId: "vps_other_host",
		Token: "vma_new_token_123",
	}

	err := UpdateAgentConfig(configPath, req, "none", "vps-manager-agent.service")
	if err == nil {
		t.Fatal("expected error on vpsId mismatch, got nil")
	}
	if !strings.Contains(err.Error(), "vpsId mismatch") {
		t.Fatalf("unexpected error message: %v", err)
	}

	// Verify original config was untouched
	afterBytes, _ := os.ReadFile(configPath)
	var afterConfig map[string]interface{}
	_ = json.Unmarshal(afterBytes, &afterConfig)
	if afterConfig["token"] != "vma_initial_old_token" {
		t.Errorf("config should have remained untouched, got %v", afterConfig["token"])
	}
}

func TestUpdateAgentConfig_RollbackOnRestartFailure(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "config.json")

	initialConfig := map[string]interface{}{
		"vpsId": "vps_local_host",
		"token": "vma_initial_old_token",
	}
	initialBytes, _ := json.Marshal(initialConfig)
	_ = os.WriteFile(configPath, initialBytes, 0640)

	req := RotationRequest{
		VpsId: "vps_local_host",
		Token: "vma_new_token_123",
	}

	// Point to a non-existent binary to simulate command failure
	fakeSystemctl := filepath.Join(tmpDir, "non_existent_systemctl_binary")
	err := UpdateAgentConfig(configPath, req, fakeSystemctl, "vps-manager-agent.service")
	if err == nil {
		t.Fatal("expected error on command failure, got nil")
	}

	// Verify config was rolled back to original token!
	afterBytes, _ := os.ReadFile(configPath)
	var afterConfig map[string]interface{}
	_ = json.Unmarshal(afterBytes, &afterConfig)
	if afterConfig["token"] != "vma_initial_old_token" {
		t.Errorf("expected config rolled back to original token, got %v", afterConfig["token"])
	}
}

func TestUpdateAgentConfig_ConcurrentBusyRejection(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "config.json")

	initialConfig := map[string]interface{}{
		"vpsId": "vps_local_host",
		"token": "vma_initial_old_token",
	}
	initialBytes, _ := json.Marshal(initialConfig)
	_ = os.WriteFile(configPath, initialBytes, 0640)

	// Artificially acquire the mutationMutex to simulate an in-progress transaction
	mutationMutex.Lock()
	defer mutationMutex.Unlock()

	req := RotationRequest{
		VpsId: "vps_local_host",
		Token: "vma_new_token_123",
	}

	err := UpdateAgentConfig(configPath, req, "none", "vps-manager-agent.service")
	if err == nil {
		t.Fatal("expected busy error when mutex is held, got nil")
	}
	if !strings.Contains(err.Error(), "rotation busy") {
		t.Fatalf("unexpected error message: %v", err)
	}
}
