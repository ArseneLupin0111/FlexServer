//go:build linux

package applications

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// testContainerKey derives a deterministic 32-character opaque key for one
// raw full Docker container ID, mirroring the state.Store.ContainerKey
// contract (HMAC over a fixed domain, base64url, first 32 characters).
func testContainerKey(secret []byte, fullID string) string {
	m := hmac.New(sha256.New, secret)
	_, _ = m.Write([]byte("app-container-key\x00"))
	_, _ = m.Write([]byte(fullID))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))[:32]
}

// fakeEngine is a deterministic Engine API transport: listAllIDs serves the
// bounded row list, InspectContainer answers per full ID; erroring IDs fail
// every inspect so incompleteness can be exercised fail-closed.
type fakeEngine struct {
	snapshots map[string]string // fullID -> inspect JSON body
	orders    []string
}

func (f *fakeEngine) client() *engineClient {
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, r *http.Request) {
		rows := make([]map[string]string, 0, len(f.orders))
		for _, id := range f.orders {
			rows = append(rows, map[string]string{"Id": id})
		}
		_ = json.NewEncoder(w).Encode(rows)
	})
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		fullID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/containers/"), "/json")
		body, ok := f.snapshots[fullID]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	})
	return &engineClient{http: &http.Client{Transport: &localMux{mux: mux}}}
}

type localMux struct{ mux *http.ServeMux }

func (l *localMux) RoundTrip(req *http.Request) (*http.Response, error) {
	rec := httptest.NewRecorder()
	l.mux.ServeHTTP(rec, req)
	return rec.Result(), nil
}

// inspectBody builds the bounded inspect projection the engine client decodes.
func inspectBody(fullID, state, project, service, number string) string {
	labels := map[string]string{}
	if project != "" {
		labels["com.docker.compose.project"] = project
	}
	if service != "" {
		labels["com.docker.compose.service"] = service
	}
	if number != "" {
		labels["com.docker.compose.container-number"] = number
	}
	body := map[string]any{
		"Id":     fullID,
		"State":  map[string]any{"Status": state, "Running": state == "running"},
		"Config": map[string]any{"Labels": labels},
	}
	encoded, _ := json.Marshal(body)
	return string(encoded)
}

func TestDeriveRemovedServiceCandidatesSelectsAbsentServices(t *testing.T) {
	secret := []byte("test-key")
	id1 := strings.Repeat("a", 64)
	id2 := strings.Repeat("b", 64)
	id3 := strings.Repeat("c", 64)
	engine := (&fakeEngine{
		orders: []string{id1, id2, id3},
		snapshots: map[string]string{
			id1: inspectBody(id1, "running", "webapp", "legacy", "1"),
			id2: inspectBody(id2, "exited", "webapp", "legacy", "2"),
			id3: inspectBody(id3, "running", "webapp", "current", "1"),
		},
	}).client()
	removals, fp, err := deriveRemovedServiceCandidates(context.Background(), engine, func(full string) string { return testContainerKey(secret, full) }, "webapp", []string{"current"})
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(removals) != 1 || removals[0].ServiceName != "legacy" {
		t.Fatalf("unexpected removals: %+v", removals)
	}
	wantKeys := []string{testContainerKey(secret, id1), testContainerKey(secret, id2)}
	if removals[0].ContainerKeys[0] != wantKeys[0] || removals[0].ContainerKeys[1] != wantKeys[1] {
		t.Fatalf("unexpected container keys: %v vs %v", removals[0].ContainerKeys, wantKeys)
	}
	if len(fp) != 64 {
		t.Fatalf("fingerprint must be sha256 hex: %q", fp)
	}
	rows := []removalInventoryRow{
		{ContainerKey: testContainerKey(secret, id1), Project: "webapp", Service: "legacy", Slot: 1, State: "running"},
		{ContainerKey: testContainerKey(secret, id2), Project: "webapp", Service: "legacy", Slot: 2, State: "exited"},
		{ContainerKey: testContainerKey(secret, id3), Project: "webapp", Service: "current", Slot: 1, State: "running"},
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ContainerKey < rows[j].ContainerKey })
	encoded, _ := json.Marshal(rows)
	if removalInventoryFingerprint(encoded) != fp {
		t.Fatalf("fingerprint must cover complete daemon inventory")
	}
}

func TestDeriveRemovedServiceCandidatesFailsClosedOnBrokenInventory(t *testing.T) {
	secret := []byte("test-key")
	id1 := strings.Repeat("a", 64)
	idMissing := strings.Repeat("e", 64)
	ctx := context.Background()
	modelServices := []string{"current"}

	t.Run("nil engine", func(t *testing.T) {
		if _, _, err := deriveRemovedServiceCandidates(ctx, nil, func(s string) string { return testContainerKey(secret, s) }, "webapp", modelServices); err == nil {
			t.Fatal("nil engine must fail closed")
		}
	})
	t.Run("nil keyForID", func(t *testing.T) {
		engine := (&fakeEngine{orders: []string{id1}, snapshots: map[string]string{id1: inspectBody(id1, "running", "webapp", "legacy", "1")}}).client()
		if _, _, err := deriveRemovedServiceCandidates(ctx, engine, nil, "webapp", modelServices); err == nil {
			t.Fatal("nil keyForID must fail closed")
		}
	})
	t.Run("empty project", func(t *testing.T) {
		engine := (&fakeEngine{orders: []string{id1}, snapshots: map[string]string{id1: inspectBody(id1, "running", "webapp", "legacy", "1")}}).client()
		if _, _, err := deriveRemovedServiceCandidates(ctx, engine, func(s string) string { return testContainerKey(secret, s) }, "", modelServices); err == nil {
			t.Fatal("empty project must fail closed")
		}
	})
	t.Run("empty canonical service name", func(t *testing.T) {
		engine := (&fakeEngine{orders: []string{}, snapshots: map[string]string{}}).client()
		if _, _, err := deriveRemovedServiceCandidates(ctx, engine, func(s string) string { return testContainerKey(secret, s) }, "webapp", []string{""}); err == nil {
			t.Fatal("invalid canonical service name must fail closed")
		}
	})
	t.Run("inspect error", func(t *testing.T) {
		engine := (&fakeEngine{orders: []string{id1, idMissing}, snapshots: map[string]string{}}).client()
		if _, _, err := deriveRemovedServiceCandidates(ctx, engine, func(s string) string { return testContainerKey(secret, s) }, "webapp", modelServices); err == nil {
			t.Fatal("incomplete inspect must fail closed")
		}
	})
	t.Run("short opaque key", func(t *testing.T) {
		engine := (&fakeEngine{orders: []string{id1}, snapshots: map[string]string{id1: inspectBody(id1, "running", "webapp", "legacy", "1")}}).client()
		if _, _, err := deriveRemovedServiceCandidates(ctx, engine, func(s string) string { return "short" }, "webapp", modelServices); err == nil {
			t.Fatal("invalid opaque key must fail closed")
		}
	})
	t.Run("duplicate opaque key", func(t *testing.T) {
		engine := (&fakeEngine{orders: []string{id1, strings.Repeat("b", 64)}, snapshots: map[string]string{id1: inspectBody(id1, "running", "webapp", "legacy", "1")}}).client()
		if _, _, err := deriveRemovedServiceCandidates(ctx, engine, func(s string) string { return testContainerKey(secret, id1) }, "webapp", modelServices); err == nil {
			t.Fatal("duplicate opaque key must fail closed")
		}
	})
}

func TestDeriveRemovedServiceCandidatesFailsClosedOutsideProjectMembership(t *testing.T) {
	// A container without a service label can never be bound to a canonical
	// removal, so its presence in the target project must fail closed rather
	// than silently produce an empty or partial removal list.
	secret := []byte("test-key")
	idOther := strings.Repeat("f", 64)
	engine := (&fakeEngine{
		orders: []string{idOther},
		snapshots: map[string]string{
			idOther: inspectBody(idOther, "running", "webapp", "", ""),
		},
	}).client()
	if _, _, err := deriveRemovedServiceCandidates(context.Background(), engine, func(s string) string { return testContainerKey(secret, s) }, "webapp", []string{"current"}); err == nil {
		t.Fatal("missing service label in the target project must fail closed")
	}
}

func TestDeriveRemovedServiceCandidatesFingerprintMatchesCaptureFormat(t *testing.T) {
	secret := []byte("test-key")
	id1 := strings.Repeat("a", 64)
	engine := (&fakeEngine{
		orders: []string{id1},
		snapshots: map[string]string{
			id1: inspectBody(id1, "running", "proj1", "legacy", "1"),
		},
	}).client()
	_, fp, err := deriveRemovedServiceCandidates(context.Background(), engine, func(s string) string { return testContainerKey(secret, s) }, "proj1", []string{"current"})
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	rows := []removalInventoryRow{{ContainerKey: testContainerKey(secret, id1), Project: "proj1", Service: "legacy", Slot: 1, State: "running"}}
	// Recompute the complete-daemon capture bytes sorted by opaque key.
	encoded, _ := json.Marshal(rows)
	if removalInventoryFingerprint(encoded) != fp {
		t.Fatalf("fingerprint must share the deploy capture format")
	}
}

func TestDeriveRemovedServiceCandidatesFingerprintProjectOnly(t *testing.T) {
	secret := []byte("test-key")
	idTarget := strings.Repeat("a", 64)
	idOther := strings.Repeat("b", 64)
	keyForID := func(id string) string { return testContainerKey(secret, id) }
	base := (&fakeEngine{orders: []string{idTarget}, snapshots: map[string]string{idTarget: inspectBody(idTarget, "running", "proj1", "legacy", "1")}}).client()
	withOtherProject := (&fakeEngine{
		orders: []string{idTarget, idOther},
		snapshots: map[string]string{
			idTarget: inspectBody(idTarget, "running", "proj1", "legacy", "1"),
			idOther:  inspectBody(idOther, "running", "proj2", "service", "1"),
		},
	}).client()
	_, baseFP, err := deriveRemovedServiceCandidates(context.Background(), base, keyForID, "proj1", []string{"current"})
	if err != nil {
		t.Fatal(err)
	}
	_, changedFP, err := deriveRemovedServiceCandidates(context.Background(), withOtherProject, keyForID, "proj1", []string{"current"})
	if err != nil {
		t.Fatal(err)
	}
	if baseFP != changedFP {
		t.Fatal("fingerprint must remain stable under other project inventory changes")
	}
}

func TestCaptureRemovedOwnershipRejectsOmittedSibling(t *testing.T) {
	id1, id2, other := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	t.Setenv("COMPOSE_WORK_DIR", t.TempDir())
	keyForID := func(id string) string { return testContainerKey([]byte("test-key"), id) }
	engine := (&fakeEngine{orders: []string{id1, id2, other}, snapshots: map[string]string{
		id1:   inspectBody(id1, "running", "target", "legacy", "1"),
		id2:   inspectBody(id2, "exited", "target", "legacy", "2"),
		other: inspectBody(other, "running", "other", "legacy", "1"),
	}}).client()
	removals, fp, err := deriveRemovedServiceCandidates(context.Background(), engine, keyForID, "target", []string{"current"})
	if err != nil {
		t.Fatal(err)
	}
	p := approvedDeployPreview{RemovedServiceIDs: []string{"legacy"}, Removals: removals, OwnershipBinding: ownershipBinding{AgentInstanceID: "inst", DaemonEpoch: "epoch", ProjectName: "target"}}
	app := "app"
	if err := os.MkdirAll(filepath.Dir(ownershipPath(app)), 0700); err != nil {
		t.Fatal(err)
	}
	manifest := durableOwnership{Binding: p.OwnershipBinding, AppID: app, Containers: map[string]string{id1: "legacy", id2: "legacy"}}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ownershipPath(app), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyDurableOwnership(app, "inst", "epoch", "target", map[string]string{id1: "legacy", id2: "legacy"}); err != nil {
		t.Fatal(err)
	}
	ids, captured, err := captureRemovedOwnership(context.Background(), engine, keyForID, p, app, "inst", "epoch", "target")
	if err != nil {
		t.Fatal(err)
	}
	if captured != fp || len(ids) != 2 || ids[id1] != "legacy" || ids[id2] != "legacy" {
		t.Fatalf("wrong captured ownership: %v, fingerprint equal: %v", ids, captured == fp)
	}
	if _, ok := ids[other]; ok {
		t.Fatal("other project's container selected")
	}
	p.Removals[0].ContainerKeys = p.Removals[0].ContainerKeys[:1]
	if _, _, err := captureRemovedOwnership(context.Background(), engine, keyForID, p, app, "inst", "epoch", "target"); err == nil {
		t.Fatal("partial service manifest accepted")
	}
}

func TestCanonicalHashJSONRemovalPreimageStability(t *testing.T) {
	removals := []previewRemoval{
		{ServiceName: "legacy", ContainerKeys: []string{"key-bb", "key-aa"}},
	}
	ownership := ownershipBinding{AgentInstanceID: "inst", DaemonEpoch: "1", ProjectName: "proj"}
	encoded, err := canonicalHashJSON([2]any{"removals", removals}, [2]any{"ownershipBinding", ownership}, [2]any{"inventoryFingerprint", "fp"})
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	// Keys are ordered, arrays sorted, ownership serialized as the exact
	// preimage shape the API digest() matches.
	want := `{"removals":[{"serviceName":"legacy","containerKeys":["key-aa","key-bb"]}],"ownershipBinding":{"agentInstanceId":"inst","daemonEpoch":"1","projectName":"proj"},"inventoryFingerprint":"fp"}`
	if encoded != sha256HexOf(want) {
		t.Fatalf("preimage hash mismatch: %s", encoded)
	}
}

func sha256HexOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
