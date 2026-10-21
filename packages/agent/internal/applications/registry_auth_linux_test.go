//go:build linux

package applications

import (
	"encoding/json"
	"testing"
)

func TestRegistryPreviewCapturesVersionsAndDeployRequiresMatch(t *testing.T) {
	runner := &composeRunner{authDir: t.TempDir()}
	credentials := []json.RawMessage{json.RawMessage(`{"id":"credential","host":"registry.example:443","username":"operator","value":"test-password","version":3}`)}
	versions, err := prepareRegistryAuth(runner, credentials, nil)
	if err != nil || versions["credential"] != 3 {
		t.Fatalf("preview capture: versions=%v error=%v", versions, err)
	}
	if _, err := prepareRegistryAuth(runner, credentials, map[string]int{"credential": 3}); err != nil {
		t.Fatalf("matching approval rejected: %v", err)
	}
	for _, approval := range []map[string]int{{}, {"credential": 2}, {"other": 3}} {
		if _, err := prepareRegistryAuth(runner, credentials, approval); err == nil {
			t.Fatalf("mismatched approval accepted: %v", approval)
		}
	}
}
