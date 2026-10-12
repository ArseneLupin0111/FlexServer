package updater

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- shared fault-injection harness ----------

// eventLog is the cross-component timeline: the fake API and the fake
// systemctl append here so tests can assert ordering across components
// (e.g. the restarting progress POST precedes the actual restart).
type eventLog struct {
	mu    sync.Mutex
	items []string
}

func (e *eventLog) add(s string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.items = append(e.items, s)
}

func (e *eventLog) index(s string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i, v := range e.items {
		if v == s {
			return i
		}
	}
	return -1
}

func (e *eventLog) contains(prefix string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, v := range e.items {
		if strings.HasPrefix(v, prefix) {
			return true
		}
	}
	return false
}

// releaseFixture is a self-contained signed release: the daemon/helper
// contract under test must accept ANY properly signed manifest, so tests
// generate their own keypair instead of depending on release fixtures.
type releaseFixture struct {
	pubKeyB64   string
	manifestRaw []byte
	releaseID   string
	buildID     string
	sha         string
	content     []byte
	artifactURL string
}

// newRelease signs a manifest over an artifact of the given content with the
// given URL (must pass the host allowlist of the test config).
func newRelease(t *testing.T, content []byte, artifactURL string) *releaseFixture {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	seed := SHA256Hex(content)
	rel := &releaseFixture{
		pubKeyB64:   base64.StdEncoding.EncodeToString(pub),
		releaseID:   seed[:40],
		buildID:     SHA256Hex([]byte(seed + "b"))[:40],
		sha:         SHA256Hex(content),
		content:     content,
		artifactURL: artifactURL,
	}
	doc := map[string]any{
		"releaseId":        rel.releaseID,
		"version":          "9.9.9",
		"buildId":          rel.buildID,
		"channel":          "stable",
		"publishedAt":      "2026-09-27T00:00:00Z",
		"apiCompatibility": map[string]any{"min": 1, "max": 2},
		"artifacts": []any{map[string]any{
			"os": "linux", "arch": "amd64",
			"size": len(content), "sha256": rel.sha, "url": artifactURL,
		}},
	}
	unsigned, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	canon, err := CanonicalJSON(unsigned)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	doc["signature"] = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, canon))
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal signed manifest: %v", err)
	}
	rel.manifestRaw = raw
	// Sanity: the harness manifest must verify — a test bug must not look
	// like a production failure later.
	if _, err := VerifyManifest(raw, rel.pubKeyB64); err != nil {
		t.Fatalf("harness manifest does not verify: %v", err)
	}
	return rel
}

// tamper flips the first hex digit of the signed artifact sha WITHOUT
// re-signing — the exact attacker model the signature check must stop.
func (r *releaseFixture) tamper(t *testing.T) []byte {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(r.manifestRaw, &doc); err != nil {
		t.Fatalf("unmarshal for tamper: %v", err)
	}
	arts := doc["artifacts"].([]any)
	a := arts[0].(map[string]any)
	sha := a["sha256"].(string)
	flipped := "0" + sha[1:]
	if flipped == sha {
		flipped = "1" + sha[1:]
	}
	a["sha256"] = flipped
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal tampered: %v", err)
	}
	return raw
}

func testConfig(t *testing.T, rel *releaseFixture) *Config {
	t.Helper()
	stateDir := t.TempDir()
	binDir := t.TempDir()
	cfg := &Config{
		APIBase:                "https://api.test.invalid",
		Credential:             "vma_test_credential",
		AgentBinary:            filepath.Join(binDir, "vps-manager-agent"),
		AgentUnit:              "vps-manager-agent.service",
		StateDir:               stateDir,
		HTTPTimeoutSec:         2,
		ClaimIntervalSec:       1,
		HeartbeatIntervalSec:   1,
		AwaitHeartbeatGraceSec: 360,
		HelperTimeoutSec:       30,
	}
	// In-process fault harness only: redirect the fixed production targets
	// and allowlist at temp dirs.
	cfg.EnableTestOverrides()
	if rel != nil {
		job := &ClaimedJob{
			JobID:           faultJobID,
			Phase:           PhaseRestarting,
			TargetSha256:    rel.sha,
			TargetSizeBytes: int64(len(rel.content)),
			LeaseExpiresAt:  FlexTime{Time: time.Now().Add(5 * time.Minute)},
			PhaseDeadlineAt: FlexTime{Time: time.Now().Add(5 * time.Minute)},
			DeadlineAt:      FlexTime{Time: time.Now().Add(5 * time.Minute)},
			Release: ReleaseInfo{
				ReleaseID:    rel.releaseID,
				BuildID:      rel.buildID,
				TargetSha256: rel.sha,
			},
		}
		cfg.SetTestAuthorizer(&fakeAPI{job: job})
	}
	if err := cfg.NormalizeAndValidate(); err != nil {
		t.Fatalf("test config: %v", err)
	}
	// Fast polling for the harness; the production cadence (60s/15s) is a
	// config concern, not a state-machine concern.
	cfg.HeartbeatInterval = 50 * time.Millisecond
	cfg.ClaimInterval = 200 * time.Millisecond
	cfg.HelperTimeout = 30 * time.Second
	return cfg
}

// fakeSystemctl replaces the systemctl seam: scripted restart failures,
// instantaneous is-active answers, everything on a shared timeline.
type fakeSystemctl struct {
	mu          sync.Mutex
	restartErrs []error
	restarts    int
	inactive    bool // when true, is-active reports "inactive"
	events      *eventLog
}

func (f *fakeSystemctl) call(_ context.Context, args ...string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(args) > 0 && args[0] == "restart" {
		f.events.add("systemctl:restart")
		f.restarts++
		if len(f.restartErrs) > 0 {
			err := f.restartErrs[0]
			f.restartErrs = f.restartErrs[1:]
			return "Job for vps-manager-agent.service failed", err
		}
		return "", nil
	}
	if len(args) > 0 && args[0] == "is-active" {
		if f.inactive {
			return "inactive", nil
		}
		return "active", nil
	}
	return "", nil
}

func (f *fakeSystemctl) restartCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.restarts
}

// installSeams swaps the process/systemd seams for the duration of the test.
func installSeams(t *testing.T, events *eventLog, buildID string) *fakeSystemctl {
	t.Helper()
	oldExec, oldSys := execStagedVersion, runSystemctl
	oldWait, oldPoll := serviceActiveWait, servicePollEvery
	fs := &fakeSystemctl{events: events}
	execStagedVersion = func(_ context.Context, _ string) (string, error) {
		return "9.9.9+" + buildID, nil
	}
	runSystemctl = fs.call
	serviceActiveWait = 200 * time.Millisecond
	servicePollEvery = 20 * time.Millisecond
	t.Cleanup(func() {
		execStagedVersion, runSystemctl = oldExec, oldSys
		serviceActiveWait, servicePollEvery = oldWait, oldPoll
	})
	return fs
}

// fakeAPI implements the API interface: an in-memory server view with the
// same terminal/lease semantics the real contract has.
type fakeAPI struct {
	mu            sync.Mutex
	job           *ClaimedJob
	claimErr      error
	claims        int // successful claim deliveries
	calls         int // total Claim invocations (incl. failures)
	phases        []string
	results       []string // "outcome|reportedBuildId"
	flipAfterGets int      // >0: after N Gets while awaiting, rule success
	events        *eventLog
}

func newFakeAPI(job *ClaimedJob, events *eventLog) *fakeAPI {
	return &fakeAPI{job: job, events: events}
}

func (f *fakeAPI) Claim(_ context.Context) (*ClaimedJob, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	if f.job == nil || f.claims > 0 {
		return nil, nil
	}
	f.claims++
	return f.job, nil
}

func (f *fakeAPI) Progress(_ context.Context, _ string, token int64, phase string, _ *int, _ string) (*ClaimedJob, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.phases = append(f.phases, phase)
	f.events.add("progress:" + phase)
	if f.job != nil {
		f.job.Phase = phase
		f.job.FencingToken = token
	}
	return f.job, nil
}

func (f *fakeAPI) Result(_ context.Context, _ string, _ int64, outcome, buildID, _ string) (*ClaimedJob, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results = append(f.results, outcome+"|"+buildID)
	f.events.add("result:" + outcome)
	if f.job != nil {
		f.job.Phase = outcome // terminal ruling, same as the real server
	}
	return f.job, false, nil
}

func (f *fakeAPI) Get(_ context.Context, _ string) (*ClaimedJob, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.flipAfterGets > 0 && f.job != nil && f.job.Phase == PhaseAwaitingHB {
		f.flipAfterGets--
		if f.flipAfterGets == 0 {
			f.job.Phase = "succeeded"
		}
	}
	return f.job, nil
}

func (f *fakeAPI) phaseList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.phases...)
}

func (f *fakeAPI) resultList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.results...)
}

func (f *fakeAPI) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// serverPhase exposes the fake server's current job phase for assertions.
func (f *fakeAPI) serverPhase() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.job == nil {
		return ""
	}
	return f.job.EffectivePhase()
}

// seedStaging writes the signed manifest + artifact the daemon stages for
// the helper.
func seedStaging(t *testing.T, cfg *Config, rel *releaseFixture) {
	t.Helper()
	dir := stagingDir(cfg.StateDir, faultJobID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir staging: %v", err)
	}
	metaBytes, _ := json.Marshal(map[string]any{
		"jobId":   faultJobID,
		"buildId": rel.buildID,
		"sha256":  rel.sha,
		"size":    len(rel.content),
	})
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), metaBytes, 0o644); err != nil {
		t.Fatalf("write staging meta: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "artifact.bin"), rel.content, 0o755); err != nil {
		t.Fatalf("write staging artifact: %v", err)
	}
}

func writeFile(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func shaOf(t *testing.T, path string) string {
	t.Helper()
	sha, err := sha256File(path)
	if err != nil {
		t.Fatalf("hash %s: %v", path, err)
	}
	return sha
}

func readResultT(t *testing.T, cfg *Config, action, jobID string) *HelperResult {
	t.Helper()
	res, err := ReadResult(cfg.StateDir, action, jobID)
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	if res == nil {
		t.Fatalf("expected %s result for %s, none written", action, jobID)
	}
	return res
}

func writePending(t *testing.T, cfg *Config, action, jobID string) {
	t.Helper()
	if err := os.MkdirAll(pendingDir(cfg.StateDir), 0o770); err != nil {
		t.Fatalf("mkdir pending: %v", err)
	}
	if err := atomicWriteFile(pendingPath(cfg.StateDir, action, jobID), []byte(`{}`), 0o644); err != nil {
		t.Fatalf("write pending: %v", err)
	}
}

const faultJobID = "lug_faulttestjob1"

// startHelperLoop simulates the systemd path unit: a goroutine that keeps
// draining pending actions while the daemon runs. It stops automatically at
// test end, so a t.Fatalf mid-test cannot leak it.
func startHelperLoop(t *testing.T, cfg *Config, events *eventLog) {
	t.Helper()
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			pending, err := os.ReadDir(pendingDir(cfg.StateDir))
			if err == nil && len(pending) > 0 {
				events.add("helper:run")
				if err := RunHelper(context.Background(), cfg); err != nil {
					events.add("helper:error:" + err.Error())
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	t.Cleanup(func() {
		close(stop)
		wg.Wait()
	})
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return raw
}

// ---------- signature verification ----------

// TestHelperRejectsTamperedManifestNoSwap: a one-byte tamper of the signed
// manifest must abort the privileged apply before ANY mutation: binary
// untouched, no backup, no helper journal, verify_failed reported.
func TestHelperRejectsTamperedMetadataNoSwap(t *testing.T) {
	rel := newRelease(t, []byte("new-agent-binary-content"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	oldContent := []byte("old-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	seedStaging(t, cfg, rel)
	tamperedMeta, _ := json.Marshal(map[string]any{
		"jobId":   faultJobID,
		"buildId": "tampered-build-id-different",
		"sha256":  rel.sha,
		"size":    len(rel.content),
	})
	if err := os.WriteFile(filepath.Join(stagingDir(cfg.StateDir, faultJobID), "meta.json"), tamperedMeta, 0o644); err != nil {
		t.Fatalf("overwrite tampered meta: %v", err)
	}
	writePending(t, cfg, actionApply, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "verify_failed" {
		t.Fatalf("outcome = %q, want verify_failed (detail: %s)", res.Outcome, res.Detail)
	}
	if !strings.Contains(res.Detail, "buildId mismatch") {
		t.Fatalf("detail %q does not mention buildId mismatch", res.Detail)
	}
	if got := shaOf(t, cfg.AgentBinary); got != oldSha || string(mustRead(t, cfg.AgentBinary)) != string(oldContent) {
		t.Fatalf("binary mutated by rejected apply: sha %s", got)
	}
	if hj, err := LoadHelperJournal(cfg.StateDir); err != nil || hj != nil {
		t.Fatalf("helper journal must be absent, got %v / %v", hj, err)
	}
	if _, err := os.Stat(backupDir(cfg.StateDir, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup dir must not exist after rejected apply: %v", err)
	}
	if events.contains("systemctl:restart") {
		t.Fatalf("service must not be restarted for a rejected manifest: %v", events.items)
	}
	// Verification failure is terminal and cannot mutate the binary; the
	// helper must consume the request or systemd's path unit loops forever.
	if _, err := os.Stat(pendingPath(cfg.StateDir, actionApply, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pending apply must be consumed on verify_failed: %v", err)
	}
}

// TestDaemonFailsPreSwapOnTamperedManifest: the same failure at daemon level
// reports outcome=failed to the API, never writes an apply request, and
// clears its journal only after the server's terminal ruling.
func TestDaemonFailsPreSwapOnMissingTargetSha(t *testing.T) {
	rel := newRelease(t, []byte("daemon-tampered-content"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	oldContent := []byte("old-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	job := &ClaimedJob{JobID: faultJobID, Phase: "queued", FencingToken: 1}
	api := newFakeAPI(job, events)
	d := NewDaemon(cfg, api)

	startHelperLoop(t, cfg, events)
	d.stepClaim(context.Background())
	j, err := d.journal.Load()
	if err != nil || j == nil {
		t.Fatalf("journal after claim: %v / %v", j, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := d.runJob(ctx, j); err != nil {
		t.Fatalf("runJob: %v", err)
	}

	if got := api.resultList(); len(got) != 1 || !strings.HasPrefix(got[0], "failed|") {
		t.Fatalf("results = %v, want exactly failed", got)
	}
	if strings.Contains(strings.Join(api.phaseList(), ","), "restarting") {
		t.Fatalf("phases = %v, must never reach restarting", api.phaseList())
	}
	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("binary mutated: %s", got)
	}
	if hj, _ := LoadHelperJournal(cfg.StateDir); hj != nil {
		t.Fatalf("helper journal must be absent")
	}
	if j, err := d.journal.Load(); err != nil || j != nil {
		t.Fatalf("journal must be consumed after terminal ruling, got %v / %v", j, err)
	}
}

// ---------- crash after swap ----------

// TestCrashAfterSwapReconcilesNoDoubleSwap: helper journal says "intent" but
// the binary already hashes to the new build — the crash landed between
// rename and journal update. The re-triggered helper must adopt the swap and
// finish the restart, never re-run the backup/swap (which would back up the
// NEW binary and destroy the rollback path).
func TestCrashAfterSwapReconcilesNoDoubleSwap(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-after-swap"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	oldContent := []byte("OLD-agent-binary")
	newSha := rel.sha
	oldSha := SHA256Hex(oldContent)

	// On-disk crash state: swap happened, journal update was lost.
	writeFile(t, cfg.AgentBinary, rel.content, 0o755) // post-rename
	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, oldContent, 0o755) // backup of the OLD binary
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjIntent,
		OldSha256: oldSha, NewSha256: newSha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save hj: %v", err)
	}
	seedStaging(t, cfg, rel)
	writePending(t, cfg, actionApply, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "recovered_restarted" {
		t.Fatalf("outcome = %q, want recovered_restarted (detail: %s)", res.Outcome, res.Detail)
	}
	// No double swap: binary still the new build, backup still the OLD bytes
	// (a fresh apply would have tried to re-create the backup and failed or
	// worse, overwritten the rollback source).
	if got := shaOf(t, cfg.AgentBinary); got != newSha {
		t.Fatalf("binary sha %s != new %s (double swap?)", got, newSha)
	}
	if got := shaOf(t, backupPath); got != oldSha {
		t.Fatalf("backup sha %s != old %s (rollback source destroyed)", got, oldSha)
	}
	hj, err := LoadHelperJournal(cfg.StateDir)
	if err != nil || hj == nil || hj.Phase != hjRestarted {
		t.Fatalf("helper journal = %+v / %v, want phase restarted", hj, err)
	}
	if fs.restartCount() != 1 {
		t.Fatalf("restarts = %d, want exactly 1", fs.restartCount())
	}
	// Pending consumed: a consumable outcome must not leave the request around.
	if _, err := os.Stat(pendingPath(cfg.StateDir, actionApply, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pending apply must be consumed: %v", err)
	}
}

// TestCrashBeforeRenameReconcilesNoSwap: crash landed before the rename —
// reconciliation must report that no swap happened (daemon then fails the
// job pre-swap) and must not touch the binary.
func TestCrashBeforeRenameReconcilesNoSwap(t *testing.T) {
	rel := newRelease(t, []byte("NEW-never-swapped"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	oldContent := []byte("OLD-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, oldContent, 0o755)
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjIntent,
		OldSha256: oldSha, NewSha256: rel.sha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save hj: %v", err)
	}
	seedStaging(t, cfg, rel)
	writePending(t, cfg, actionApply, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "recovered_no_swap" {
		t.Fatalf("outcome = %q, want recovered_no_swap (detail: %s)", res.Outcome, res.Detail)
	}
	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("binary mutated: %s", got)
	}
}

// ---------- disk full ----------

// TestJournalENOSPCAbortsPreSwap: an ENOSPC on the durability-critical
// journal write must abort the job step before any helper request exists.
func TestJournalENOSPCAbortsPreSwap(t *testing.T) {
	rel := newRelease(t, []byte("enospc-artifact"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	oldContent := []byte("old-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	d := NewDaemon(cfg, newFakeAPI(nil, events))
	// Journal exists at downloading with a valid manifest; the next Save
	// (the phase transition) hits a full disk.
	j := &Journal{
		JobID: faultJobID, FencingToken: 1,
		ReleaseID: rel.releaseID, BuildID: rel.buildID, Version: "9.9.9",
		TargetSha256: rel.sha, ManifestRaw: string(rel.manifestRaw),
		Phase: PhaseDownloading, CreatedAt: time.Now().UTC(),
	}
	if err := d.journal.Save(j); err != nil {
		t.Fatalf("seed journal: %v", err)
	}
	d.journal.faultWrite = func() error {
		return errors.New("no space left on device")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := d.runJob(ctx, j)
	if err == nil || !strings.Contains(err.Error(), "injected fault") {
		t.Fatalf("runJob err = %v, want injected fault", err)
	}

	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("binary mutated under ENOSPC: %s", got)
	}
	if entries, err := os.ReadDir(pendingDir(cfg.StateDir)); err == nil && len(entries) > 0 {
		t.Fatalf("helper request must not exist, found %v", entries)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read pending dir: %v", err)
	}
	// On-disk journal unchanged: still downloading.
	got, err := NewJournalStore(cfg.StateDir).Load()
	if err != nil || got == nil || got.Phase != PhaseDownloading {
		t.Fatalf("journal on disk = %+v / %v, want phase downloading", got, err)
	}
}

// ---------- offline ----------

// TestOfflineClaimRetriesNeverMutates: with the API unreachable the daemon
// must keep retrying claims without creating any local state or touching the
// healthy agent.
func TestOfflineClaimRetriesNeverMutates(t *testing.T) {
	rel := newRelease(t, []byte("offline-artifact"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	oldContent := []byte("healthy-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	api := &fakeAPI{claimErr: errors.New("dial tcp: connection refused"), events: events}
	d := NewDaemon(cfg, api)

	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	if err := d.Run(ctx); err != nil {
		t.Fatalf("Run must not fail offline, got %v", err)
	}

	if api.callCount() < 2 {
		t.Fatalf("expected retried claims while offline, got %d", api.callCount())
	}
	if j, _ := d.journal.Load(); j != nil {
		t.Fatalf("no journal may be created offline: %+v", j)
	}
	if fs.restartCount() != 0 {
		t.Fatalf("restarts = %d, want 0", fs.restartCount())
	}
	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("healthy agent mutated offline: %s", got)
	}
	if events.contains("progress:") {
		t.Fatalf("no progress may be posted offline: %v", events.items)
	}
}

// TestOfflineDownloadRetriesPreSwap: an unreachable artifact host during the
// downloading phase is a retry state — no phase advance, no helper request,
// no rollback of the healthy agent.
func TestOfflineDownloadRetriesPreSwap(t *testing.T) {
	rel := newRelease(t, []byte("unreachable-download"), "https://localhost:443/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	oldContent := []byte("healthy-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	api := newFakeAPI(nil, events)
	d := NewDaemon(cfg, api)
	j := &Journal{
		JobID: faultJobID, FencingToken: 1,
		ReleaseID: rel.releaseID, BuildID: rel.buildID, Version: "9.9.9",
		TargetSha256: rel.sha, ManifestRaw: string(rel.manifestRaw),
		Phase: PhaseDownloading, CreatedAt: time.Now().UTC(),
	}
	if err := d.journal.Save(j); err != nil {
		t.Fatalf("seed journal: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err := d.runJob(ctx, j)
	if err == nil || !strings.Contains(err.Error(), "download") {
		t.Fatalf("runJob err = %v, want download error", err)
	}

	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("healthy agent mutated after failed download: %s", got)
	}
	if fs.restartCount() != 0 {
		t.Fatalf("restarts = %d, want 0", fs.restartCount())
	}
	if entries, e := os.ReadDir(pendingDir(cfg.StateDir)); e == nil && len(entries) > 0 {
		t.Fatalf("no helper request may exist: %v", entries)
	}
	if got, e := NewJournalStore(cfg.StateDir).Load(); e != nil || got.Phase != PhaseDownloading {
		t.Fatalf("journal = %+v / %v, want staying at downloading", got, e)
	}
}

// ---------- rollback verification ----------

// TestFailedRestartAutoRollsBack: restart fails after the swap → the helper
// must restore the backup byte-identically, restart the old binary and
// report auto_rolled_back with the OLD hash.
func TestFailedRestartAutoRollsBack(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-v2"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)
	fs.restartErrs = []error{errors.New("unit failed to start")}

	oldContent := []byte("OLD-agent-binary")
	writeFile(t, cfg.AgentBinary, oldContent, 0o755)
	oldSha := shaOf(t, cfg.AgentBinary)

	seedStaging(t, cfg, rel)
	writePending(t, cfg, actionApply, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionApply, faultJobID)
	if res.Outcome != "auto_rolled_back" {
		t.Fatalf("outcome = %q, want auto_rolled_back (detail: %s)", res.Outcome, res.Detail)
	}
	if res.BinarySha256 != oldSha {
		t.Fatalf("binarySha256 = %s, want old %s", res.BinarySha256, oldSha)
	}
	if got := shaOf(t, cfg.AgentBinary); got != oldSha {
		t.Fatalf("binary after auto-rollback = %s, want byte-identical old %s", got, oldSha)
	}
	if string(mustRead(t, cfg.AgentBinary)) != string(oldContent) {
		t.Fatalf("restored binary content differs from original")
	}
	hj, err := LoadHelperJournal(cfg.StateDir)
	if err != nil || hj == nil || hj.Phase != hjRolledBack {
		t.Fatalf("helper journal = %+v / %v, want rolled_back", hj, err)
	}
	// Backup retained until the server's terminal ruling (cleanup is a
	// separate action the daemon only triggers after seeing the ruling).
	if _, err := os.Stat(hj.BackupPath); err != nil {
		t.Fatalf("backup must be retained after auto-rollback: %v", err)
	}
	if fs.restartCount() != 2 {
		t.Fatalf("restarts = %d, want 2 (failed + rollback)", fs.restartCount())
	}
}

// TestRollbackRefusesTamperedBackup: a backup that no longer hashes to the
// recorded old value must never be restored — rollback_failed, binary left
// exactly as it was, pending request retained for the operator.
func TestRollbackRefusesTamperedBackup(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-tamper-backup"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)

	writeFile(t, cfg.AgentBinary, rel.content, 0o755)
	newSha := shaOf(t, cfg.AgentBinary)
	oldSha := SHA256Hex([]byte("OLD-agent-binary"))

	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, []byte("TAMPERED-backup-bytes"), 0o755) // sha != oldSha
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjRestarted,
		OldSha256: oldSha, NewSha256: newSha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save hj: %v", err)
	}
	writePending(t, cfg, actionRollback, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionRollback, faultJobID)
	if res.Outcome != "rollback_failed" {
		t.Fatalf("outcome = %q, want rollback_failed (detail: %s)", res.Outcome, res.Detail)
	}
	if !strings.Contains(res.Detail, "backup sha") {
		t.Fatalf("detail %q must explain the backup hash mismatch", res.Detail)
	}
	if got := shaOf(t, cfg.AgentBinary); got != newSha {
		t.Fatalf("binary must be untouched when restore refuses: %s", got)
	}
	// Unclear/failed outcomes keep the pending file so the daemon still sees
	// the request until it halts the job.
	if _, err := os.Stat(pendingPath(cfg.StateDir, actionRollback, faultJobID)); err != nil {
		t.Fatalf("pending rollback must be retained: %v", err)
	}
}

// TestRollbackRestoresOldBinary: the explicit rollback action restores the
// backup byte-identically, restarts and reports rolled_back.
func TestRollbackRestoresOldBinary(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-rollback-path"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	oldContent := []byte("OLD-agent-binary")
	writeFile(t, cfg.AgentBinary, rel.content, 0o755)
	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, oldContent, 0o755)
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjRestarted,
		OldSha256: SHA256Hex(oldContent), NewSha256: rel.sha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save hj: %v", err)
	}
	writePending(t, cfg, actionRollback, faultJobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res := readResultT(t, cfg, actionRollback, faultJobID)
	if res.Outcome != "rolled_back" {
		t.Fatalf("outcome = %q, want rolled_back (detail: %s)", res.Outcome, res.Detail)
	}
	if string(mustRead(t, cfg.AgentBinary)) != string(oldContent) {
		t.Fatalf("binary not restored byte-identically")
	}
	if fs.restartCount() != 1 {
		t.Fatalf("restarts = %d, want 1", fs.restartCount())
	}
	if _, err := os.Stat(pendingPath(cfg.StateDir, actionRollback, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pending rollback must be consumed: %v", err)
	}
}

// ---------- daemon end-to-end ----------

// TestDaemonEndToEndUpgrade runs the full state machine against the fake API
// and helper loop: claim → download (pre-seeded) → verify → stage →
// progress(restarting) BEFORE the privileged restart → await heartbeat →
// observe terminal succeeded → cleanup → journal consumed.
func TestDaemonEndToEndUpgrade(t *testing.T) {
	rel := newRelease(t, []byte("E2E-new-agent-binary"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	writeFile(t, cfg.AgentBinary, []byte("E2E-old-agent-binary"), 0o755)

	job := &ClaimedJob{JobID: faultJobID, Phase: "queued", FencingToken: 1,
		ManifestRaw: string(rel.manifestRaw)}
	job.Release.ReleaseID, job.Release.BuildID = rel.releaseID, rel.buildID
	job.Release.Version, job.Release.TargetSha256 = "9.9.9", rel.sha
	api := newFakeAPI(job, events)
	api.flipAfterGets = 2 // server observes the target heartbeat, then rules

	// Pre-seed the staged artifact: the download path is exercised by its own
	// tests; here the URL is unreachable by design.
	seedStaging(t, cfg, rel)

	startHelperLoop(t, cfg, events)

	d := NewDaemon(cfg, api)
	d.stepClaim(context.Background())
	j, err := d.journal.Load()
	if err != nil || j == nil {
		t.Fatalf("journal after claim: %v / %v", j, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := d.runJob(ctx, j); err != nil {
		t.Fatalf("runJob: %v", err)
	}

	// Server view: the happy path is server-ruled — the updater posts no
	// result on success, only phases; the server rules succeeded after
	// observing the target heartbeat and the daemon consumes from GET.
	if got := api.resultList(); len(got) != 0 {
		t.Fatalf("results = %v, want none: success is server-ruled", got)
	}
	if got := api.serverPhase(); got != "succeeded" {
		t.Fatalf("server phase = %q, want succeeded", got)
	}
	phases := api.phaseList()
	wantOrder := []string{PhaseDownloading, PhaseVerifying, PhaseStaging, PhaseRestarting, PhaseAwaitingHB}
	var seq int
	for _, want := range wantOrder {
		found := -1
		for i := seq; i < len(phases); i++ {
			if phases[i] == want {
				found = i
				break
			}
		}
		if found == -1 {
			t.Fatalf("phases = %v, missing %q in order", phases, want)
		}
		seq = found + 1
	}
	// Contract: the restarting progress POST must precede the actual restart
	// so the server's heartbeat baseline is older than the first
	// post-restart heartbeat.
	ri, si := events.index("progress:restarting"), events.index("systemctl:restart")
	if ri < 0 || si < 0 || ri > si {
		t.Fatalf("progress:restarting (%d) must precede systemctl:restart (%d): %v", ri, si, events.items)
	}
	// Awaiting must be reported after the restart as well.
	ai := events.index("progress:awaiting_heartbeat")
	if ai < si {
		t.Fatalf("awaiting_heartbeat (%d) reported before restart (%d)", ai, si)
	}

	// Local view: swapped, consumed, cleaned.
	if got := shaOf(t, cfg.AgentBinary); got != rel.sha {
		t.Fatalf("binary sha %s, want new %s", got, rel.sha)
	}
	if fs.restartCount() != 1 {
		t.Fatalf("restarts = %d, want 1", fs.restartCount())
	}
	if j, err := d.journal.Load(); err != nil || j != nil {
		t.Fatalf("journal must be consumed, got %v / %v", j, err)
	}
	if _, err := os.Stat(backupDir(cfg.StateDir, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup must be cleaned after succeeded ruling: %v", err)
	}
	if _, err := os.Stat(stagingDir(cfg.StateDir, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging must be cleaned: %v", err)
	}
}

// TestDaemonRollbackOnHeartbeatTimeout: post-swap awaiting with a baseline
// older than the grace deadline (server reachable, non-terminal) must trigger
// the rollback request, restore the old binary and report rolled_back.
func TestDaemonRollbackOnHeartbeatTimeout(t *testing.T) {
	rel := newRelease(t, []byte("grace-timeout-new-binary"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)

	oldContent := []byte("grace-old-binary")
	newSha := rel.sha
	oldSha := SHA256Hex(oldContent)
	writeFile(t, cfg.AgentBinary, rel.content, 0o755) // post-swap state

	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, oldContent, 0o755)
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjRestarted,
		OldSha256: oldSha, NewSha256: newSha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save hj: %v", err)
	}

	job := &ClaimedJob{JobID: faultJobID, Phase: PhaseAwaitingHB, FencingToken: 7,
		ManifestRaw: string(rel.manifestRaw)}
	job.Release.ReleaseID, job.Release.BuildID = rel.releaseID, rel.buildID
	api := newFakeAPI(job, events) // never flips: heartbeat never arrives

	d := NewDaemon(cfg, api)
	j := &Journal{
		JobID: faultJobID, FencingToken: 7, PostSwap: true, SwapRequested: true,
		ReleaseID: rel.releaseID, BuildID: rel.buildID, Version: "9.9.9",
		TargetSha256: newSha, ManifestRaw: string(rel.manifestRaw),
		Phase:    PhaseAwaitingHB,
		OldSha256: oldSha, NewSha256: newSha,
		// Baseline far in the past: grace already expired on entry.
		BaselineHBAt: time.Now().Add(-30 * time.Minute).UTC(),
		CreatedAt:    time.Now().UTC(),
	}
	if err := d.journal.Save(j); err != nil {
		t.Fatalf("seed journal: %v", err)
	}

	startHelperLoop(t, cfg, events)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := d.runJob(ctx, j); err != nil {
		t.Fatalf("runJob: %v", err)
	}

	if !events.contains("progress:rolling_back") {
		t.Fatalf("rolling_back progress missing: %v", events.items)
	}
	if got := api.resultList(); len(got) != 1 || !strings.HasPrefix(got[0], "rolled_back|") {
		t.Fatalf("results = %v, want rolled_back", got)
	}
	if string(mustRead(t, cfg.AgentBinary)) != string(oldContent) {
		t.Fatalf("binary not restored after grace-triggered rollback")
	}
	if fs.restartCount() != 1 {
		t.Fatalf("restarts = %d, want exactly the rollback restart", fs.restartCount())
	}
	if j, err := d.journal.Load(); err != nil || j != nil {
		t.Fatalf("journal must be consumed after ruled rollback, got %v / %v", j, err)
	}
	if _, err := os.Stat(backupDir(cfg.StateDir, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup must be cleaned after rolled_back ruling: %v", err)
	}
}

// ---------- hold acknowledgment, post-swap retention, cleanup boundaries ----------

// heldPostSwapJob seeds on-disk state for an applied-but-unclear job:
// binary already swapped, backup of the OLD binary retained, helper journal
// at restarted, the helper result "unclear" with its apply request retained,
// and the root journal on hold in terminal post-swap phase.
func heldPostSwapJob(t *testing.T, cfg *Config, rel *releaseFixture, oldContent []byte) *JournalStore {
	t.Helper()
	writeFile(t, cfg.AgentBinary, rel.content, 0o755)
	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	writeFile(t, backupPath, oldContent, 0o755)
	if err := os.MkdirAll(helperRoot(cfg.StateDir), 0o755); err != nil {
		t.Fatalf("mkdir helper root: %v", err)
	}
	if err := saveHelperJournal(cfg.StateDir, &HelperJournal{
		JobID: faultJobID, Phase: hjRestarted,
		OldSha256: SHA256Hex(oldContent), NewSha256: rel.sha, BackupPath: backupPath,
	}); err != nil {
		t.Fatalf("save helper journal: %v", err)
	}
	seedStaging(t, cfg, rel)
	if err := os.MkdirAll(resultsDir(cfg.StateDir), 0o770); err != nil {
		t.Fatalf("mkdir results: %v", err)
	}
	if err := writeResult(cfg.StateDir, &HelperResult{
		JobID: faultJobID, Action: actionApply, Outcome: "unclear",
		Detail: "post-swap journal write failed", BinarySha256: rel.sha,
	}); err != nil {
		t.Fatalf("seed result: %v", err)
	}
	writePending(t, cfg, actionApply, faultJobID)
	store := NewJournalStore(cfg.StateDir)
	j := &Journal{
		JobID: faultJobID, FencingToken: 1, RequiresReconcile: true,
		ReleaseID: rel.releaseID, Version: "9.9.9", BuildID: rel.buildID,
		TargetSha256: rel.sha, ManifestRaw: string(rel.manifestRaw),
		Phase: PhaseTerminal, SwapRequested: true, PostSwap: true,
		OldSha256: SHA256Hex(oldContent), NewSha256: rel.sha,
		Outcome: "rollback_unverified", ReportedToServer: true,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if err := store.Save(j); err != nil {
		t.Fatalf("save journal: %v", err)
	}
	return store
}

// TestHoldAckNoReapplyOnPostSwapFailed: after the operator acknowledges the
// hold (ack clears Hold), a server ruling of "failed" for the post-swap job
// must not be treated as safe cleanup. The daemon has to re-hold with
// backup, staging and journal intact, never claim or re-apply, and the
// helper must not re-run swap or restart for the unclear mutation.
func TestHoldAckNoReapplyOnPostSwapFailed(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-held-unclear"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	fs := installSeams(t, events, rel.buildID)
	oldContent := []byte("OLD-agent-binary")
	store := heldPostSwapJob(t, cfg, rel, oldContent)

	// The server has already settled this job with ruling "failed".
	api := newFakeAPI(&ClaimedJob{
		JobID: faultJobID, Phase: "failed", FencingToken: 1,
		ManifestRaw: string(rel.manifestRaw),
	}, events)
	startHelperLoop(t, cfg, events) // path unit fires: the pending dir is non-empty

	// Operator acknowledgment — exactly what `vps-updater ack` persists.
	j, err := store.Load()
	if err != nil || j == nil {
		t.Fatalf("load journal: %v / %v", j, err)
	}
	j.Hold = false
	j.Reason = "operator acknowledged hold; cleared by vps-updater ack"
	if err := store.Save(j); err != nil {
		t.Fatalf("ack save: %v", err)
	}

	d := NewDaemon(cfg, api)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := d.runJob(ctx, j); err != nil {
		t.Fatalf("runJob after ack: %v", err)
	}

	j2, err := store.Load()
	if err != nil || j2 == nil {
		t.Fatalf("journal must survive a post-swap failed ruling: %v / %v", j2, err)
	}
	if !j2.Hold || j2.Phase != PhaseTerminal {
		t.Fatalf("want re-hold at terminal, got hold=%v phase=%s reason=%q",
			j2.Hold, j2.Phase, j2.Reason)
	}
	if !j2.PostSwap {
		t.Fatalf("post-swap flag must remain set")
	}
	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	if got := shaOf(t, backupPath); got != SHA256Hex(oldContent) {
		t.Fatalf("rollback source destroyed: backup sha %s", got)
	}
	if got := shaOf(t, cfg.AgentBinary); got != rel.sha {
		t.Fatalf("binary changed during hold handling: %s", got)
	}
	if fs.restartCount() != 0 {
		t.Fatalf("unclear mutation was re-run: %d restarts", fs.restartCount())
	}
	if api.callCount() != 0 {
		t.Fatalf("must not claim another job while holding: %d claim calls", api.callCount())
	}
	if res := api.resultList(); len(res) != 0 {
		t.Fatalf("no further result posts expected (outcome already reported): %v", res)
	}
	if _, err := os.Stat(stagingDir(cfg.StateDir, faultJobID)); err != nil {
		t.Fatalf("staging must be retained as evidence: %v", err)
	}
}

// TestPostSwapFailedRulingRetainsBackup: consumeWithRuling may treat a
// "failed" ruling as cleanup-safe only when the journal proves nothing was
// swapped. Post-swap it must retain backup + staging + journal and hold,
// reporting rollback_unverified instead of tearing evidence down.
func TestPostSwapFailedRulingRetainsBackup(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-ruling"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)
	oldContent := []byte("OLD-agent-binary")
	store := heldPostSwapJob(t, cfg, rel, oldContent)
	api := newFakeAPI(&ClaimedJob{JobID: faultJobID, Phase: "failed", FencingToken: 1}, events)
	startHelperLoop(t, cfg, events)

	j, err := store.Load()
	if err != nil || j == nil {
		t.Fatalf("load journal: %v / %v", j, err)
	}
	j.Hold = false
	j.ReportedToServer = false // also exercise the hold report on the way down
	if err := store.Save(j); err != nil {
		t.Fatalf("save: %v", err)
	}

	d := NewDaemon(cfg, api)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := d.consumeWithRuling(ctx, j, "failed"); err != nil {
		t.Fatalf("consumeWithRuling(failed): %v", err)
	}

	j2, err := store.Load()
	if err != nil || j2 == nil {
		t.Fatalf("journal must be retained: %v / %v", j2, err)
	}
	if !j2.Hold || j2.Phase != PhaseTerminal || j2.Outcome != "rollback_unverified" {
		t.Fatalf("want held terminal rollback_unverified, got hold=%v phase=%s outcome=%s",
			j2.Hold, j2.Phase, j2.Outcome)
	}
	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	if got := shaOf(t, backupPath); got != SHA256Hex(oldContent) {
		t.Fatalf("backup deleted on unclear post-swap failure: sha %s", got)
	}
	if _, err := os.Stat(stagingDir(cfg.StateDir, faultJobID)); err != nil {
		t.Fatalf("staging must be retained: %v", err)
	}
	if got := api.resultList(); len(got) != 1 || got[0] != "rollback_unverified|" {
		t.Fatalf("hold must be reported as rollback_unverified, got %v", got)
	}
}

// TestConsumeRemovesRetainedPendingAndResults: consumption must first stop
// the path-unit triggers for the job — a retained apply/rollback request
// would let the helper re-run the helper against a job the server already
// ruled on — then finish tearing down local state idempotently.
func TestConsumeRemovesRetainedPendingAndResults(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-consume"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)
	oldContent := []byte("OLD-agent-binary")
	store := heldPostSwapJob(t, cfg, rel, oldContent)

	j, err := store.Load()
	if err != nil || j == nil {
		t.Fatalf("load journal: %v / %v", j, err)
	}
	// Crash-after-cleanup state: the privileged cleanup already ran, so the
	// direct teardown below needs no helper and stays deterministic.
	j.CleanupDone = true
	j.Hold = false
	if err := store.Save(j); err != nil {
		t.Fatalf("save: %v", err)
	}

	d := NewDaemon(cfg, newFakeAPI(nil, events))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := d.consume(ctx, j); err != nil {
		t.Fatalf("consume: %v", err)
	}

	for _, p := range []string{
		pendingPath(cfg.StateDir, actionApply, faultJobID),
		pendingPath(cfg.StateDir, actionRollback, faultJobID),
		pendingPath(cfg.StateDir, actionCleanup, faultJobID),
		resultPath(cfg.StateDir, actionApply, faultJobID),
		resultPath(cfg.StateDir, actionCleanup, faultJobID),
	} {
		if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s must be removed by consume: %v", p, err)
		}
	}
	if _, err := os.Stat(stagingDir(cfg.StateDir, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging must be removed: %v", err)
	}
	if names, err := PendingActions(cfg.StateDir); err != nil || len(names) != 0 {
		t.Fatalf("no path-unit trigger may survive consumption: %v / %v", names, err)
	}
	if j2, err := store.Load(); err != nil || j2 != nil {
		t.Fatalf("journal must be cleared: %v / %v", j2, err)
	}
}

// TestRuledCleanupRemovesHelperJournal: after a server-ruled terminal
// outcome the backup is deleted — the root helper journal for that job must
// go with it, or a stale journal would drive reconciliation of a consumed
// job (restarting services from records that no longer exist).
func TestRuledCleanupRemovesHelperJournal(t *testing.T) {
	rel := newRelease(t, []byte("NEW-binary-ruled"), "https://example.com/agent")
	cfg := testConfig(t, rel)
	events := &eventLog{}
	installSeams(t, events, rel.buildID)
	oldContent := []byte("OLD-agent-binary")
	store := heldPostSwapJob(t, cfg, rel, oldContent)
	api := newFakeAPI(&ClaimedJob{JobID: faultJobID, Phase: "succeeded", FencingToken: 1}, events)
	startHelperLoop(t, cfg, events)
	// Let the path unit finish the seeded (retained) apply request first, so
	// no in-flight helper run can re-write a result after consumption —
	// mirrors production, where the helper run that triggered the ruling has
	// long completed before the terminal ruling arrives.
	deadline := time.Now().Add(3 * time.Second)
	for {
		names, _ := PendingActions(cfg.StateDir)
		_, rerr := ReadResult(cfg.StateDir, actionApply, faultJobID)
		if len(names) == 0 && rerr == nil {
			break // request drained and the helper's result is on disk
		}
		if time.Now().After(deadline) {
			t.Fatalf("helper never finished the seeded request: pending=%v resultErr=%v", names, rerr)
		}
		time.Sleep(10 * time.Millisecond)
	}

	j, err := store.Load()
	if err != nil || j == nil {
		t.Fatalf("load journal: %v / %v", j, err)
	}
	// Reported succeeded, awaiting the ruling — not on hold.
	j.Hold = false
	j.Outcome = "succeeded"
	if err := store.Save(j); err != nil {
		t.Fatalf("save: %v", err)
	}

	d := NewDaemon(cfg, api)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := d.runJob(ctx, j); err != nil {
		t.Fatalf("runJob: %v", err)
	}

	if j2, err := store.Load(); err != nil || j2 != nil {
		t.Fatalf("journal must be consumed: %v / %v", j2, err)
	}
	if hj, err := LoadHelperJournal(cfg.StateDir); err != nil || hj != nil {
		t.Fatalf("helper journal must be removed with its backup: %v / %v", hj, err)
	}
	backupPath := filepath.Join(backupDir(cfg.StateDir, faultJobID), "agent-binary")
	if _, err := os.Stat(backupPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup must be cleaned after succeeded ruling: %v", err)
	}
	if _, err := os.Stat(stagingDir(cfg.StateDir, faultJobID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging must be cleaned: %v", err)
	}
	if names, err := PendingActions(cfg.StateDir); err != nil || len(names) != 0 {
		t.Fatalf("no path-unit trigger may survive consumption: %v / %v", names, err)
	}
	if res, err := ReadResult(cfg.StateDir, actionApply, faultJobID); err != nil || res != nil {
		t.Fatalf("helper results must be cleaned: %v / %v", res, err)
	}
}

// TestHelperRefusesSymlinkedStateDirs: stateDir is group-writable by the
// updater user, so between two helper runs that user can plant a symlink at
// results/ or helper/. The privileged helper must fail closed on it —
// nothing written through the link, no request drained.
func TestHelperRefusesSymlinkedStateDirs(t *testing.T) {
	rel := newRelease(t, []byte("symlink-boundary"), "https://example.com/agent")

	t.Run("results", func(t *testing.T) {
		cfg := testConfig(t, rel)
		target := t.TempDir()
		if err := os.Symlink(target, resultsDir(cfg.StateDir)); err != nil {
			t.Skipf("symlink not permitted in this environment: %v", err)
		}
		writePending(t, cfg, actionApply, faultJobID)
		err := RunHelper(context.Background(), cfg)
		if err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("RunHelper must refuse the planted results symlink, got %v", err)
		}
		entries, rerr := os.ReadDir(target)
		if rerr != nil {
			t.Fatalf("read symlink target: %v", rerr)
		}
		if len(entries) != 0 {
			t.Fatalf("helper wrote through the results symlink: %v", entries)
		}
		if _, serr := os.Stat(pendingPath(cfg.StateDir, actionApply, faultJobID)); serr != nil {
			t.Fatalf("request must stay untouched: %v", serr)
		}
	})

	t.Run("helper", func(t *testing.T) {
		cfg := testConfig(t, rel)
		target := t.TempDir()
		if err := os.Symlink(target, helperRoot(cfg.StateDir)); err != nil {
			t.Skipf("symlink not permitted in this environment: %v", err)
		}
		writePending(t, cfg, actionApply, faultJobID)
		err := RunHelper(context.Background(), cfg)
		if err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("RunHelper must refuse the planted helper symlink, got %v", err)
		}
		entries, rerr := os.ReadDir(target)
		if rerr != nil {
			t.Fatalf("read symlink target: %v", rerr)
		}
		if len(entries) != 0 {
			t.Fatalf("helper created state through the helper symlink: %v", entries)
		}
		if _, serr := os.Stat(pendingPath(cfg.StateDir, actionApply, faultJobID)); serr != nil {
			t.Fatalf("request must stay untouched: %v", serr)
		}
	})

	// Runs everywhere (symlinks above may be unprivileged): the helper root
	// replaced by a plain file must also fail the helper closed before any
	// request is drained or any state is written.
	t.Run("helper-replaced-by-file", func(t *testing.T) {
		cfg := testConfig(t, rel)
		if err := os.WriteFile(helperRoot(cfg.StateDir), []byte("not a dir"), 0o644); err != nil {
			t.Fatalf("plant file: %v", err)
		}
		writePending(t, cfg, actionApply, faultJobID)
		err := RunHelper(context.Background(), cfg)
		if err == nil || !strings.Contains(err.Error(), "not a directory") {
			t.Fatalf("RunHelper must refuse a non-directory helper root, got %v", err)
		}
		if _, serr := os.Stat(pendingPath(cfg.StateDir, actionApply, faultJobID)); serr != nil {
			t.Fatalf("request must stay untouched: %v", serr)
		}
		if _, serr := os.Stat(resultPath(cfg.StateDir, actionApply, faultJobID)); !errors.Is(serr, os.ErrNotExist) {
			t.Fatalf("no result may be written on a refused boundary: %v", serr)
		}
	})
}

func TestHelperBundledUpdate(t *testing.T) {
	content := []byte("NEW-bundled-binary-content")
	sha := SHA256Hex(content)
	buildID := SHA256Hex([]byte(sha + "b"))[:40]

	events := &eventLog{}
	installSeams(t, events, buildID)

	stateDir := t.TempDir()
	binDir := t.TempDir()
	agentBin := filepath.Join(binDir, "vps-manager-agent")
	if err := os.WriteFile(agentBin, []byte("OLD-binary"), 0o755); err != nil {
		t.Fatalf("write old binary: %v", err)
	}

	cfg := &Config{
		APIBase:      "https://api.test.invalid",
		Credential:   "vma_test_credential",
		AgentBinary:  agentBin,
		AgentUnit:    "vps-manager-agent.service",
		StateDir:     stateDir,
	}
	jobID := "bundled-job-test-1"
	job := &ClaimedJob{
		JobID:           jobID,
		Phase:           PhaseRestarting,
		TargetSha256:    sha,
		TargetSizeBytes: int64(len(content)),
		LeaseExpiresAt:  FlexTime{Time: time.Now().Add(5 * time.Minute)},
		PhaseDeadlineAt: FlexTime{Time: time.Now().Add(5 * time.Minute)},
		DeadlineAt:      FlexTime{Time: time.Now().Add(5 * time.Minute)},
		Release: ReleaseInfo{
			ReleaseID:    buildID,
			BuildID:      buildID,
			TargetSha256: sha,
		},
	}
	cfg.EnableTestOverrides()
	cfg.SetTestAuthorizer(&fakeAPI{job: job})
	if err := cfg.NormalizeAndValidate(); err != nil {
		t.Fatalf("NormalizeAndValidate: %v", err)
	}
	staging := stagingDir(cfg.StateDir, jobID)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatalf("mkdir staging: %v", err)
	}
	if err := os.WriteFile(filepath.Join(staging, "artifact.bin"), content, 0o755); err != nil {
		t.Fatalf("write artifact: %v", err)
	}
	meta := map[string]any{
		"jobId":   jobID,
		"buildId": buildID,
		"sha256":  sha,
		"size":    int64(len(content)),
	}
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		t.Fatalf("marshal meta: %v", err)
	}
	if err := os.WriteFile(filepath.Join(staging, "meta.json"), metaBytes, 0o644); err != nil {
		t.Fatalf("write meta: %v", err)
	}

	writePending(t, cfg, actionApply, jobID)

	if err := RunHelper(context.Background(), cfg); err != nil {
		t.Fatalf("RunHelper: %v", err)
	}

	res, err := ReadResult(cfg.StateDir, actionApply, jobID)
	if err != nil {
		t.Fatalf("ReadResult: %v", err)
	}
	if res == nil {
		t.Fatal("expected result, got nil")
	}
	if res.Outcome != "restarted" {
		t.Fatalf("expected outcome 'restarted', got %q (%s)", res.Outcome, res.Detail)
	}
	gotNew, err := os.ReadFile(agentBin)
	if err != nil {
		t.Fatalf("read new binary: %v", err)
	}
	if string(gotNew) != string(content) {
		t.Fatalf("expected binary content %q, got %q", string(content), string(gotNew))
	}
}
