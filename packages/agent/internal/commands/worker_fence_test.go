package commands

import (
	"context"
	"errors"
	"testing"
)

type fenceTestStore struct{ receipt *Receipt }

func (s *fenceTestStore) GetReceipt() *Receipt {
	if s.receipt == nil { return nil }
	r := *s.receipt
	return &r
}
func (s *fenceTestStore) PersistReceipt(r Receipt) error { c := r; s.receipt = &c; return nil }
func (s *fenceTestStore) CommitReceipt(id, instance string) error { s.receipt = nil; return nil }

type fenceTestCommander struct{ reported *Result }
func (*fenceTestCommander) Claim(context.Context, string) (*Command, error) { return nil, nil }
func (c *fenceTestCommander) Report(_ context.Context, r *Result) error { c.reported = r; return nil }

type fenceTestController struct{ calls int }
func (c *fenceTestController) Act(context.Context, string, string, bool) ActResult {
	c.calls++
	return ActResult{Executed: true}
}

type busyTestFence struct{ acquired int; marked int; released int }
func (f *busyTestFence) Acquire(context.Context, string, string) error { f.acquired++; return errors.New("busy") }
func (f *busyTestFence) MarkMutating(context.Context, string, string) error { f.marked++; return nil }
func (f *busyTestFence) Release(context.Context, string, string) error { f.released++; return nil }

func TestWorkerMutationFenceBusyPreventsDaemonAction(t *testing.T) {
	store := &fenceTestStore{}
	commander := &fenceTestCommander{}
	controller := &fenceTestController{}
	fence := &busyTestFence{}
	w, err := NewWorker("testinstance000000000000000001", "vps_1", commander, controller, store,
		func(key string) (string, bool) { return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", true })
	if err != nil { t.Fatalf("NewWorker: %v", err) }
	w.SetMutationFence(fence)
	cmd := validCommand()
	if err := w.start(context.Background(), cmd); err != nil { t.Fatalf("start: %v", err) }
	if fence.acquired != 1 || fence.marked != 0 || fence.released != 0 {
		t.Fatalf("fence calls acquire/mark/release = %d/%d/%d", fence.acquired, fence.marked, fence.released)
	}
	if controller.calls != 0 { t.Fatalf("busy fence allowed daemon action: calls=%d", controller.calls) }
	if commander.reported == nil || commander.reported.ErrorCode != ErrCodeTargetBusy || commander.reported.Executed {
		t.Fatalf("expected truthful non-executed target_busy report, got %#v", commander.reported)
	}
}
