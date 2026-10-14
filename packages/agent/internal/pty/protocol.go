package pty

import (
	"encoding/binary"
	"fmt"
	"io"
	"sync"
)

// Wire message types between Node LocalTerminalService and host-pty.
const (
	MsgTypeData   byte = 0x01 // Raw terminal input/output bytes
	MsgTypeResize byte = 0x02 // Window resize: 2 bytes rows, 2 bytes cols
	MsgTypeExit   byte = 0x03 // Process exited: 4 bytes int32 exit code
	MsgTypeClose  byte = 0x04 // Graceful close / terminate request
	MsgTypeError  byte = 0x05 // Error string
)

const (
	MaxPayloadSize = 4 * 1024 * 1024 // 4 MiB max frame payload
)

// Frame represents a framed binary message.
type Frame struct {
	Type    byte
	Payload []byte
}

// ReadFrame reads a single frame from the reader.
func ReadFrame(r io.Reader) (Frame, error) {
	header := make([]byte, 5)
	if _, err := io.ReadFull(r, header); err != nil {
		return Frame{}, err
	}
	msgType := header[0]
	length := binary.BigEndian.Uint32(header[1:5])
	if length > MaxPayloadSize {
		return Frame{}, fmt.Errorf("pty protocol: frame payload too large (%d bytes)", length)
	}

	payload := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(r, payload); err != nil {
			return Frame{}, err
		}
	}
	return Frame{Type: msgType, Payload: payload}, nil
}

// FramedWriter writes binary frames with thread safety.
type FramedWriter struct {
	w  io.Writer
	mu sync.Mutex
}

// NewFramedWriter creates a thread-safe FramedWriter.
func NewFramedWriter(w io.Writer) *FramedWriter {
	return &FramedWriter{w: w}
}

// WriteFrame sends a frame atomically.
func (fw *FramedWriter) WriteFrame(msgType byte, payload []byte) error {
	fw.mu.Lock()
	defer fw.mu.Unlock()

	length := uint32(len(payload))
	if length > MaxPayloadSize {
		return fmt.Errorf("pty protocol: frame payload too large (%d bytes)", length)
	}

	buf := make([]byte, 5+length)
	buf[0] = msgType
	binary.BigEndian.PutUint32(buf[1:5], length)
	if length > 0 {
		copy(buf[5:], payload)
	}

	_, err := fw.w.Write(buf)
	return err
}

// EncodeResize builds the 4-byte payload for a resize message.
func EncodeResize(rows, cols uint16) []byte {
	buf := make([]byte, 4)
	binary.BigEndian.PutUint16(buf[0:2], rows)
	binary.BigEndian.PutUint16(buf[2:4], cols)
	return buf
}

// DecodeResize parses the 4-byte payload from a resize message.
func DecodeResize(payload []byte) (rows, cols uint16, err error) {
	if len(payload) < 4 {
		return 0, 0, fmt.Errorf("invalid resize payload length: %d", len(payload))
	}
	rows = binary.BigEndian.Uint16(payload[0:2])
	cols = binary.BigEndian.Uint16(payload[2:4])
	return rows, cols, nil
}

// EncodeExit builds the 4-byte payload for an exit code message.
func EncodeExit(code int32) []byte {
	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, uint32(code))
	return buf
}

// DecodeExit parses the 4-byte payload from an exit code message.
func DecodeExit(payload []byte) (int32, error) {
	if len(payload) < 4 {
		return -1, fmt.Errorf("invalid exit payload length: %d", len(payload))
	}
	return int32(binary.BigEndian.Uint32(payload[:4])), nil
}

// WriteFrame writes a single frame to the writer.
func WriteFrame(w io.Writer, f Frame) error {
	header := make([]byte, 5)
	header[0] = f.Type
	binary.BigEndian.PutUint32(header[1:5], uint32(len(f.Payload)))
	if _, err := w.Write(header); err != nil {
		return err
	}
	if len(f.Payload) > 0 {
		_, err := w.Write(f.Payload)
		return err
	}
	return nil
}
