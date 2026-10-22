package applications

// Host-local operation exclusion. A shared, durable, per-scope lock registry
// is held in one file under the agent state directory: one JSON document per
// active lock keyed by scope, guarding against concurrent mutation by the
// Compose worker, the legacy container command worker and future writers.
//
// Scope keys (bounded):
//   project:<vps|epoch|project>  — whole Compose project on this daemon
//   container:<key>              — exact opaque container identity
//
// Correctness: acquisition is atomic (single read-modify-write under an
// OS-level file lock), and every holder records the NsUnix monotonic time of
// grant plus the owning worker identity. Crashes clear rows only via
// explicit reconcile: no lock expiry ever re-runs a blind mutation.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	LockScopeProject   = "project"
	LockScopeContainer = "container"
	LockScopeUpgrade   = "system:upgrade"
	MaxLockSeconds     = 3600 // bounded upper life for any holder record
	defaultLockTTL     = 900  // non-mutating observation TTL; never re-executes
	RecheckLockSeconds = 600
)

// LockHolder identifies which in-process worker owns a scope right now.
type LockHolder struct {
	// Kind: compose-operation | container-command | recheck | updater-helper | host-pty | ai-host-helper
	Kind string `json:"kind"`
	// ID is the durable operation or command receipt identity.
	ID string `json:"id"`
	// GrantedAtUnix is the monotonic grant timestamp.
	GrantedAtUnix int64 `json:"grantedAtUnix"`
	// PID is the OS process ID of the holder (for stale activity cleanup).
	PID int `json:"pid,omitempty"`
	// ProcessStartTime is the monotonic start time of the holder process.
	ProcessStartTime int64 `json:"processStartTime,omitempty"`
}

// LockRow is one held exclusion scope.
type LockRow struct {
	Scope  string     `json:"scope"`
	Holder LockHolder `json:"holder"`
	// ExpiresAtUnix bounds a non-mutating row; mutating rows require the
	// explicit owner receipt to clear (never TTL-driven).
	ExpiresAtUnix int64 `json:"expiresAtUnix,omitempty"`
	// Mutating flags that the holder has begun a resource-level change.
	Mutating bool `json:"mutating"`
}

type lockStore struct {
	path string
	mu   sync.Mutex
}

var (
	lockRegistryOnce      sync.Once
	lockRegistry          *lockStore
	lockRegistryErr       error
	storesMu              sync.Mutex
	stores                = make(map[string]*lockStore)
	procStartTimeOverride func(pid int) (int64, error)
	procAliveOverride     func(pid int, startTime int64) (bool, bool)
)

// CurrentProcessStartTime returns the OS-specific start time identity of the current process.
func CurrentProcessStartTime() int64 {
	return currentProcessStartTime()
}

// IsProcessAlive reports whether the process with the given PID is running and matches recordedStartTime.
func IsProcessAlive(pid int, recordedStartTime int64) bool {
	return isProcessAlive(pid, recordedStartTime)
}

// SetProcessLivenessHook installs a test hook for process liveness checks.
func SetProcessLivenessHook(hook func(pid int, startTime int64) (bool, bool)) func() {
	procAliveOverride = hook
	return func() {
		procAliveOverride = nil
	}
}

// SetProcessStartTimeHook installs a test hook for process start time checks.
func SetProcessStartTimeHook(hook func(pid int) (int64, error)) func() {
	procStartTimeOverride = hook
	return func() {
		procStartTimeOverride = nil
	}
}

func getLockStore(path string) *lockStore {
	storesMu.Lock()
	defer storesMu.Unlock()
	clean := filepath.Clean(path)
	s, ok := stores[clean]
	if !ok {
		s = &lockStore{path: clean}
		stores[clean] = s
	}
	return s
}

func resolveLockPath(stateDir string) (string, error) {
	if stateDir == "" {
		return lockStorePath()
	}
	var target string
	clean := filepath.Clean(stateDir)
	if strings.HasSuffix(clean, ".json") {
		target = clean
	} else if filepath.Base(clean) == "docker-applications" {
		target = filepath.Join(clean, "exclusion.json")
	} else {
		target = filepath.Join(clean, "docker-applications", "exclusion.json")
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("applications: mkdir exclusion dir: %w", err)
	}
	return target, nil
}

// DefaultLockPath returns the shared exclusion registry inside the agent
// state/base directory (created on first use, 0700).
func DefaultLockPath() (string, error) {
	return lockStorePath()
}

func lockStorePath() (string, error) {
	lockRegistryOnce.Do(func() {
		base := os.Getenv("FLEXSERVER_AGENT_STATE_DIR")
		if base == "" {
			home := os.Getenv("HOME")
			if home == "" {
				home = os.Getenv("USERPROFILE")
			}
			if home != "" {
				base = filepath.Join(home, ".flexserver", "agent")
			}
		}
		if base == "" {
			lockRegistryErr = fmt.Errorf("applications: no state dir")
			return
		}
		dir := filepath.Join(base, "docker-applications")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			lockRegistryErr = err
			return
		}
		lockRegistry = &lockStore{path: filepath.Join(dir, "exclusion.json")}
	})
	if lockRegistry == nil {
		return "", lockRegistryErr
	}
	return lockRegistry.path, nil
}

// AcquireHostScope acquires the shared host-local fence using the default configured state dir.
func AcquireHostScope(scope, holderKind, holderID string, mutating bool, ttl time.Duration) error {
	return AcquireHostScopeAt("", scope, holderKind, holderID, mutating, ttl)
}

// AcquireHostScopeAt acquires the shared host-local fence at an explicit state directory.
func AcquireHostScopeAt(stateDir, scope, holderKind, holderID string, mutating bool, ttl time.Duration) error {
	if !safeMetadata(scope, 512) || !safeMetadata(holderKind, 64) || !safeMetadata(holderID, 128) || ttl < 0 || ttl > time.Duration(MaxLockSeconds)*time.Second {
		return fmt.Errorf("invalid_lock_scope")
	}
	return acquireScopeAt(stateDir, scope, holderKind, holderID, mutating, ttl)
}

// MarkHostScopeMutating permanently pins a host fence until its owner records a terminal receipt.
func MarkHostScopeMutating(scope, holderKind, holderID string) error {
	return MarkHostScopeMutatingAt("", scope, holderKind, holderID)
}

// MarkHostScopeMutatingAt permanently pins a host fence at an explicit state dir.
func MarkHostScopeMutatingAt(stateDir, scope, holderKind, holderID string) error {
	if !safeMetadata(scope, 512) || !safeMetadata(holderKind, 64) || !safeMetadata(holderID, 128) {
		return fmt.Errorf("invalid_lock_scope")
	}
	return markMutatingAt(stateDir, scope, holderKind, holderID)
}

// ReleaseHostScope clears only the exact matching holder's fence using the default state dir.
func ReleaseHostScope(scope, holderKind, holderID string) error {
	return ReleaseHostScopeAt("", scope, holderKind, holderID)
}

// ReleaseHostScopeAt clears only the exact matching holder's fence at an explicit state dir.
func ReleaseHostScopeAt(stateDir, scope, holderKind, holderID string) error {
	if !safeMetadata(scope, 512) || !safeMetadata(holderKind, 64) || !safeMetadata(holderID, 128) {
		return fmt.Errorf("invalid_lock_scope")
	}
	return releaseScopeAt(stateDir, scope, holderKind, holderID)
}

func acquireScope(scope, holderKind, holderID string, mutating bool, ttl time.Duration) error {
	return acquireScopeAt("", scope, holderKind, holderID, mutating, ttl)
}

func acquireScopeAt(stateDir, scope, holderKind, holderID string, mutating bool, ttl time.Duration) error {
	path, err := resolveLockPath(stateDir)
	if err != nil {
		return err
	}
	store := getLockStore(path)
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.mutate(path, func(rows []LockRow) ([]LockRow, error) {
		now := time.Now().Unix()
		pid := os.Getpid()
		startTime := CurrentProcessStartTime()

		// 1. Reconcile active rows: prune expired non-mutating rows and dead-PID activity rows
		active := rows[:0]
		for _, row := range rows {
			// Expired non-mutating rows are pruned by TTL
			if !row.Mutating && row.ExpiresAtUnix > 0 && row.ExpiresAtUnix < now {
				continue
			}
			// Stale activity cleanup:
			// 1. system:upgrade is NOT pruned by PID (updater helper journal recovery owns its removal).
			// 2. terminal:* and ai:* activity rows (even mutating) MUST be pruned when their recorded owner PID
			//    is dead or has recycled start-time, so a killed terminal or AI process does not permanently block updates.
			// 3. For project:* and container:* scopes, mutating rows preserve crash recovery semantics
			//    (blocked until explicit reconcile), while non-mutating rows are pruned if the holder is dead.
			isEphemeralActivity := strings.HasPrefix(row.Scope, "terminal:") || strings.HasPrefix(row.Scope, "ai:")
			if row.Scope != LockScopeUpgrade && row.Holder.PID > 0 {
				if isEphemeralActivity || !row.Mutating {
					if !IsProcessAlive(row.Holder.PID, row.Holder.ProcessStartTime) {
						continue // holder process died without releasing; safe to prune
					}
				}
			}
			active = append(active, row)
		}
		rows = active

		// 2. Check mutual exclusion and exact owner reentry
		if scope == LockScopeUpgrade {
			// system:upgrade mutual exclusion with EVERY active scope
			for i := range rows {
				if rows[i].Scope == LockScopeUpgrade && rows[i].Holder.ID == holderID && rows[i].Holder.Kind == holderKind {
					// Exact owner reentry
					rows[i].Holder.GrantedAtUnix = now
					rows[i].Holder.PID = pid
					rows[i].Holder.ProcessStartTime = startTime
					rows[i].Mutating = rows[i].Mutating || mutating
					if rows[i].Mutating {
						rows[i].ExpiresAtUnix = 0
					} else {
						rows[i].ExpiresAtUnix = now + int64(ttl.Seconds())
					}
					return rows, nil
				}
				// Any active row (whether another scope or different upgrade holder) conflicts
				return rows, fmt.Errorf("scope_busy:%s:%s", rows[i].Holder.Kind, rows[i].Holder.ID)
			}
			// Admitted
			expiresAt := int64(0)
			if !mutating && ttl > 0 {
				expiresAt = now + int64(ttl.Seconds())
			}
			return append(rows, LockRow{
				Scope:         LockScopeUpgrade,
				Holder:        LockHolder{Kind: holderKind, ID: holderID, GrantedAtUnix: now, PID: pid, ProcessStartTime: startTime},
				Mutating:      mutating,
				ExpiresAtUnix: expiresAt,
			}), nil
		}

		// Ordinary scope: cannot be acquired if system:upgrade is active
		for i := range rows {
			if rows[i].Scope == LockScopeUpgrade {
				return rows, fmt.Errorf("scope_busy:%s:%s", rows[i].Holder.Kind, rows[i].Holder.ID)
			}
			if rows[i].Scope == scope {
				if rows[i].Holder.ID == holderID && rows[i].Holder.Kind == holderKind {
					// Exact owner reentry
					rows[i].Holder.GrantedAtUnix = now
					rows[i].Holder.PID = pid
					rows[i].Holder.ProcessStartTime = startTime
					rows[i].Mutating = rows[i].Mutating || mutating
					if rows[i].Mutating {
						rows[i].ExpiresAtUnix = 0
					} else {
						rows[i].ExpiresAtUnix = now + int64(ttl.Seconds())
					}
					return rows, nil
				}
				return rows, fmt.Errorf("scope_busy:%s:%s", rows[i].Holder.Kind, rows[i].Holder.ID)
			}
		}

		// Admitted
		expiresAt := int64(0)
		if !mutating && ttl > 0 {
			expiresAt = now + int64(ttl.Seconds())
		}
		return append(rows, LockRow{
			Scope:         scope,
			Holder:        LockHolder{Kind: holderKind, ID: holderID, GrantedAtUnix: now, PID: pid, ProcessStartTime: startTime},
			Mutating:      mutating,
			ExpiresAtUnix: expiresAt,
		}), nil
	})
}

func releaseScope(scope, kind, id string) error {
	return releaseScopeAt("", scope, kind, id)
}

func releaseScopeAt(stateDir, scope, kind, id string) error {
	path, err := resolveLockPath(stateDir)
	if err != nil {
		return err
	}
	store := getLockStore(path)
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.mutate(path, func(rows []LockRow) ([]LockRow, error) {
		kept := make([]LockRow, 0, len(rows))
		for _, r := range rows {
			if r.Scope == scope && r.Holder.Kind == kind && r.Holder.ID == id {
				continue
			}
			kept = append(kept, r)
		}
		return kept, nil
	})
}

func markMutating(scope, kind, id string) error {
	return markMutatingAt("", scope, kind, id)
}

func markMutatingAt(stateDir, scope, kind, id string) error {
	path, err := resolveLockPath(stateDir)
	if err != nil {
		return err
	}
	store := getLockStore(path)
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.mutate(path, func(rows []LockRow) ([]LockRow, error) {
		found := false
		for i, r := range rows {
			if r.Scope == scope && r.Holder.Kind == kind && r.Holder.ID == id {
				rows[i].Mutating = true
				rows[i].ExpiresAtUnix = 0
				found = true
			}
		}
		if !found {
			return rows, fmt.Errorf("no_holder")
		}
		return rows, nil
	})
}

// mutate rewrites the JSON document atomically. Reads and writes are
// protected by the registry mutex plus an OS advisory file lock so two
// processes never race the same file.
func (s *lockStore) mutate(path string, fn func(rows []LockRow) ([]LockRow, error)) error {
	releaseProcessLock, err := acquireProcessFileLock(path)
	if err != nil {
		return err
	}
	defer releaseProcessLock()
	if fi, err := os.Lstat(path); err == nil && (fi.Mode()&os.ModeSymlink != 0) {
		return fmt.Errorf("applications: symlink not allowed for exclusion registry: %s", path)
	}
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("applications: read exclusion registry: %w", err)
	}
	var rows []LockRow
	if err == nil && len(b) > 0 {
		if json.Unmarshal(b, &rows) != nil {
			return fmt.Errorf("applications: corrupt exclusion registry preserved")
		}
	}
	rows, err = fn(rows)
	if err != nil {
		return err
	}
	// The cap bounds the persisted document, so it must gate the mutation's
	// result: a full registry must reject an additional row, not admit it
	// and only trip on the next acquire.
	if len(rows) > 256 {
		return fmt.Errorf("applications: exclusion registry cap exceeded")
	}
	buf := &bytes.Buffer{}
	enc := json.NewEncoder(buf)
	if err := enc.Encode(rows); err != nil {
		return err
	}
	targetMode := os.FileMode(0o664)
	targetGID := -1
	if fi, err := os.Stat(path); err == nil {
		targetMode = fi.Mode().Perm()
		targetGID = getFileGID(fi)
	} else if dirFi, err := os.Stat(filepath.Dir(path)); err == nil {
		targetGID = getFileGID(dirFi)
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), ".excl-")
	if err != nil {
		return writeRegistryInPlace(path, buf.Bytes(), targetMode, targetGID)
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(targetMode); err != nil {
		tmp.Close()
		return err
	}
	if os.Geteuid() == 0 && targetGID >= 0 {
		_ = os.Chown(name, -1, targetGID)
	}
	if _, err := tmp.Write(buf.Bytes()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return writeRegistryInPlace(path, buf.Bytes(), targetMode, targetGID)
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return nil
	}
	defer dir.Close()
	return dir.Sync()
}

func writeRegistryInPlace(path string, data []byte, mode os.FileMode, targetGID int) error {
	f, err := openRegistryFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return fmt.Errorf("applications: write exclusion registry: %w", err)
	}
	defer f.Close()
	if os.Geteuid() == 0 && targetGID >= 0 {
		_ = os.Chown(path, -1, targetGID)
	}
	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("applications: write exclusion registry data: %w", err)
	}
	return f.Sync()
}
