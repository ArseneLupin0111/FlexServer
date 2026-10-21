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
	"sync"
	"time"
)

const (
	LockScopeProject   = "project"
	LockScopeContainer = "container"
	MaxLockSeconds     = 3600 // bounded upper life for any holder record
	defaultLockTTL     = 900  // non-mutating observation TTL; never re-executes
	RecheckLockSeconds = 600
)

// LockHolder identifies which in-process worker owns a scope right now.
type LockHolder struct {
	// Kind: compose-operation | container-command | recheck
	Kind string `json:"kind"`
	// ID is the durable operation or command receipt identity.
	ID string `json:"id"`
	// GrantedAtUnix is the monotonic grant timestamp.
	GrantedAtUnix int64 `json:"grantedAtUnix"`
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
	lockRegistryOnce sync.Once
	lockRegistry     *lockStore
	lockRegistryErr  error
)

// DefaultLockPath returns the shared exclusion registry inside the agent
// state/base directory (created on first use, 0700).
func DefaultLockPath() (string, error) {
	return lockStorePath()
}

func lockStorePath() (string, error) {
	lockRegistryOnce.Do(func() {
		base := os.Getenv("FLEXSERVER_AGENT_STATE_DIR")
		if base == "" {
			base = filepath.Join(os.Getenv("HOME"), ".flexserver", "agent")
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

// AcquireHostScope acquires the shared host-local fence used by Compose and legacy container controls.
func AcquireHostScope(scope, holderKind, holderID string, mutating bool, ttl time.Duration) error {
	if !safeMetadata(scope, 512) || !safeMetadata(holderKind, 64) || !safeMetadata(holderID, 128) || ttl < 0 || ttl > time.Duration(MaxLockSeconds)*time.Second {
		return fmt.Errorf("invalid_lock_scope")
	}
	return acquireScope(scope, holderKind, holderID, mutating, ttl)
}

// MarkHostScopeMutating permanently pins a host fence until its owner records a terminal receipt.
func MarkHostScopeMutating(scope, holderKind, holderID string) error {
	return markMutating(scope, holderKind, holderID)
}

// ReleaseHostScope clears only the exact matching holder's fence.
func ReleaseHostScope(scope, holderKind, holderID string) error {
	return releaseScope(scope, holderKind, holderID)
}

// acquireScope atomically registers a scope entry; conflicting mutating rows
// or active container-command rows fail with a truthy busy error.
func acquireScope(scope, holderKind, holderID string, mutating bool, ttl time.Duration) error {
	path, err := lockStorePath()
	if err != nil {
		return err
	}
	lockRegistry.mu.Lock()
	defer lockRegistry.mu.Unlock()
	return lockRegistry.mutate(path, func(rows []LockRow) ([]LockRow, error) {
		now := time.Now().Unix()
		active := rows[:0]
		for _, row := range rows {
			if !row.Mutating && row.ExpiresAtUnix > 0 && row.ExpiresAtUnix < now {
				continue
			}
			active = append(active, row)
		}
		rows = active
		for i := range rows {
			if rows[i].Scope != scope {
				continue
			}
			if rows[i].Holder.ID == holderID && rows[i].Holder.Kind == holderKind {
				rows[i].Holder.GrantedAtUnix = now
				rows[i].Mutating = rows[i].Mutating || mutating
				rows[i].ExpiresAtUnix = now + int64(ttl.Seconds())
				return rows, nil
			}
			return rows, fmt.Errorf("scope_busy:%s:%s", rows[i].Holder.Kind, rows[i].Holder.ID)
		}
		return append(rows, LockRow{
			Scope:         scope,
			Holder:        LockHolder{Kind: holderKind, ID: holderID, GrantedAtUnix: now},
			Mutating:      mutating,
			ExpiresAtUnix: now + int64(ttl.Seconds()),
		}), nil
	})
}

// releaseScope removes only rows owned by (kind, id).
func releaseScope(scope, kind, id string) error {
	path, err := lockStorePath()
	if err != nil {
		return err
	}
	lockRegistry.mu.Lock()
	defer lockRegistry.mu.Unlock()
	return lockRegistry.mutate(path, func(rows []LockRow) ([]LockRow, error) {
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

// markMutating flips an existing row to mutating (irreversible without the
// owner receipt releasing it).
func markMutating(scope, kind, id string) error {
	path, err := lockStorePath()
	if err != nil {
		return err
	}
	lockRegistry.mu.Lock()
	defer lockRegistry.mu.Unlock()
	return lockRegistry.mutate(path, func(rows []LockRow) ([]LockRow, error) {
		found := false
		for i, r := range rows {
			if r.Scope == scope && r.Holder.Kind == kind && r.Holder.ID == id {
				rows[i].Mutating = true
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
	tmp, err := os.CreateTemp(filepath.Dir(path), ".excl-")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
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
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
