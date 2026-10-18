package metrics

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// I0 contract: legacy collection shape is exactly preserved (it never
// reaches the wire; the payload derives separately from it).
func TestPhase1_LegacyCollectionContract(t *testing.T) {
	if MaxContainers != 20 {
		t.Fatalf("MaxContainers = %d, want 20", MaxContainers)
	}
	if MaxIDLen != 16 {
		t.Fatalf("MaxIDLen = %d, want 16", MaxIDLen)
	}
	m := unavailableDocker(DockerErrorSocketMissing)
	if m.Available {
		t.Fatalf("unavailable shape changed: %+v", m)
	}
	// Collection stays disabled by default; the payload adds no collection path.
	c := NewCollector()
	if c.isDockerEnabled() {
		t.Fatal("docker collection must stay disabled by default")
	}
}

// I0 contract: allowlisted GET builders use hardcoded paths, all GET, exact
// queries; stats requires a full 64-char hex ID; events take canonical
// decimal-string nanos with internally fixed filters.
func TestPhase1_AllowlistPaths(t *testing.T) {
	ctx := context.Background()
	base := "http://localhost"
	fullID := strings.Repeat("a", 64)

	req, err := dockerVersionRequest(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	assertGetRequest(t, req, "/version", map[string]string{})

	req, err = dockerListRequest(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	assertGetRequest(t, req, "/containers/json", map[string]string{"all": "1", "size": "false"})

	req, err = dockerStatsRequest(ctx, base, fullID)
	if err != nil {
		t.Fatal(err)
	}
	assertGetRequest(t, req, "/containers/"+fullID+"/stats", map[string]string{"stream": "false"})

	req, err = dockerSystemDFRequest(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	assertGetRequest(t, req, "/system/df", map[string]string{})

	since := "1767225590000000000"
	until := "1767225620000000000"
	req, err = dockerEventsRequest(ctx, base, since, until)
	if err != nil {
		t.Fatal(err)
	}
	if req.Method != "GET" {
		t.Fatalf("events method = %q, want GET", req.Method)
	}
	if req.URL.EscapedPath() != "/events" {
		t.Fatalf("events path = %q, want /events", req.URL.EscapedPath())
	}
	wantSince, err := formatDockerEventTimestamp(since)
	if err != nil {
		t.Fatal(err)
	}
	wantUntil, err := formatDockerEventTimestamp(until)
	if err != nil {
		t.Fatal(err)
	}
	if wantSince != "1767225590.000000000" {
		t.Fatalf("since encoding = %q, want 1767225590.000000000", wantSince)
	}
	if wantUntil != "1767225620.000000000" {
		t.Fatalf("until encoding = %q, want 1767225620.000000000", wantUntil)
	}
	q := req.URL.Query()
	if len(q) != 3 || q.Get("since") != wantSince || q.Get("until") != wantUntil || q.Get("filters") != dockerEventsFilters {
		t.Fatalf("events query must be exactly since+until+filters, got %v", q)
	}
}

func TestPhase1_StrictBaseURL(t *testing.T) {
	ctx := context.Background()
	bad := []string{
		"https://localhost",
		"http://localhost/v1",
		"http://localhost?x=1",
		"http://localhost#frag",
		"http://user@localhost",
		"://bad",
		"",
		"http://",
	}
	for _, b := range bad {
		if _, err := dockerVersionRequest(ctx, b); err == nil {
			t.Fatalf("base %q must be rejected", b)
		}
		if _, err := dockerListRequest(ctx, b); err == nil {
			t.Fatalf("base %q must be rejected", b)
		}
		if _, err := dockerSystemDFRequest(ctx, b); err == nil {
			t.Fatalf("base %q must be rejected", b)
		}
		if _, err := dockerEventsRequest(ctx, b, "1767225590000000000", "1767225620000000000"); err == nil {
			t.Fatalf("base %q must be rejected", b)
		}
	}
	// Trailing slash is normalized, not rejected.
	req, err := dockerVersionRequest(ctx, "http://localhost/")
	if err != nil {
		t.Fatalf("trailing slash base must normalize: %v", err)
	}
	assertGetRequest(t, req, "/version", map[string]string{})
}

func TestPhase1_StatsFullIDOnly(t *testing.T) {
	ctx := context.Background()
	fullID := strings.Repeat("a", 64)
	if !isDockerRawContainerID(fullID) {
		t.Fatal("full 64-char hex id must be accepted")
	}
	// Truncated display IDs, names, keys, traversal, and crafted segments fail closed.
	rejected := []string{
		"",
		"abc123",
		strings.Repeat("a", 63),
		strings.Repeat("a", 65),
		strings.Repeat("A", 64),
		strings.Repeat("g", 64),
		"../../events",
		"abc?since=1",
		"abc/def",
		"abc/../version",
		"x#frag",
		"a&x=1",
		"a\x00b",
		strings.Repeat("k", 32),
	}
	for _, id := range rejected {
		if _, err := dockerStatsRequest(ctx, "http://localhost", id); err == nil {
			t.Fatalf("id %q must be rejected", id)
		}
	}
	if _, err := dockerStatsRequest(ctx, "http://localhost", strings.Repeat("a", dockerMaxContainerID64+1)); err == nil {
		t.Fatal("oversize id must be rejected")
	}
}

func TestPhase1_EventsFixedFilters(t *testing.T) {
	// Filters are fixed at compile time: type=container plus the 9 container
	// lifecycle actions. stream_gap/daemon_restarted are synthesized locally.
	var decoded map[string][]string
	if err := json.Unmarshal([]byte(dockerEventsFilters), &decoded); err != nil {
		t.Fatalf("filters must be JSON: %v", err)
	}
	if len(decoded) != 2 {
		t.Fatalf("filters must have exactly event+type, got %v", decoded)
	}
	gotType := decoded["type"]
	if len(gotType) != 1 || gotType[0] != dockerEventsType {
		t.Fatalf("filters type = %v, want [container]", gotType)
	}
	if dockerEventsType != "container" {
		t.Fatalf("dockerEventsType = %q, want container", dockerEventsType)
	}
	wantActions := []string{"create", "start", "restart", "die", "stop", "kill", "destroy", "remove", "health_status"}
	gotActions := decoded["event"]
	if len(gotActions) != len(wantActions) {
		t.Fatalf("filters event = %v, want %v", gotActions, wantActions)
	}
	for i, w := range wantActions {
		if gotActions[i] != w {
			t.Fatalf("filters event = %v, want %v", gotActions, wantActions)
		}
	}
	for _, banned := range []string{"stream_gap", "daemon_restarted"} {
		for _, a := range gotActions {
			if a == banned {
				t.Fatalf("daemon filter must not request synthesized action %q", banned)
			}
		}
	}
	if len(dockerEventActionAllowlist) != len(wantActions) {
		t.Fatalf("action allowlist = %v, want %v", dockerEventActionAllowlist, wantActions)
	}
}

func TestPhase1_EventsCanonicalNanos(t *testing.T) {
	ctx := context.Background()
	base := "http://localhost"
	since := "1767225590000000000"
	until := "1767225620000000000"
	if len(since) != 19 || len(until) != 19 {
		t.Fatal("golden nanos must be 19 digits")
	}
	// Non-canonical nanos fail closed.
	for _, bad := range []string{"", "01", "00", "-5", " 1", "1 ", "+1", "1.0", "abc", strings.Repeat("1", 33)} {
		if _, err := dockerEventsRequest(ctx, base, bad, until); err == nil {
			t.Fatalf("since %q must be rejected", bad)
		}
		if _, err := dockerEventsRequest(ctx, base, since, bad); err == nil {
			t.Fatalf("until %q must be rejected", bad)
		}
		if _, err := formatDockerEventTimestamp(bad); err == nil {
			t.Fatalf("format(%q) must be rejected", bad)
		}
		if err := validateDockerNanoString(bad); err == nil {
			t.Fatalf("nano %q must be rejected", bad)
		}
	}
	// Equal and inverted windows rejected (canonical decimal ordering).
	if _, err := dockerEventsRequest(ctx, base, until, until); err == nil {
		t.Fatal("equal window must be rejected")
	}
	if _, err := dockerEventsRequest(ctx, base, until, since); err == nil {
		t.Fatal("inverted window must be rejected")
	}
	// Zero is canonical but zero-length windows still fail ordering.
	if !isCanonicalNanoDecimal("0") || isCanonicalNanoDecimal("01") {
		t.Fatal("canonical nano predicate mismatch")
	}
	if cmpCanonicalNano(since, until) >= 0 || cmpCanonicalNano(until, since) <= 0 || cmpCanonicalNano(since, since) != 0 {
		t.Fatal("canonical nano ordering mismatch")
	}
}

// goldenMetrics builds the canonical cross-language golden object: flat
// top-level batch fields, decimal-string exact nanoseconds (19-digit),
// ISO eventOccurredAt source timestamps, max-length IDs/digests.
func goldenMetrics() DockerMetrics {
	since := "1767225590000000000"
	until := "1767225620000000000"
	exit := 137
	skipped := 3
	oom := true
	return DockerMetrics{
		CollectedAt:      "2026-01-01T00:00:30Z",
		SchemaVersion:    DockerMetricsSchemaVersion,
		AgentInstanceID:  strings.Repeat("a", 32),
		SnapshotID:       strings.Repeat("b", 64),
		BatchID:          strings.Repeat("c", 64),
		Available:        true,
		ContainerTotal:   2,
		ContainerRunning: 1,
		CPUPercent:       5,
		MemoryUsageBytes: 1024,
		NetworkRxBytes:   10,
		NetworkTxBytes:   10,
		BlockReadBytes:   10,
		BlockWriteBytes:  10,
		PIDs:             2,
		Containers: []DockerContainer{
			{
				ContainerKey: strings.Repeat("k", 32), ID: "abc123def456", Name: "/web-nginx",
				Image: "nginx:1.25", State: "running", Status: "Up 3 hours",
				CPUPercent: 12.3, MemoryUsageBytes: 65536000,
				NetworkRxBytes: 800000, NetworkTxBytes: 400000,
				BlockReadBytes: 50000, BlockWriteBytes: 20000, PIDs: 12,
			},
		},
		SampledContainerAggregate: &DockerSampledContainerAggregate{
			Coverage:         DockerCoverage{DetailsSampled: 1, DetailsTotalEligible: 2, Complete: false, CohortDigest: strings.Repeat("d", 64)},
			CPUPercent:       5,
			MemoryUsageBytes: 1024,
			NetworkRxBytes:   10,
			NetworkTxBytes:   10,
			BlockReadBytes:   10,
			BlockWriteBytes:  10,
			PIDs:             2,
		},
		Events: &[]DockerEvent{
			{
				EventID:         strings.Repeat("e", 128),
				EventOccurredAt: "2026-01-01T00:00:10Z",
				ContainerKey:    strings.Repeat("k", 32),
				Action:          DockerActionDie,
				Context:         DockerEventContext{Version: DockerEventContextVersion, ExitCode: &exit, OOMKilled: &oom},
			},
			{
				EventID:         "gap1",
				EventOccurredAt: "2026-01-01T00:00:20Z",
				Action:          DockerActionStreamGap,
				Context: DockerEventContext{
					Version: DockerEventContextVersion, Reason: DockerGapBoundaryOverflow,
					SkippedFromNano: since, SkippedThroughNano: until, SkippedCount: &skipped,
				},
			},
		},
		EventWindow:       &DockerEventWindow{Since: since, Until: until, Capped: true, Lossy: true, GapReason: DockerGapBoundaryOverflow},
		FromWatermark:     &DockerEventWatermark{TimeNano: since, BoundaryDigests: []string{strings.Repeat("f", 64)}},
		ProposedWatermark: &DockerEventWatermark{TimeNano: until, BoundaryDigests: []string{}},
		Storage: &DockerStorageAggregate{
			FormulaVersion: DockerStorageFormulaVersion,
			Images:         DockerStorageCategory{Supported: true, Count: 2, TotalBytes: 1000, ReclaimableSupported: false},
			Containers:     DockerStorageCategory{Supported: true, Count: 1, TotalBytes: 500, ReclaimableBytes: 0},
			LocalVolumes:   DockerStorageCategory{Supported: false, Count: 0, TotalBytes: 0},
			BuildCache:     DockerStorageCategory{Supported: false, Count: 0, TotalBytes: 0},
		},
	}
}

// I0 contract: marshalled Docker DTOs contain only approved bounded flat fields
// with canonical 19-digit nanos and ISO event timestamps.
func TestPhase1_GoldenFlatJSON(t *testing.T) {
	v := goldenMetrics()
	if err := validateDockerMetrics(v); err != nil {
		t.Fatalf("golden metrics must validate: %v", err)
	}
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	// Canonical 19-digit nanos and ISO event timestamps are the agreed shapes.
	for _, want := range []string{`"since":"1767225590000000000"`, `"until":"1767225620000000000"`, `"timeNano":"1767225590000000000"`, `"timeNano":"1767225620000000000"`, `"eventOccurredAt":"2026-01-01T00:00:10Z"`, `"eventOccurredAt":"2026-01-01T00:00:20Z"`} {
		if !strings.Contains(s, want) {
			t.Fatalf("golden JSON missing %s: %s", want, s)
		}
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	allowedTop := map[string]bool{
		"collectedAt": true, "agentVersion": true, "engineVersion": true, "apiVersion": true,
		"os": true, "architecture": true, "schemaVersion": true,
		"agentInstanceId": true, "snapshotId": true, "sourceSequence": true, "batchId": true,
		"available": true, "errorCode": true,
		"containerTotal": true, "containerRunning": true,
		"cpuPercent": true, "memoryUsageBytes": true, "memoryLimitBytes": true,
		"networkRxBytes": true, "networkTxBytes": true,
		"blockReadBytes": true, "blockWriteBytes": true, "pids": true,
		"containers": true, "sampledContainerAggregate": true,
		"events": true, "eventWindow": true, "fromWatermark": true, "proposedWatermark": true,
		"storage": true,
	}
	for k := range m {
		if !allowedTop[k] {
			t.Fatalf("top-level key %q not in flat Docker allowlist: %s", k, raw)
		}
	}
	// Flat plan: legacy nested batch/window envelopes must not exist.
	// NOTE: `"coverage":` is intentionally NOT banned as a raw substring:
	// the canonical shape nests it at sampledContainerAggregate.coverage.
	// Legacy top-level coverage/eventBatch are rejected structurally via the
	// allowedTop map check above plus the explicit guards below.
	if _, ok := m["coverage"]; ok {
		t.Fatalf("flat Docker must not contain legacy top-level coverage: %s", raw)
	}
	if _, ok := m["eventBatch"]; ok {
		t.Fatalf("flat Docker must not contain legacy top-level eventBatch: %s", raw)
	}
	for _, bannedKey := range []string{`"eventBatch"`, `"window":`, `"sinceNano"`, `"untilNano"`, `"eventTimeNano"`, `"contextVersion"`} {
		if strings.Contains(s, bannedKey) {
			t.Fatalf("flat Docker must not contain legacy field %s: %s", bannedKey, s)
		}
	}
	// Event shape: flat fields with nested context only.
	var decoded DockerMetrics
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Events == nil || len(*decoded.Events) != 2 {
		t.Fatalf("events = %+v, want 2", decoded.Events)
	}
	if (*decoded.Events)[0].Action != "die" || (*decoded.Events)[0].ContainerKey != strings.Repeat("k", 32) {
		t.Fatalf("event0 mismatch: %+v", (*decoded.Events)[0])
	}
	if decoded.EventWindow.Since != "1767225590000000000" || decoded.FromWatermark.TimeNano != "1767225590000000000" || decoded.ProposedWatermark.TimeNano != "1767225620000000000" {
		t.Fatalf("watermark/window binding broken: %+v", decoded)
	}
	assertJSONHasNoForbiddenKeys(t, raw,
		"env", "Env", "ENV", "labels", "Labels",
		"command", "Command", "args", "Args", "entrypoint", "Entrypoint",
		"log", "Log", "logs", "Logs", "secret", "Secret", "config", "Config",
		"inspect", "Inspect", "volumeName", "mountPoint", "layerId", "cacheRecord",
		"objectName")
	assertJSONOmitsValues(t, raw, "hunter2")
}

func TestPhase1_AllOrNone(t *testing.T) {
	full := goldenMetrics()
	if err := validateDockerBatch(full); err != nil {
		t.Fatalf("full batch must validate: %v", err)
	}
	// Events alone without window/watermarks is partial.
	partial := goldenMetrics()
	partial.EventWindow = nil
	partial.FromWatermark = nil
	partial.ProposedWatermark = nil
	if err := validateDockerBatch(partial); err == nil {
		t.Fatal("events without window/watermarks must be rejected")
	}
	// Window alone without events/watermarks is partial.
	windowOnly := goldenMetrics()
	windowOnly.Events = nil
	windowOnly.FromWatermark = nil
	windowOnly.ProposedWatermark = nil
	if err := validateDockerBatch(windowOnly); err == nil {
		t.Fatal("window without events/watermarks must be rejected")
	}
	// Empty (no event branch at all, no batchId) is valid: minimal snapshot.
	empty := goldenMetrics()
	empty.BatchID = ""
	empty.Events = nil
	empty.EventWindow = nil
	empty.FromWatermark = nil
	empty.ProposedWatermark = nil
	if err := validateDockerBatch(empty); err != nil {
		t.Fatalf("empty event branch must validate: %v", err)
	}
	if err := validateDockerMetrics(empty); err != nil {
		t.Fatalf("minimal snapshot must validate: %v", err)
	}
}

func TestPhase1_BatchIDAllOrNone(t *testing.T) {
	// Complete batch (batchId + events + window + both watermarks) validates.
	complete := goldenMetrics()
	if err := validateDockerBatch(complete); err != nil {
		t.Fatalf("complete batch must validate: %v", err)
	}
	if err := validateDockerMetrics(complete); err != nil {
		t.Fatalf("complete batch metrics must validate: %v", err)
	}
	// Missing batchId with the rest of the event branch present is partial.
	missingBatch := goldenMetrics()
	missingBatch.BatchID = ""
	if err := validateDockerBatch(missingBatch); err == nil {
		t.Fatal("event branch without batchId must be rejected")
	}
	if err := validateDockerMetrics(missingBatch); err == nil {
		t.Fatal("metrics with event branch but missing batchId must be rejected")
	}
	// BatchId alone without any event branch members is partial.
	batchAlone := goldenMetrics()
	batchAlone.Events = nil
	batchAlone.EventWindow = nil
	batchAlone.FromWatermark = nil
	batchAlone.ProposedWatermark = nil
	if batchAlone.BatchID == "" {
		t.Fatal("golden fixture must carry a batchId for the batch-alone case")
	}
	if err := validateDockerBatch(batchAlone); err == nil {
		t.Fatal("batchId alone without event branch must be rejected")
	}
	if err := validateDockerMetrics(batchAlone); err == nil {
		t.Fatal("metrics with batchId alone must be rejected")
	}
	// Malformed batchId shape still fails even when the batch is complete.
	badShape := goldenMetrics()
	badShape.BatchID = "has space!"
	if err := validateDockerMetrics(badShape); err == nil {
		t.Fatal("malformed batchId must be rejected")
	}
}

func TestPhase1_WindowWatermarkRelations(t *testing.T) {
	mk := func(since, until string, capped, lossy bool, gap string) DockerMetrics {
		v := goldenMetrics()
		v.EventWindow = &DockerEventWindow{Since: since, Until: until, Capped: capped, Lossy: lossy, GapReason: gap}
		v.FromWatermark = &DockerEventWatermark{TimeNano: since, BoundaryDigests: []string{}}
		v.ProposedWatermark = &DockerEventWatermark{TimeNano: until, BoundaryDigests: []string{}}
		return v
	}
	since := "1767225590000000000"
	until := "1767225620000000000"
	// Equal and inverted windows rejected.
	if err := validateDockerWindow(&DockerEventWindow{Since: until, Until: until}); err == nil {
		t.Fatal("equal window must be rejected")
	}
	if err := validateDockerWindow(&DockerEventWindow{Since: until, Until: since}); err == nil {
		t.Fatal("inverted window must be rejected")
	}
	// lossy/gapReason consistency.
	if err := validateDockerMetrics(mk(since, until, true, true, "")); err == nil {
		t.Fatal("lossy=true without gapReason must be rejected")
	}
	if err := validateDockerMetrics(mk(since, until, false, false, DockerGapBoundaryOverflow)); err == nil {
		t.Fatal("lossy=false with gapReason must be rejected")
	}
	if err := validateDockerMetrics(mk(since, until, true, true, DockerGapBoundaryOverflow)); err != nil {
		t.Fatalf("lossy gap must validate: %v", err)
	}
	// Watermark/window binding: since=S=from, from <= proposed <= until.
	mismatched := goldenMetrics()
	mismatched.FromWatermark = &DockerEventWatermark{TimeNano: "1", BoundaryDigests: []string{}}
	if err := validateDockerBatch(mismatched); err == nil {
		t.Fatal("fromWatermark != since must be rejected")
	}
	// Proposed before from is out of range.
	mismatched = goldenMetrics()
	mismatched.ProposedWatermark = &DockerEventWatermark{TimeNano: "1", BoundaryDigests: []string{}}
	if err := validateDockerBatch(mismatched); err == nil {
		t.Fatal("proposedWatermark before fromWatermark must be rejected")
	}
	// Proposed beyond until is out of range.
	mismatched = goldenMetrics()
	mismatched.EventWindow = &DockerEventWindow{Since: since, Until: until, Capped: false, Lossy: false}
	mismatched.FromWatermark = &DockerEventWatermark{TimeNano: since, BoundaryDigests: []string{}}
	mismatched.ProposedWatermark = &DockerEventWatermark{TimeNano: until + "0", BoundaryDigests: []string{}}
	if err := validateDockerBatch(mismatched); err == nil {
		t.Fatal("proposedWatermark beyond until must be rejected")
	}
	// Digest cap enforced.
	many := make([]string, MaxDockerBoundaryDigests+1)
	for i := range many {
		many[i] = "d"
	}
	if err := validateDockerWatermark(&DockerEventWatermark{TimeNano: since, BoundaryDigests: many}); err == nil {
		t.Fatal("257 digests must be rejected")
	}
}

func TestPhase1_ProposedWatermarkRange(t *testing.T) {
	since := "1767225590000000000"
	mid := "1767225605000000000"
	until := "1767225620000000000"
	mkBatch := func(win *DockerEventWindow, proposed string) DockerMetrics {
		v := goldenMetrics()
		v.EventWindow = win
		v.FromWatermark = &DockerEventWatermark{TimeNano: since, BoundaryDigests: []string{}}
		v.ProposedWatermark = &DockerEventWatermark{TimeNano: proposed, BoundaryDigests: []string{}}
		return v
	}
	// Capped non-lossy windows permit partial progress: since < proposed < until.
	partial := mkBatch(&DockerEventWindow{Since: since, Until: until, Capped: true, Lossy: false}, mid)
	if err := validateDockerBatch(partial); err != nil {
		t.Fatalf("capped partial progress must validate: %v", err)
	}
	if err := validateDockerMetrics(partial); err != nil {
		t.Fatalf("capped partial progress metrics must validate: %v", err)
	}
	// Uncapped complete windows require proposed == until.
	complete := mkBatch(&DockerEventWindow{Since: since, Until: until, Capped: false, Lossy: false}, until)
	if err := validateDockerBatch(complete); err != nil {
		t.Fatalf("uncapped complete window must validate: %v", err)
	}
	short := mkBatch(&DockerEventWindow{Since: since, Until: until, Capped: false, Lossy: false}, mid)
	if err := validateDockerBatch(short); err == nil {
		t.Fatal("uncapped window with proposed < until must be rejected")
	}
	if err := validateDockerMetrics(short); err == nil {
		t.Fatal("uncapped short metrics must be rejected")
	}
	// Explicit lossy windows through U validate for every plan gap reason.
	for _, reason := range []string{DockerGapBoundaryOverflow, DockerGapBoundaryOverrun, DockerGapResponseOversize, DockerGapCollectionDeadline} {
		abandoned := mkBatch(&DockerEventWindow{Since: since, Until: until, Capped: true, Lossy: true, GapReason: reason}, until)
		if err := validateDockerBatch(abandoned); err != nil {
			t.Fatalf("lossy %q through U must validate: %v", reason, err)
		}
	}
	abandoned := mkBatch(&DockerEventWindow{Since: since, Until: until, Capped: true, Lossy: true, GapReason: DockerGapBoundaryOverrun}, until)
	if err := validateDockerBatch(abandoned); err != nil {
		t.Fatalf("abandoned window through U must validate: %v", err)
	}
	shortAbandoned := mkBatch(&DockerEventWindow{Since: since, Until: until, Capped: true, Lossy: true, GapReason: DockerGapBoundaryOverrun}, mid)
	if err := validateDockerBatch(shortAbandoned); err == nil {
		t.Fatal("abandoned window with proposed < until must be rejected")
	}
	if err := validateDockerMetrics(shortAbandoned); err == nil {
		t.Fatal("abandoned short metrics must be rejected")
	}
}

func TestPhase1_AbandonmentThroughU(t *testing.T) {
	since := "1767225590000000000"
	mid := "1767225605000000000"
	until := "1767225620000000000"
	mkBatch := func(win *DockerEventWindow, proposed string) DockerMetrics {
		v := goldenMetrics()
		v.EventWindow = win
		v.FromWatermark = &DockerEventWatermark{TimeNano: since, BoundaryDigests: []string{}}
		v.ProposedWatermark = &DockerEventWatermark{TimeNano: proposed, BoundaryDigests: []string{}}
		return v
	}
	// Each abandonment-through-U gap reason: partial proposed<until rejected,
	// equality proposed==until accepted (both batch and full-metrics paths).
	abandonment := []string{DockerGapBoundaryOverrun, DockerGapResponseOversize, DockerGapCollectionDeadline}
	for _, reason := range abandonment {
		reason := reason
		t.Run("abandon/"+reason+"/partial_rejected", func(t *testing.T) {
			partial := mkBatch(&DockerEventWindow{Since: since, Until: until, Capped: true, Lossy: true, GapReason: reason}, mid)
			if err := validateDockerBatch(partial); err == nil {
				t.Fatalf("lossy %q with proposed<until must be rejected", reason)
			}
			if err := validateDockerMetrics(partial); err == nil {
				t.Fatalf("lossy %q metrics with proposed<until must be rejected", reason)
			}
		})
		t.Run("abandon/"+reason+"/equality_accepted", func(t *testing.T) {
			equal := mkBatch(&DockerEventWindow{Since: since, Until: until, Capped: true, Lossy: true, GapReason: reason}, until)
			if err := validateDockerBatch(equal); err != nil {
				t.Fatalf("lossy %q through U must validate: %v", reason, err)
			}
			if err := validateDockerMetrics(equal); err != nil {
				t.Fatalf("lossy %q metrics through U must validate: %v", reason, err)
			}
		})
	}
	// Partial boundary_overflow remains accepted.
	t.Run("partial_boundary_overflow_accepted", func(t *testing.T) {
		partial := mkBatch(&DockerEventWindow{Since: since, Until: until, Capped: true, Lossy: true, GapReason: DockerGapBoundaryOverflow}, mid)
		if err := validateDockerBatch(partial); err != nil {
			t.Fatalf("partial boundary_overflow must validate: %v", err)
		}
		if err := validateDockerMetrics(partial); err != nil {
			t.Fatalf("partial boundary_overflow metrics must validate: %v", err)
		}
	})
	// Capped non-lossy partial progress remains accepted.
	t.Run("capped_nonlossy_partial_accepted", func(t *testing.T) {
		partial := mkBatch(&DockerEventWindow{Since: since, Until: until, Capped: true, Lossy: false}, mid)
		if err := validateDockerBatch(partial); err != nil {
			t.Fatalf("capped non-lossy partial must validate: %v", err)
		}
		if err := validateDockerMetrics(partial); err != nil {
			t.Fatalf("capped non-lossy partial metrics must validate: %v", err)
		}
	})
}

func TestPhase1_ContainerKeyScoping(t *testing.T) {
	// die without containerKey rejected.
	e := DockerEvent{EventID: "e1", EventOccurredAt: "2026-01-01T00:00:10Z", Action: DockerActionDie, Context: DockerEventContext{Version: 1}}
	if err := validateDockerEvent(e); err == nil {
		t.Fatal("die without containerKey must be rejected")
	}
	// stream_gap and daemon_restarted may omit containerKey.
	for _, action := range []string{DockerActionStreamGap, DockerActionDaemonRestart} {
		e := DockerEvent{EventID: "h_" + action, EventOccurredAt: "2026-01-01T00:00:10Z", Action: action, Context: DockerEventContext{Version: 1}}
		if err := validateDockerEvent(e); err != nil {
			t.Fatalf("host-scope %q must validate: %v", action, err)
		}
	}
}

func TestPhase1_ExactEnumsIDsDigests(t *testing.T) {
	v := goldenMetrics()
	if err := validateDockerMetrics(v); err != nil {
		t.Fatalf("golden must validate: %v", err)
	}
	// ID/digest exact limits: instance/container 32, snapshot/batch 64, event 128, digest 64.
	cases := []struct {
		name string
		mut  func(*DockerMetrics)
	}{
		{"instance32", func(m *DockerMetrics) { m.AgentInstanceID = strings.Repeat("a", 33) }},
		{"snapshot64", func(m *DockerMetrics) { m.SnapshotID = strings.Repeat("b", 65) }},
		{"batch64", func(m *DockerMetrics) { m.BatchID = strings.Repeat("c", 65) }},
		{"event128", func(m *DockerMetrics) { (*m.Events)[0].EventID = strings.Repeat("e", 129) }},
		{"digest64", func(m *DockerMetrics) { m.FromWatermark.BoundaryDigests = []string{strings.Repeat("f", 65)} }},
		{"cohort64", func(m *DockerMetrics) { m.SampledContainerAggregate.Coverage.CohortDigest = strings.Repeat("d", 65) }},
		{"badIDCharset", func(m *DockerMetrics) { m.AgentInstanceID = "has space!" }},
	}
	for _, tc := range cases {
		mut := goldenMetrics()
		tc.mut(&mut)
		if err := validateDockerMetrics(mut); err == nil {
			t.Fatalf("%s must be rejected", tc.name)
		}
	}
	// Enums: unknown action/health/gap/context-version rejected.
	badEvent := DockerEvent{EventID: "e1", EventOccurredAt: "2026-01-01T00:00:10Z", ContainerKey: strings.Repeat("k", 32), Action: "exec_start", Context: DockerEventContext{Version: 1}}
	if err := validateDockerEvent(badEvent); err == nil {
		t.Fatal("unknown action must be rejected")
	}
	badHealth := goldenMetrics()
	badHealth.Containers[0].Health = "mystery"
	if err := validateDockerMetrics(badHealth); err == nil {
		t.Fatal("unknown health must be rejected")
	}
	if err := validateDockerGapReason("mystery"); err == nil {
		t.Fatal("unknown gapReason must be rejected")
	}
	if err := validateDockerContextVersion(99); err == nil {
		t.Fatal("unknown context version must be rejected")
	}
	// Exit/signal 0..255; skippedCount 0..10000.
	bad := 10001
	if err := validateDockerExitCode(&bad); err == nil {
		t.Fatal("exit 999 must be rejected")
	}
	if err := validateDockerSignal(&bad); err == nil {
		t.Fatal("signal 999 must be rejected")
	}
	if err := validateDockerSkippedCount(&bad); err == nil {
		t.Fatal("skippedCount 10001 must be rejected")
	}
	over := 10001
	if err := validateDockerSkippedCount(&over); err == nil {
		t.Fatal("skippedCount 10001 must be rejected")
	}
	// Error codes are the exact legacy enum.
	if err := validateDockerErrorCode("mystery"); err == nil {
		t.Fatal("unknown errorCode must be rejected")
	}
	if err := validateDockerErrorCode(DockerErrorSocketMissing); err != nil {
		t.Fatalf("known errorCode must validate: %v", err)
	}
	// Storage formula version is exactly 1.
	badStorage := goldenMetrics()
	badStorage.Storage.FormulaVersion = 2
	if err := validateDockerMetrics(badStorage); err == nil {
		t.Fatal("storage formulaVersion != 1 must be rejected")
	}
	// Caps: 100 events.
	many := goldenMetrics()
	manyEvents := make([]DockerEvent, MaxDockerEvents+1)
	for i := range manyEvents {
		manyEvents[i] = DockerEvent{EventID: "e", EventOccurredAt: "2026-01-01T00:00:10Z", ContainerKey: strings.Repeat("k", 32), Action: "die", Context: DockerEventContext{Version: 1}}
	}
	many.Events = &manyEvents
	// Rebind watermarks so only the count fails.
	many.EventWindow = &DockerEventWindow{Since: "1", Until: "2"}
	many.FromWatermark = &DockerEventWatermark{TimeNano: "1", BoundaryDigests: []string{}}
	many.ProposedWatermark = &DockerEventWatermark{TimeNano: "2", BoundaryDigests: []string{}}
	if err := validateDockerMetrics(many); err == nil {
		t.Fatal("101 events must be rejected")
	}
	if MaxDockerEvents != 100 || MaxDockerBoundaryDigests != 256 || MaxDockerEventBranchBytes != 64*1024 || MaxDockerSystemDFBytes != 256*1024 {
		t.Fatal("Docker caps changed")
	}
}

// I0 contract: identity/digest/action/version fields are fail-closed and
// never truncated; only display strings truncate.
func TestPhase1_NoTruncation(t *testing.T) {
	if err := validateDockerAgentInstanceID(strings.Repeat("a", 33)); err == nil {
		t.Fatal("overlong instance id must be rejected, not truncated")
	}
	if err := validateDockerContainerKey("has space!"); err == nil {
		t.Fatal("bad charset key must be rejected, not truncated")
	}
	if err := validateDockerDigest(strings.Repeat("d", 65)); err == nil {
		t.Fatal("overlong digest must be rejected, not truncated")
	}
	if err := validateDockerAction(strings.Repeat("a", 200)); err == nil {
		t.Fatal("overlong action must be rejected, not truncated")
	}
	c := sanitizeDockerDisplay(DockerContainer{
		ContainerKey: strings.Repeat("k", 100), ID: strings.Repeat("i", 100),
		Name: strings.Repeat("n", 500), Image: strings.Repeat("g", 500),
		State: strings.Repeat("s", 500), Status: strings.Repeat("t", 500),
		CreatedAt:  strings.Repeat("c", 500),
		CPUPercent: -5, MemoryUsageBytes: -1, NetworkRxBytes: 1e30, PIDs: -2,
	})
	// Identity fields are untouched by the display sanitizer.
	if len(c.ContainerKey) != 100 || len(c.ID) != 100 {
		t.Fatalf("identity fields must never truncate: %+v", c)
	}
	if len(c.Name) != MaxNameLen || len(c.Image) != MaxImageLen || len(c.State) != MaxStateLen || len(c.Status) != MaxStatusLen || len(c.CreatedAt) != MaxCreatedAtLen {
		t.Fatalf("display strings not capped: %+v", c)
	}
	if c.CPUPercent != 0 || c.MemoryUsageBytes != 0 || c.NetworkRxBytes != MaxSafeJSONNumberFloat || c.PIDs != 0 {
		t.Fatalf("numerics not clamped: %+v", c)
	}
}
