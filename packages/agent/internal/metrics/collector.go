package metrics

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Sentinel errors.
var (
	ErrUnsupported = fmt.Errorf("metrics collection not supported on this platform")
)

// NetworkUnitBytesPerSecond is the explicit unit for NetworkRx/NetworkTx:
// both are computed throughput rates (bytes per second), never cumulative
// counters. Always set on samples produced by Collect.
const NetworkUnitBytesPerSecond = "bytes/s"

// SystemMetrics represents a single snapshot of system metrics.
type SystemMetrics struct {
	CPU              float64        `json:"cpu"`
	Memory           float64        `json:"memory"`
	Disk             float64        `json:"disk"`
	LoadAverage      float64        `json:"loadAverage"`
	NetworkRx        float64        `json:"networkRx"`
	NetworkTx        float64        `json:"networkTx"`
	NetworkUnit      string         `json:"networkUnit,omitempty"`
	NetworkAvailable bool           `json:"networkAvailable"`
	Uptime           float64        `json:"uptime"`
	System           *SystemInfo    `json:"system,omitempty"`
	Docker           *DockerMetrics `json:"docker,omitempty"`
	Location         *Location      `json:"location,omitempty"`
}

// CPUStats holds raw CPU time values from /proc/stat.
type CPUStats struct {
	User    uint64
	Nice    uint64
	System  uint64
	Idle    uint64
	IOWait  uint64
	IRQ     uint64
	SoftIRQ uint64
	Steal   uint64
}

// NetStats holds raw network byte counters.
type NetStats struct {
	RxBytes uint64
	TxBytes uint64
}

// Collector gathers system metrics using /proc (Linux) or returns clear errors.
type Collector struct {
	prevCPU *CPUStats
	// Network baseline is stored as raw uint64 counters (not float64) to
	// avoid precision loss past 2^53, plus the baseline timestamp.
	// prevNetTime.IsZero() means "no baseline yet" (first sample).
	prevNetRx   uint64
	prevNetTx   uint64
	prevNetTime time.Time

	// Docker metrics collection (thread-safe, off by default).
	dockerEnabled    bool
	dockerMu         sync.RWMutex
	dockerHTTPClient *http.Client
	dockerBaseURL    string
	dockerSocketPath string
	// Additive Docker runtime hooks (gate defaults off). The key func derives
	// stable opaque containerKeys; the finalize hook lets Runner attach
	// durable batch metadata before push. Neither performs I/O.
	dockerKeyFunc     DockerContainerKeyFunc
	dockerFinalize    DockerFinalizeFunc
	dockerEventInput  DockerEventInputProvider
	dockerStorage     bool
	dockerLastStorage time.Time
	dockerRotation    uint64
}

// NewCollector creates a new Collector.
func NewCollector() *Collector {
	return &Collector{}
}

// Collect gathers a full SystemMetrics snapshot.
func (c *Collector) Collect(ctx context.Context) (*SystemMetrics, error) {
	if runtime.GOOS != "linux" {
		if _, err := os.Stat("/proc/stat"); os.IsNotExist(err) {
			return nil, ErrUnsupported
		}
	}

	metrics := &SystemMetrics{}

	cpu, err := c.collectCPU()
	if err != nil {
		return nil, fmt.Errorf("cpu: %w", err)
	}
	metrics.CPU = cpu

	mem, err := collectMemory()
	if err != nil {
		return nil, fmt.Errorf("memory: %w", err)
	}
	metrics.Memory = mem

	load, err := collectLoad()
	if err != nil {
		return nil, fmt.Errorf("load: %w", err)
	}
	metrics.LoadAverage = load

	uptime, err := collectUptime()
	if err != nil {
		return nil, fmt.Errorf("uptime: %w", err)
	}
	metrics.Uptime = uptime

	netRx, netTx, netAvailable, err := c.collectNetwork()
	if err != nil {
		return nil, fmt.Errorf("network: %w", err)
	}
	metrics.NetworkRx = netRx
	metrics.NetworkTx = netTx
	metrics.NetworkUnit = NetworkUnitBytesPerSecond
	metrics.NetworkAvailable = netAvailable

	disk, err := collectDisk()
	if err != nil {
		return nil, fmt.Errorf("disk: %w", err)
	}
	metrics.Disk = disk

	// System info is best-effort — do not fail the whole collection.
	metrics.System = collectSystemInfo()

	// Docker metrics are best-effort; never fail host metrics collection.
	if c.isDockerEnabled() {
		collectionStart := time.Now()
		dockerCtx, cancel := context.WithTimeout(ctx, DefaultDockerTimeoutSeconds*time.Second)
		defer cancel()
		// Leave time for event/storage and inspect enrichment within the same
		// outer deadline even when sequential stats requests are slow.
		baseCtx, cancelBase := context.WithDeadline(dockerCtx, collectionStart.Add(3*time.Second))
		legacy := c.collectDocker(baseCtx)
		cancelBase()
		if legacy != nil {
			metrics.Docker = c.collectDockerSnapshot(dockerCtx, legacy, collectionStart)
		}
	}

	return metrics, nil
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

// ReadCPUStats parses the first "cpu " line from /proc/stat content.
func ReadCPUStats(data string) (*CPUStats, error) {
	lines := strings.Split(data, "\n")
	for _, line := range lines {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 8 {
			return nil, fmt.Errorf("unexpected cpu line: %q", line)
		}
		var vals [8]uint64
		for i := 1; i <= 8; i++ {
			v, err := strconv.ParseUint(fields[i], 10, 64)
			if err != nil {
				return nil, fmt.Errorf("parsing cpu field %d: %w", i, err)
			}
			vals[i-1] = v
		}
		return &CPUStats{
			User:    vals[0],
			Nice:    vals[1],
			System:  vals[2],
			Idle:    vals[3],
			IOWait:  vals[4],
			IRQ:     vals[5],
			SoftIRQ: vals[6],
			Steal:   vals[7],
		}, nil
	}
	return nil, fmt.Errorf("no cpu line found")
}

// CPUPercent calculates CPU usage percentage from two consecutive snapshots.
func CPUPercent(prev, curr *CPUStats) float64 {
	prevTotal := prev.User + prev.Nice + prev.System + prev.Idle + prev.IOWait + prev.IRQ + prev.SoftIRQ + prev.Steal
	currTotal := curr.User + curr.Nice + curr.System + curr.Idle + curr.IOWait + curr.IRQ + curr.SoftIRQ + curr.Steal
	// Counter reset (e.g., boot / /proc rollover): total went backwards.
	// Report 0 until the next sample instead of wrapping unsigned math.
	if currTotal < prevTotal {
		return 0
	}
	totalDelta := currTotal - prevTotal
	if totalDelta == 0 {
		return 0
	}
	// Partial reset guard: idle moving backwards while total moved forward
	// would wrap idleDelta and spike. Clamp instead of emitting garbage.
	if curr.Idle < prev.Idle {
		return 0
	}
	idleDelta := curr.Idle - prev.Idle
	return math.Round((1-float64(idleDelta)/float64(totalDelta))*10000) / 100
}

func (c *Collector) collectCPU() (float64, error) {
	data, err := readProcFile("/proc/stat")
	if err != nil {
		return 0, err
	}
	curr, err := ReadCPUStats(data)
	if err != nil {
		return 0, err
	}
	if c.prevCPU == nil {
		c.prevCPU = curr
		return 0, nil
	}
	pct := CPUPercent(c.prevCPU, curr)
	c.prevCPU = curr
	return pct, nil
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

// ReadMemInfo parses MemTotal and MemAvailable from /proc/meminfo content.
// Values are in kB.
func ReadMemInfo(data string) (total, available uint64, err error) {
	lines := strings.Split(data, "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				return 0, 0, fmt.Errorf("unexpected MemTotal line: %q", line)
			}
			total, err = strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return 0, 0, fmt.Errorf("parsing MemTotal: %w", err)
			}
		}
		if strings.HasPrefix(line, "MemAvailable:") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				return 0, 0, fmt.Errorf("unexpected MemAvailable line: %q", line)
			}
			available, err = strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return 0, 0, fmt.Errorf("parsing MemAvailable: %w", err)
			}
		}
	}
	if total == 0 {
		return 0, 0, fmt.Errorf("MemTotal not found")
	}
	return total, available, nil
}

// MemoryPercent calculates used memory percentage.
func MemoryPercent(total, available uint64) float64 {
	if total == 0 {
		return 0
	}
	used := total - available
	return math.Round(float64(used)/float64(total)*10000) / 100
}

func collectMemory() (float64, error) {
	data, err := readProcFile("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	total, avail, err := ReadMemInfo(data)
	if err != nil {
		return 0, err
	}
	return MemoryPercent(total, avail), nil
}

// ---------------------------------------------------------------------------
// Load Average
// ---------------------------------------------------------------------------

// ReadLoadAvg parses the 1-minute load average from /proc/loadavg content.
func ReadLoadAvg(data string) (float64, error) {
	fields := strings.Fields(data)
	if len(fields) < 3 {
		return 0, fmt.Errorf("unexpected loadavg format: %q", data)
	}
	load, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("parsing loadavg 1min: %w", err)
	}
	return load, nil
}

func collectLoad() (float64, error) {
	data, err := readProcFile("/proc/loadavg")
	if err != nil {
		return 0, err
	}
	return ReadLoadAvg(data)
}

// ---------------------------------------------------------------------------
// Uptime
// ---------------------------------------------------------------------------

// ReadUptime parses the system uptime in seconds from /proc/uptime content.
func ReadUptime(data string) (float64, error) {
	fields := strings.Fields(data)
	if len(fields) < 1 {
		return 0, fmt.Errorf("unexpected uptime format: %q", data)
	}
	uptime, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("parsing uptime: %w", err)
	}
	return uptime, nil
}

func collectUptime() (float64, error) {
	data, err := readProcFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	return ReadUptime(data)
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

// ReadNetDev parses /proc/net/dev content and returns per-interface stats.
func ReadNetDev(data string) (map[string]NetStats, error) {
	lines := strings.Split(data, "\n")
	stats := make(map[string]NetStats)
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Inter-") || strings.HasPrefix(line, " face") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		iface := strings.TrimSpace(parts[0])
		fields := strings.Fields(parts[1])
		if len(fields) < 9 {
			continue
		}
		rx, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		tx, err := strconv.ParseUint(fields[8], 10, 64)
		if err != nil {
			continue
		}
		stats[iface] = NetStats{RxBytes: rx, TxBytes: tx}
	}
	return stats, nil
}

// collectNetwork computes bytes-per-second rates from consecutive
// /proc/net/dev snapshots. available=false means no trustworthy rate exists
// for this interval (first sample, counter reset, or non-advancing clock):
// rx/tx are 0 and the caller must treat the point as a gap, never as a
// zero-valued observation.
func (c *Collector) collectNetwork() (rxRate, txRate float64, available bool, err error) {
	data, err := readProcFile("/proc/net/dev")
	if err != nil {
		return 0, 0, false, err
	}
	curr, err := ReadNetDev(data)
	if err != nil {
		return 0, 0, false, err
	}

	var currRx, currTx uint64
	for name, s := range curr {
		if name == "lo" {
			continue
		}
		currRx += s.RxBytes
		currTx += s.TxBytes
	}

	now := timeNow()

	// First sample: store the baseline, no rate yet.
	if c.prevNetTime.IsZero() {
		c.prevNetRx = currRx
		c.prevNetTx = currTx
		c.prevNetTime = now
		return 0, 0, false, nil
	}

	elapsed := now.Sub(c.prevNetTime).Seconds()
	if elapsed <= 0 {
		// Keep the baseline; the next sample with positive elapsed computes
		// the delta over the longer window. No rate for this instant.
		return 0, 0, false, nil
	}

	// Counter reset (interface restart / hot-unplug): either direction going
	// backwards makes the delta meaningless. Re-baseline on the current
	// counters so the next sample recovers cleanly, and mark unavailable so
	// the backend records a gap instead of a fake rate or 0-spike.
	if currRx < c.prevNetRx || currTx < c.prevNetTx {
		c.prevNetRx = currRx
		c.prevNetTx = currTx
		c.prevNetTime = now
		return 0, 0, false, nil
	}

	// Guarded by the check above: both subtractions are non-negative.
	rxRate = float64(currRx-c.prevNetRx) / elapsed
	txRate = float64(currTx-c.prevNetTx) / elapsed

	c.prevNetRx = currRx
	c.prevNetTx = currTx
	c.prevNetTime = now

	return rxRate, txRate, true, nil
}

// ---------------------------------------------------------------------------
// Disk (collectDisk defined in platform-specific files)
// ---------------------------------------------------------------------------

// readProcFile is overridable in tests.
var readProcFile = func(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", path, err)
	}
	return string(data), nil
}

// timeNow is overridable in tests.
var timeNow = func() time.Time { return time.Now() }
