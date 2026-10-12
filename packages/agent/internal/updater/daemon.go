package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// API is the slice of the local-updater API the daemon depends on.
type API interface {
	Claim(ctx context.Context) (*ClaimedJob, error)
	Progress(ctx context.Context, jobID string, token int64, phase string, progress *int, message string) (*ClaimedJob, error)
	Result(ctx context.Context, jobID string, token int64, outcome, reportedBuildID, reason string) (*ClaimedJob, bool, error)
	Get(ctx context.Context, jobID string) (*ClaimedJob, error)
}

// Daemon runs the claim → download → verify → stage → swap → heartbeat →
// report state machine. Exactly one job at a time, guarded by a filesystem
// lock and a durable journal; every post-swap step is reconciled from disk
// after a crash instead of re-executed.
type Daemon struct {
	cfg    *Config
	api    API
	journal *JournalStore
	dl     *http.Client
	logf   func(format string, args ...any)

	// lastPhase tracks what the server already knows, so progress POSTs fire
	// only on phase changes (rate-limit contract).
	lastPhase string
}

// NewDaemon wires a daemon from config.
func NewDaemon(cfg *Config, api API) *Daemon {
	if cfg.testMode && cfg.testAuthorizer == nil {
		if auth, ok := api.(JobAuthorizer); ok {
			cfg.testAuthorizer = auth
		}
	}
	return &Daemon{
		cfg:     cfg,
		api:     api,
		journal: NewJournalStore(cfg.StateDir),
		dl:      newHTTPClient(cfg),
		logf:    func(format string, args ...any) { fmt.Printf("vps-updater: "+format+"\n", args...) },
	}
}

// Run blocks until ctx is cancelled. It never returns on transient errors:
// offline is a retry state, not a failure.
func (d *Daemon) Run(ctx context.Context) error {
	if err := os.MkdirAll(d.cfg.StateDir, 0o770); err != nil {
		return fmt.Errorf("state dir: %w", err)
	}
	lock, err := acquireLock(filepath.Join(d.cfg.StateDir, "updater.lock"))
	if err != nil {
		return err
	}
	defer lock.release()

	for ctx.Err() == nil {
		j, err := d.journal.Load()
		if err != nil {
			// Corrupt journal: never guess about a mutation of unclear state.
			d.logf("journal unreadable, halting: %v", err)
			return err
		}
		if j == nil {
			d.stepClaim(ctx)
			continue
		}
		if j.Hold {
			d.logf("job %s on hold (%s) — manual intervention required; not claiming new jobs",
				j.JobID, j.Reason)
			if err := sleepCtx(ctx, d.cfg.ClaimInterval); err != nil {
				return nil
			}
			continue
		}
		if err := d.runJob(ctx, j); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			d.logf("job step error (will retry): %v", err)
			if err := sleepCtx(ctx, d.cfg.HeartbeatInterval); err != nil {
				return nil
			}
		}
	}
	return nil
}

// stepClaim claims at most one job and starts it.
func (d *Daemon) stepClaim(ctx context.Context) {
	job, err := d.api.Claim(ctx)
	if errors.Is(err, ErrUnauthorized) || errors.Is(err, ErrForbidden) {
		d.logf("credential rejected: %v — fix config %s and restart", err, "updater config")
		_ = sleepCtx(ctx, 5*d.cfg.ClaimInterval)
		return
	}
	if err != nil {
		d.logf("claim failed (offline?): %v", err)
		_ = sleepCtx(ctx, d.cfg.ClaimInterval)
		return
	}
	if job == nil {
		_ = sleepCtx(ctx, d.cfg.ClaimInterval)
		return
	}
	if job.JobID == "" || !jobIDRe.MatchString(job.JobID) {
		d.logf("claim returned job with invalid id, ignoring")
		return
	}
	targetSha := job.TargetSha256
	if targetSha == "" {
		targetSha = job.Release.TargetSha256
	}
	targetURL := job.TargetURL
	if targetURL == "" {
		targetURL = "/api/local-updater/jobs/" + job.JobID + "/artifact"
	}
	j := &Journal{
		JobID:             job.JobID,
		FencingToken:      job.FencingToken,
		RequiresReconcile: job.RequiresReconcile,
		ReleaseID:         job.Release.ReleaseID,
		Version:           job.Release.Version,
		BuildID:           job.Release.BuildID,
		TargetSha256:      targetSha,
		TargetURL:         targetURL,
		TargetSizeBytes:   job.TargetSizeBytes,
		ManifestRaw:       job.ManifestRaw,
		Phase:             PhaseDownloading,
		CreatedAt:         time.Now().UTC(),
	}
	if err := d.journal.Save(j); err != nil {
		d.logf("cannot persist journal (disk full?): %v", err)
		_ = sleepCtx(ctx, d.cfg.ClaimInterval)
		return
	}
	d.lastPhase = ""
	d.logf("claimed job %s release=%s build=%s", j.JobID, j.ReleaseID, j.BuildID)
}

// runJob advances the journal to completion (consume or hold). Each step is
// restartable from the journal alone.
func (d *Daemon) runJob(ctx context.Context, j *Journal) error {
	// The privileged cleanup already ran: finish tearing down local state
	// idempotently. Reconciling half-deleted evidence here (helper journal
	// and backup gone, results gone) would misread the crash as a lost
	// mutation and hold a job that is already being consumed. The helper's
	// "cleaned" result is consulted too: a crash may land after the helper
	// wrote it but before CleanupDone reached the journal.
	cleanupDone := j.CleanupDone
	if !cleanupDone {
		if res, err := ReadResult(d.cfg.StateDir, actionCleanup, j.JobID); err == nil && res != nil && res.Outcome == "cleaned" {
			cleanupDone = true
		}
	}
	if cleanupDone {
		return d.observeRuling(ctx, j)
	}
	// Post-swap truth always comes from disk first.
	if j.PostSwap || j.SwapRequested || j.RequiresReconcile {
		if err := d.reconcile(ctx, j); err != nil {
			return err
		}
	}

	switch j.Phase {
	case PhaseDownloading, PhaseVerifying, PhaseStaging:
		return d.runPreSwap(ctx, j)
	case PhaseRestarting:
		return d.runRestarting(ctx, j)
	case PhaseAwaitingHB:
		return d.awaitHeartbeat(ctx, j)
	case PhaseRollingBack:
		return d.runRollingBack(ctx, j)
	case PhaseTerminal:
		return d.observeRuling(ctx, j)
	default:
		return fmt.Errorf("journal phase %q unknown", j.Phase)
	}
}

// reconcile decides what is actually true on disk after a crash, a reboot or
// a lost claim, before any report or mutation.
func (d *Daemon) reconcile(ctx context.Context, j *Journal) error {
	hj, err := LoadHelperJournal(d.cfg.StateDir)
	if err != nil {
		return err
	}

	pendingExists := fileExists(pendingPath(d.cfg.StateDir, actionApply, j.JobID))
	resultApplied := fileExists(resultPath(d.cfg.StateDir, actionApply, j.JobID))

	// Helper journal belongs to a different job: treat as absent for us.
	if hj != nil && hj.JobID != j.JobID {
		hj = nil
	}

	if hj == nil {
		if !j.SwapRequested && !j.RequiresReconcile {
			return nil // pure pre-swap resume
		}
		// The swap is claimed somewhere; find the truth on disk.
		actual, err := sha256File(d.cfg.AgentBinary)
		if err != nil {
			return fmt.Errorf("hash agent binary: %w", err)
		}
		target := j.NewSha256
		if target == "" {
			target = j.TargetSha256
		}
		if target != "" && actual == target {
			// A completed swap without its root record means the root-owned
			// journal vanished — never trust a mutation of unclear provenance.
			j.PostSwap = true
			return d.holdJob(ctx, j, "binary matches target build but root helper journal is missing")
		}
		if pendingExists {
			if j.RequiresReconcile {
				j.PostSwap = true
				return d.holdJob(ctx, j, "post-swap reconcile found pending request but no root record")
			}
			// Crash after journal save, before the helper ran.
			j.Phase = PhaseRestarting
			return d.journal.Save(j)
		}
		if resultApplied {
			// verify_failed is the one helper outcome that guarantees no
			// mutation happened; anything else without a journal is unclear.
			if res, err := ReadResult(d.cfg.StateDir, actionApply, j.JobID); err == nil && res != nil && res.Outcome == "verify_failed" {
				return d.failPreSwap(ctx, j, "helper refused apply: "+res.Detail)
			}
			j.PostSwap = true
			return d.holdJob(ctx, j, "helper result without root journal: unclear mutation")
		}
		if j.RequiresReconcile {
			j.PostSwap = true
			return d.holdJob(ctx, j, "post-swap reconcile found no records on disk")
		}
		// Crash inside the tiny window between the journal save and writing
		// the pending file: nothing was requested yet — request it now.
		j.Phase = PhaseRestarting
		return d.journal.Save(j)
	}

	actual, err := sha256File(d.cfg.AgentBinary)
	if err != nil {
		return fmt.Errorf("hash agent binary: %w", err)
	}

	switch {
	case actual == hj.NewSha256 && hj.Phase != hjRolledBack:
		// Swap happened; adopt post-swap truth.
		j.PostSwap = true
		j.OldSha256 = hj.OldSha256
		j.NewSha256 = hj.NewSha256
		if j.Phase == PhaseDownloading || j.Phase == PhaseVerifying || j.Phase == PhaseStaging {
			j.Phase = PhaseRestarting
			if err := d.journal.Save(j); err != nil {
				return err
			}
			if err := d.reportPhase(ctx, j, PhaseRestarting, ""); err != nil {
				return err
			}
		}
		return nil
	case actual == hj.OldSha256 && hj.Phase == hjIntent:
		return d.failPreSwap(ctx, j, "crash before rename; swap never occurred")
	case actual == hj.OldSha256 && hj.Phase == hjRolledBack:
		j.PostSwap = true
		j.Phase = PhaseRollingBack
		j.OldSha256 = hj.OldSha256
		j.NewSha256 = hj.NewSha256
		return d.journal.Save(j)
	default:
		j.PostSwap = true
		return d.holdJob(ctx, j, fmt.Sprintf(
			"binary sha256 matches neither new (%s) nor old (%s); manual intervention",
			j.NewSha256, j.OldSha256))
	}
}

// runPreSwap covers downloading → verifying → staging, then hands off to the
// privileged helper. Nothing privileged happens here.
func (d *Daemon) runPreSwap(ctx context.Context, j *Journal) error {
	staging := stagingDir(d.cfg.StateDir, j.JobID)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return fmt.Errorf("staging dir (disk full?): %w", err)
	}

	targetSha := j.TargetSha256
	if targetSha == "" {
		targetSha = j.ReleaseID
	}
	if targetSha == "" {
		return d.failPreSwap(ctx, j, "job carries no target sha256")
	}
	targetURL := j.TargetURL
	if targetURL == "" {
		targetURL = "/api/local-updater/jobs/" + j.JobID + "/artifact"
	}

	if j.Phase == PhaseDownloading {
		if err := d.reportPhase(ctx, j, PhaseDownloading, ""); err != nil {
			return err
		}
		dest := filepath.Join(staging, "artifact.bin")
		if cur, err := sha256File(dest); err == nil && targetSha != "" && cur == targetSha {
			d.logf("job %s: reuse already-downloaded artifact", j.JobID)
		} else {
			d.logf("job %s: downloading artifact", j.JobID)
			if _, err := DownloadBundledArtifact(ctx, d.cfg, d.dl, targetURL, targetSha, j.TargetSizeBytes, dest); err != nil {
				return fmt.Errorf("download (offline/full disk?): %w", err)
			}
		}
		j.Phase = PhaseVerifying
		if err := d.journal.Save(j); err != nil {
			return err
		}
	}

	if j.Phase == PhaseVerifying {
		if err := d.reportPhase(ctx, j, PhaseVerifying, ""); err != nil {
			return err
		}
		got, err := sha256File(filepath.Join(staging, "artifact.bin"))
		if err != nil {
			return fmt.Errorf("hash artifact: %w", err)
		}
		if targetSha != "" && got != targetSha {
			return d.failPreSwap(ctx, j, fmt.Sprintf("staged artifact sha %s != target %s", got, targetSha))
		}
		binPath := filepath.Join(staging, "artifact.bin")
		if err := os.Chmod(binPath, 0o755); err != nil {
			return d.failPreSwap(ctx, j, "staged artifact permissions: "+err.Error())
		}
		vctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		line, err := execStagedVersion(vctx, binPath)
		cancel()
		if err != nil {
			return d.failPreSwap(ctx, j, "staged -version: "+err.Error())
		}
		_, buildID, err := ParseVersionLine(line)
		if err != nil {
			return d.failPreSwap(ctx, j, err.Error())
		}
		if buildID != j.BuildID {
			return d.failPreSwap(ctx, j, fmt.Sprintf("staged buildId %s != job %s", buildID, j.BuildID))
		}
		j.Phase = PhaseStaging
		if err := d.journal.Save(j); err != nil {
			return err
		}
	}

	if j.Phase == PhaseStaging {
		if err := d.reportPhase(ctx, j, PhaseStaging, ""); err != nil {
			return err
		}
		metaBytes, err := json.Marshal(map[string]any{
			"jobId":   j.JobID,
			"buildId": j.BuildID,
			"sha256":  targetSha,
			"size":    j.TargetSizeBytes,
		})
		if err != nil {
			return err
		}
		if err := atomicWriteFile(filepath.Join(staging, "meta.json"), metaBytes, 0o644); err != nil {
			return fmt.Errorf("write staging meta: %w", err)
		}

		j.SwapRequested = true
		j.Phase = PhaseRestarting
		if err := d.journal.Save(j); err != nil {
			return err
		}
		if err := d.reportPhase(ctx, j, PhaseRestarting, ""); err != nil {
			return err
		}
		return d.runRestarting(ctx, j)
	}
	return nil
}

// runRestarting submits (or resumes) the privileged apply and consumes the
// helper result.
func (d *Daemon) runRestarting(ctx context.Context, j *Journal) error {
	res, err := d.ensureAction(ctx, actionApply, j.JobID)
	if err != nil {
		return err
	}
	switch res.Outcome {
	case "restarted", "already_current", "recovered_restarted":
		j.PostSwap = true
		if res.BinarySha256 != "" {
			j.NewSha256 = res.BinarySha256
		}
		j.Phase = PhaseAwaitingHB
		if err := d.journal.Save(j); err != nil {
			return err
		}
		if err := d.reportPhase(ctx, j, PhaseAwaitingHB, ""); err != nil {
			return err
		}
		return d.awaitHeartbeat(ctx, j)

	case "recovered_no_swap":
		return d.failPreSwap(ctx, j, "helper confirmed the swap never happened")

	case "auto_rolled_back":
		j.PostSwap = true
		return d.reportAndObserve(ctx, j, "rolled_back",
			"agent service failed to start after swap; helper restored the backup")

	case "restart_failed_rollback_failed":
		j.PostSwap = true
		return d.holdJob(ctx, j, "restart failed and rollback could not be verified: "+res.Detail)

	case "verify_failed":
		return d.failPreSwap(ctx, j, "helper verification failed: "+res.Detail)

	case "unclear":
		j.PostSwap = true
		return d.holdJob(ctx, j, "helper reported unclear mutation: "+res.Detail)

	default:
		return fmt.Errorf("unexpected helper apply outcome %q (%s)", res.Outcome, res.Detail)
	}
}

// awaitHeartbeat polls the server ruling with 15s GETs until terminal, a
// dead service, or the grace deadline forces a rollback request.
func (d *Daemon) awaitHeartbeat(ctx context.Context, j *Journal) error {
	graceBase := j.BaselineHBAt
	if graceBase.IsZero() {
		graceBase = time.Now().UTC()
		j.BaselineHBAt = graceBase
		if err := d.journal.Save(j); err != nil {
			return err
		}
	}
	graceDeadline := graceBase.Add(d.cfg.AwaitHeartbeatGrace)

	for {
		job, err := d.api.Get(ctx, j.JobID)
		if err == nil && job != nil {
			if terminal, ok := job.terminal(); ok {
				return d.consumeWithRuling(ctx, j, terminal)
			}
			if job.FencingToken != j.FencingToken {
				// Server re-leased; adopt its token for future reports.
				j.FencingToken = job.FencingToken
				if err := d.journal.Save(j); err != nil {
					return err
				}
			}
			if time.Now().After(graceDeadline) {
				return d.startRollback(ctx, j, "target heartbeat not observed before grace deadline")
			}
		} else if err != nil {
			// Offline: never roll back a healthy agent because the updater
			// lost sight of the server — the server has its own deadline.
			d.logf("job %s: heartbeat poll failed (offline?): %v", j.JobID, err)
		}

		active, detail := runIsActive(ctx, d.cfg)
		if !active {
			return d.startRollback(ctx, j, "agent service not active after restart: "+detail)
		}

		if err := sleepCtx(ctx, d.cfg.HeartbeatInterval); err != nil {
			return nil
		}
	}
}

// startRollback enters the rolling_back phase and requests the root restore.
func (d *Daemon) startRollback(ctx context.Context, j *Journal, reason string) error {
	d.logf("job %s: rollback requested: %s", j.JobID, reason)
	j.Phase = PhaseRollingBack
	if err := d.journal.Save(j); err != nil {
		return err
	}
	if err := d.reportPhase(ctx, j, PhaseRollingBack, reason); err != nil {
		return err
	}
	return d.runRollingBack(ctx, j)
}

func (d *Daemon) runRollingBack(ctx context.Context, j *Journal) error {
	res, err := d.ensureAction(ctx, actionRollback, j.JobID)
	if err != nil {
		return err
	}
	switch res.Outcome {
	case "rolled_back":
		return d.reportAndObserve(ctx, j, "rolled_back", "backup restored and service verified")
	case "rollback_failed":
		j.PostSwap = true
		return d.holdJob(ctx, j, "rollback failed: "+res.Detail)
	default:
		// A rollback was requested at all: the swap definitely happened.
		j.PostSwap = true
		return d.holdJob(ctx, j, fmt.Sprintf("unexpected rollback outcome %q: %s", res.Outcome, res.Detail))
	}
}

// reportAndObserve posts our verdict, then follows the server's ruling.
func (d *Daemon) reportAndObserve(ctx context.Context, j *Journal, outcome, reason string) error {
	if !j.ReportedToServer {
		_, awaitHB, err := d.api.Result(ctx, j.JobID, j.FencingToken, outcome, j.BuildID, reason)
		if errors.Is(err, ErrStaleLease) && !j.PostSwap {
			// Pre-swap: re-claim to obtain a fresh fencing token, retry once.
			if fresh, cerr := d.api.Claim(ctx); cerr == nil && fresh != nil && fresh.JobID == j.JobID {
				j.FencingToken = fresh.FencingToken
				_, awaitHB, err = d.api.Result(ctx, j.JobID, j.FencingToken, outcome, j.BuildID, reason)
			}
		}
		if errors.Is(err, ErrJobTerminal) {
			j.ReportedToServer = true
			if serr := d.journal.Save(j); serr != nil {
				return serr
			}
			return d.observeRuling(ctx, j)
		}
		if err != nil {
			if errors.Is(err, ErrStaleLease) && j.PostSwap {
				return d.holdJob(ctx, j, "stale lease after swap — halting per contract")
			}
			return fmt.Errorf("report %s: %w", outcome, err)
		}
		j.Outcome = outcome
		j.Reason = reason
		j.ReportedToServer = true
		j.Phase = PhaseTerminal
		if err := d.journal.Save(j); err != nil {
			return err
		}
		d.logf("job %s: reported %s (awaitHeartbeat=%v)", j.JobID, outcome, awaitHB)
	}
	return d.observeRuling(ctx, j)
}

// observeRuling polls GET until the server's terminal state for this job is
// visible, then applies the backup-retention rules.
func (d *Daemon) observeRuling(ctx context.Context, j *Journal) error {
	for {
		job, err := d.api.Get(ctx, j.JobID)
		if err == nil && job != nil {
			if terminal, ok := job.terminal(); ok {
				return d.consumeWithRuling(ctx, j, terminal)
			}
		} else if err != nil {
			d.logf("job %s: waiting for server ruling (offline?): %v", j.JobID, err)
		}
		if err := sleepCtx(ctx, d.cfg.HeartbeatInterval); err != nil {
			return nil
		}
	}
}

// consumeWithRuling applies the retention contract:
//   - succeeded / rolled_back (server-ruled) → delete backup, consume job
//   - failed (pre-swap) → consume, no backup exists
//   - failed after a local post-swap phase → never clean up: the mutation is
//     unclear, so keep backup + journal and hold (rollback_unverified
//     semantics), regardless of how the server labeled it
//   - rollback_unverified → keep backup + journal, hold all further jobs
func (d *Daemon) consumeWithRuling(ctx context.Context, j *Journal, ruling string) error {
	switch ruling {
	case "succeeded", "rolled_back":
		d.logf("job %s: server ruling %s — cleaning up", j.JobID, ruling)
		if err := d.consume(ctx, j); err != nil {
			return err
		}
		return nil
	case "failed":
		if j.PostSwap {
			// Local evidence says the swap was requested or performed: a
			// server "failed" cannot prove the post-swap state safe to tear
			// down. Deleting the backup here would destroy the only rollback
			// source for an unclear mutation — retain everything and halt.
			return d.holdJob(ctx, j,
				"server ruled failed after a post-swap phase — retaining backup and journal")
		}
		d.logf("job %s: server ruling failed (pre-swap) — cleaning up", j.JobID)
		if err := d.consume(ctx, j); err != nil {
			return err
		}
		return nil
	case "rollback_unverified":
		j.Outcome = ruling
		j.Reason = "server ruled rollback_unverified; backup and journal retained"
		j.Hold = true
		j.Phase = PhaseTerminal
		if err := d.journal.Save(j); err != nil {
			return err
		}
		d.logf("job %s: server ruled rollback_unverified — backup retained, jobs halted", j.JobID)
		return nil
	default:
		return d.holdJob(ctx, j, "unknown terminal ruling "+ruling)
	}
}

// failPreSwap reports a pre-swap failure (no mutation happened).
func (d *Daemon) failPreSwap(ctx context.Context, j *Journal, reason string) error {
	d.logf("job %s: failing pre-swap: %s", j.JobID, reason)
	return d.reportAndObserve(ctx, j, "failed", reason)
}

// holdJob halts the machine without destroying evidence.
func (d *Daemon) holdJob(ctx context.Context, j *Journal, reason string) error {
	j.Hold = true
	j.Phase = PhaseTerminal
	if j.Outcome == "" {
		j.Outcome = "rollback_unverified"
	}
	j.Reason = reason
	if !j.ReportedToServer {
		if _, _, err := d.api.Result(ctx, j.JobID, j.FencingToken, j.Outcome, "", reason); err != nil &&
			!errors.Is(err, ErrJobTerminal) && !errors.Is(err, ErrStaleLease) {
			d.logf("job %s: hold report failed (will retry via ruling poll): %v", j.JobID, err)
		} else {
			j.ReportedToServer = true
		}
	}
	if err := d.journal.Save(j); err != nil {
		return err
	}
	d.logf("job %s: HALTED: %s", j.JobID, reason)
	return nil
}

// consume tears down local state after a ruled terminal outcome. Order
// matters: first stop every path-unit trigger for this job (its pending
// requests and staging) — a retained pending file would let the helper
// re-run apply/rollback against state the server already ruled on — then
// the privileged cleanup (backup + helper journal), then the job's own
// result files, journal last. Each step reruns idempotently; CleanupDone
// skips the privileged part on rerun.
func (d *Daemon) consume(ctx context.Context, j *Journal) error {
	// Stop the job's path-unit triggers first: a retained apply/rollback
	// request would let the helper re-run a job the server already ruled on.
	_ = os.Remove(pendingPath(d.cfg.StateDir, actionApply, j.JobID))
	_ = os.Remove(pendingPath(d.cfg.StateDir, actionRollback, j.JobID))
	_ = os.RemoveAll(stagingDir(d.cfg.StateDir, j.JobID))
	if !j.CleanupDone {
		res, err := d.ensureAction(ctx, actionCleanup, j.JobID)
		if err != nil {
			return fmt.Errorf("helper cleanup: %w", err)
		}
		if res.Outcome != "cleaned" {
			// Never finish consumption over a failed cleanup: the journal
			// must survive so the ruling (and the retained backup) can be
			// retried instead of silently orphaned.
			return fmt.Errorf("helper cleanup: %s: %s", res.Outcome, res.Detail)
		}
		j.CleanupDone = true
		if err := d.journal.Save(j); err != nil {
			return err
		}
	}
	// Torn down after the privileged step: the cleanup result must stay in
	// place until ensureAction reads it, and removing the job's own files
	// last also covers a helper run that was already in flight when the
	// ruling landed.
	_ = os.Remove(resultPath(d.cfg.StateDir, actionApply, j.JobID))
	_ = os.Remove(resultPath(d.cfg.StateDir, actionRollback, j.JobID))
	_ = os.Remove(resultPath(d.cfg.StateDir, actionCleanup, j.JobID))
	_ = os.Remove(pendingPath(d.cfg.StateDir, actionCleanup, j.JobID))
	if err := d.journal.Clear(); err != nil {
		return err
	}
	d.lastPhase = ""
	d.logf("job %s consumed", j.JobID)
	return nil
}

// reportPhase posts a phase change (only when it differs) and mirrors it into
// the journal so a crash resumes from a server-known phase.
func (d *Daemon) reportPhase(ctx context.Context, j *Journal, phase, message string) error {
	if d.lastPhase != phase {
		job, err := d.api.Progress(ctx, j.JobID, j.FencingToken, phase, nil, message)
		if errors.Is(err, ErrStaleLease) {
			if j.PostSwap {
				return d.holdJob(ctx, j, "stale lease after swap — halting per contract")
			}
			fresh, cerr := d.api.Claim(ctx)
			if cerr != nil || fresh == nil || fresh.JobID != j.JobID {
				return fmt.Errorf("stale lease and re-claim did not return job %s", j.JobID)
			}
			j.FencingToken = fresh.FencingToken
			if job, err = d.api.Progress(ctx, j.JobID, j.FencingToken, phase, nil, message); err != nil {
				return fmt.Errorf("progress %s: %w", phase, err)
			}
		} else if errors.Is(err, ErrJobTerminal) {
			// The server already ruled this job; follow its verdict instead
			// of mutating. observeRuling applies the retention rules.
			return d.observeRuling(ctx, j)
		} else if err != nil {
			// Offline: keep going; the phase report retries on the next
			// boundary and the server has its own deadlines.
			d.logf("job %s: progress %s not delivered: %v", j.JobID, phase, err)
			return nil
		}
		if job != nil && job.FencingToken != 0 && job.FencingToken != j.FencingToken {
			j.FencingToken = job.FencingToken
		}
		d.lastPhase = phase
	}
	return d.journal.Save(j)
}

// ensureAction submits a pending action to the root helper (idempotent:
// existing pending/result files are respected) and waits for its result.
func (d *Daemon) ensureAction(ctx context.Context, action, jobID string) (*HelperResult, error) {
	if res, err := ReadResult(d.cfg.StateDir, action, jobID); err == nil && res != nil {
		return res, nil
	}
	if !fileExists(pendingPath(d.cfg.StateDir, action, jobID)) {
		if err := os.MkdirAll(pendingDir(d.cfg.StateDir), 0o770); err != nil {
			return nil, fmt.Errorf("pending dir: %w", err)
		}
		if err := atomicWriteFile(pendingPath(d.cfg.StateDir, action, jobID),
			[]byte(fmt.Sprintf(`{"jobId":%q,"at":%q}`, jobID, time.Now().UTC().Format(time.RFC3339))), 0o644); err != nil {
			return nil, fmt.Errorf("write pending %s: %w", action, err)
		}
	}
	deadline := time.Now().Add(d.cfg.HelperTimeout)
	for time.Now().Before(deadline) {
		if err := sleepCtx(ctx, 300*time.Millisecond); err != nil {
			return nil, err
		}
		res, err := ReadResult(d.cfg.StateDir, action, jobID)
		if err != nil {
			return nil, err
		}
		if res != nil {
			d.logf("job %s: helper %s → %s", jobID, action, res.Outcome)
			return res, nil
		}
	}
	return nil, fmt.Errorf("helper %s for %s timed out after %s", action, jobID, d.cfg.HelperTimeout)
}


func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func lastResultDetail(stateDir, action, jobID string) string {
	if res, err := ReadResult(stateDir, action, jobID); err == nil && res != nil {
		return res.Detail
	}
	return "no result recorded"
}

// runIsActive reports whether the agent unit is active, using the injectable
// systemctl seam (unprivileged `is-active` works for any local user).
func runIsActive(ctx context.Context, cfg *Config) (bool, string) {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := runSystemctl(cctx, "is-active", cfg.AgentUnit)
	if err != nil {
		return false, out
	}
	return out == "active", out
}

// MarshalJob pretty-prints the journal for the status command.
func MarshalJob(j *Journal) string {
	raw, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return j.JobID
	}
	return string(raw)
}
