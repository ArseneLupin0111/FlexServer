package updater

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/vps-manager/agent/internal/lock"
)

// jobIDRe is the client-side constraint the API also guarantees
// (lug_ + nanoid(12) over [A-Za-z0-9_-]). It makes jobId safe as a file name
// and systemd instance name: no separators, no traversal.
var jobIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Helper action file names in stateDir/pending/.
const (
	actionApply    = "apply"
	actionRollback = "rollback"
	actionCleanup  = "cleanup"
)

// Helper journal phases (stateDir/helper/journal.json, root-owned).
const (
	hjIntent     = "intent"    // backup taken, swap not yet performed
	hjRenamed    = "renamed"   // new binary in place, restart not yet confirmed
	hjRestarted  = "restarted" // service restarted with new binary
	hjRolledBack = "rolled_back"
)

// HelperJournal records the privileged mutation so a crash between backup,
// rename and restart is always reconcilable from on-disk facts. Root-owned:
// the unprivileged updater can read it but never write or delete it.
type HelperJournal struct {
	JobID      string    `json:"jobId"`
	Phase      string    `json:"phase"`
	OldSha256  string    `json:"oldSha256"`
	NewSha256  string    `json:"newSha256"`
	BackupPath string    `json:"backupPath"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// HelperResult is what the helper writes back for the daemon to consume.
type HelperResult struct {
	JobID         string    `json:"jobId"`
	Action        string    `json:"action"`
	Outcome       string    `json:"outcome"`
	Detail        string    `json:"detail,omitempty"`
	BinarySha256  string    `json:"binarySha256,omitempty"`
	ServiceActive bool      `json:"serviceActive"`
	At            time.Time `json:"at"`
}

// Injectable seams so the fault-injection harness can fake process execution
// and systemd without a real Linux host.
var (
	execStagedVersion = defaultExecStagedVersion
	runSystemctl      = defaultRunSystemctl
	serviceActiveWait = 10 * time.Second
	servicePollEvery  = 500 * time.Millisecond
)

func defaultExecStagedVersion(ctx context.Context, path string) (string, error) {
	cmd := exec.CommandContext(ctx, path, "-version")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("run %s -version: %w", path, err)
	}
	return strings.TrimSpace(string(out)), nil
}

func defaultRunSystemctl(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "systemctl", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return strings.TrimSpace(string(out)), fmt.Errorf("systemctl %s: %w", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(out)), nil
}

// Filesystem layout helpers.
func pendingDir(stateDir string) string { return filepath.Join(stateDir, "pending") }
func resultsDir(stateDir string) string { return filepath.Join(stateDir, "results") }
func stagingDir(stateDir, jobID string) string {
	return filepath.Join(stateDir, "staging", jobID)
}
func helperRoot(stateDir string) string { return filepath.Join(stateDir, "helper") }
func helperJournalPath(stateDir string) string {
	return filepath.Join(helperRoot(stateDir), "journal.json")
}
func backupDir(stateDir, jobID string) string {
	return filepath.Join(helperRoot(stateDir), "backups", jobID)
}

func pendingPath(stateDir, action, jobID string) string {
	return filepath.Join(pendingDir(stateDir), action+"."+jobID)
}
func resultPath(stateDir, action, jobID string) string {
	return filepath.Join(resultsDir(stateDir), jobID+"."+action+".json")
}

// requireSecureDir fail-closes the privileged helper against a planted
// symlink. stateDir is group-writable by the updater user, so between two
// helper runs that user could replace stateDir/helper or stateDir/results
// with a link and redirect root-owned state (helper journal, backups and
// RemoveAll targets) somewhere else. Every privileged path must be a real
// directory and, when the helper runs as root, root-owned. A missing path
// is acceptable — the caller creates it — and is re-checked after creation.
func requireSecureDir(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symlink", path)
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", path)
	}
	if os.Geteuid() == 0 {
		if rooted, ok := statIsRootOwned(fi); ok && !rooted {
			return fmt.Errorf("%s is not root-owned", path)
		}
	}
	return nil
}

// PendingActions lists pending helper request file names (sorted by ReadDir),
// for the status command.
func PendingActions(stateDir string) ([]string, error) {
	entries, err := os.ReadDir(pendingDir(stateDir))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	return names, nil
}

// LoadHelperJournal reads the root-owned helper journal (nil when absent).
func LoadHelperJournal(stateDir string) (*HelperJournal, error) {
	raw, err := os.ReadFile(helperJournalPath(stateDir))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read helper journal: %w", err)
	}
	var hj HelperJournal
	if err := json.Unmarshal(raw, &hj); err != nil {
		return nil, fmt.Errorf("corrupt helper journal: %w", err)
	}
	return &hj, nil
}

func saveHelperJournal(stateDir string, hj *HelperJournal) error {
	// Fail closed: never create or replace the root-owned journal through a
	// planted symlink in the updater-writable state dir.
	if err := requireSecureDir(helperRoot(stateDir)); err != nil {
		return err
	}
	hj.UpdatedAt = time.Now().UTC()
	raw, err := json.MarshalIndent(hj, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(helperJournalPath(stateDir), raw, 0o644)
}

// sha256File streams a file through SHA-256.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", h.Sum(nil)), nil
}

// writeResult persists the helper outcome for the daemon.
func writeResult(stateDir string, res *HelperResult) error {
	res.At = time.Now().UTC()
	raw, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		return err
	}
	// Unlink first: a compromised updater-owned dir may hold a stale file.
	_ = os.Remove(resultPath(stateDir, res.Action, res.JobID))
	return atomicWriteFile(resultPath(stateDir, res.Action, res.JobID), raw, 0o644)
}

// ReadResult loads a helper result (nil when not yet produced).
func ReadResult(stateDir, action, jobID string) (*HelperResult, error) {
	raw, err := os.ReadFile(resultPath(stateDir, action, jobID))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var res HelperResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("corrupt helper result: %w", err)
	}
	return &res, nil
}

// RunHelper is the root oneshot entrypoint: it drains every pending action
// file, performs the fixed privileged operations, and writes results. It
// accepts no argv — the daemon can only ask for actions the helper already
// knows how to do with root-owned state.
// JobAuthorizer fetches and validates job authorization from the local API.
type JobAuthorizer interface {
	Get(ctx context.Context, jobID string) (*ClaimedJob, error)
}

func RunHelper(ctx context.Context, cfg *Config) error {
	return RunHelperWithAuthorizer(ctx, cfg, nil)
}

func RunHelperWithAuthorizer(ctx context.Context, cfg *Config, auth JobAuthorizer) error {
	if auth == nil && cfg.testAuthorizer != nil {
		auth = cfg.testAuthorizer
	}
	// Fail closed before any privileged work: the state layout must be real
	// directories, never planted symlinks (requireSecureDir).
	if err := requireSecureDir(helperRoot(cfg.StateDir)); err != nil {
		return err
	}
	if err := requireSecureDir(resultsDir(cfg.StateDir)); err != nil {
		return err
	}
	// The results dir must exist before writeResult; the daemon owns the
	// state layout but the helper cannot depend on that ordering.
	if err := os.MkdirAll(resultsDir(cfg.StateDir), 0o770); err != nil {
		return err
	}
	if err := requireSecureDir(resultsDir(cfg.StateDir)); err != nil {
		return err
	}
	entries, err := os.ReadDir(pendingDir(cfg.StateDir))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var firstErr error
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		action, jobID, ok := parsePendingName(name)
		if !ok {
			continue // never act on a name we did not create
		}
		var res *HelperResult
		switch action {
		case actionApply:
			res = handleApply(ctx, cfg, auth, jobID)
		case actionRollback:
			res = handleRollback(ctx, cfg, jobID)
		case actionCleanup:
			res = handleCleanup(ctx, cfg, jobID)
		default:
			continue
		}
		if err := writeResult(cfg.StateDir, res); err != nil && firstErr == nil {
			firstErr = err
		}
		if res.Outcome != "unclear" && res.Outcome != "rollback_failed" &&
			res.Outcome != "restart_failed_rollback_failed" {
			// A verification failure guarantees no mutation and is terminal;
			// leaving its request causes the path unit to spin until rate-limited.
			_ = os.Remove(filepath.Join(pendingDir(cfg.StateDir), name))
		}
	}
	return firstErr
}

func parsePendingName(name string) (action, jobID string, ok bool) {
	for _, a := range []string{actionApply, actionRollback, actionCleanup} {
		prefix := a + "."
		if strings.HasPrefix(name, prefix) {
			jobID = strings.TrimPrefix(name, prefix)
			if jobIDRe.MatchString(jobID) {
				return a, jobID, true
			}
		}
	}
	return "", "", false
}

// handleApply performs (or crash-reconciles) one privileged upgrade. Fresh
// apply re-verifies everything from scratch; a leftover helper journal turns
// the call into pure reconciliation so a re-triggered path unit can never
// double-swap.
func handleApply(ctx context.Context, cfg *Config, auth JobAuthorizer, jobID string) *HelperResult {
	res := &HelperResult{JobID: jobID, Action: actionApply}

	hj, err := LoadHelperJournal(cfg.StateDir)
	if err != nil {
		res.Outcome, res.Detail = "verify_failed", err.Error()
		return res
	}
	if hj != nil && hj.JobID == jobID {
		return reconcileApply(ctx, cfg, hj, res)
	}

	staging := stagingDir(cfg.StateDir, jobID)
	metaPath := filepath.Join(staging, "meta.json")

	if auth == nil {
		auth = NewClient(cfg)
	}
	apiJob, err := auth.Get(ctx, jobID)
	if err != nil {
		res.Outcome, res.Detail = "verify_failed", "api verify job authorization: "+err.Error()
		return res
	}
	if apiJob == nil || apiJob.JobID != jobID {
		res.Outcome, res.Detail = "verify_failed", "api returned invalid job"
		return res
	}
	if apiJob.EffectivePhase() != PhaseRestarting {
		res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("job not in restarting phase: %s", apiJob.EffectivePhase())
		return res
	}
	now := time.Now()
	if apiJob.LeaseExpiresAt.IsZero() || now.After(apiJob.LeaseExpiresAt.Time) {
		res.Outcome, res.Detail = "verify_failed", "job lease missing or expired"
		return res
	}
	if apiJob.PhaseDeadlineAt.IsZero() || now.After(apiJob.PhaseDeadlineAt.Time) {
		res.Outcome, res.Detail = "verify_failed", "job phase deadline missing or expired"
		return res
	}
	if apiJob.DeadlineAt.IsZero() || now.After(apiJob.DeadlineAt.Time) {
		res.Outcome, res.Detail = "verify_failed", "job overall deadline missing or expired"
		return res
	}

	expectedSha := apiJob.TargetSha256
	if !hex64Re.MatchString(expectedSha) {
		res.Outcome, res.Detail = "verify_failed", "api job targetSha256 must be 64-hex SHA-256"
		return res
	}
	expectedBuildID := apiJob.Release.BuildID
	if !hex40Re.MatchString(expectedBuildID) {
		res.Outcome, res.Detail = "verify_failed", "api job buildId must be 40-hex git SHA"
		return res
	}
	maxBytes := cfg.MaxArtifactBytes
	if maxBytes <= 0 {
		maxBytes = int64(defaultMaxArtifactBytes)
	}
	expectedSize := apiJob.TargetSizeBytes
	if expectedSize <= 0 || expectedSize > maxBytes {
		res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("api job target size %d out of bounds (1..%d)", expectedSize, maxBytes)
		return res
	}
	metaFi, err := os.Lstat(metaPath)
	if err != nil || !metaFi.Mode().IsRegular() {
		res.Outcome, res.Detail = "verify_failed", "staging metadata meta.json missing"
		return res
	}
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		res.Outcome, res.Detail = "verify_failed", "staging meta unreadable: "+err.Error()
		return res
	}
	var meta struct {
		JobID   string `json:"jobId"`
		BuildID string `json:"buildId"`
		SHA256  string `json:"sha256"`
		Size    int64  `json:"size"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		res.Outcome, res.Detail = "verify_failed", "staging meta invalid: "+err.Error()
		return res
	}
	if meta.JobID != "" && meta.JobID != jobID {
		res.Outcome, res.Detail = "verify_failed", "staging meta jobId mismatch"
		return res
	}
	if meta.BuildID != "" && meta.BuildID != expectedBuildID {
		res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("staging meta buildId mismatch: expected %s, got %s", expectedBuildID, meta.BuildID)
		return res
	}
	if meta.SHA256 != "" && meta.SHA256 != expectedSha {
		res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("staging meta sha256 mismatch: expected %s, got %s", expectedSha, meta.SHA256)
		return res
	}

	// Copy the staged artifact into a root-owned temp file in the TARGET
	// directory while hashing it: the file that is later verified, executed
	// and swapped is one file the updater can never mutate after the copy.
	binDir := filepath.Dir(cfg.AgentBinary)
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		res.Outcome, res.Detail = "verify_failed", err.Error()
		return res
	}
	tmpPath := filepath.Join(binDir, ".vps-new-"+jobID)
	defer os.Remove(tmpPath)

	newSha, err := copyHashed(filepath.Join(staging, "artifact.bin"), tmpPath, expectedSha, expectedSize)
	if err != nil {
		res.Outcome, res.Detail = "verify_failed", "staged artifact: "+err.Error()
		return res
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		res.Outcome, res.Detail = "verify_failed", err.Error()
		return res
	}

	// Execute the staged binary only AFTER hash checks, and only
	// to read its self-reported build identity.
	vctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	line, err := execStagedVersion(vctx, tmpPath)
	cancel()
	if err != nil {
		res.Outcome, res.Detail = "verify_failed", "staged -version: "+err.Error()
		return res
	}
	_, stagedBuild, err := ParseVersionLine(line)
	if err != nil {
		res.Outcome, res.Detail = "verify_failed", err.Error()
		return res
	}
	if expectedBuildID != "" && stagedBuild != expectedBuildID {
		res.Outcome, res.Detail = "verify_failed",
			fmt.Sprintf("staged buildId %s != expected %s", stagedBuild, expectedBuildID)
		return res
	}

	// Already the current binary: nothing to swap (idempotent re-trigger).
	if curSha, err := sha256File(cfg.AgentBinary); err == nil && curSha == newSha {
		res.BinarySha256 = curSha
		active, detail := ensureServiceActive(ctx, cfg)
		res.ServiceActive = active
		if active {
			res.Outcome = "already_current"
			markHelperJournal(cfg, &HelperJournal{
				JobID: jobID, Phase: hjRestarted, NewSha256: newSha, OldSha256: newSha,
			})
		} else {
			res.Outcome, res.Detail = "restart_failed_rollback_failed", detail
		}
		return res
	}

	// Backups and the helper journal live under the helper root: fail closed
	// if it was swapped for a symlink since the entry check.
	if err := requireSecureDir(helperRoot(cfg.StateDir)); err != nil {
		res.Outcome, res.Detail = "verify_failed", err.Error()
		return res
	}
	// Backup the current binary (root-owned, unreadable/unwritable by the
	// updater) before any mutation.
	bdir := backupDir(cfg.StateDir, jobID)
	if err := os.MkdirAll(bdir, 0o755); err != nil {
		res.Outcome, res.Detail = "verify_failed", "backup dir: "+err.Error()
		return res
	}
	backupPath := filepath.Join(bdir, "agent-binary")
	oldSha := ""
	if _, statErr := os.Stat(cfg.AgentBinary); statErr == nil {
		oldSha, err = copyHashed(cfg.AgentBinary, backupPath, "", 0)
		if err != nil {
			res.Outcome, res.Detail = "verify_failed", "backup: "+err.Error()
			return res
		}
		_ = os.Chmod(backupPath, 0o755)
	}

	// Durably record intent BEFORE the swap so a crash is reconcilable.
	hj = &HelperJournal{
		JobID: jobID, Phase: hjIntent,
		OldSha256: oldSha, NewSha256: newSha, BackupPath: backupPath,
	}
	if err := saveHelperJournal(cfg.StateDir, hj); err != nil {
		res.Outcome, res.Detail = "verify_failed", "helper journal: "+err.Error()
		return res
	}

	// Provision lock and reboot persistence before binary swap so the new agent
	// can acquire its singleton lock immediately on restart.
	if err := provisionLockForUpgrade(cfg); err != nil {
		res.Outcome, res.Detail = "verify_failed", "provision lock: "+err.Error()
		return res
	}

	// Atomic swap: same filesystem as the target, fsync'd directory.
	if err := os.Rename(tmpPath, cfg.AgentBinary); err != nil {
		res.Outcome, res.Detail = "verify_failed", "swap: "+err.Error()
		return res
	}
	_ = fsyncDir(binDir)
	hj.Phase = hjRenamed
	if err := saveHelperJournal(cfg.StateDir, hj); err != nil {
		// Swapped but not recorded as such — reconcile will detect it by hash.
		res.Outcome, res.Detail = "unclear", "post-swap journal: "+err.Error()
		return res
	}
	res.BinarySha256 = newSha

	return restartOrRollback(ctx, cfg, hj, res)
}

// restartOrRollback restarts the agent onto the new binary and rolls back
// inline when the service fails to come up.
func restartOrRollback(ctx context.Context, cfg *Config, hj *HelperJournal, res *HelperResult) *HelperResult {
	if _, err := runSystemctl(ctx, "restart", cfg.AgentUnit); err != nil {
		res.Detail = "systemctl restart: " + err.Error()
		return autoRollback(ctx, cfg, hj, res)
	}
	hj.Phase = hjRestarted
	_ = saveHelperJournal(cfg.StateDir, hj)

	active, detail := ensureServiceActive(ctx, cfg)
	res.ServiceActive = active
	if active {
		res.Outcome = "restarted"
		return res
	}
	res.Detail = "service not active after restart: " + detail
	return autoRollback(ctx, cfg, hj, res)
}

// autoRollback restores the backup after a failed start. It refuses to run
// when the backup does not hash to the recorded old value.
func autoRollback(ctx context.Context, cfg *Config, hj *HelperJournal, res *HelperResult) *HelperResult {
	if hj.OldSha256 == "" || hj.BackupPath == "" {
		res.Outcome, res.Detail = "restart_failed_rollback_failed", "no backup to restore"
		return res
	}
	if _, err := restoreBackup(cfg, hj); err != nil {
		res.Outcome, res.Detail = "restart_failed_rollback_failed", "restore: "+err.Error()
		return res
	}
	hj.Phase = hjRolledBack
	_ = saveHelperJournal(cfg.StateDir, hj)
	if _, err := runSystemctl(ctx, "restart", cfg.AgentUnit); err != nil {
		res.Outcome, res.Detail = "restart_failed_rollback_failed", "restart old: "+err.Error()
		return res
	}
	active, detail := ensureServiceActive(ctx, cfg)
	res.ServiceActive = active
	res.BinarySha256 = hj.OldSha256
	if active {
		res.Outcome = "auto_rolled_back"
		return res
	}
	res.Outcome, res.Detail = "restart_failed_rollback_failed", "old binary also inactive: "+detail
	return res
}

// restoreBackup copies the root-owned backup over the target atomically,
// verifying the backup still hashes to the recorded old value first.
func restoreBackup(cfg *Config, hj *HelperJournal) (string, error) {
	sha, err := sha256File(hj.BackupPath)
	if err != nil {
		return "", fmt.Errorf("hash backup: %w", err)
	}
	if sha != hj.OldSha256 {
		return "", fmt.Errorf("backup sha %s != recorded %s", sha, hj.OldSha256)
	}
	binDir := filepath.Dir(cfg.AgentBinary)
	tmpPath := filepath.Join(binDir, ".vps-restore-"+hj.JobID)
	defer os.Remove(tmpPath)
	got, err := copyHashed(hj.BackupPath, tmpPath, hj.OldSha256, 0)
	if err != nil {
		return "", err
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(tmpPath, cfg.AgentBinary); err != nil {
		return "", err
	}
	_ = fsyncDir(binDir)
	return got, nil
}

// reconcileApply completes or aborts a previously initiated mutation based on
// what is actually on disk — it never re-swaps a mutation of unclear outcome.
func reconcileApply(ctx context.Context, cfg *Config, hj *HelperJournal, res *HelperResult) *HelperResult {
	actual, err := sha256File(cfg.AgentBinary)
	if err != nil {
		res.Outcome, res.Detail = "unclear", "cannot hash current binary: "+err.Error()
		return res
	}
	res.BinarySha256 = actual

	switch {
	case actual == hj.NewSha256 && hj.OldSha256 == hj.NewSha256:
		// already_current from an earlier run
		res.Outcome = "already_current"
		res.ServiceActive, _ = ensureServiceActive(ctx, cfg)
		return res
	case actual == hj.NewSha256:
		// Swap happened. Restart only when the restart was never confirmed —
		// re-triggering systemctl for an already-restarted job would keep
		// re-running a mutation whose outcome is recorded (or held unclear).
		if hj.Phase != hjRestarted {
			_ = provisionLockForUpgrade(cfg)
			if _, err := runSystemctl(ctx, "restart", cfg.AgentUnit); err == nil {
				hj.Phase = hjRestarted
				_ = saveHelperJournal(cfg.StateDir, hj)
			}
		}
		res.ServiceActive, res.Detail = ensureServiceActive(ctx, cfg)
		if res.ServiceActive {
			res.Outcome = "recovered_restarted"
		} else {
			res.Outcome, res.Detail = "unclear", "service inactive after recovery: "+res.Detail
		}
		return res
	case actual == hj.OldSha256 && hj.Phase == hjIntent:
		// Crash happened before the rename: the swap never occurred.
		res.Outcome = "recovered_no_swap"
		res.ServiceActive, _ = ensureServiceActive(ctx, cfg)
		return res
	default:
		res.Outcome, res.Detail = "unclear",
			fmt.Sprintf("binary sha %s matches neither new %s nor old %s", actual, hj.NewSha256, hj.OldSha256)
		return res
	}
}

// handleRollback restores the pre-upgrade binary for jobID.
func handleRollback(ctx context.Context, cfg *Config, jobID string) *HelperResult {
	res := &HelperResult{JobID: jobID, Action: actionRollback}
	hj, err := LoadHelperJournal(cfg.StateDir)
	if err != nil || hj == nil || hj.JobID != jobID || hj.BackupPath == "" || hj.OldSha256 == "" {
		res.Outcome, res.Detail = "rollback_failed", "no helper journal with backup for this job"
		return res
	}
	if hj.Phase == hjRolledBack {
		res.Outcome, res.Detail = "rolled_back", "already rolled back"
		res.BinarySha256 = hj.OldSha256
		res.ServiceActive, _ = ensureServiceActive(ctx, cfg)
		return res
	}
	if _, err := restoreBackup(cfg, hj); err != nil {
		res.Outcome, res.Detail = "rollback_failed", err.Error()
		return res
	}
	hj.Phase = hjRolledBack
	_ = saveHelperJournal(cfg.StateDir, hj)
	if _, err := runSystemctl(ctx, "restart", cfg.AgentUnit); err != nil {
		res.Outcome, res.Detail = "rollback_failed", "restart: "+err.Error()
		return res
	}
	res.ServiceActive, res.Detail = ensureServiceActive(ctx, cfg)
	res.BinarySha256 = hj.OldSha256
	if res.ServiceActive {
		res.Outcome = "rolled_back"
	} else {
		res.Outcome, res.Detail = "rollback_failed", "old binary inactive: "+res.Detail
	}
	return res
}

// handleCleanup deletes the root-owned backup for a job the server has ruled
// on. The daemon only requests it after observing the terminal ruling, and
// only after it stopped the job's own path-unit triggers.
func handleCleanup(_ context.Context, cfg *Config, jobID string) *HelperResult {
	res := &HelperResult{JobID: jobID, Action: actionCleanup}
	// RemoveAll follows the final path component: refuse to run it through a
	// planted symlink in the updater-writable state dir.
	if err := requireSecureDir(helperRoot(cfg.StateDir)); err != nil {
		res.Outcome, res.Detail = "cleanup_failed", err.Error()
		return res
	}
	if err := os.RemoveAll(backupDir(cfg.StateDir, jobID)); err != nil {
		res.Outcome, res.Detail = "cleanup_failed", err.Error()
		return res
	}
	// The helper journal exists to protect this backup. Once the backup is
	// gone (ruled terminal) a stale journal would drive reconciliation of a
	// consumed job — remove it, but only when it belongs to this job.
	if hj, err := LoadHelperJournal(cfg.StateDir); err == nil && hj != nil && hj.JobID == jobID {
		_ = os.Remove(helperJournalPath(cfg.StateDir))
		_ = fsyncDir(helperRoot(cfg.StateDir))
	}
	res.Outcome = "cleaned"
	return res
}

// ensureServiceActive polls systemctl is-active briefly.
func ensureServiceActive(ctx context.Context, cfg *Config) (bool, string) {
	deadline := time.Now().Add(serviceActiveWait)
	last := ""
	for {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		out, err := runSystemctl(cctx, "is-active", cfg.AgentUnit)
		cancel()
		if err == nil && out == "active" {
			return true, "active"
		}
		if err != nil {
			last = err.Error()
		} else {
			last = out
		}
		if time.Now().After(deadline) {
			return false, last
		}
		select {
		case <-ctx.Done():
			return false, last
		case <-time.After(servicePollEvery):
		}
	}
}

// copyHashed copies src to dst (O_EXCL create, no symlinks followed on the
// destination) while hashing, enforcing an optional expected sha and size.
// When wantSHA is empty it just returns the computed hash.
func copyHashed(src, dst, wantSHA string, wantSize int64) (string, error) {
	// Lstat before Open: a FIFO or symlink planted at src in the
	// updater-writable staging dir must not hang or redirect the privileged
	// read (content is hash-bound anyway; this keeps the read bounded).
	if sfi, err := os.Lstat(src); err != nil {
		return "", err
	} else if !sfi.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file", src)
	}
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	if fi, err := in.Stat(); err != nil {
		return "", err
	} else if !fi.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file", src)
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", fmt.Errorf("create %s: %w", dst, err)
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), in)
	if err != nil {
		_ = out.Close()
		return "", fmt.Errorf("copy: %w", err)
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	if wantSize > 0 && n != wantSize {
		return "", fmt.Errorf("copied %d bytes, want %d", n, wantSize)
	}
	got := fmt.Sprintf("%x", h.Sum(nil))
	if wantSHA != "" && got != wantSHA {
		return "", fmt.Errorf("sha256 %s != expected %s", got, wantSHA)
	}
	return got, nil
}

func markHelperJournal(cfg *Config, hj *HelperJournal) {
	_ = saveHelperJournal(cfg.StateDir, hj)
}

type localAgentConfigHeader struct {
	VpsID string `json:"vpsId"`
}

func readTrustedLocalVpsID(configPath string) (string, error) {
	if configPath == "" {
		return "", fmt.Errorf("agent config path is empty")
	}
	fi, err := os.Lstat(configPath)
	if err != nil {
		return "", fmt.Errorf("stat trusted local agent config %s: %w", configPath, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("trusted local agent config %s must not be a symlink", configPath)
	}
	if !fi.Mode().IsRegular() {
		return "", fmt.Errorf("trusted local agent config %s must be a regular file", configPath)
	}
	if os.Geteuid() == 0 {
		if fi.Mode().Perm()&0o022 != 0 {
			return "", fmt.Errorf("trusted local agent config %s must not be group- or world-writable (mode %o)", configPath, fi.Mode().Perm())
		}
		if rooted, ok := statIsRootOwned(fi); ok && !rooted {
			return "", fmt.Errorf("trusted local agent config %s must be owned by root", configPath)
		}
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return "", fmt.Errorf("read trusted local agent config %s: %w", configPath, err)
	}
	var c localAgentConfigHeader
	if err := json.Unmarshal(raw, &c); err != nil {
		return "", fmt.Errorf("parse trusted local agent config %s: %w", configPath, err)
	}
	vpsID := strings.TrimSpace(c.VpsID)
	if vpsID == "" {
		return "", fmt.Errorf("trusted local agent config %s has empty vpsId", configPath)
	}
	return vpsID, nil
}

func provisionLockForUpgrade(cfg *Config) error {
	var vpsID string
	if cfg.VpsID != "" {
		vpsID = strings.TrimSpace(cfg.VpsID)
	}

	configPath := cfg.AgentConfig
	if configPath == "" && !cfg.testMode {
		configPath = FixedAgentConfig
	}

	// If vpsId was not directly in updater config, read from trusted local agent config
	if vpsID == "" && configPath != "" {
		if cfg.testMode {
			if _, err := os.Stat(configPath); os.IsNotExist(err) && cfg.testLockDir == "" {
				return nil
			}
		}
		var err error
		vpsID, err = readTrustedLocalVpsID(configPath)
		if err != nil {
			if cfg.testMode && cfg.testLockDir == "" {
				return nil
			}
			return fmt.Errorf("read trusted local agent config: %w", err)
		}
	}

	if vpsID == "" {
		if cfg.testMode && cfg.testLockDir != "" {
			vpsID = "test-upgrade-vps"
		} else if cfg.testMode {
			return nil
		} else {
			return fmt.Errorf("trusted local agent config not found or vpsId empty")
		}
	}

	var opts []lock.Option
	if cfg.testLockDir != "" {
		opts = append(opts, lock.WithDir(cfg.testLockDir))
	}
	if cfg.testTmpfilesDir != "" {
		opts = append(opts, lock.WithTmpfilesDir(cfg.testTmpfilesDir))
	}

	return lock.Provision(vpsID, opts...)
}
