package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	ErrReceiptReplayDenied = errors.New("cannot replay command: terminal or executing receipt exists")
	ErrReceiptNotFound     = errors.New("receipt not found")
	ErrInvalidStateChange  = errors.New("invalid receipt state transition")
)

// ReceiptStore persists command receipts with atomic writes and durable fsyncs.
type ReceiptStore interface {
	Load(commandID string) (*Receipt, error)
	ListPending() ([]*Receipt, error)
	Persist(r *Receipt) error
	Transition(commandID string, fromState, toState string, mutate func(r *Receipt)) (*Receipt, error)
}

// FileReceiptStore implements ReceiptStore by writing each receipt to a JSON file
// in a designated directory using atomic write-to-temp-and-rename with directory fsync.
type FileReceiptStore struct {
	dir string
	mu  sync.Mutex
}

// NewFileReceiptStore creates or initializes the receipts directory.
func NewFileReceiptStore(dir string) (*FileReceiptStore, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("creating receipts dir: %w", err)
	}
	return &FileReceiptStore{dir: dir}, nil
}

func (s *FileReceiptStore) receiptPath(commandID string) string {
	h := sha256.Sum256([]byte(commandID))
	hashPrefix := hex.EncodeToString(h[:8])
	safeID := filepath.Base(commandID)
	return filepath.Join(s.dir, fmt.Sprintf("receipt-%s-%s.json", hashPrefix, safeID))
}

// Load retrieves a receipt by command ID.
func (s *FileReceiptStore) Load(commandID string) (*Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.receiptPath(commandID)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrReceiptNotFound
		}
		return nil, fmt.Errorf("reading receipt: %w", err)
	}

	var r Receipt
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("corrupt receipt file: %w", err)
	}
	return &r, nil
}

// ListPending finds all receipts that are not yet in a completed terminal state.
// If a receipt is in "executing" state on startup, it represents an interrupted mutation
// and must be handled as "uncertain".
func (s *FileReceiptStore) ListPending() ([]*Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, fmt.Errorf("reading receipts dir: %w", err)
	}

	var pending []*Receipt
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(s.dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var r Receipt
		if err := json.Unmarshal(data, &r); err != nil {
			continue
		}
		if r.State == ReceiptClaimed || r.State == ReceiptExecuting || r.State == ReceiptUncertain {
			pending = append(pending, &r)
		}
	}
	return pending, nil
}

// Persist writes the receipt to disk with strict fsync before returning.
func (s *FileReceiptStore) Persist(r *Receipt) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.persistLocked(r)
}

func (s *FileReceiptStore) persistLocked(r *Receipt) error {
	path := s.receiptPath(r.CommandID)
	tempPath := fmt.Sprintf("%s.tmp.%d", path, time.Now().UnixNano())

	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal receipt: %w", err)
	}

	f, err := os.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("create temp receipt file: %w", err)
	}

	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tempPath)
		return fmt.Errorf("write receipt data: %w", err)
	}

	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tempPath)
		return fmt.Errorf("fsync receipt: %w", err)
	}

	if err := f.Close(); err != nil {
		os.Remove(tempPath)
		return fmt.Errorf("close receipt: %w", err)
	}

	if err := os.Rename(tempPath, path); err != nil {
		os.Remove(tempPath)
		return fmt.Errorf("atomic rename receipt: %w", err)
	}

	// fsync the directory to ensure rename is durable
	dirFile, err := os.Open(s.dir)
	if err == nil {
		_ = dirFile.Sync()
		_ = dirFile.Close()
	}

	return nil
}

// Transition performs an atomic state transition on a receipt.
func (s *FileReceiptStore) Transition(commandID string, fromState, toState string, mutate func(r *Receipt)) (*Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.receiptPath(commandID)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrReceiptNotFound
		}
		return nil, fmt.Errorf("reading receipt for transition: %w", err)
	}

	var r Receipt
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("unmarshal receipt: %w", err)
	}

	if fromState != "" && r.State != fromState {
		return nil, fmt.Errorf("%w: expected %q, got %q", ErrInvalidStateChange, fromState, r.State)
	}

	r.State = toState
	r.UpdatedAt = time.Now().UTC()
	if mutate != nil {
		mutate(&r)
	}

	if err := s.persistLocked(&r); err != nil {
		return nil, err
	}

	return &r, nil
}
