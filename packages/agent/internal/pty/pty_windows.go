//go:build windows

package pty

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var (
	kernel32                              = syscall.NewLazyDLL("kernel32.dll")
	procCreatePseudoConsole               = kernel32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole               = kernel32.NewProc("ResizePseudoConsole")
	procClosePseudoConsole                = kernel32.NewProc("ClosePseudoConsole")
	procInitializeProcThreadAttributeList = kernel32.NewProc("InitializeProcThreadAttributeList")
	procUpdateProcThreadAttribute         = kernel32.NewProc("UpdateProcThreadAttribute")
	procDeleteProcThreadAttributeList     = kernel32.NewProc("DeleteProcThreadAttributeList")
	procCreateProcessW                    = kernel32.NewProc("CreateProcessW")
	procCreateJobObjectW                  = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject           = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject          = kernel32.NewProc("AssignProcessToJobObject")
)

const (
	procThreadAttributePseudoConsole = 0x00020016
	extendedStartupInfoPresent       = 0x00080000
	startfUseStdHandles              = 0x00000100
)
const (
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x00002000
)

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInformationStruct struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type coord struct {
	X int16
	Y int16
}

type startupInfoEx struct {
	syscall.StartupInfo
	AttributeList uintptr
}

type windowsPty struct {
	hPC       uintptr
	inWrite   *os.File
	outRead   *os.File
	closed    bool
	mu        sync.Mutex
	procInfo  syscall.ProcessInformation
	hJob      syscall.Handle
	closeOnce sync.Once
}

func (p *windowsPty) Read(b []byte) (int, error) {
	return p.outRead.Read(b)
}

func (p *windowsPty) Write(b []byte) (int, error) {
	return p.inWrite.Write(b)
}

func (p *windowsPty) Resize(size Winsize) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.hPC == 0 {
		return ErrClosed
	}
	c := coord{X: int16(size.Cols), Y: int16(size.Rows)}
	cVal := uintptr(uint32(c.X) | (uint32(c.Y) << 16))
	r, _, err := procResizePseudoConsole.Call(p.hPC, cVal)
	if r != 0 {
		return fmt.Errorf("ResizePseudoConsole failed: %w", err)
	}
	return nil
}

func (p *windowsPty) closeConsole() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.hPC != 0 {
		procClosePseudoConsole.Call(p.hPC)
		p.hPC = 0
	}
}

func (p *windowsPty) Close() error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closed = true
		hProc := p.procInfo.Process
		hTh := p.procInfo.Thread
		hJob := p.hJob
		p.procInfo.Process = 0
		p.procInfo.Thread = 0
		p.hJob = 0
		p.mu.Unlock()

		if hJob != 0 {
			_ = syscall.CloseHandle(hJob)
		}

		if hProc != 0 {
			_ = syscall.TerminateProcess(hProc, 1)
			_ = syscall.CloseHandle(hProc)
		}
		if hTh != 0 {
			_ = syscall.CloseHandle(hTh)
		}

		_ = p.inWrite.Close()
		p.closeConsole()
		_ = p.outRead.Close()
	})
	return nil
}

// Start launches the command attached to a new Windows Pseudo Console (ConPTY).
func Start(cmd *exec.Cmd, size Winsize) (*Session, error) {
	if procCreatePseudoConsole.Find() != nil {
		return nil, errors.New("ConPTY not supported on this Windows version (requires Windows 10 1809+)")
	}

	if size.Cols == 0 {
		size.Cols = 80
	}
	if size.Rows == 0 {
		size.Rows = 24
	}

	// Create pseudo console input & output pipes
	var inRead, inWrite, outRead, outWrite syscall.Handle
	if err := syscall.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return nil, fmt.Errorf("CreatePipe in: %w", err)
	}
	if err := syscall.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		syscall.CloseHandle(inRead)
		syscall.CloseHandle(inWrite)
		return nil, fmt.Errorf("CreatePipe out: %w", err)
	}

	c := coord{X: int16(size.Cols), Y: int16(size.Rows)}
	cVal := uintptr(uint32(c.X) | (uint32(c.Y) << 16))
	var hPC uintptr

	r, _, err := procCreatePseudoConsole.Call(cVal, uintptr(inRead), uintptr(outWrite), 0, uintptr(unsafe.Pointer(&hPC)))
	if r != 0 {
		syscall.CloseHandle(inRead)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		syscall.CloseHandle(outWrite)
		return nil, fmt.Errorf("CreatePseudoConsole: %w", err)
	}

	// Prepare STARTUPINFOEX with PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
	var sizeAttr uintptr
	procInitializeProcThreadAttributeList.Call(0, 1, 0, uintptr(unsafe.Pointer(&sizeAttr)))
	if sizeAttr == 0 {
		procClosePseudoConsole.Call(hPC)
		syscall.CloseHandle(inRead)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		syscall.CloseHandle(outWrite)
		return nil, errors.New("InitializeProcThreadAttributeList query failed")
	}

	attrList := make([]byte, sizeAttr)
	si := startupInfoEx{}
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Flags = extendedStartupInfoPresent | startfUseStdHandles
	si.AttributeList = uintptr(unsafe.Pointer(&attrList[0]))

	r, _, err = procInitializeProcThreadAttributeList.Call(si.AttributeList, 1, 0, uintptr(unsafe.Pointer(&sizeAttr)))
	if r == 0 {
		procClosePseudoConsole.Call(hPC)
		syscall.CloseHandle(inRead)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		syscall.CloseHandle(outWrite)
		return nil, fmt.Errorf("InitializeProcThreadAttributeList: %w", err)
	}
	defer procDeleteProcThreadAttributeList.Call(si.AttributeList)

	r, _, err = procUpdateProcThreadAttribute.Call(
		si.AttributeList,
		0,
		procThreadAttributePseudoConsole,
		hPC,
		unsafe.Sizeof(hPC),
		0,
		0,
	)
	if r == 0 {
		procClosePseudoConsole.Call(hPC)
		syscall.CloseHandle(inRead)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		syscall.CloseHandle(outWrite)
		return nil, fmt.Errorf("UpdateProcThreadAttribute: %w", err)
	}

	// Prepare command line
	cmdLine := cmd.Path
	if len(cmd.Args) > 0 {
		cmdLine = strings.Join(cmd.Args, " ")
	}
	cmdUtf16, err := syscall.UTF16PtrFromString(cmdLine)
	if err != nil {
		procClosePseudoConsole.Call(hPC)
		syscall.CloseHandle(inRead)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		syscall.CloseHandle(outWrite)
		return nil, err
	}

	var dirUtf16 *uint16
	if cmd.Dir != "" {
		dirUtf16, err = syscall.UTF16PtrFromString(cmd.Dir)
		if err != nil {
			procClosePseudoConsole.Call(hPC)
			syscall.CloseHandle(inRead)
			syscall.CloseHandle(inWrite)
			syscall.CloseHandle(outRead)
			syscall.CloseHandle(outWrite)
			return nil, err
		}
	}

	var pi syscall.ProcessInformation
	r, _, err = procCreateProcessW.Call(
		0,
		uintptr(unsafe.Pointer(cmdUtf16)),
		0,
		0,
		0, // bInheritHandles = false
		extendedStartupInfoPresent,
		0,
		uintptr(unsafe.Pointer(dirUtf16)),
		uintptr(unsafe.Pointer(&si)),
		uintptr(unsafe.Pointer(&pi)),
	)
	// PseudoConsole owns inRead and outWrite after CreateProcess
	syscall.CloseHandle(inRead)
	syscall.CloseHandle(outWrite)

	if r == 0 {
		procClosePseudoConsole.Call(hPC)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, fmt.Errorf("CreateProcessW: %w", err)
	}

	var hJob syscall.Handle
	rJob, _, _ := procCreateJobObjectW.Call(0, 0)
	if rJob != 0 {
		hJob = syscall.Handle(rJob)
		var info jobObjectExtendedLimitInformationStruct
		info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
		procSetInformationJobObject.Call(
			uintptr(hJob),
			jobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)),
			uintptr(unsafe.Sizeof(info)),
		)
		procAssignProcessToJobObject.Call(uintptr(hJob), uintptr(pi.Process))
	}

	wp := &windowsPty{
		hPC:      hPC,
		inWrite:  os.NewFile(uintptr(inWrite), "pty-inWrite"),
		outRead:  os.NewFile(uintptr(outRead), "pty-outRead"),
		procInfo: pi,
		hJob:     hJob,
	}
	// Duplicate process handle for monitor goroutine so it does not race with wp.Close()
	var monitorProc syscall.Handle
	currentProc, _ := syscall.GetCurrentProcess()
	_ = syscall.DuplicateHandle(currentProc, pi.Process, currentProc, &monitorProc, 0, false, syscall.DUPLICATE_SAME_ACCESS)

	go func() {
		if monitorProc != 0 {
			defer syscall.CloseHandle(monitorProc)
			syscall.WaitForSingleObject(monitorProc, syscall.INFINITE)
		}
		wp.closeConsole()
	}()

	cmd.Process, err = os.FindProcess(int(pi.ProcessId))
	if err != nil {
		_ = wp.Close()
		return nil, fmt.Errorf("FindProcess: %w", err)
	}

	return &Session{
		Pty: wp,
		Cmd: cmd,
	}, nil
}

func (s *Session) KillProcessGroup() {
	if s.Pty != nil {
		_ = s.Pty.Close()
	}
	if s.Cmd != nil && s.Cmd.Process != nil {
		_ = s.Cmd.Process.Kill()
	}
}
