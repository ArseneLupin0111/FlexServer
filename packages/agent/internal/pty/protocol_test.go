package pty

import (
	"bytes"
	"testing"
)

func TestFramingRoundTrip(t *testing.T) {
	buf := new(bytes.Buffer)
	fw := NewFramedWriter(buf)

	// Test data frame
	payload := []byte("hello terminal world")
	if err := fw.WriteFrame(MsgTypeData, payload); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}

	// Test resize frame
	resizePayload := EncodeResize(30, 100)
	if err := fw.WriteFrame(MsgTypeResize, resizePayload); err != nil {
		t.Fatalf("WriteFrame resize: %v", err)
	}

	// Test exit frame
	exitPayload := EncodeExit(42)
	if err := fw.WriteFrame(MsgTypeExit, exitPayload); err != nil {
		t.Fatalf("WriteFrame exit: %v", err)
	}

	// Read first frame
	f1, err := ReadFrame(buf)
	if err != nil {
		t.Fatalf("ReadFrame 1: %v", err)
	}
	if f1.Type != MsgTypeData || !bytes.Equal(f1.Payload, payload) {
		t.Fatalf("unexpected frame 1: %+v", f1)
	}

	// Read second frame
	f2, err := ReadFrame(buf)
	if err != nil {
		t.Fatalf("ReadFrame 2: %v", err)
	}
	if f2.Type != MsgTypeResize {
		t.Fatalf("unexpected frame 2 type: %d", f2.Type)
	}
	rows, cols, err := DecodeResize(f2.Payload)
	if err != nil {
		t.Fatalf("DecodeResize: %v", err)
	}
	if rows != 30 || cols != 100 {
		t.Fatalf("unexpected resize values: rows=%d cols=%d", rows, cols)
	}

	// Read third frame
	f3, err := ReadFrame(buf)
	if err != nil {
		t.Fatalf("ReadFrame 3: %v", err)
	}
	if f3.Type != MsgTypeExit {
		t.Fatalf("unexpected frame 3 type: %d", f3.Type)
	}
	code, err := DecodeExit(f3.Payload)
	if err != nil {
		t.Fatalf("DecodeExit: %v", err)
	}
	if code != 42 {
		t.Fatalf("unexpected exit code: %d", code)
	}
}
