package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ReceiptStore is the durable single-pending-command record. Exactly one
// receipt may be pending: persist-before-execute, commit-only-on-matching
// report echo. Implementations must be crash-safe (atomic write) and fail
// closed on corruption (return error, preserve nothing phantom).
type ReceiptStore interface {
	GetReceipt() *Receipt
	PersistReceipt(Receipt) error
	CommitReceipt(commandID, agentInstanceID string) error
}

// TargetResolver maps an opaque containerKey to the full 64-char lowercase
// hex daemon ID. Production wires state.Store.ContainerKey inversion via a
// list-and-derive scan; tests inject a map. Unknown keys fail closed.
type TargetResolver func(containerKey string) (fullID string, ok bool)

// Commander is the claim/result transport surface (implemented by *Client).
type Commander interface {
	Claim(ctx context.Context, agentInstanceID string) (*Command, error)
	Report(ctx context.Context, r *Result) error
}

// MutationFence is the narrow shared host-local exclusion boundary. Scope
// must identify the exact daemon resource (the full container ID), not a
// display name or label. Acquisition is idempotent for ownerID so a pending
// receipt can recover after restart. Release is called only after the
// terminal report is acknowledged; uncertain receipts retain the fence.
type MutationFence interface {
	Acquire(ctx context.Context, scope, ownerID string) error
	MarkMutating(ctx context.Context, scope, ownerID string) error
	Release(ctx context.Context, scope, ownerID string) error
}

// Controller is the daemon POST surface (implemented by *DockerControl).
type Controller interface {
	Act(ctx context.Context, action, fullID string, tty bool) ActResult
}
// Worker executes at most one command at a time with report-only retry:
// a receipt with Executed=true (including every uncertain receipt) is never
// re-executed, only re-reported.
type Worker struct {
	instanceID string
	vpsID      string
	transport  Commander
	control    Controller
	store      ReceiptStore
	resolve    TargetResolver
	fence      MutationFence
	now        func() time.Time
}

// SetMutationFence installs the shared host-local exclusion adapter.
func (w *Worker) SetMutationFence(f MutationFence) { w.fence = f }

// NewWorker builds a worker. All deps required except now (defaults to time.Now).
func NewWorker(instanceID, vpsID string, t Commander, c Controller, s ReceiptStore, r TargetResolver) (*Worker, error) {
	if !validSafeID(instanceID, MaxInstanceIDLen) {
		return nil, fmt.Errorf("bad agentInstanceId")
	}
	if t == nil || c == nil || s == nil || r == nil {
		return nil, fmt.Errorf("nil worker dependency")
	}
	return &Worker{instanceID: instanceID, vpsID: vpsID, transport: t, control: c, store: s, resolve: r, now: time.Now}, nil
}

// SetNowFunc overrides the clock (tests).
func (w *Worker) SetNowFunc(fn func() time.Time) {
	if fn != nil {
		w.now = fn
	}
}

// ProcessOne runs a single command cycle: resume pending (report-only when
// terminal/executed) or claim new. Metrics collection is untouched.
func (w *Worker) ProcessOne(ctx context.Context) error {
	if pending := w.store.GetReceipt(); pending != nil {
		return w.resume(ctx, pending)
	}
	cmd, err := w.transport.Claim(ctx, w.instanceID)
	if err != nil {
		return err
	}
	if cmd == nil {
		return nil
	}
	return w.start(ctx, cmd)
}

func (w *Worker) resume(ctx context.Context, p *Receipt) error {
	if err := ValidateReceipt(p); err != nil {
		// Corrupt durable receipt: fail closed, never act.
		log.Printf("commands: pending %q corrupt (%v), preserved", p.CommandID, err)
		return fmt.Errorf("commands: pending corrupt: %w", err)
	}
	if p.AgentInstanceID != w.instanceID {
		log.Printf("commands: pending %q identity mismatch, preserved", p.CommandID)
		return fmt.Errorf("commands: identity mismatch")
	}
	switch p.State {
	case ReceiptSucceeded, ReceiptFailed, ReceiptUncertain:
		return w.reportTerminal(ctx, p)
	case ReceiptClaimed, ReceiptExecuting:
		if p.Executed {
			// Executed but non-terminal (crash between act and persist):
			// outcome unknown → uncertain, report-only.
			unc := *p
			unc.State = ReceiptUncertain
			unc.Executed = true
			if unc.ErrorCode == "" {
				unc.ErrorCode = ErrCodeUncertainOutcome
			}
			if err := ValidateReceipt(&unc); err != nil {
				return fmt.Errorf("commands: uncertain promotion invalid: %w", err)
			}
			if err := w.store.PersistReceipt(unc); err != nil {
				return fmt.Errorf("commands: persist uncertain: %w", err)
			}
			return w.reportTerminal(ctx, &unc)
		}
		return w.execute(ctx, p)
	default:
		return fmt.Errorf("commands: unsupported receipt state")
	}
}

func (w *Worker) start(ctx context.Context, cmd *Command) error {
	if err := ValidateCommand(cmd); err != nil {
		return fmt.Errorf("commands: claim invalid: %w", err)
	}
	if cmd.AgentInstanceID != w.instanceID {
		return fmt.Errorf("commands: claim instance mismatch: fail closed")
	}
	if w.vpsID != "" && cmd.VpsID != "" && cmd.VpsID != w.vpsID {
		// Cross-instance/vps rejection without executing.
		rec := Receipt{
			CommandID: cmd.CommandID, AgentInstanceID: cmd.AgentInstanceID,
			Action: cmd.Action, ContainerKey: cmd.ContainerKey,
			DeadlineNano: cmd.DeadlineNano, TimeoutSeconds: cmd.TimeoutSeconds, TTY: cmd.TTY,
			State: ReceiptFailed, Executed: false, ErrorCode: ErrCodeIdentityMismatch,
		}
		if err := w.store.PersistReceipt(rec); err != nil {
			return fmt.Errorf("commands: persist identity-mismatch: %w", err)
		}
		return w.reportTerminal(ctx, &rec)
	}
	if w.expired(cmd.DeadlineNano) {
		rec := Receipt{
			CommandID: cmd.CommandID, AgentInstanceID: cmd.AgentInstanceID,
			Action: cmd.Action, ContainerKey: cmd.ContainerKey,
			DeadlineNano: cmd.DeadlineNano, TimeoutSeconds: cmd.TimeoutSeconds, TTY: cmd.TTY,
			State: ReceiptFailed, Executed: false, ErrorCode: ErrCodeDeadlineExceeded,
		}
		if err := w.store.PersistReceipt(rec); err != nil {
			return fmt.Errorf("commands: persist expired: %w", err)
		}
		return w.reportTerminal(ctx, &rec)
	}
	rec := Receipt{
		CommandID: cmd.CommandID, AgentInstanceID: cmd.AgentInstanceID,
		Action: cmd.Action, ContainerKey: cmd.ContainerKey,
		DeadlineNano: cmd.DeadlineNano, TimeoutSeconds: cmd.TimeoutSeconds, TTY: cmd.TTY,
		State: ReceiptClaimed, Executed: false,
	}
	if err := ValidateReceipt(&rec); err != nil {
		return fmt.Errorf("commands: receipt invalid: %w", err)
	}
	// Persist-before-execute: crash here replays execute exactly once.
	if err := w.store.PersistReceipt(rec); err != nil {
		return fmt.Errorf("commands: persist claimed: %w", err)
	}
	return w.execute(ctx, &rec)
}

// execute resolves the target, enforces the deadline, performs exactly one
// daemon POST, persists the terminal receipt before reporting, and reports.
func (w *Worker) execute(ctx context.Context, rec *Receipt) error {
	if err := ValidateAction(rec.Action); err != nil {
		return w.failClosed(ctx, rec, ErrCodeUnsupportedAction)
	}
	fullID, ok := w.resolve(rec.ContainerKey)
	if !ok || !isRawContainerID(fullID) {
		return w.failClosed(ctx, rec, ErrCodeTargetMismatch)
	}
	if w.expired(rec.DeadlineNano) {
		return w.failClosed(ctx, rec, ErrCodeDeadlineExceeded)
	}
	scope := "container:" + fullID
	if w.fence != nil {
		if err := w.fence.Acquire(ctx, scope, rec.CommandID); err != nil {
			return w.failClosed(ctx, rec, ErrCodeTargetBusy)
		}
	}
	execCtx, cancel := w.execContext(ctx, rec)
	defer cancel()
	// Persist exact scope and the no-replay marker before daemon mutation;
	// any crash from here reports uncertain and keeps the scope fenced.
	mark := *rec
	mark.FenceScope = scope
	mark.State = ReceiptExecuting
	mark.Executed = true
	if err := w.store.PersistReceipt(mark); err != nil {
		return fmt.Errorf("commands: persist executing: %w", err)
	}
	rec.FenceScope = scope
	rec.Executed = true
	if w.fence != nil {
		if err := w.fence.MarkMutating(ctx, scope, rec.CommandID); err != nil {
			return w.failClosed(ctx, rec, ErrCodeTargetBusy)
		}
	}
	out := w.control.Act(execCtx, rec.Action, fullID, rec.TTY)
	terminal := *rec
	terminal.Executed = out.Executed
	terminal.OutputPreview = out.Preview
	switch {
	case out.Uncertain:
		terminal.State = ReceiptUncertain
		terminal.ErrorCode = out.ErrorCode
		if terminal.ErrorCode == "" {
			terminal.ErrorCode = ErrCodeUncertainOutcome
		}
	case out.ErrorCode == "":
		terminal.State = ReceiptSucceeded
		terminal.ErrorCode = ""
	default:
		terminal.State = ReceiptFailed
		terminal.ErrorCode = out.ErrorCode
	}
	if err := ValidateReceipt(&terminal); err != nil {
		// Daemon output broke bounds (should be impossible: decoder caps).
		// Fail closed to uncertain, executed, no preview.
		terminal.OutputPreview = ""
		terminal.State = ReceiptUncertain
		terminal.Executed = true
		terminal.ErrorCode = ErrCodeUncertainOutcome
		if err2 := ValidateReceipt(&terminal); err2 != nil {
			return fmt.Errorf("commands: terminal invalid: %w", err2)
		}
	}
	// Persist terminal before report: crash here resumes report-only.
	if err := w.store.PersistReceipt(terminal); err != nil {
		return fmt.Errorf("commands: persist terminal: %w", err)
	}
	return w.reportTerminal(ctx, &terminal)
}

// failClosed persists a non-executed terminal failure and reports it.
func (w *Worker) failClosed(ctx context.Context, rec *Receipt, code string) error {
	terminal := *rec
	terminal.State = ReceiptFailed
	terminal.Executed = false
	terminal.ErrorCode = code
	terminal.OutputPreview = ""
	if err := ValidateReceipt(&terminal); err != nil {
		return fmt.Errorf("commands: fail-closed invalid: %w", err)
	}
	if err := w.store.PersistReceipt(terminal); err != nil {
		return fmt.Errorf("commands: persist fail-closed: %w", err)
	}
	return w.reportTerminal(ctx, &terminal)
}

// reportTerminal reports a terminal receipt and commits only on matching
// echo. Transport/5xx failures preserve the receipt for report-only retry;
// the action is never re-executed by the caller (resume routes terminal
// receipts here).
func (w *Worker) reportTerminal(ctx context.Context, rec *Receipt) error {
	res := &Result{
		CommandID: rec.CommandID, AgentInstanceID: rec.AgentInstanceID,
		Executed: rec.Executed, ErrorCode: rec.ErrorCode, OutputPreview: rec.OutputPreview,
	}
	switch rec.State {
	case ReceiptSucceeded:
		res.Status = StatusSucceeded
	case ReceiptFailed:
		res.Status = StatusFailed
	case ReceiptUncertain:
		res.Status = StatusUncertain
	default:
		return fmt.Errorf("commands: non-terminal report")
	}
	if err := ValidateResult(res); err != nil {
		return fmt.Errorf("commands: result invalid: %w", err)
	}
	if err := w.transport.Report(ctx, res); err != nil {
		// Preserve for report-only retry. Log IDs only, never payloads.
		if IsConflict(err) || IsFatal(err) || isRetryable(err) {
			log.Printf("commands: report %q deferred (%v), receipt preserved", rec.CommandID, err)
		}
		return err
	}
	if err := w.store.CommitReceipt(rec.CommandID, rec.AgentInstanceID); err != nil {
		return fmt.Errorf("commands: commit: %w", err)
	}
	if w.fence != nil && rec.FenceScope != "" && rec.State != ReceiptUncertain {
		if err := w.fence.Release(ctx, rec.FenceScope, rec.CommandID); err != nil {
			return fmt.Errorf("commands: release mutation fence: %w", err)
		}
	}
	log.Printf("commands: reported %q state=%s", rec.CommandID, rec.State)
	return nil
}

// execContext applies the per-command timeout bounded by the absolute
// deadline minus a report reserve. Expired deadlines fail before execute.
func (w *Worker) execContext(ctx context.Context, rec *Receipt) (context.Context, context.CancelFunc) {
	timeout := rec.TimeoutSeconds
	if timeout < MinCommandTimeoutSeconds {
		timeout = MinCommandTimeoutSeconds
	}
	if timeout > MaxCommandTimeoutSeconds {
		timeout = MaxCommandTimeoutSeconds
	}
	d := time.Duration(timeout) * time.Second
	if dl, ok := w.untilDeadline(rec.DeadlineNano); ok {
		// Reserve 500ms for persist+report after the daemon call.
		const reserve = 500 * time.Millisecond
		if dl <= reserve {
			// Already effectively expired; caller checks expired(), but
			// clamp to a cancelled context rather than acting unbounded.
			c, cancel := context.WithTimeout(ctx, time.Nanosecond)
			return c, cancel
		}
		if avail := dl - reserve; avail < d {
			d = avail
		}
	}
	return context.WithTimeout(ctx, d)
}

// expired reports whether deadlineNano is at or before now. Non-canonical
// deadlines fail closed as expired (never execute unbounded).
func (w *Worker) expired(deadlineNano string) bool {
	if !validNano(deadlineNano) {
		return true
	}
	nowNano := strconv.FormatInt(w.now().UnixNano(), 10)
	nowNano = strings.TrimLeft(nowNano, "-")
	if !validNano(nowNano) {
		// Clock before epoch or overflow: fail closed.
		return true
	}
	return cmpNano(nowNano, deadlineNano) >= 0
}

// untilDeadline returns the duration until deadlineNano.
func (w *Worker) untilDeadline(deadlineNano string) (time.Duration, bool) {
	if !validNano(deadlineNano) {
		return 0, false
	}
	now := w.now().UnixNano()
	dl, err := strconv.ParseInt(deadlineNano, 10, 64)
	if err != nil {
		return 0, false
	}
	d := time.Duration(dl - now)
	if d <= 0 {
		return 0, false
	}
	return d, true
}

// cmpNano compares canonical decimal strings: -1/0/+1.
func cmpNano(a, b string) int {
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

// ---------------------------------------------------------------------------
// In-memory receipt store (tests, ephemeral agents).
// ---------------------------------------------------------------------------

// MemoryReceiptStore holds at most one receipt.
type MemoryReceiptStore struct {
	mu sync.Mutex
	r  *Receipt
}

// GetReceipt returns a copy or nil.
func (m *MemoryReceiptStore) GetReceipt() *Receipt {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.r == nil {
		return nil
	}
	cp := *m.r
	return &cp
}

// PersistReceipt validates then stores (single-pending: a different second
// receipt conflicts; idempotent retry of the identical receipt succeeds).
func (m *MemoryReceiptStore) PersistReceipt(r Receipt) error {
	if err := ValidateReceipt(&r); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.r != nil && (m.r.CommandID != r.CommandID || m.r.AgentInstanceID != r.AgentInstanceID) {
		return fmt.Errorf("commands: receipt conflict")
	}
	cp := r
	m.r = &cp
	return nil
}

// CommitReceipt clears only on matching IDs.
func (m *MemoryReceiptStore) CommitReceipt(commandID, agentInstanceID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.r == nil {
		return fmt.Errorf("commands: no pending receipt")
	}
	if m.r.CommandID != commandID || m.r.AgentInstanceID != agentInstanceID {
		return fmt.Errorf("commands: commit mismatch")
	}
	m.r = nil
	return nil
}

// ---------------------------------------------------------------------------
// File receipt store: crash-safe single JSON file, 0600, atomic replace.
// ---------------------------------------------------------------------------

// FileReceiptStore persists one receipt at path.
type FileReceiptStore struct {
	mu   sync.Mutex
	path string
}

// NewFileReceiptStore builds a file store, loading and validating existing
// state (corrupt files fail closed with an error, never a phantom receipt).
func NewFileReceiptStore(path string) (*FileReceiptStore, error) {
	s := &FileReceiptStore{path: path}
	if _, err := os.Stat(path); err == nil {
		if _, err := s.load(); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("commands: receipt stat: %w", err)
	}
	return s, nil
}

// GetReceipt returns a copy or nil (corrupt file fails closed as error-less
// nil? No: surface via error on load/persist; Get re-reads and returns nil
// only when absent, error state preserved by returning last valid nil).
func (s *FileReceiptStore) GetReceipt() *Receipt {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.readLocked()
	if err != nil {
		// Fail closed: pretend a corrupt receipt exists? Callers need the
		// error. Since the interface has no error, stash corruption as a
		// synthetic invalid receipt that resume() rejects without acting.
		return &Receipt{CommandID: "corrupt", AgentInstanceID: "corrupt", Action: "bogus", ContainerKey: "corrupt", State: "corrupt"}
	}
	if r == nil {
		return nil
	}
	cp := *r
	return &cp
}

// PersistReceipt validates and atomically replaces the file.
func (s *FileReceiptStore) PersistReceipt(r Receipt) error {
	if err := ValidateReceipt(&r); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.readLocked()
	if err != nil {
		return err
	}
	if cur != nil && (cur.CommandID != r.CommandID || cur.AgentInstanceID != r.AgentInstanceID) {
		return fmt.Errorf("commands: receipt conflict")
	}
	return s.writeLocked(&r)
}

// CommitReceipt clears only on matching IDs.
func (s *FileReceiptStore) CommitReceipt(commandID, agentInstanceID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.readLocked()
	if err != nil {
		return err
	}
	if cur == nil {
		return fmt.Errorf("commands: no pending receipt")
	}
	if cur.CommandID != commandID || cur.AgentInstanceID != agentInstanceID {
		return fmt.Errorf("commands: commit mismatch")
	}
	return s.writeLocked(nil)
}

func (s *FileReceiptStore) load() (*Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

func (s *FileReceiptStore) readLocked() (*Receipt, error) {
	raw, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("commands: receipt read: %w", err)
	}
	var wrap struct {
		Receipt *Receipt `json:"receipt"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&wrap); err != nil {
		return nil, fmt.Errorf("commands: receipt malformed: fail closed: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("commands: receipt trailing data: fail closed")
		}
		return nil, fmt.Errorf("commands: receipt trailing data: fail closed: %w", err)
	}
	if wrap.Receipt == nil {
		return nil, nil
	}
	if err := ValidateReceipt(wrap.Receipt); err != nil {
		return nil, fmt.Errorf("commands: receipt invalid: fail closed: %w", err)
	}
	return wrap.Receipt, nil
}

func (s *FileReceiptStore) writeLocked(r *Receipt) error {
	wrap := struct {
		Receipt *Receipt `json:"receipt"`
	}{Receipt: r}
	blob, err := json.Marshal(wrap)
	if err != nil {
		return fmt.Errorf("commands: receipt marshal: %w", err)
	}
	if dir := filepath.Dir(s.path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("commands: receipt mkdir: %w", err)
		}
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".receipt-*.tmp")
	if err != nil {
		return fmt.Errorf("commands: receipt temp: %w", err)
	}
	tmpName := tmp.Name()
	_ = tmp.Chmod(0o600)
	if _, err := tmp.Write(blob); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("commands: receipt write: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("commands: receipt sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("commands: receipt close: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("commands: receipt replace: %w", err)
	}
	return nil
}
