package ai

import (
	"os"
	"testing"
	"time"
)

func TestReceiptStore_LifecycleAndPersist(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-receipt-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	store, err := NewFileReceiptStore(tempDir)
	if err != nil {
		t.Fatalf("NewFileReceiptStore failed: %v", err)
	}

	commandID := "cmd-test-12345"
	r := &Receipt{
		Version:       ProtocolVersion,
		CommandID:     commandID,
		TaskID:        "task-1",
		StepID:        "step-1",
		Kind:          KindShell,
		State:         ReceiptClaimed,
		Executed:      false,
		PlanDigest:    "digest-plan",
		PayloadDigest: "digest-payload",
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}

	// 1. Initial persist
	if err := store.Persist(r); err != nil {
		t.Fatalf("failed to persist initial receipt: %v", err)
	}

	// 2. Load
	loaded, err := store.Load(commandID)
	if err != nil {
		t.Fatalf("failed to load receipt: %v", err)
	}
	if loaded.State != ReceiptClaimed {
		t.Fatalf("expected state claimed, got %s", loaded.State)
	}

	// 3. Persist-before-mutate transition: claimed -> executing
	trans, err := store.Transition(commandID, ReceiptClaimed, ReceiptExecuting, func(rc *Receipt) {
		rc.Executed = true
	})
	if err != nil {
		t.Fatalf("transition claimed -> executing failed: %v", err)
	}
	if trans.State != ReceiptExecuting || !trans.Executed {
		t.Fatalf("unexpected state or executed flag: %+v", trans)
	}

	// 4. Invalid transition rejection: trying to transition from claimed when currently executing
	_, err = store.Transition(commandID, ReceiptClaimed, ReceiptSucceeded, nil)
	if err == nil {
		t.Fatalf("expected error transitioning from claimed when currently executing")
	}

	// 5. Valid transition: executing -> succeeded
	trans, err = store.Transition(commandID, ReceiptExecuting, ReceiptSucceeded, func(rc *Receipt) {
		rc.ObservedEvidence = "exit code 0"
	})
	if err != nil {
		t.Fatalf("transition executing -> succeeded failed: %v", err)
	}
	if trans.State != ReceiptSucceeded {
		t.Fatalf("expected state succeeded, got %s", trans.State)
	}
}

func TestReceiptStore_StartupRecoveryPending(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "ai-receipt-recovery-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	store, err := NewFileReceiptStore(tempDir)
	if err != nil {
		t.Fatalf("NewFileReceiptStore failed: %v", err)
	}

	// Create an executing receipt representing an interrupted run
	rExecuting := &Receipt{
		Version:   ProtocolVersion,
		CommandID: "cmd-executing",
		TaskID:    "task-crash",
		StepID:    "step-crash",
		Kind:      KindFileApply,
		State:     ReceiptExecuting,
		Executed:  true,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.Persist(rExecuting); err != nil {
		t.Fatalf("persist executing failed: %v", err)
	}

	// Create a completed succeeded receipt
	rDone := &Receipt{
		Version:   ProtocolVersion,
		CommandID: "cmd-done",
		TaskID:    "task-done",
		StepID:    "step-done",
		Kind:      KindFileRead,
		State:     ReceiptSucceeded,
		Executed:  false,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.Persist(rDone); err != nil {
		t.Fatalf("persist done failed: %v", err)
	}

	// ListPending should only return the executing receipt
	pending, err := store.ListPending()
	if err != nil {
		t.Fatalf("ListPending failed: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("expected 1 pending receipt, got %d", len(pending))
	}
	if pending[0].CommandID != "cmd-executing" {
		t.Fatalf("expected cmd-executing, got %s", pending[0].CommandID)
	}
}
