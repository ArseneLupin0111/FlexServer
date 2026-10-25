package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Journal phases tracked across crashes and reboots. Pre-swap phases may be
// retried; post-swap phases must be reconciled from on-disk facts, never
// re-executed blindly.
const (
	PhaseDownloading = "downloading"
	PhaseVerifying   = "verifying"
	PhaseStaging     = "staging"
	PhaseRestarting  = "restarting"
	PhaseAwaitingHB  = "awaiting_heartbeat"
	PhaseRollingBack = "rolling_back"
	PhaseTerminal    = "terminal"
)

// Journal is the durable, fsync'd record of the one in-flight job. Exactly one
// job may exist at a time; a global filesystem lock enforces that even across
// manual runs.
type Journal struct {
	JobID             string `json:"jobId"`
	FencingToken      int64  `json:"fencingToken"`
	RequiresReconcile bool   `json:"requiresReconcile,omitempty"`
	// Kind is the server-declared job kind ("update" default or "ai-install").
	// It decides whether first-install of AI components is permitted; it is
	// validated against the fail-closed allowlist on save.
	Kind             string    `json:"kind,omitempty"`
	ReleaseID        string    `json:"releaseId"`
	Version          string    `json:"version"`
	BuildID          string    `json:"buildId"`
	TargetSha256     string    `json:"targetSha256"`
	TargetURL        string    `json:"targetUrl,omitempty"`
	TargetSizeBytes  int64     `json:"targetSizeBytes,omitempty"`
	ManifestRaw      string    `json:"manifestRaw"`
	Phase            string    `json:"phase"`
	SwapRequested    bool      `json:"swapRequested"`
	PostSwap         bool      `json:"postSwap"`
	UpdaterUpgraded  bool      `json:"updaterUpgraded,omitempty"`
	OldSha256        string    `json:"oldSha256,omitempty"`
	NewSha256        string    `json:"newSha256,omitempty"`
	BaselineHBAt     time.Time `json:"baselineHeartbeatAt,omitempty"`
	Outcome          string    `json:"outcome,omitempty"` // succeeded|rolled_back|rollback_unverified|failed|deferred|superseded
	Reason           string    `json:"reason,omitempty"`
	ReportedToServer bool      `json:"reportedToServer"`
	CleanupDone      bool      `json:"cleanupDone"`
	Hold             bool      `json:"hold"` // halt other jobs (rollback_unverified / unclear mutation)
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// JournalStore persists the journal with write-temp + fsync + rename + fsync
// of the directory, so a crash never leaves a half-written record.
type JournalStore struct {
	path string
	// faultWrite, when set by tests, replaces the fsync'd write to simulate
	// ENOSPC and friends on the durability-critical path.
	faultWrite func() error
}

// NewJournalStore returns the store rooted at stateDir/journal.json.
func NewJournalStore(stateDir string) *JournalStore {
	return &JournalStore{path: filepath.Join(stateDir, "journal.json")}
}

// Path returns the journal file path.
func (s *JournalStore) Path() string { return s.path }

// Load reads the journal; a missing file means no job in flight.
func (s *JournalStore) Load() (*Journal, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read journal: %w", err)
	}
	var j Journal
	if err := json.Unmarshal(raw, &j); err != nil {
		return nil, fmt.Errorf("corrupt journal %s: %w", s.path, err)
	}
	// Fail closed on a kind this binary does not implement: a resumed job of
	// unknown provenance must halt the daemon, never run as something else.
	if !KindIsSupported(j.Kind) {
		return nil, fmt.Errorf("journal %s carries unsupported job kind %q", s.path, j.Kind)
	}
	return &j, nil
}

// Save durably persists the journal. The record is written to a temp file in
// the same directory, fsync'd, renamed over the journal, and the directory is
// fsync'd so the rename itself is durable.
func (s *JournalStore) Save(j *Journal) error {
	j.UpdatedAt = time.Now().UTC()
	if err := j.Validate(); err != nil {
		return err
	}
	if s.faultWrite != nil {
		if err := s.faultWrite(); err != nil {
			return fmt.Errorf("journal write (injected fault): %w", err)
		}
	}
	raw, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(s.path, raw, 0o600)
}

// Clear removes the journal durably (after terminal cleanup).
func (s *JournalStore) Clear() error {
	if s.faultWrite != nil {
		if err := s.faultWrite(); err != nil {
			return fmt.Errorf("journal clear (injected fault): %w", err)
		}
	}
	if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return fsyncDir(filepath.Dir(s.path))
}

// Validate enforces single-job and phase invariants.
func (j *Journal) Validate() error {
	if j.JobID == "" {
		return fmt.Errorf("journal has no jobId")
	}
	if !jobIDRe.MatchString(j.JobID) {
		return fmt.Errorf("journal jobId %q has invalid charset", j.JobID)
	}
	if !KindIsSupported(j.Kind) {
		return fmt.Errorf("journal job kind %q is not supported by this updater", j.Kind)
	}
	if j.Phase == "" {
		return fmt.Errorf("journal has no phase")
	}
	if j.PostSwap && j.Outcome == "" && j.Phase == PhaseTerminal {
		return fmt.Errorf("terminal post-swap journal without outcome")
	}
	return nil
}

// atomicWriteFile writes data to path atomically with fsync guarantees.
func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once renamed

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("fsync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename into place: %w", err)
	}
	return fsyncDir(dir)
}
