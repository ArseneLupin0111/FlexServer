//go:build linux

package applications

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestObservedReceiptReplayPreservesPayload(t *testing.T) {
	var first []byte
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		calls++
		if calls == 1 {
			first = body
			w.WriteHeader(503)
			return
		}
		if string(body) != string(first) {
			t.Errorf("replayed receipt differs: %s != %s", body, first)
		}
		w.WriteHeader(200)
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "receipt.json")
	worker, err := newOperationWorker(testConfig2(server.URL), "instance", path, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	receipt := &workerReceipt{OperationID: "op", AppID: "app", Generation: 1, Kind: "preview_prepare", ClaimToken: "claim", State: "succeeded"}
	observed := []any{map[string]any{"digest": "canonical-digest", "removedServiceIds": []string{"legacy"}}}
	if err := worker.reportObserved(context.Background(), receipt, "succeeded", false, observed, ""); err == nil {
		t.Fatal("transport failure must retain receipt")
	}
	if err := worker.ProcessOne(context.Background(), "instance"); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("wanted report then replay, got %d requests", calls)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("acknowledged receipt not cleared: %v", err)
	}
}
