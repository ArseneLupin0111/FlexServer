//go:build linux

package applications

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Subprocess helpers re-enter this test binary with the Go test flag parser
// disabled so they behave like real agent processes: they talk to the shared
// exclusion registry only through the exported hostlock API, under the same
// FLEXSERVER_AGENT_STATE_DIR convention the daemon uses.

const (
	helperModeEnv       = "TEST_HOSTLOCK_HELPER_MODE"
	helperScopeEnv      = "TEST_HOSTLOCK_SCOPE"
	helperKindEnv       = "TEST_HOSTLOCK_KIND"
	helperIDEnv         = "TEST_HOSTLOCK_ID"
	helperStateDirEnv   = "TEST_HOSTLOCK_STATE_DIR"
	helperAcquiredMark  = "ACQUIRED"
	helperErrorMark     = "ERROR:"
	helperKindCompose   = "compose-operation"
	helperKindContainer = "container-command"
)

// isBusyMark reports whether a helper marker carries the fail-closed busy
// error body "scope_busy:<kind>:<id>" (forwarded verbatim since the helper
// emits every non-success as ERROR:<err>).
func isBusyMark(m string) bool {
	return strings.HasPrefix(m, helperErrorMark+"scope_busy:")
}

// runHostLockHelper starts a fresh process against the given state dir.
// The returned mark channel carries exactly one line: ACQUIRED or
// ERROR:<message>; the scope_busy error (with blocking holder kind/id) is
// forwarded verbatim. Hold modes (acquire-*) block until killed, so wait is
// only for the short-lived modes (try-acquire, release).
func runHostLockHelper(t *testing.T, mode, scope, kind, id, stateDir string) (mark <-chan string, wait func(), kill func()) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=TestHostLockHelperEntrypoint")
	cmd.Env = append(os.Environ(),
		helperModeEnv+"="+mode,
		helperScopeEnv+"="+scope,
		helperKindEnv+"="+kind,
		helperIDEnv+"="+id,
		helperStateDirEnv+"="+stateDir,
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	marks := make(chan string, 1)
	go func() {
		defer close(marks)
		line, err := bufio.NewReader(stdout).ReadString('\n')
		if err != nil {
			marks <- helperErrorMark + "helper exited before marker: " + err.Error()
			return
		}
		marks <- strings.TrimSpace(line)
	}()
	return marks, func() { _ = cmd.Wait() }, func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }
}

// waitHostLockMark reads the helper's first marker line.
func waitHostLockMark(t *testing.T, mark <-chan string) string {
	t.Helper()
	select {
	case m := <-mark:
		return m
	case <-time.After(30 * time.Second):
		return helperErrorMark + "timed out waiting for helper marker"
	}
}

// TestHostLockHelperEntrypoint is never asserted directly; it is the
// subprocess body selected by TEST_HOSTLOCK_HELPER_MODE.
func TestHostLockHelperEntrypoint(t *testing.T) {
	mode := os.Getenv(helperModeEnv)
	if mode == "" {
		t.Skip("not a helper run")
	}
	if err := os.Setenv("FLEXSERVER_AGENT_STATE_DIR", os.Getenv(helperStateDirEnv)); err != nil {
		fmt.Println(helperErrorMark + "state dir env: " + err.Error())
		os.Exit(2)
	}
	scope := os.Getenv(helperScopeEnv)
	kind := os.Getenv(helperKindEnv)
	id := os.Getenv(helperIDEnv)

	var err error
	switch mode {
	case "acquire-mutating":
		// Acquire + pin mutating, then hold the fence open until killed.
		err = AcquireHostScope(scope, kind, id, true, time.Minute)
		if err == nil {
			err = MarkHostScopeMutating(scope, kind, id)
		}
	case "acquire-nonmutating":
		err = AcquireHostScope(scope, kind, id, false, time.Minute)
	case "try-acquire":
		err = AcquireHostScope(scope, kind, id, false, time.Minute)
		if err == nil {
			_ = ReleaseHostScope(scope, kind, id)
		}
	case "release":
		err = ReleaseHostScope(scope, kind, id)
	default:
		err = fmt.Errorf("unknown helper mode %q", mode)
	}

	switch {
	case err == nil:
		fmt.Println(helperAcquiredMark)
		// Hold modes stay alive until the caller kills them: their registry
		// row must outlive this process, and their wait func would block on
		// cmd.Wait forever. Callers must use kill, never wait, for these.
		if mode == "acquire-mutating" || mode == "acquire-nonmutating" {
			select {}
		}
	case strings.HasPrefix(err.Error(), "scope_busy"):
		// Preserve the blocking holder identity: the exported error body is
		// "scope_busy:<kind>:<id>" and workers map it to target_busy.
		fmt.Println(helperErrorMark + err.Error())
	default:
		fmt.Println(helperErrorMark + err.Error())
	}
	os.Exit(0)
}

// TestHostLockCrossProcessMutatingFence proves the real cross-process
// advisory fence: a second process cannot acquire a conflicting scope held
// mutating by a live holder, while an unrelated scope stays free.
func TestHostLockCrossProcessMutatingFence(t *testing.T) {
	stateDir := t.TempDir()
	scope := "project:9|9|fence-proj"

	holderMarks, _, holderKill := runHostLockHelper(t, "acquire-mutating", scope, helperKindCompose, "op-holder", stateDir)
	defer holderKill()
	if m := waitHostLockMark(t, holderMarks); m != helperAcquiredMark {
		holderKill()
		t.Fatalf("mutating holder did not report acquired: %q", m)
	}

	// Conflicting same-scope acquire from a second process must fail closed.
	conflictMarks, conflictWait, conflictKill := runHostLockHelper(t, "try-acquire", scope, helperKindCompose, "op-conflict", stateDir)
	defer conflictKill()
	if m := waitHostLockMark(t, conflictMarks); !isBusyMark(m) {
		conflictKill()
		t.Fatalf("conflicting same-scope acquire must be busy, got: %q", m)
	}
	conflictWait()

	// Unrelated scope must succeed concurrently in another process.
	otherScope := "container:alpha-bravo-001"
	otherMarks, _, otherKill := runHostLockHelper(t, "acquire-nonmutating", otherScope, helperKindContainer, "cmd-001", stateDir)
	defer otherKill()
	if m := waitHostLockMark(t, otherMarks); m != helperAcquiredMark {
		otherKill()
		t.Fatalf("unrelated scope must not contend, got: %q", m)
	}

	// Exact-holder release in a third process clears the fence...
	releaseMarks, releaseWait, releaseKill := runHostLockHelper(t, "release", scope, helperKindCompose, "op-holder", stateDir)
	defer releaseKill()
	if m := waitHostLockMark(t, releaseMarks); m != helperAcquiredMark {
		releaseKill()
		t.Fatalf("exact-holder release failed: %q", m)
	}
	releaseWait()
	// The unrelated holder is deliberately still live (acquire-nonmutating
	// holds after its marker), so stop it; waiting would block forever.
	otherKill()
	holderKill()

	// ...so a fresh conflicting acquire now succeeds.
	afterMarks, afterWait, afterKill := runHostLockHelper(t, "try-acquire", scope, helperKindCompose, "op-after", stateDir)
	defer afterKill()
	if m := waitHostLockMark(t, afterMarks); m != helperAcquiredMark {
		afterKill()
		t.Fatalf("acquire after exact-holder release must succeed, got: %q", m)
	}
	afterWait()
}

// TestHostLockMutatingHolderPersistsPastTTL proves a mutating holder is never
// TTL-reclaimed: after the grant TTL lapses, conflicting processes still see
// the fence, wrong-holder release is a no-op, and only the exact holder's
func TestHostLockMutatingHolderPersistsPastTTL(t *testing.T) {
	stateDir := t.TempDir()
	scope := "project:9|9|ttl-proj"

	// Grant with the smallest bounded positive TTL, then pin mutating.
	holderMarks, _, holderKill := runHostLockHelper(t, "acquire-mutating", scope, helperKindCompose, "op-ttl-holder", stateDir)
	defer holderKill()
	if m := waitHostLockMark(t, holderMarks); m != helperAcquiredMark {
		holderKill()
		t.Fatalf("mutating holder did not report acquired: %q", m)
	}

	// Wait until wall-clock time passes grant + 2s (1s TTL covers second
	// truncation, extra second covers the acquire loop). No deadline sleeps
	// gate correctness: the probe below re-checks, so slow CI cannot flip it.
	deadline := time.Now().Add(2500 * time.Millisecond)
	for time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}

	stillHeld := func() bool {
		marks, wait, kill := runHostLockHelper(t, "try-acquire", scope, helperKindCompose, "op-ttl-peek", stateDir)
		defer kill()
		m := waitHostLockMark(t, marks)
		wait()
		return isBusyMark(m)
	}
	if !stillHeld() {
		holderKill()
		t.Fatalf("mutating holder was TTL-reclaimed; mutating rows must persist past TTL")
	}

	// Wrong-holder release must not clear the fence.
	wrongMarks, wrongWait, wrongKill := runHostLockHelper(t, "release", scope, helperKindCompose, "op-ttl-other", stateDir)
	defer wrongKill()
	if m := waitHostLockMark(t, wrongMarks); m != helperAcquiredMark {
		wrongKill()
		t.Fatalf("wrong-holder release should be a no-op success, got: %q", m)
	}
	wrongWait()
	if !stillHeld() {
		holderKill()
		t.Fatalf("wrong-holder release cleared a mutating fence")
	}

	// Exact holder release clears it.
	exactMarks, exactWait, exactKill := runHostLockHelper(t, "release", scope, helperKindCompose, "op-ttl-holder", stateDir)
	defer exactKill()
	if m := waitHostLockMark(t, exactMarks); m != helperAcquiredMark {
		exactKill()
		t.Fatalf("exact-holder release failed: %q", m)
	}
	exactWait()
	holderKill()

	afterMarks, afterWait, afterKill := runHostLockHelper(t, "try-acquire", scope, helperKindCompose, "op-ttl-after", stateDir)
	defer afterKill()
	if m := waitHostLockMark(t, afterMarks); m != helperAcquiredMark {
		afterKill()
		t.Fatalf("acquire after exact-holder release must succeed, got: %q", m)
	}
	afterWait()
}

// TestHostLockCorruptRegistryFailsClosed proves every hostlock entry point
// refuses to act when the shared registry document is not parseable JSON,
// and that the corrupt bytes are preserved (no blind overwrite).
func TestHostLockCorruptRegistryFailsClosed(t *testing.T) {
	stateDir := t.TempDir()
	registryPath := filepath.Join(stateDir, "docker-applications", "exclusion.json")
	if err := os.MkdirAll(filepath.Dir(registryPath), 0o700); err != nil {
		t.Fatalf("mkdir registry dir: %v", err)
	}
	corrupt := []byte(`{"scope":"project:9|9|corrupt","holder":`) // truncated JSON
	if err := os.WriteFile(registryPath, corrupt, 0o600); err != nil {
		t.Fatalf("write corrupt registry: %v", err)
	}

	t.Setenv("FLEXSERVER_AGENT_STATE_DIR", stateDir)
	resetHostLockSingleton()
	if _, err := DefaultLockPath(); err != nil {
		t.Fatalf("lock path: %v", err)
	}

	if err := AcquireHostScope("project:9|9|corrupt", helperKindCompose, "op-corrupt", true, time.Minute); err == nil {
		t.Fatalf("acquire must fail closed on corrupt registry")
	}
	if err := ReleaseHostScope("project:9|9|corrupt", helperKindCompose, "op-corrupt"); err == nil {
		t.Fatalf("release must fail closed on corrupt registry")
	}
	if err := MarkHostScopeMutating("project:9|9|corrupt", helperKindCompose, "op-corrupt"); err == nil {
		t.Fatalf("mark-mutating must fail closed on corrupt registry")
	}

	got, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatalf("corrupt registry must be preserved on disk: %v", err)
	}
	if string(got) != string(corrupt) {
		t.Fatalf("corrupt registry bytes must be preserved, got: %q", got)
	}
}

// TestHostLockHelperEnvIsolation pins the env lock-path convention the
// subprocess helpers rely on: FLEXSERVER_AGENT_STATE_DIR steers the registry
// under <dir>/docker-applications/exclusion.json, and unset falls back to
// $HOME/.flexserver/agent.
func TestHostLockHelperEnvIsolation(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("FLEXSERVER_AGENT_STATE_DIR", dir)
	resetHostLockSingleton()
	path, err := DefaultLockPath()
	if err != nil {
		t.Fatalf("DefaultLockPath: %v", err)
	}
	if want := filepath.Join(dir, "docker-applications", "exclusion.json"); path != want {
		t.Fatalf("registry path = %q, want %q", path, want)
	}

	t.Setenv("FLEXSERVER_AGENT_STATE_DIR", "")
	t.Setenv("HOME", dir)
	resetHostLockSingleton()
	path, err = DefaultLockPath()
	if err != nil {
		t.Fatalf("DefaultLockPath fallback: %v", err)
	}
	if want := filepath.Join(dir, ".flexserver", "agent", "docker-applications", "exclusion.json"); path != want {
		t.Fatalf("fallback registry path = %q, want %q", path, want)
	}

	// Each helper process must resolve the same registry from the env alone:
	// a mutating holder in process A is visible to process B via the file.
	stateDir := t.TempDir()
	scope := "container:env-isolation-001"
	holderMarks, _, holderKill := runHostLockHelper(t, "acquire-mutating", scope, helperKindContainer, "cmd-env-001", stateDir)
	defer holderKill()
	if m := waitHostLockMark(t, holderMarks); m != helperAcquiredMark {
		holderKill()
		t.Fatalf("helper holder did not report acquired: %q", m)
	}
	rows, err := os.ReadFile(filepath.Join(stateDir, "docker-applications", "exclusion.json"))
	if err != nil {
		t.Fatalf("registry must exist under env steered dir: %v", err)
	}
	if !strings.Contains(string(rows), scope) {
		t.Fatalf("registry must record scope %q, got: %s", scope, rows)
	}
	if !strings.Contains(string(rows), helperKindContainer) || !strings.Contains(string(rows), "cmd-env-001") {
		t.Fatalf("registry must record holder kind/id, got: %s", rows)
	}
	if !strings.Contains(string(rows), `"mutating":true`) {
		t.Fatalf("registry must record mutating pin, got: %s", rows)
	}
	holderKill()
}

// TestHostLockBusyErrorShape keeps the cross-process contract explicit: a
// conflicting acquire surfaces a scope_busy error carrying the blocking
// holder identity, which is what workers map to target_busy reports.
func TestHostLockBusyErrorShape(t *testing.T) {
	stateDir := t.TempDir()
	scope := "project:9|9|busy-shape"

	holderMarks, _, holderKill := runHostLockHelper(t, "acquire-mutating", scope, helperKindCompose, "op-shape", stateDir)
	defer holderKill()
	if m := waitHostLockMark(t, holderMarks); m != helperAcquiredMark {
		holderKill()
		t.Fatalf("mutating holder did not report acquired: %q", m)
	}

	conflictMarks, conflictWait, conflictKill := runHostLockHelper(t, "try-acquire", scope, helperKindContainer, "cmd-shape", stateDir)
	defer conflictKill()
	m := waitHostLockMark(t, conflictMarks)
	conflictWait()
	if !strings.HasPrefix(m, helperErrorMark) || !strings.Contains(m, "scope_busy") || !strings.Contains(m, helperKindCompose) || !strings.Contains(m, "op-shape") {
		t.Fatalf("busy error must carry scope_busy plus blocking holder kind/id, got: %q", m)
	}
	holderKill()
}

// TestHostLockHelperCrashKeepsMutatingFence documents the crash posture:
// a killed mutating holder leaves its row in the shared registry; no other
// process may blind-reclaim it (explicit reconcile is the only path).
func TestHostLockHelperCrashKeepsMutatingFence(t *testing.T) {
	stateDir := t.TempDir()
	scope := "project:9|9|crash-proj"

	holderMarks, _, holderKill := runHostLockHelper(t, "acquire-mutating", scope, helperKindCompose, "op-crash", stateDir)
	if m := waitHostLockMark(t, holderMarks); m != helperAcquiredMark {
		holderKill()
		t.Fatalf("mutating holder did not report acquired: %q", m)
	}
	// SIGKILL the holder: the advisory flock dies with the process, but the
	// registry row must survive.
	holderKill()

	rows, err := os.ReadFile(filepath.Join(stateDir, "docker-applications", "exclusion.json"))
	if err != nil {
		t.Fatalf("registry must survive holder crash: %v", err)
	}
	if !strings.Contains(string(rows), scope) || !strings.Contains(string(rows), `"mutating":true`) {
		t.Fatalf("crashed holder's mutating row must persist, got: %s", rows)
	}

	conflictMarks, conflictWait, conflictKill := runHostLockHelper(t, "try-acquire", scope, helperKindCompose, "op-after-crash", stateDir)
	defer conflictKill()
	m := waitHostLockMark(t, conflictMarks)
	conflictWait()
	if !isBusyMark(m) {
		t.Fatalf("crashed holder's mutating row must still block, got: %q", m)
	}
}

// TestHostLockScopeValidationBoundaries pins the exported API guards the
// subprocess contract depends on (bounded scope/holder metadata, bounded TTL).
func TestHostLockScopeValidationBoundaries(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("FLEXSERVER_AGENT_STATE_DIR", stateDir)
	resetHostLockSingleton()
	if _, err := DefaultLockPath(); err != nil {
		t.Fatalf("lock path: %v", err)
	}

	if err := AcquireHostScope("", helperKindCompose, "op-x", false, time.Minute); err == nil {
		t.Fatalf("empty scope must be rejected")
	}
	if err := AcquireHostScope("project:9|9|bad/slash", helperKindCompose, "op-x", false, time.Minute); err == nil {
		t.Fatalf("scope with slash must be rejected")
	}
	if err := AcquireHostScope("project:9|9|ok", helperKindCompose, strings.Repeat("x", 129), false, time.Minute); err == nil {
		t.Fatalf("oversized holder id must be rejected")
	}
	if err := AcquireHostScope("project:9|9|ok", helperKindCompose, "op-x", false, time.Duration(MaxLockSeconds+1)*time.Second); err == nil {
		t.Fatalf("ttl beyond MaxLockSeconds must be rejected")
	}
	if err := AcquireHostScope("project:9|9|ok", helperKindCompose, "op-x", false, -time.Second); err == nil {
		t.Fatalf("negative ttl must be rejected")
	}
	if err := AcquireHostScope("project:9|9|ok", helperKindCompose, "op-x", false, time.Minute); err != nil {
		t.Fatalf("valid acquire must succeed: %v", err)
	}
	if err := ReleaseHostScope("project:9|9|ok", helperKindCompose, "op-x"); err != nil {
		t.Fatalf("release: %v", err)
	}
}

// TestHostLockRegistryCapRejectsFlooding pins the 256-row registry cap so a
// runaway worker cannot grow the shared document unbounded.
func TestHostLockRegistryCapRejectsFlooding(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("FLEXSERVER_AGENT_STATE_DIR", stateDir)
	resetHostLockSingleton()
	if _, err := DefaultLockPath(); err != nil {
		t.Fatalf("lock path: %v", err)
	}
	for i := 0; i < 256; i++ {
		scope := fmt.Sprintf("container:flood-%04d", i)
		if err := AcquireHostScope(scope, helperKindContainer, fmt.Sprintf("cmd-%04d", i), false, time.Minute); err != nil {
			t.Fatalf("acquire %d: %v", i, err)
		}
	}
	if err := AcquireHostScope("container:flood-over", helperKindContainer, "cmd-over", false, time.Minute); err == nil {
		t.Fatalf("acquire past registry cap must be rejected")
	}
	// The cap failure must not have disturbed existing rows.
	rows, err := os.ReadFile(filepath.Join(stateDir, "docker-applications", "exclusion.json"))
	if err != nil {
		t.Fatalf("registry readable: %v", err)
	}
	if got := strings.Count(string(rows), `"scope"`); got != 256 {
		t.Fatalf("registry must keep exactly 256 rows, got %d", got)
	}
}

// TestHostLockErrorsAreDistinct keeps fail-closed errors distinguishable from
// busy errors so workers never map a corrupt registry to a retryable busy.
func TestHostLockErrorsAreDistinct(t *testing.T) {
	stateDir := t.TempDir()
	registryPath := filepath.Join(stateDir, "docker-applications", "exclusion.json")
	if err := os.MkdirAll(filepath.Dir(registryPath), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(registryPath, []byte(`not json`), 0o600); err != nil {
		t.Fatalf("write corrupt registry: %v", err)
	}
	t.Setenv("FLEXSERVER_AGENT_STATE_DIR", stateDir)
	resetHostLockSingleton()
	if _, err := DefaultLockPath(); err != nil {
		t.Fatalf("lock path: %v", err)
	}

	corruptErr := AcquireHostScope("project:9|9|distinct", helperKindCompose, "op-d", true, time.Minute)
	if corruptErr == nil {
		t.Fatalf("corrupt registry must fail closed")
	}
	if strings.Contains(corruptErr.Error(), "scope_busy") {
		t.Fatalf("corrupt registry must not surface as scope_busy: %v", corruptErr)
	}
	if corruptErr.Error() == "invalid_lock_scope" {
		t.Fatalf("corrupt registry error must carry its own message: %v", corruptErr)
	}
}
