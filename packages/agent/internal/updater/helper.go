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
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/vps-manager/agent/internal/applications"
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
type ComponentBackup struct {
	Component  string `json:"component"`
	TargetPath string `json:"targetPath"`
	BackupPath string `json:"backupPath"`
	OldSha256  string `json:"oldSha256,omitempty"`
	NewSha256  string `json:"newSha256,omitempty"`
}

type HelperJournal struct {
	JobID            string            `json:"jobId"`
	Phase            string            `json:"phase"`
	OldSha256        string            `json:"oldSha256"`
	NewSha256        string            `json:"newSha256"`
	BackupPath       string            `json:"backupPath"`
	ComponentBackups []ComponentBackup `json:"componentBackups,omitempty"`
	UpdatedAt        time.Time         `json:"updatedAt"`
	FenceOwner       string            `json:"fenceOwner,omitempty"`
}

func agentLockDir(cfg *Config) string {
	if cfg != nil && cfg.AgentStateDir != "" {
		return cfg.AgentStateDir
	}
	if cfg != nil && cfg.StateDir != "" {
		return cfg.StateDir
	}
	return ""
}

func acquireUpgradeFence(cfg *Config, jobID string) error {
	dir := agentLockDir(cfg)
	return applications.AcquireHostScopeAt(dir, applications.LockScopeUpgrade, "updater-helper", jobID, true, 0)
}

func releaseUpgradeFence(cfg *Config, jobID string) error {
	dir := agentLockDir(cfg)
	return applications.ReleaseHostScopeAt(dir, applications.LockScopeUpgrade, "updater-helper", jobID)
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
	applySpecPath := filepath.Join(staging, "apply-spec.json")
	if fileExists(applySpecPath) {
		return handleApplyFleet(ctx, cfg, auth, apiJob, jobID, staging, res)
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
	// Acquire upgrade fence before final idle check:
	cfg.CurrentJobID = jobID
	if err := acquireUpgradeFence(cfg, jobID); err != nil {
		res.Outcome = "deferred"
		res.Detail = "host busy before swap: acquire upgrade fence: " + err.Error()
		return res
	}

	// Final idle check before swap: safely abandon pre-swap if host activity began.
	if idle, reason := DetectHostIdle(cfg); !idle {
		_ = releaseUpgradeFence(cfg, jobID)
		res.Outcome = "deferred"
		res.Detail = "host busy before swap: " + reason
		return res
	}

	// Backups and the helper journal live under the helper root: fail closed
	// if it was swapped for a symlink since the entry check.
	if err := requireSecureDir(helperRoot(cfg.StateDir)); err != nil {
		_ = releaseUpgradeFence(cfg, jobID)
		res.Outcome, res.Detail = "verify_failed", err.Error()
		return res
	}
	// Backup the current binary (root-owned, unreadable/unwritable by the
	// updater) before any mutation.
	bdir := backupDir(cfg.StateDir, jobID)
	if err := os.MkdirAll(bdir, 0o755); err != nil {
		_ = releaseUpgradeFence(cfg, jobID)
		res.Outcome, res.Detail = "verify_failed", "backup dir: "+err.Error()
		return res
	}
	backupPath := filepath.Join(bdir, "agent-binary")
	oldSha := ""
	if _, statErr := os.Stat(cfg.AgentBinary); statErr == nil {
		oldSha, err = copyHashed(cfg.AgentBinary, backupPath, "", 0)
		if err != nil {
			_ = releaseUpgradeFence(cfg, jobID)
			res.Outcome, res.Detail = "verify_failed", "backup: "+err.Error()
			return res
		}
		_ = os.Chmod(backupPath, 0o755)
	}

	// Durably record intent BEFORE the swap so a crash is reconcilable.
	hj = &HelperJournal{
		JobID: jobID, Phase: hjIntent,
		OldSha256: oldSha, NewSha256: newSha, BackupPath: backupPath,
		FenceOwner: jobID,
	}
	if err := saveHelperJournal(cfg.StateDir, hj); err != nil {
		_ = releaseUpgradeFence(cfg, jobID)
		res.Outcome, res.Detail = "verify_failed", "helper journal: "+err.Error()
		return res
	}

	// Provision lock and reboot persistence before binary swap so the new agent
	// can acquire its singleton lock immediately on restart.
	if err := provisionLockForUpgrade(cfg); err != nil {
		_ = releaseUpgradeFence(cfg, jobID)
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
	if (hj.OldSha256 == "" || hj.BackupPath == "") && len(hj.ComponentBackups) == 0 {
		res.Outcome, res.Detail = "restart_failed_rollback_failed", "no backup to restore"
		return res
	}
	if _, err := restoreBackup(cfg, hj); err != nil {
		res.Outcome, res.Detail = "restart_failed_rollback_failed", "restore: "+err.Error()
		return res
	}
	hj.Phase = hjRolledBack
	_ = saveHelperJournal(cfg.StateDir, hj)

	hasAgent := hj.BackupPath != ""
	hasAI := false
	for _, cb := range hj.ComponentBackups {
		if cb.Component == "agent" {
			hasAgent = true
		}
		if strings.HasPrefix(cb.Component, "ai-") {
			hasAI = true
		}
	}

	if hasAgent {
		if _, err := runSystemctl(ctx, "restart", cfg.AgentUnit); err != nil {
			res.Outcome, res.Detail = "restart_failed_rollback_failed", "restart old: "+err.Error()
			return res
		}
	}
	if hasAI && unitExists(ctx, "flexserver-ai-helper.service") {
		_, _ = runSystemctl(ctx, "restart", "flexserver-ai-helper.service")
	}

	if hasAgent {
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

	res.ServiceActive = true
	res.Outcome = "auto_rolled_back"
	return res
}

// restoreBackup copies the root-owned backup over the target atomically,
// verifying the backup still hashes to the recorded old value first.
func restoreBackup(cfg *Config, hj *HelperJournal) (string, error) {
	got := ""
	if hj.BackupPath != "" && hj.OldSha256 != "" {
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
		var copyErr error
		got, copyErr = copyHashed(hj.BackupPath, tmpPath, hj.OldSha256, 0)
		if copyErr != nil {
			return "", copyErr
		}
		if err := os.Chmod(tmpPath, 0o755); err != nil {
			return "", err
		}
		if err := os.Rename(tmpPath, cfg.AgentBinary); err != nil {
			return "", err
		}
		_ = fsyncDir(binDir)
	}

	// Restore secondary component backups (e.g. AI executor, helper, profiles, rootfs)
	for _, cb := range hj.ComponentBackups {
		if cb.TargetPath == "" {
			continue
		}
		// Component was not present prior to upgrade: remove it on rollback
		if cb.BackupPath == "" {
			if err := os.RemoveAll(cb.TargetPath); err != nil {
				return "", fmt.Errorf("rollback remove new component %s: %w", cb.Component, err)
			}
			continue
		}

		fi, err := os.Lstat(cb.BackupPath)
		if err != nil {
			return "", fmt.Errorf("stat backup for %s (%s): %w", cb.Component, cb.BackupPath, err)
		}

		if fi.IsDir() {
			if err := os.RemoveAll(cb.TargetPath); err != nil {
				return "", fmt.Errorf("clear target dir %s for %s: %w", cb.TargetPath, cb.Component, err)
			}
			if err := copyDir(cb.BackupPath, cb.TargetPath); err != nil {
				return "", fmt.Errorf("restore dir %s for %s: %w", cb.Component, cb.TargetPath, err)
			}
			_ = fsyncDir(cb.TargetPath)
		} else {
			cbSha, err := sha256File(cb.BackupPath)
			if err != nil {
				return "", fmt.Errorf("hash backup for %s: %w", cb.Component, err)
			}
			if cb.OldSha256 != "" && cbSha != cb.OldSha256 {
				return "", fmt.Errorf("backup sha %s != recorded %s for %s", cbSha, cb.OldSha256, cb.Component)
			}
			cbDir := filepath.Dir(cb.TargetPath)
			tmpCB := filepath.Join(cbDir, ".restore-"+filepath.Base(cb.TargetPath))
			defer os.Remove(tmpCB)
			if _, err := copyHashed(cb.BackupPath, tmpCB, cbSha, 0); err != nil {
				return "", fmt.Errorf("copy backup for %s: %w", cb.Component, err)
			}
			perm := fi.Mode().Perm()
			if perm == 0 {
				perm = 0o755
			}
			if err := os.Chmod(tmpCB, perm); err != nil {
				return "", fmt.Errorf("chmod %s: %w", tmpCB, err)
			}
			if err := os.Rename(tmpCB, cb.TargetPath); err != nil {
				return "", fmt.Errorf("rename %s -> %s: %w", tmpCB, cb.TargetPath, err)
			}
			_ = fsyncDir(cbDir)
		}
	}
	return got, nil
}

// reconcileApply completes or aborts a previously initiated mutation based on
// what is actually on disk — it never re-swaps a mutation of unclear outcome.
func reconcileApply(ctx context.Context, cfg *Config, hj *HelperJournal, res *HelperResult) *HelperResult {
	if hj != nil && hj.JobID != "" {
		cfg.CurrentJobID = hj.JobID
		_ = acquireUpgradeFence(cfg, hj.JobID)
	}
	hasAgent := hj.NewSha256 != "" || hj.OldSha256 != "" || hj.BackupPath != ""
	if !hasAgent {
		for _, cb := range hj.ComponentBackups {
			if cb.Component == "agent" {
				hasAgent = true
				break
			}
		}
	}

	if !hasAgent {
		// Non-agent / updater-only update
		allMatchNew := len(hj.ComponentBackups) > 0
		allMatchOld := len(hj.ComponentBackups) > 0
		for _, cb := range hj.ComponentBackups {
			if cb.TargetPath == "" {
				continue
			}
			if cb.BackupPath == "" {
				if fileExists(cb.TargetPath) || dirExists(cb.TargetPath) {
					allMatchOld = false
				} else {
					allMatchNew = false
				}
				continue
			}
			if fi, err := os.Stat(cb.TargetPath); err == nil && !fi.IsDir() {
				curSha, _ := sha256File(cb.TargetPath)
				if cb.NewSha256 != "" && curSha != cb.NewSha256 {
					allMatchNew = false
				}
				if cb.OldSha256 != "" && curSha != cb.OldSha256 {
					allMatchOld = false
				}
			}
		}

		switch {
		case allMatchNew && (hj.Phase == hjRenamed || hj.Phase == hjRestarted):
			hj.Phase = hjRestarted
			_ = saveHelperJournal(cfg.StateDir, hj)
			res.Outcome = "recovered_restarted"
			res.ServiceActive = true
			return res
		case allMatchOld || hj.Phase == hjIntent:
			res.Outcome = "recovered_no_swap"
			res.ServiceActive = true
			return res
		default:
			if hj.Phase == hjRestarted {
				res.Outcome = "recovered_restarted"
				res.ServiceActive = true
				return res
			}
			res.Outcome, res.Detail = "unclear", "components match neither new nor old state"
			return res
		}
	}

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
		// Swap happened. Restart only when the restart was never confirmed
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
	cfg.CurrentJobID = jobID
	_ = acquireUpgradeFence(cfg, jobID)
	hj, err := LoadHelperJournal(cfg.StateDir)
	if err != nil || hj == nil || hj.JobID != jobID || (hj.BackupPath == "" && len(hj.ComponentBackups) == 0) {
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

	hasAgent := hj.BackupPath != ""
	hasAI := false
	for _, cb := range hj.ComponentBackups {
		if cb.Component == "agent" {
			hasAgent = true
		}
		if strings.HasPrefix(cb.Component, "ai-") {
			hasAI = true
		}
	}

	if hasAgent {
		if _, err := runSystemctl(ctx, "restart", cfg.AgentUnit); err != nil {
			res.Outcome, res.Detail = "rollback_failed", "restart: "+err.Error()
			return res
		}
	}
	if hasAI && unitExists(ctx, "flexserver-ai-helper.service") {
		_, _ = runSystemctl(ctx, "restart", "flexserver-ai-helper.service")
	}

	if hasAgent {
		res.ServiceActive, res.Detail = ensureServiceActive(ctx, cfg)
		res.BinarySha256 = hj.OldSha256
		if res.ServiceActive {
			res.Outcome = "rolled_back"
		} else {
			res.Outcome, res.Detail = "rollback_failed", "old binary inactive: "+res.Detail
		}
		return res
	}

	res.ServiceActive = true
	res.Outcome = "rolled_back"
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

	backupsBase := filepath.Join(helperRoot(cfg.StateDir), "backups")
	if cfg.testMode {
		if err := os.RemoveAll(backupDir(cfg.StateDir, jobID)); err != nil {
			res.Outcome, res.Detail = "cleanup_failed", err.Error()
			return res
		}
	} else {
		// Safe pruning: retain current + previous backup (up to 2 backup generations)
		if entries, err := os.ReadDir(backupsBase); err == nil {
			type dirInfo struct {
				path    string
				modTime time.Time
			}
			var dirs []dirInfo
			for _, e := range entries {
				if !e.IsDir() {
					continue
				}
				p := filepath.Join(backupsBase, e.Name())
				fi, err := os.Stat(p)
				if err == nil {
					dirs = append(dirs, dirInfo{path: p, modTime: fi.ModTime()})
				}
			}
			sort.Slice(dirs, func(i, j int) bool {
				return dirs[i].modTime.After(dirs[j].modTime)
			})
			for i := 2; i < len(dirs); i++ {
				_ = os.RemoveAll(dirs[i].path)
			}
		}
	}

	// The helper journal exists to protect this backup. Once the backup is
	// gone (ruled terminal) a stale journal would drive reconciliation of a
	// consumed job — remove it, but only when it belongs to this job.
	if hj, err := LoadHelperJournal(cfg.StateDir); err == nil && hj != nil && hj.JobID == jobID {
		jobBackupDir := filepath.Join(backupsBase, jobID)
		if dirExists(jobBackupDir) {
			if raw, err := os.ReadFile(helperJournalPath(cfg.StateDir)); err == nil {
				_ = os.WriteFile(filepath.Join(jobBackupDir, "journal.json"), raw, 0o600)
				_ = fsyncDir(jobBackupDir)
			}
		}
		_ = os.Remove(helperJournalPath(cfg.StateDir))
		_ = fsyncDir(helperRoot(cfg.StateDir))
	}
	// Release only own terminal recovery fence:
	_ = releaseUpgradeFence(cfg, jobID)
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

// ApplySpec is written by the daemon during fleet staging
type ApplySpec struct {
	JobID      string               `json:"jobId"`
	ReleaseID  string               `json:"releaseId"`
	BuildID    string               `json:"buildId"`
	Components []ComponentApplySpec `json:"components"`
}

type ComponentApplySpec struct {
	Component   string `json:"component"`
	SourcePath  string `json:"sourcePath"`
	TargetPath  string `json:"targetPath"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
	IsTar       bool   `json:"isTar,omitempty"`
	StripPrefix string `json:"stripPrefix,omitempty"`
}

func handleApplyFleet(ctx context.Context, cfg *Config, auth JobAuthorizer, apiJob *ClaimedJob, jobID string, staging string, res *HelperResult) *HelperResult {
	if apiJob == nil || apiJob.ManifestRaw == "" {
		res.Outcome, res.Detail = "verify_failed", "api job manifestRaw is empty"
		return res
	}

	pubKeyPEM, err := cfg.FleetPublicKeyPEM()
	if err != nil {
		res.Outcome, res.Detail = "verify_failed", "load fleet release public key: "+err.Error()
		return res
	}

	payload, err := VerifyFleetManifest([]byte(apiJob.ManifestRaw), pubKeyPEM)
	if err != nil {
		res.Outcome, res.Detail = "verify_failed", "verify fleet release manifest: "+err.Error()
		return res
	}

	if apiJob.Release.BuildID != "" && payload.BuildID != apiJob.Release.BuildID {
		res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("payload buildId %s != api job %s", payload.BuildID, apiJob.Release.BuildID)
		return res
	}
	if apiJob.Release.ReleaseID != "" && payload.ReleaseID != apiJob.Release.ReleaseID {
		res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("payload releaseId %s != api job %s", payload.ReleaseID, apiJob.Release.ReleaseID)
		return res
	}

	specPath := filepath.Join(staging, "apply-spec.json")
	specData, err := os.ReadFile(specPath)
	if err != nil {
		res.Outcome, res.Detail = "verify_failed", "read apply-spec: "+err.Error()
		return res
	}
	var spec ApplySpec
	if err := json.Unmarshal(specData, &spec); err != nil {
		res.Outcome, res.Detail = "verify_failed", "parse apply-spec: "+err.Error()
		return res
	}

	if spec.JobID != "" && spec.JobID != jobID {
		res.Outcome, res.Detail = "verify_failed", "apply-spec jobId mismatch"
		return res
	}
	if spec.BuildID != "" && payload.BuildID != spec.BuildID {
		res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("payload buildId %s != spec %s", payload.BuildID, spec.BuildID)
		return res
	}
	if spec.ReleaseID != "" && payload.ReleaseID != spec.ReleaseID {
		res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("payload releaseId %s != spec %s", payload.ReleaseID, spec.ReleaseID)
		return res
	}
	if len(spec.Components) == 0 {
		res.Outcome, res.Detail = "verify_failed", "apply-spec contains no components"
		return res
	}

	curVer := cfg.UpdaterVersion()
	if payload.MinUpdaterVersion != "" && curVer != "dev" && CompareSemver(curVer, payload.MinUpdaterVersion) < 0 {
		for _, c := range spec.Components {
			if c.Component == "agent" {
				res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("current updater version %s is below required minUpdaterVersion %s for agent upgrade", curVer, payload.MinUpdaterVersion)
				return res
			}
		}
	}

	cleanStaging := filepath.Clean(staging)
	for _, c := range spec.Components {
		expectedTarget, ok := cfg.CanonicalTarget(c.Component)
		if !ok || filepath.Clean(c.TargetPath) != filepath.Clean(expectedTarget) {
			res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("component %s target path %q is not canonical (expected %q)", c.Component, c.TargetPath, expectedTarget)
			return res
		}

		cleanSource := filepath.Clean(c.SourcePath)
		rel, err := filepath.Rel(cleanStaging, cleanSource)
		if err != nil || strings.HasPrefix(rel, "..") || rel == "." {
			res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("component %s source path %q escapes staging", c.Component, c.SourcePath)
			return res
		}

		var match *FleetArtifact
		for i := range payload.Artifacts {
			a := &payload.Artifacts[i]
			if a.Component == c.Component {
				if a.OS == runtime.GOOS && a.Arch == runtime.GOARCH {
					match = a
					break
				}
				if match == nil {
					match = a
				}
			}
		}
		if match == nil {
			res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("component %s not in signed manifest artifacts", c.Component)
			return res
		}

		if c.SHA256 != match.SHA256 {
			res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("component %s sha256 %s != manifest %s", c.Component, c.SHA256, match.SHA256)
			return res
		}
		if c.Size != match.Size {
			res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("component %s size %d != manifest %d", c.Component, c.Size, match.Size)
			return res
		}

		srcSha, err := sha256File(c.SourcePath)
		if err != nil {
			res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("component %s source missing: %v", c.Component, err)
			return res
		}
		if srcSha != match.SHA256 {
			res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("component %s source sha %s != manifest %s", c.Component, srcSha, match.SHA256)
			return res
		}
	}

	// Acquire upgrade fence before final idle check:
	cfg.CurrentJobID = jobID
	if err := acquireUpgradeFence(cfg, jobID); err != nil {
		res.Outcome = "deferred"
		res.Detail = "host busy before swap: acquire upgrade fence: " + err.Error()
		return res
	}

	// Final idle check before swap: safely abandon pre-swap if host activity began.
	if idle, reason := DetectHostIdle(cfg); !idle {
		_ = releaseUpgradeFence(cfg, jobID)
		res.Outcome = "deferred"
		res.Detail = "host busy before swap: " + reason
		return res
	}

	if err := requireSecureDir(helperRoot(cfg.StateDir)); err != nil {
		_ = releaseUpgradeFence(cfg, jobID)
		res.Outcome, res.Detail = "verify_failed", err.Error()
		return res
	}

	bdir := backupDir(cfg.StateDir, jobID)
	if err := os.MkdirAll(bdir, 0o755); err != nil {
		_ = releaseUpgradeFence(cfg, jobID)
		res.Outcome, res.Detail = "verify_failed", "backup dir: "+err.Error()
		return res
	}

	hj := &HelperJournal{
		JobID:      jobID,
		Phase:      hjIntent,
		FenceOwner: jobID,
	}
	for _, c := range spec.Components {
		if fi, err := os.Lstat(c.TargetPath); err == nil {
			backupPath := filepath.Join(bdir, c.Component)
			if c.IsTar || fi.IsDir() {
				if err := copyDir(c.TargetPath, backupPath); err != nil {
					res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("backup %s dir: %v", c.Component, err)
					return res
				}
				hj.ComponentBackups = append(hj.ComponentBackups, ComponentBackup{
					Component:  c.Component,
					TargetPath: c.TargetPath,
					BackupPath: backupPath,
				})
			} else {
				oldSha, err := copyHashed(c.TargetPath, backupPath, "", 0)
				if err != nil {
					res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("backup %s: %v", c.Component, err)
					return res
				}
				_ = os.Chmod(backupPath, fi.Mode().Perm())
				hj.ComponentBackups = append(hj.ComponentBackups, ComponentBackup{
					Component:  c.Component,
					TargetPath: c.TargetPath,
					BackupPath: backupPath,
					OldSha256:  oldSha,
					NewSha256:  c.SHA256,
				})
				if c.Component == "agent" {
					hj.OldSha256 = oldSha
					hj.NewSha256 = c.SHA256
					hj.BackupPath = backupPath
				}
			}
		} else {
			// Newly installed component not present on host prior to upgrade
			hj.ComponentBackups = append(hj.ComponentBackups, ComponentBackup{
				Component:  c.Component,
				TargetPath: c.TargetPath,
				BackupPath: "",
				NewSha256:  c.SHA256,
			})
			if c.Component == "agent" {
				hj.NewSha256 = c.SHA256
			}
		}
	}

	if err := saveHelperJournal(cfg.StateDir, hj); err != nil {
		_ = releaseUpgradeFence(cfg, jobID)
		res.Outcome, res.Detail = "verify_failed", "save helper journal: "+err.Error()
		return res
	}

	if err := provisionLockForUpgrade(cfg); err != nil {
		_ = releaseUpgradeFence(cfg, jobID)
		res.Outcome, res.Detail = "verify_failed", "provision lock: "+err.Error()
		return res
	}

	// 2. Perform component mutations
	hasAI := false
	hasAgent := false
	for _, c := range spec.Components {
		if strings.HasPrefix(c.Component, "ai-") {
			hasAI = true
		}
		if c.Component == "agent" {
			hasAgent = true
		}
		if c.IsTar {
			if err := ExtractTarGz(c.SourcePath, c.TargetPath, c.StripPrefix); err != nil {
				res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("extract %s: %v", c.Component, err)
				return res
			}
		} else {
			targetDir := filepath.Dir(c.TargetPath)
			if err := os.MkdirAll(targetDir, 0o755); err != nil {
				res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("mkdir %s: %v", targetDir, err)
				return res
			}
			tmp := filepath.Join(targetDir, ".vps-fleet-new-"+c.Component+"-"+jobID)
			defer os.Remove(tmp)
			if _, err := copyHashed(c.SourcePath, tmp, c.SHA256, c.Size); err != nil {
				res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("copy %s: %v", c.Component, err)
				return res
			}
			_ = os.Chmod(tmp, 0o755)
			if os.Geteuid() == 0 {
				_ = os.Chown(tmp, 0, 0)
			}
			if err := os.Rename(tmp, c.TargetPath); err != nil {
				res.Outcome, res.Detail = "verify_failed", fmt.Sprintf("rename %s: %v", c.Component, err)
				return res
			}
			_ = fsyncDir(targetDir)
		}
	}

	hj.Phase = hjRenamed
	if err := saveHelperJournal(cfg.StateDir, hj); err != nil {
		res.Outcome, res.Detail = "unclear", "post-swap journal: "+err.Error()
		return res
	}

	// 3. Restart services
	if hasAgent {
		if _, err := runSystemctl(ctx, "restart", cfg.AgentUnit); err != nil {
			res.Outcome, res.Detail = "restart_failed", "restart agent: "+err.Error()
			return autoRollback(ctx, cfg, hj, res)
		}
	}

	if hasAI && unitExists(ctx, "flexserver-ai-helper.service") {
		if _, err := runSystemctl(ctx, "restart", "flexserver-ai-helper.service"); err != nil {
			res.Outcome, res.Detail = "restart_failed", "restart ai-helper: "+err.Error()
			return autoRollback(ctx, cfg, hj, res)
		}
	}

	// 4. Verify health
	if hasAgent {
		active, detail := ensureServiceActive(ctx, cfg)
		res.ServiceActive = active
		if !active {
			res.Detail = "agent service not active after restart: " + detail
			return autoRollback(ctx, cfg, hj, res)
		}
	} else {
		res.ServiceActive = true
	}

	if hasAI && unitExists(ctx, "flexserver-ai-helper.service") {
		aiActive, aiDetail := ensureUnitActive(ctx, "flexserver-ai-helper.service")
		if !aiActive {
			res.Detail = "ai-helper service not active after restart: " + aiDetail
			return autoRollback(ctx, cfg, hj, res)
		}
	}

	hj.Phase = hjRestarted
	_ = saveHelperJournal(cfg.StateDir, hj)
	res.Outcome = "restarted"
	res.BinarySha256 = hj.NewSha256
	return res
}

func dirExists(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

func unitExists(ctx context.Context, unit string) bool {
	for _, dir := range []string{"/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"} {
		if _, err := os.Stat(filepath.Join(dir, unit)); err == nil {
			return true
		}
	}
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := runSystemctl(cctx, "cat", unit)
	if err != nil {
		return false
	}
	trimmed := strings.TrimSpace(out)
	return len(trimmed) > 0 && !strings.Contains(trimmed, "could not be found")
}

func ensureUnitActive(ctx context.Context, unit string) (bool, string) {
	deadline := time.Now().Add(serviceActiveWait)
	last := ""
	for {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		out, err := runSystemctl(cctx, "is-active", unit)
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
			return false, ctx.Err().Error()
		case <-time.After(servicePollEvery):
		}
	}
}

func copyDir(src, dst string) error {
	srcFi, err := os.Lstat(src)
	if err != nil {
		return err
	}
	perm := srcFi.Mode().Perm()
	if perm == 0 {
		perm = 0o755
	}
	if err := os.MkdirAll(dst, perm); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		fi, err := os.Lstat(s)
		if err != nil {
			return err
		}
		switch {
		case fi.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(s)
			if err != nil {
				return err
			}
			_ = os.Remove(d)
			if err := os.Symlink(target, d); err != nil {
				return err
			}
		case fi.IsDir():
			if err := copyDir(s, d); err != nil {
				return err
			}
		default:
			data, err := os.ReadFile(s)
			if err != nil {
				return err
			}
			filePerm := fi.Mode().Perm()
			if filePerm == 0 {
				filePerm = 0o644
			}
			if err := os.WriteFile(d, data, filePerm); err != nil {
				return err
			}
		}
	}
	return nil
}
