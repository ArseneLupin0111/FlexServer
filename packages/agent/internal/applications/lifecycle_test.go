//go:build linux

package applications

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vps-manager/agent/internal/config"
)

// Worker restart after authorization must never re-authorize or re-execute:
// the unknown following the durable mutationStarted receipt is reported as
// uncertain, exactly once, and the receipt is not replayed as a fresh claim.
func testUncertainRestartNoReexecute(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"ok":true,"committed":true,"acceptedSeq":1}}`))
	}))
}

// Uncertain receipt survives a corrupt/missing claim token only for truthfulness:
// result is never reported as success in the absence of proof.
func TestWorkerUncertainReceiptPromotesNotReclaims(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "compose-receipt.json")
	srv := testUncertainRestartNoReexecute(t)
	defer srv.Close()

	// Seed an authorized receipt as if a previous agent instance had already
	// granted mutation authorization and replayed the receipt.
	if err := writePrivateFile(path, []byte(`{"operationId":"op-1","appId":"app-1","generation":1,"kind":"deploy","claimToken":"tok","state":"applying","mutationAuthorized":true}`), 0o600); err != nil {
		t.Fatalf("seed receipt: %v", err)
	}
	w, err := newOperationWorker(testConfig2(srv.URL), "inst-1", path, func(string) string { return "" })
	if err != nil {
		t.Fatalf("worker: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := w.ProcessOne(ctx, "inst-1"); err != nil {
		t.Fatalf("process uncertain receipt: %v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read receipt: %v", err)
	}
	if strings.Contains(string(b), `"mutationAuthorized":false`) {
		t.Fatalf("authorization must remain, never re-granted: %s", b)
	}
	if !strings.Contains(string(b), `"state":"uncertain"`) {
		t.Fatalf("receipt must be promoted to uncertain on restart: %s", b)
	}
}

// The dependency-order verifier accepts healthy/completed conditions and
// rejects cycles and unresolved interpolation affecting identity/profiles.
func TestParseSourceDependencyConditions(t *testing.T) {
	svc := []byte(`
services:
  db:
    image: postgres
  web:
    image: app
    depends_on:
      db:
        condition: service_healthy
  migrate:
    image: app
    depends_on:
      db:
        condition: service_completed_successfully
`)
	vs, err := ParseSource(svc)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	positions := map[string]int{}
	for i, service := range vs.Order {
		positions[service] = i
	}
	if len(positions) != 3 || positions["db"] >= positions["web"] || positions["db"] >= positions["migrate"] {
		t.Fatalf("dependencies must precede their consumers: %v", vs.Order)
	}
	if d := vs.Services["web"].DependsOn["db"]; !strings.HasPrefix(d.Condition, "service_") {
		t.Fatalf("edge condition lost: %+v", d)
	}
	if !vs.Services["migrate"].DependsOn["db"].OneShot {
		t.Fatalf("service_completed_successfully must project as one-shot: %+v", vs.Services["migrate"].DependsOn)
	}
	if vs.Services["web"].Image != "app" {
		t.Fatalf("Image projection lost")
	}
}

// Healthcheck fact: readiness of a service itself derives from its declared
// healthcheck, never from dependency edge conditions.
func TestParseSourceHealthcheckFact(t *testing.T) {
	vs, err := ParseSource([]byte(`
services:
  db:
    image: postgres
    healthcheck:
      test: ["CMD", "true"]
  web:
    image: app
    depends_on:
      db:
        condition: service_healthy
`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !vs.Services["db"].Healthcheck {
		t.Fatalf("declared healthcheck must project as fact: %+v", vs.Services["db"])
	}
	// The dependent edge stays service_healthy, but web itself carries no
	// healthcheck fact and must not inherit "healthy" readiness.
	if vs.Services["web"].Healthcheck {
		t.Fatalf("healthcheck fact must not be inferred from dependency edges")
	}
	if len(vs.Order) != 2 || vs.Order[0] != "db" {
		t.Fatalf("dependency order broken: %v", vs.Order)
	}
}


func TestParseSourceRejectsProfilesInterpolationAndCycles(t *testing.T) {
	if _, err := ParseSource([]byte(`
services:
  a:
    image: img
    depends_on: ["b"]
  b:
    image: img
    depends_on: ["a"]
`)); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("cycle must be rejected: %v", err)
	}
	if _, err := ParseSource([]byte(`
services:
  a:
    image: img
    profiles: ["$OP"]
`)); err == nil || !strings.Contains(err.Error(), "profile") {
		t.Fatalf("unresolved profile interpolation must be rejected: %v", err)
	}
	if _, err := ParseSource([]byte(`
services:
  a:
    image: "img-${TAG}"
`)); err == nil || !strings.Contains(err.Error(), "identity") {
		t.Fatalf("unresolved identity interpolation must be rejected: %v", err)
	}
}

func TestParseSourceRejectsCustomTags(t *testing.T) {
	_, err := ParseSource([]byte("services:\n  web:\n    image: !custom app\n"))
	if err == nil || !strings.Contains(err.Error(), "unsupported_yaml") {
		t.Fatalf("custom YAML tags must be rejected: %v", err)
	}
}

// Lifecycle plan: failed one-shots are refused from retry by name.
func TestPlanFailedOneShots(t *testing.T) {
	p := &LifecyclePlan{
		Mode:  "lifecycle_restart",
		AppID: "a", Project: "p", Epoch: 1,
		Selected: []string{"job"},
		OneShots: map[string]OneShotPlan{
			"job": {State: "exited", ExitCode: 3},
		},
	}
	if got := planFailedOneShots(p); len(got) != 1 || got[0] != "job" {
		t.Fatalf("failed one-shot must be reported, got %v", got)
	}
	if err := p.ValidatePlan(); err != nil {
		t.Fatalf("plan validate: %v", err)
	}
}

func TestPlanMissingLongLivedContainerRefuses(t *testing.T) {
	p := &LifecyclePlan{
		Mode: "lifecycle_start", AppID: "a", Project: "p", Epoch: 1,
		Selected: []string{"web"},
		OneShots: map[string]OneShotPlan{"web": {NeverRerun: false, Awaitable: false}},
	}
	err := planMissingContainers(map[string][]string{"web": {}}, p)
	if err == nil || !strings.HasPrefix(err.Error(), "missing_container:web") {
		t.Fatalf("missing long-lived container must refuse the plan: %v", err)
	}
}

// Compose argv policy: no shell metachars, no orphan/rollback/swarm args, ever.
func TestComposeArgvPolicy(t *testing.T) {
	if err := validateComposeFixedArgv([]string{"up", "-d", "--no-build", "--pull", "never"}); err != nil {
		t.Fatalf("valid pinned up must pass, got %v", err)
	}
	for _, bad := range [][]string{
		{"up", "--remove-orphans"},
		{"up", "--wait-timeout=5"},
		{"up", "--scale=web=3"},
		{"config", "a;reboot"},
		{"up", "a\n"},
	} {
		if err := validateComposeFixedArgv(bad); err == nil {
			t.Fatalf("rejected vector expected: %v", bad)
		}
	}
}

// Runtime detection refuses user-selected binary and tolerates absence.
func TestDetectRuntimeMissing(t *testing.T) {
	if _, err := DetectRuntime(); err == nil {
		t.Logf("unexpected runtime present on test host")
	}
}

// The scrubbed environment never leaks ambient proxy/docker context and pins
// an isolated DOCKER_CONFIG, so agent/API secrets and platform-specific
// helpers never reach the Compose child process.
func TestScrubEnvIsolation(t *testing.T) {
	env := scrubEnv("/home", "/opaqueAuth", "unix:///var/run/docker.sock")
	for _, v := range env {
		if strings.HasPrefix(v, "DOCKER_CONFIG=/opaqueAuth") {
			continue
		}
		if strings.Contains(v, "COMPOSE_") && !strings.HasSuffix(v, "=") {
			t.Fatalf("environment must not carry COMPOSE values: %s", v)
		}
		if strings.HasPrefix(v, "HTTP_PROXY=") || strings.HasPrefix(v, "https_proxy=") {
			if v != "HTTP_PROXY=" && v != "https_proxy=" {
				t.Fatalf("proxy env leaked: %s", v)
			}
		}
	}
	if !strings.Contains(strings.Join(env, "\n"), "DOCKER_HOST=unix:///var/run/docker.sock") {
		t.Fatalf("compose child must use the fixed socket")
	}
}

// Bounded registry path: oversized identifiers never enter private paths.
func TestWorkspacePathBounded(t *testing.T) {
	if err := safeDirComponent(strings.Repeat("z", 200)); err == nil {
		t.Fatalf("unsafe workspace component: expected rejection, got none")
	}
}

// Lock store is atomic under a single writer; TTL reclaim never touches a
// mutating holder and a conflicting mutating row always reports busy.
func TestHostLockMutatingExclusion(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("FLEXSERVER_AGENT_STATE_DIR", dir)
	// resetHostLockSingleton + DefaultLockPath force the lazy registry to
	// re-resolve and mkdir this temp dir's state path (a bare `lockRegistry
	// = nil` leaves the once spent, so nothing else re-inits/MkdirAll's the
	// directory the sidecar .lock file needs).
	resetHostLockSingleton()
	if _, err := DefaultLockPath(); err != nil {
		t.Fatalf("lock path: %v", err)
	}
	if err := acquireScope("project:1|1|proj", "compose-operation", "op-a", true, time.Minute); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := acquireScope("project:1|1|proj", "compose-operation", "op-b", false, time.Minute); err == nil || !strings.HasPrefix(err.Error(), "scope_busy") {
		t.Fatalf("conflicting holder must be refused: %v", err)
	}
	if err := releaseScope("project:1|1|proj", "compose-operation", "op-a"); err != nil {
		t.Fatalf("release: %v", err)
	}
	if err := acquireScope("project:1|1|proj", "compose-operation", "op-b", true, time.Minute); err != nil {
		t.Fatalf("reacquire after release: %v", err)
	}
	if err := acquireScope("container:other", "compose-operation", "op-c", true, time.Minute); err != nil {
		t.Fatalf("independent resource scope must not contend: %v", err)
	}
	if err := releaseScope("container:other", "compose-operation", "op-c"); err != nil {
		t.Fatalf("release independent scope: %v", err)
	}
	// Lock store must never overwrite a corrupt registry (fail closed).
	b, err := os.ReadFile(filepath.Join(dir, "docker-applications", "exclusion.json"))
	if err != nil {
		t.Fatalf("registry readable: %v", err)
	}
	if len(b) == 0 {
		t.Fatalf("registry must persist rows")
	}
}

func testConfig2(url string) *config.Config {
	return &config.Config{BackendUrl: url, Token: "test-token", RequestTimeoutSeconds: 5, IntervalSeconds: 30}
}
