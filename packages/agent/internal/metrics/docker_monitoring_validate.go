package metrics

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Docker monitoring Phase 1 increment I0 — additive schema validation.
//
// Fail-closed contract validation for identity/digest/action/context-version
// fields. Display strings (name/image/state/status/createdAt) may truncate
// via cappedString; the fields below never truncate or coerce: invalid
// input is rejected with an error.

func isSafeIDChar(r rune) bool {
	switch {
	case r >= 'A' && r <= 'Z':
		return true
	case r >= 'a' && r <= 'z':
		return true
	case r >= '0' && r <= '9':
		return true
	case r == '.' || r == '_' || r == '~' || r == '-':
		return true
	}
	return false
}

func validateSafeID(value string, max int) error {
	if value == "" || len(value) > max {
		return fmt.Errorf("invalid bounded id")
	}
	for _, r := range value {
		if !isSafeIDChar(r) {
			return fmt.Errorf("invalid bounded id")
		}
	}
	return nil
}

// isCanonicalNanoDecimal reports whether s is a canonical non-negative
// decimal integer string: "0" or [1-9][0-9]*, length 1..MaxDockerNanoLen.
// Leading zeros (except "0" itself), signs, whitespace, and non-digits fail.
func isCanonicalNanoDecimal(s string) bool {
	if s == "" || len(s) > MaxDockerNanoLen {
		return false
	}
	if s == "0" {
		return true
	}
	if s[0] < '1' || s[0] > '9' {
		return false
	}
	for i := 1; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func validateDockerNanoString(value string) error {
	if !isCanonicalNanoDecimal(value) {
		return fmt.Errorf("non-canonical nanosecond value")
	}
	return nil
}

// cmpCanonicalNano compares two canonical decimal strings: -1/0/+1.
func cmpCanonicalNano(a, b string) int {
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

// validateDockerIdentity validates agentInstanceId/snapshotId/batchId
// shape (safe charset, bounded). Agent emission length is exactly
// MaxAgentInstanceIDLen for instance IDs; the API accepts the wider
// safeId(128), so validation here is fail-closed on charset/bounds.
func validateDockerIdentity(value string, max int) error {
	return validateSafeID(value, max)
}

func validateDockerAgentInstanceID(value string) error {
	return validateDockerIdentity(value, MaxAgentInstanceIDLen)
}

func validateDockerContainerKey(value string) error {
	return validateDockerIdentity(value, MaxContainerKeyLen)
}

func validateDockerDigest(value string) error {
	return validateSafeID(value, MaxDockerDigestLen)
}

func validateDockerEventID(value string) error {
	return validateSafeID(value, MaxEventIDLen)
}

func validateDockerAction(value string) error {
	if !dockerActionAllowlist[value] {
		return fmt.Errorf("unapproved event action")
	}
	return nil
}

func validateDockerHealth(value string) error {
	if value == "" {
		return nil
	}
	if !dockerHealthAllowlist[value] {
		return fmt.Errorf("unapproved health value")
	}
	return nil
}

func validateDockerGapReason(value string) error {
	if value == "" {
		return nil
	}
	if !dockerGapReasonAllowlist[value] {
		return fmt.Errorf("unapproved gap reason")
	}
	return nil
}

func validateDockerContextReason(value string) error {
	if value == "" {
		return nil
	}
	if !dockerContextReasonAllowlist[value] {
		return fmt.Errorf("unapproved context reason")
	}
	return nil
}

func validateDockerContextVersion(value int) error {
	if value != DockerEventContextVersion {
		return fmt.Errorf("unsupported event context version")
	}
	return nil
}

func validateDockerExitCode(v *int) error {
	if v == nil {
		return nil
	}
	if *v < 0 || *v > 255 {
		return fmt.Errorf("exit code out of range")
	}
	return nil
}

func validateDockerSignal(v *int) error {
	if v == nil {
		return nil
	}
	if *v < 0 || *v > 255 {
		return fmt.Errorf("signal out of range")
	}
	return nil
}

func validateDockerSkippedCount(v *int) error {
	if v == nil {
		return nil
	}
	if *v < 0 || *v > 10000 {
		return fmt.Errorf("skipped count out of range")
	}
	return nil
}

func validateDockerErrorCode(value string) error {
	if value == "" {
		return nil
	}
	switch value {
	case DockerErrorSocketMissing,
		DockerErrorPermissionDenied,
		DockerErrorTimeout,
		DockerErrorDaemonUnreachable,
		DockerErrorUnsupported,
		DockerErrorBadResponse:
		return nil
	}
	return fmt.Errorf("unapproved error code")
}

func validateDockerCoverage(c DockerCoverage) error {
	if c.DetailsSampled < 0 || c.DetailsSampled > MaxContainers {
		return fmt.Errorf("details sampled out of range")
	}
	if c.DetailsTotalEligible < 0 || c.DetailsTotalEligible > 10000 {
		return fmt.Errorf("details total eligible out of range")
	}
	if c.CohortDigest != "" {
		if err := validateDockerDigest(c.CohortDigest); err != nil {
			return err
		}
	}
	return nil
}

func validateDockerWatermark(w *DockerEventWatermark) error {
	if w == nil {
		return nil
	}
	if err := validateDockerNanoString(w.TimeNano); err != nil {
		return err
	}
	if len(w.BoundaryDigests) > MaxDockerBoundaryDigests {
		return fmt.Errorf("boundary digest overflow")
	}
	for _, d := range w.BoundaryDigests {
		if err := validateDockerDigest(d); err != nil {
			return err
		}
	}
	return nil
}

func validateDockerWindow(win *DockerEventWindow) error {
	if win == nil {
		return nil
	}
	if err := validateDockerNanoString(win.Since); err != nil {
		return err
	}
	if err := validateDockerNanoString(win.Until); err != nil {
		return err
	}
	if cmpCanonicalNano(win.Since, win.Until) >= 0 {
		return fmt.Errorf("invalid event window")
	}
	// Canonical lossy/gapReason consistency (API: lossy === (gapReason !== undefined)).
	if win.Lossy && win.GapReason == "" {
		return fmt.Errorf("lossy window requires gap reason")
	}
	if !win.Lossy && win.GapReason != "" {
		return fmt.Errorf("non-lossy window must not carry gap reason")
	}
	return validateDockerGapReason(win.GapReason)
}

func validateDockerEvent(e DockerEvent) error {
	if err := validateDockerEventID(e.EventID); err != nil {
		return err
	}
	if e.EventOccurredAt == "" {
		return fmt.Errorf("missing event time")
	}
	if err := validateDockerAction(e.Action); err != nil {
		return err
	}
	// Host-scope events (daemon_restarted, stream_gap) omit containerKey;
	// container-scope events require a valid opaque key.
	switch e.Action {
	case DockerActionDaemonRestart, DockerActionStreamGap:
		if e.ContainerKey != "" {
			if err := validateDockerContainerKey(e.ContainerKey); err != nil {
				return err
			}
		}
	default:
		if err := validateDockerContainerKey(e.ContainerKey); err != nil {
			return err
		}
	}
	if err := validateDockerContextVersion(e.Context.Version); err != nil {
		return err
	}
	if err := validateDockerHealth(e.Context.HealthStatus); err != nil {
		return err
	}
	if err := validateDockerExitCode(e.Context.ExitCode); err != nil {
		return err
	}
	if err := validateDockerSignal(e.Context.Signal); err != nil {
		return err
	}
	if err := validateDockerContextReason(e.Context.Reason); err != nil {
		return err
	}
	if e.Context.SkippedFromNano != "" {
		if err := validateDockerNanoString(e.Context.SkippedFromNano); err != nil {
			return err
		}
	}
	if e.Context.SkippedThroughNano != "" {
		if err := validateDockerNanoString(e.Context.SkippedThroughNano); err != nil {
			return err
		}
	}
	if err := validateDockerSkippedCount(e.Context.SkippedCount); err != nil {
		return err
	}
	return nil
}

// validateDockerBatch enforces the all-or-none event protocol:
// batchId/events/eventWindow/fromWatermark/proposedWatermark travel
// together. The batch is either fully absent (minimal snapshot, no event
// branch, no batchId) or fully present. Watermark binding retains
// from==since and enforces from <= proposed <= until (canonical decimal
// ordering): capped windows may report partial progress
// (since < proposed < until); uncapped complete windows and explicit lossy
// abandonment through U (boundary_overrun_abandoned, response_oversize,
// collection_deadline) must advance proposed exactly to until.
// boundary_overflow stays partial-tolerant: lossy overflow with
// proposed < until is accepted.
func validateDockerBatch(m DockerMetrics) error {
	hasBatch := m.BatchID != ""
	if m.Events != nil && *m.Events == nil {
		// A present-but-nil slice marshals as `"events":null`, which the
		// API array type rejects; fail closed agent-side.
		return fmt.Errorf("events branch must be an array, not null")
	}
	hasEvents := m.Events != nil
	hasWindow := m.EventWindow != nil
	hasFrom := m.FromWatermark != nil
	hasProposed := m.ProposedWatermark != nil
	present := 0
	for _, p := range []bool{hasBatch, hasEvents, hasWindow, hasFrom, hasProposed} {
		if p {
			present++
		}
	}
	if present != 0 && present != 5 {
		return fmt.Errorf("event batch must include batchId+events+eventWindow+fromWatermark+proposedWatermark together")
	}
	if present == 5 {
		if m.FromWatermark.TimeNano != m.EventWindow.Since {
			return fmt.Errorf("fromWatermark.timeNano must equal eventWindow.since")
		}
		// Range: from <= proposed <= until.
		if cmpCanonicalNano(m.FromWatermark.TimeNano, m.ProposedWatermark.TimeNano) > 0 {
			return fmt.Errorf("proposedWatermark.timeNano must not precede fromWatermark.timeNano")
		}
		if cmpCanonicalNano(m.ProposedWatermark.TimeNano, m.EventWindow.Until) > 0 {
			return fmt.Errorf("proposedWatermark.timeNano must not exceed eventWindow.until")
		}
		// Uncapped complete windows must advance exactly to until.
		if !m.EventWindow.Capped && !m.EventWindow.Lossy {
			if m.ProposedWatermark.TimeNano != m.EventWindow.Until {
				return fmt.Errorf("proposedWatermark.timeNano must equal eventWindow.until for uncapped complete windows")
			}
		}
		// Explicit lossy abandonment through U must advance exactly to until.
		// Applies to every abandonment-through-U gap reason:
		// boundary_overrun_abandoned, response_oversize, collection_deadline.
		// boundary_overflow remains partial-tolerant.
		switch {
		case m.EventWindow.Lossy && m.EventWindow.GapReason == DockerGapBoundaryOverrun,
			m.EventWindow.Lossy && m.EventWindow.GapReason == DockerGapResponseOversize,
			m.EventWindow.Lossy && m.EventWindow.GapReason == DockerGapCollectionDeadline:
			if m.ProposedWatermark.TimeNano != m.EventWindow.Until {
				return fmt.Errorf("proposedWatermark.timeNano must equal eventWindow.until for abandoned windows")
			}
		}
	}
	return nil
}

// validateDockerMetrics validates a full flat Docker wire payload against the
// canonical API contract: IDs/digests/enums, caps, window/watermark
// relations, event scoping, and storage shape.
func validateDockerMonitoringMetadata(m *DockerMonitoringMetadata) error {
	if m == nil {
		return nil
	}
	if m.EffectiveCadenceSeconds <= 0 || m.EffectiveCadenceSeconds > 86400 {
		return fmt.Errorf("effective cadence out of range")
	}
	if m.Availability != "available" && m.Availability != "unavailable" && m.Availability != "unknown" {
		return fmt.Errorf("invalid availability")
	}
	if m.State != "enabled" && m.State != "disabled" && m.State != "unknown" {
		return fmt.Errorf("invalid monitoring state")
	}
	return nil
}

var dockerDetailsReasons = map[string]bool{
	"timeout": true, "not_found": true, "permission_denied": true,
	"daemon_unreachable": true, "invalid_response": true, "budget_exhausted": true,
}

var dockerDetailsHealthStatuses = map[string]bool{
	"healthy": true, "unhealthy": true, "starting": true, "none": true,
}

// validateDetailTimestamp enforces the API `detailsTimestamp` contract: UTF-8,
// 1..256 bytes, UTC ISO-8601 (`...Z`) with up to 9 fraction digits, and never
// the Docker zero time `0001-01-01T00:00:00Z`.
func validateDetailTimestamp(value string) error {
	if !validDetailString(value, 256) {
		return fmt.Errorf("invalid details timestamp")
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || t.Location() != time.UTC || !strings.HasSuffix(value, "Z") || strings.Contains(value, "+") {
		return fmt.Errorf("invalid details timestamp")
	}
	rest := value[1+strings.IndexByte(value, 'T'):]
	if dot := strings.IndexByte(rest, '.'); dot >= 0 {
		frac := rest[dot+1 : len(rest)-1]
		if len(frac) < 1 || len(frac) > 9 {
			return fmt.Errorf("invalid details timestamp")
		}
	}
	if t.IsZero() {
		return fmt.Errorf("invalid details timestamp")
	}
	return nil
}

func validateDetailNonNegativeSafeInt(v int64) error {
	if v < 0 || v > 9007199254740991 {
		return fmt.Errorf("details integer out of range")
	}
	return nil
}

func validateDockerContainerDetails(d *DockerContainerDetails) error {
	if d == nil {
		return nil
	}
	if d.Status != "available" && d.Status != "unavailable" {
		return fmt.Errorf("invalid details status")
	}
	if err := validateDetailTimestamp(d.CollectedAt); err != nil {
		return err
	}
	if d.Status == "unavailable" {
		// Unavailable carries only collectedAt/status/reason: any scalar or
		// collection payload besides the reason is rejected outright.
		if !dockerDetailsReasons[d.Reason] {
			return fmt.Errorf("invalid details reason")
		}
		if d.CreatedAt != "" || d.StartedAt != "" || d.FinishedAt != "" ||
			d.ExitCode != nil || d.OOMKilled != nil || d.RestartCount != nil ||
			d.RestartPolicy != nil || d.Ports != nil || d.Mounts != nil ||
			d.Networks != nil || d.Healthcheck != nil {
			return fmt.Errorf("unavailable details must not carry payload")
		}
		return nil
	}
	if d.Reason != "" {
		return fmt.Errorf("available details must not carry reason")
	}
	for _, value := range []string{d.CreatedAt, d.StartedAt, d.FinishedAt} {
		if value != "" {
			if err := validateDetailTimestamp(value); err != nil {
				return err
			}
		}
	}
	// Available: required arrays (non-nil) and healthcheck.
	if d.Ports == nil || d.Mounts == nil || d.Networks == nil || d.Healthcheck == nil {
		return fmt.Errorf("available details require ports/mounts/networks/healthcheck")
	}
	if len(d.Ports) > dockerDetailsPortsMax || len(d.Mounts) > dockerDetailsMountsMax ||
		len(d.Networks) > dockerDetailsNetworksMax {
		return fmt.Errorf("details collection overflow")
	}
	if !dockerDetailsHealthStatuses[d.Healthcheck.Status] {
		return fmt.Errorf("invalid details health status")
	}
	checks := []*int{d.Healthcheck.FailingStreak, d.Healthcheck.Retries}
	for _, v := range checks {
		if v != nil {
			if err := validateDetailNonNegativeSafeInt(int64(*v)); err != nil {
				return err
			}
		}
	}
	for _, v := range []*int64{d.Healthcheck.IntervalMs, d.Healthcheck.TimeoutMs, d.Healthcheck.StartPeriodMs} {
		if v != nil {
			if err := validateDetailNonNegativeSafeInt(*v); err != nil {
				return err
			}
		}
	}
	if d.RestartCount != nil {
		if err := validateDetailNonNegativeSafeInt(int64(*d.RestartCount)); err != nil {
			return err
		}
	}
	if d.RestartPolicy != nil {
		if d.RestartPolicy.Name == "" || !validDetailString(d.RestartPolicy.Name, 32) {
			return fmt.Errorf("invalid restart policy details")
		}
		if err := validateDetailNonNegativeSafeInt(int64(d.RestartPolicy.MaximumRetryCount)); err != nil {
			return err
		}
	}
	if d.ExitCode != nil && (*d.ExitCode < 0 || *d.ExitCode > 255) {
		return fmt.Errorf("invalid details exit code")
	}
	for _, v := range d.Ports {
		if v.ContainerPort < 1 || v.ContainerPort > 65535 ||
			v.Protocol == "" || !validDetailString(v.Protocol, 32) || v.HostPort < 0 || v.HostPort > 65535 ||
			!validDetailString(v.HostIP, 256) {
			return fmt.Errorf("invalid port details")
		}
	}
	for _, v := range d.Mounts {
		if v.Type == "" || v.Destination == "" || !validDetailString(v.Type, 32) || !validDetailString(v.Source, 1024) ||
			!validDetailString(v.Destination, 1024) {
			return fmt.Errorf("invalid mount details")
		}
	}
	for _, v := range d.Networks {
		if v.Name == "" || !validDetailString(v.Name, 256) || !validDetailString(v.IPv4, 256) ||
			!validDetailString(v.IPv6, 256) || !validDetailString(v.Gateway, 256) {
			return fmt.Errorf("invalid network details")
		}
	}
	b, err := json.Marshal(d)
	if err != nil || len(b) > dockerDetailsBytesMax {
		return fmt.Errorf("details envelope exceeded")
	}
	return nil
}

func validateDockerMetrics(m DockerMetrics) error {
	if m.SchemaVersion != DockerMetricsSchemaVersion {
		return fmt.Errorf("schemaVersion %d, want %d", m.SchemaVersion, DockerMetricsSchemaVersion)
	}
	if err := validateDockerAgentInstanceID(m.AgentInstanceID); err != nil {
		return err
	}
	if err := validateDockerIdentity(m.SnapshotID, MaxSnapshotIDLen); err != nil {
		return err
	}
	if m.BatchID != "" {
		if err := validateDockerIdentity(m.BatchID, MaxBatchIDLen); err != nil {
			return err
		}
	}
	if err := validateDockerErrorCode(m.ErrorCode); err != nil {
		return err
	}
	if len(m.Containers) > MaxContainers {
		return fmt.Errorf("container overflow")
	}
	for _, c := range m.Containers {
		if err := validateDockerContainerKey(c.ContainerKey); err != nil {
			return err
		}
		if err := validateDockerHealth(c.Health); err != nil {
			return err
		}
		if err := validateDockerContainerDetails(c.Details); err != nil {
			return err
		}
	}
	if m.SampledContainerAggregate != nil {
		if err := validateDockerCoverage(m.SampledContainerAggregate.Coverage); err != nil {
			return err
		}
	}
	if m.Events != nil {
		if len(*m.Events) > MaxDockerEvents {
			return fmt.Errorf("event overflow")
		}
		for _, e := range *m.Events {
			if err := validateDockerEvent(e); err != nil {
				return err
			}
		}
	}
	if err := validateDockerWindow(m.EventWindow); err != nil {
		return err
	}
	if err := validateDockerWatermark(m.FromWatermark); err != nil {
		return err
	}
	if err := validateDockerWatermark(m.ProposedWatermark); err != nil {
		return err
	}
	if err := validateDockerBatch(m); err != nil {
		return err
	}
	if m.Storage != nil && m.Storage.FormulaVersion != DockerStorageFormulaVersion {
		return fmt.Errorf("unsupported storage formula version")
	}
	if err := validateDockerMonitoringMetadata(m.Monitoring); err != nil {
		return err
	}
	return nil
}

// sanitizeDockerDisplay truncates display-only strings. Identity, digest,
// action, and context-version fields are never truncated: they validate
// fail-closed via the validators above.
func sanitizeDockerDisplay(c DockerContainer) DockerContainer {
	c.Name = cappedString(c.Name, MaxNameLen)
	c.Image = cappedString(c.Image, MaxImageLen)
	c.State = cappedString(c.State, MaxStateLen)
	c.Status = cappedString(c.Status, MaxStatusLen)
	c.CreatedAt = cappedString(c.CreatedAt, MaxCreatedAtLen)
	c.CPUPercent = cappedDockerPercent(c.CPUPercent)
	c.MemoryUsageBytes = cappedDockerFloat(c.MemoryUsageBytes)
	c.MemoryLimitBytes = cappedDockerFloat(c.MemoryLimitBytes)
	c.NetworkRxBytes = cappedDockerFloat(c.NetworkRxBytes)
	c.NetworkTxBytes = cappedDockerFloat(c.NetworkTxBytes)
	c.BlockReadBytes = cappedDockerFloat(c.BlockReadBytes)
	c.BlockWriteBytes = cappedDockerFloat(c.BlockWriteBytes)
	if c.PIDs < 0 {
		c.PIDs = 0
	}
	return c
}
