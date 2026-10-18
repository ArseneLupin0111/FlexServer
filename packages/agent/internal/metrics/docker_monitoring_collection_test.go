package metrics

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func testKeyForID(id string) string {
	if id == "" {
		return "invalid key with spaces!!"
	}
	// Deterministic opaque 32-char-ish safe key derived from actor id suffix.
	s := strings.ReplaceAll(id, "-", "")
	s = strings.ReplaceAll(s, "_", "")
	if len(s) < 4 {
		s += "0000"
	}
	k := "k-" + s
	for len(k) < 8 {
		k += "0"
	}
	if len(k) > 32 {
		k = k[:32]
	}
	return k
}

func testEventJSON(n int, nano int64) string {
	var sb strings.Builder
	for i := 0; i < n; i++ {
		fmt.Fprintf(&sb, `{"Type":"container","Action":"die","Actor":{"ID":"actor-%04d","Attributes":{}},"time":1767225600,"timeNano":%d}`+"\n", i, nano)
	}
	return sb.String()
}

func validateBatchShape(t *testing.T, evs []DockerEvent, win *DockerEventWindow, prop *DockerEventWatermark, since string) {
	t.Helper()
	m := DockerMetrics{
		AgentInstanceID: strings.Repeat("a", 32),
		SnapshotID:      strings.Repeat("b", 64), BatchID: strings.Repeat("c", 64),
		SchemaVersion: DockerMetricsSchemaVersion,
		Available:     true, Events: &evs, EventWindow: win,
		FromWatermark:     &DockerEventWatermark{TimeNano: since, BoundaryDigests: []string{}},
		ProposedWatermark: prop,
	}
	if err := validateDockerBatch(m); err != nil {
		t.Fatalf("batch shape must validate: %v (win=%+v prop=%+v events=%d)", err, win, prop, len(evs))
	}
	if err := validateDockerMetrics(m); err != nil {
		t.Fatalf("metrics must validate: %v", err)
	}
	raw, _ := json.Marshal(m)
	if len(raw) > 0 && len(evs) > MaxDockerEvents {
		t.Fatalf("transmit events %d exceeds cap", len(evs))
	}
}

func TestI2_EventProviderPendingSuppressesWindow(t *testing.T) {
	c := NewCollector()
	c.SetDockerEventInputProvider(func() (DockerEventInput, bool) {
		return DockerEventInput{}, false
	})
	// The provider's false result is the durable pending gate (production
	// wiring lives in run.DockerEventInput; this synthetic provider
	// exercises the collector side of the same contract); no API call is
	// needed and the output must remain free of an event window.
	out := &DockerMetrics{}
	c.collectDockerAPI(context.Background(), out)
	if out.EventWindow != nil || out.Events != nil {
		t.Fatalf("pending provider must suppress event window: %+v", out)
	}
}

func TestI2_DefaultContainerKeyOpaqueAndStable(t *testing.T) {
	id := "very-secret-container-id-123"
	one := defaultDockerContainerKey(id)
	two := defaultDockerContainerKey(id)
	if one != two || len(one) != MaxContainerKeyLen || strings.Contains(one, id) {
		t.Fatalf("key must be stable and opaque: %q %q", one, two)
	}
	if other := defaultDockerContainerKey(id + "x"); other == one {
		t.Fatal("different IDs must derive different keys")
	}
}

func TestI2_RotationPartialCoverage(t *testing.T) {
	in := []DockerSelection{
		{ContainerKey: "k-0003"}, {ContainerKey: "k-0001"}, {ContainerKey: "k-0002", Running: true},
		{ContainerKey: "k-0004", Running: true, Unhealthy: true}, {ContainerKey: "k-0005", StateChanged: true},
	}
	sel := selectDockerContainers(in, 3, 0)
	if len(sel) != 3 {
		t.Fatalf("len=%d want 3", len(sel))
	}
	// Priority: unhealthy/state-changed first by key, then running.
	if sel[0].ContainerKey != "k-0004" || sel[1].ContainerKey != "k-0005" || sel[2].ContainerKey != "k-0002" {
		t.Fatalf("priority order wrong: %+v", sel)
	}
	// Rotation only affects the non-priority tail.
	tail := []DockerSelection{{ContainerKey: "k-b"}, {ContainerKey: "k-a"}, {ContainerKey: "k-c"}}
	r0 := selectDockerContainers(tail, 2, 0)
	r1 := selectDockerContainers(tail, 2, 1)
	if len(r0) != 2 || len(r1) != 2 || r0[0].ContainerKey == r1[0].ContainerKey {
		t.Fatalf("rotation must vary tail: %+v vs %+v", r0, r1)
	}
	// Input never mutated.
	if in[0].ContainerKey != "k-0003" {
		t.Fatal("input mutated")
	}
	// Partial coverage: aggregates cover only sampled containers.
	sampled := []DockerContainer{
		{ContainerKey: "k-1", CPUPercent: 10, MemoryUsageBytes: 100, NetworkRxBytes: 1, NetworkTxBytes: 2, BlockReadBytes: 3, BlockWriteBytes: 4, PIDs: 1},
		{ContainerKey: "k-2", CPUPercent: 20, MemoryUsageBytes: 200, NetworkRxBytes: 10, NetworkTxBytes: 20, BlockReadBytes: 30, BlockWriteBytes: 40, PIDs: 2},
	}
	agg := dockerSampledAggregate(sampled, 5)
	if agg.Coverage.DetailsSampled != 2 || agg.Coverage.DetailsTotalEligible != 5 || agg.Coverage.Complete {
		t.Fatalf("coverage must be explicit partial: %+v", agg.Coverage)
	}
	if agg.Coverage.CohortDigest == "" {
		t.Fatal("cohort digest must be set for sampled cohort")
	}
	if agg.CPUPercent != 30 || agg.MemoryUsageBytes != 300 || agg.PIDs != 3 {
		t.Fatalf("aggregate must sum only sampled: %+v", agg)
	}
	full := dockerSampledAggregate(sampled, 2)
	if !full.Coverage.Complete {
		t.Fatalf("full coverage must be complete: %+v", full.Coverage)
	}
}

func TestI2_SecondsOnlyEventNormalization(t *testing.T) {
	sec := int64(1767225600)
	raw := DockerRawEvent{Time: &sec}
	nano, reduced, ok := dockerNormalizeNano(raw)
	if !ok || !reduced || nano != "1767225600000000000" {
		t.Fatalf("seconds-only normalization: nano=%q reduced=%v ok=%v", nano, reduced, ok)
	}
	body := `{"Type":"container","Action":"die","Actor":{"ID":"actor-1","Attributes":{}},"time":1767225600}`
	evs, _, _, err := collectDockerEventWindow(context.Background(), strings.NewReader(body), "1767225590000000000", "1767225610000000000", strings.Repeat("a", 32), nil, testKeyForID)
	if err != nil || len(evs) != 1 {
		t.Fatalf("seconds-only event collection: len=%d err=%v", len(evs), err)
	}
	if !evs[0].Context.ReducedPrecision {
		t.Fatal("seconds-only event must mark reducedPrecision")
	}
}

func TestI2_DigestDedupeAndWatermark(t *testing.T) {
	since := "1767225590000000000"
	until := "1767225620000000000"
	inst := strings.Repeat("a", 32)
	body := testEventJSON(3, 1767225600000000000)
	// First collection.
	evs, win, prop, err := collectDockerEventWindow(context.Background(), strings.NewReader(body), since, until, inst, nil, testKeyForID)
	if err != nil {
		t.Fatal(err)
	}
	if win.Capped || win.Lossy {
		t.Fatalf("small window must be uncapped: %+v", win)
	}
	if prop.TimeNano != until {
		t.Fatalf("complete window must propose until, got %q", prop.TimeNano)
	}
	validateBatchShape(t, evs, win, prop, since)
	// Inclusive replay: digests at since suppress duplicates.
	nano0, _ := json.Marshal(evs)
	_ = nano0
	// Build fromDigests for the first event nano and re-collect same body with since=event nano.
	if len(evs) == 0 {
		t.Fatal("expected events")
	}
	// Re-collect with since equal to first safe nano and its digest set.
	firstNano := "1767225600000000000"
	digests := boundaryDigestsFor(func() []dockerSafeEvent {
		// Recompute via a second full-decode to get digests deterministically.
		raw, _, _ := decodeDockerEventStream(strings.NewReader(body), dockerDecodeMaxEvents, dockerDecodeMaxBytes)
		var s []dockerSafeEvent
		for _, e := range raw {
			key := testKeyForID(e.Actor.ID)
			sctx := dockerSafeContext(e)
			ev := DockerEvent{EventID: dockerEventDigest(inst, firstNano, e.Action, key, sctx)[:32], EventOccurredAt: "2026-01-01T00:00:00Z", ContainerKey: key, Action: e.Action, Context: sctx}
			b, _ := json.Marshal(ev)
			s = append(s, dockerSafeEvent{nano: firstNano, key: key, ev: ev, size: len(b)})
		}
		return s
	}(), firstNano, inst)
	evs2, _, _, err := collectDockerEventWindow(context.Background(), strings.NewReader(body), firstNano, until, inst, digests, testKeyForID)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs2) != 0 {
		t.Fatalf("replay duplicates at since must be suppressed, got %d events", len(evs2))
	}
}

func TestI2_101SameTimeNano(t *testing.T) {
	since := "1767225590000000000"
	until := "1767225620000000000"
	inst := strings.Repeat("a", 32)
	nano := int64(1767225600000000000)
	body := testEventJSON(150, nano)
	evs, win, prop, err := collectDockerEventWindow(context.Background(), strings.NewReader(body), since, until, inst, nil, testKeyForID)
	if err != nil {
		t.Fatal(err)
	}
	if !win.Capped || !win.Lossy || win.GapReason != DockerGapBoundaryOverflow {
		t.Fatalf("101+ same-nano must overflow with gap, got %+v", win)
	}
	if len(evs) > MaxDockerEvents {
		t.Fatalf("transmit cap violated: %d", len(evs))
	}
	raw, _ := json.Marshal(evs)
	if len(raw) > MaxDockerEventBranchBytes+4096 {
		t.Fatalf("branch bytes wildly over cap: %d", len(raw))
	}
	// Last event must be the explicit gap.
	last := evs[len(evs)-1]
	if last.Action != DockerActionStreamGap || last.Context.Reason != DockerGapBoundaryOverflow {
		t.Fatalf("last must be boundary_overflow gap: %+v", last)
	}
	if prop.TimeNano != "1767225600000000000" {
		t.Fatalf("overflow must propose completed boundary, got %q", prop.TimeNano)
	}
	if len(prop.BoundaryDigests) == 0 || len(prop.BoundaryDigests) > MaxDockerBoundaryDigests {
		t.Fatalf("boundary digests must be retained 1..256, got %d", len(prop.BoundaryDigests))
	}
	validateBatchShape(t, evs, win, prop, since)
}

func TestI2_MidBoundaryByteCap(t *testing.T) {
	// Transmit byte accounting truncates mid-stream and still fits a gap.
	mk := func(n, size int) []dockerSafeEvent {
		out := make([]dockerSafeEvent, 0, n)
		for i := 0; i < n; i++ {
			ev := DockerEvent{EventID: fmt.Sprintf("e-%04d", i), EventOccurredAt: "2026-01-01T00:00:00Z", ContainerKey: strings.Repeat("k", 32), Action: "die", Context: DockerEventContext{Version: 1}}
			out = append(out, dockerSafeEvent{nano: "5", ev: ev, size: size})
		}
		return out
	}
	safe := mk(10, 20*1024) // 10 * 20KiB > 64KiB
	trans, acc := truncateDockerTransmit(safe, true)
	if len(trans) >= len(safe) {
		t.Fatal("byte cap must truncate")
	}
	if acc > MaxDockerEventBranchBytes {
		t.Fatalf("truncated bytes %d exceed cap", acc)
	}
	gap := dockerGapEvent("1", "5", 7, strings.Repeat("a", 32), "5")
	fitted := appendDockerGapFitting(trans, acc, gap)
	if len(fitted) > MaxDockerEvents {
		t.Fatalf("fitted %d exceeds event cap", len(fitted))
	}
	raw, _ := json.Marshal(fitted)
	if len(raw) > MaxDockerEventBranchBytes+2048 {
		t.Fatalf("fitted bytes %d exceed cap", len(raw))
	}
	if fitted[len(fitted)-1].Action != DockerActionStreamGap {
		t.Fatal("fitted tail must be gap")
	}
}

func TestI2_OverrunAbandonment(t *testing.T) {
	since := "1767225590000000000"
	until := "1767225620000000000"
	inst := strings.Repeat("a", 32)
	// 100 transmit cap + 1001 overrun at same nano exceeds the 1000 limit+1.
	body := testEventJSON(MaxDockerEvents+dockerBoundaryMaxEvents+1, 1767225600000000000)
	evs, win, prop, err := collectDockerEventWindow(context.Background(), strings.NewReader(body), since, until, inst, nil, testKeyForID)
	if err != nil {
		t.Fatal(err)
	}
	if !win.Lossy || win.GapReason != DockerGapBoundaryOverrun {
		t.Fatalf("overrun must abandon through U, got %+v", win)
	}
	if prop.TimeNano != until {
		t.Fatalf("abandon must propose until, got %q", prop.TimeNano)
	}
	if len(evs) > MaxDockerEvents {
		t.Fatalf("transmit cap violated: %d", len(evs))
	}
	validateBatchShape(t, evs, win, prop, since)
	// Collection-deadline abandonment path: cancelled context.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	evs2, win2, prop2, err := collectDockerEventWindow(ctx, strings.NewReader(testEventJSON(150, 1767225600000000000)), since, until, inst, nil, testKeyForID)
	if err != nil {
		t.Fatal(err)
	}
	_ = evs2
	_ = win2
	_ = prop2
	// Either overflow (if overrun check fires first) or deadline is acceptable;
	// both must validate.
	validateBatchShape(t, evs2, win2, prop2, since)
	if win2.Lossy && win2.GapReason != DockerGapBoundaryOverflow && win2.GapReason != DockerGapCollectionDeadline && win2.GapReason != DockerGapBoundaryOverrun {
		t.Fatalf("unexpected gap reason %q", win2.GapReason)
	}
}

func TestI2_ResponseLimitPlusOne(t *testing.T) {
	// Decode-level limit+1 sentinel.
	small := testEventJSON(6, 1767225600000000000)
	got, oversize, err := decodeDockerEventStream(strings.NewReader(small), 5, 1<<20)
	if err != nil || !oversize || len(got) != 5 {
		t.Fatalf("5+1 must be oversize: got=%d oversize=%v err=%v", len(got), oversize, err)
	}
	got, oversize, err = decodeDockerEventStream(strings.NewReader(small), 6, 1<<20)
	if err != nil || oversize || len(got) != 6 {
		t.Fatalf("exact limit must not be oversize: got=%d oversize=%v err=%v", len(got), oversize, err)
	}
	// Byte-level limit+1.
	got, oversize, err = decodeDockerEventStream(strings.NewReader(small), 100, 10)
	if err != nil || !oversize {
		t.Fatalf("byte overrun must be oversize: oversize=%v err=%v", oversize, err)
	}
	// Full-window response oversize: >10k decoded events.
	since := "1767225590000000000"
	until := "1767225620000000000"
	inst := strings.Repeat("a", 32)
	big := testEventJSON(dockerDecodeMaxEvents+1, 1767225600000000000)
	evs, win, prop, err := collectDockerEventWindow(context.Background(), strings.NewReader(big), since, until, inst, nil, testKeyForID)
	if err != nil {
		t.Fatal(err)
	}
	if !win.Lossy || win.GapReason != DockerGapResponseOversize || prop.TimeNano != until {
		t.Fatalf("response oversize must abandon through U: %+v prop=%+v", win, prop)
	}
	validateBatchShape(t, evs, win, prop, since)
}

func TestI2_SharedImageLayers(t *testing.T) {
	// Two images share layers: summed Sizes overlap, LayersSize is authoritative.
	body := `{"LayersSize":1000,"Images":[{"Size":900,"SharedSize":400},{"Size":800,"SharedSize":500}],"Containers":[],"Volumes":[],"BuildCache":[]}`
	agg, err := decodeDockerSystemDF(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if !agg.Images.Supported || agg.Images.TotalBytes != 1000 {
		t.Fatalf("images total must be LayersSize, got %+v", agg.Images)
	}
	if agg.FormulaVersion != DockerStorageFormulaVersion {
		t.Fatalf("formula version must be 1, got %d", agg.FormulaVersion)
	}
	if agg.Images.ReclaimableSupported {
		t.Fatal("image reclaimability must be unsupported/estimated only")
	}
	// Missing LayersSize => images unsupported (never sum Sizes).
	body2 := `{"Images":[{"Size":900,"SharedSize":0}],"Containers":[],"Volumes":[],"BuildCache":[]}`
	agg2, err := decodeDockerSystemDF(strings.NewReader(body2))
	if err != nil {
		t.Fatal(err)
	}
	if agg2.Images.Supported {
		t.Fatalf("images without LayersSize must be unsupported: %+v", agg2.Images)
	}
	// Containers/volumes/buildcache aggregates with support/count flags.
	body3 := `{"LayersSize":10,"Images":[],"Containers":[{"State":"running","SizeRw":100},{"State":"exited","SizeRw":50}],"Volumes":[{"UsageData":{"Size":30,"RefCount":1}},{"UsageData":{"Size":20,"RefCount":0}}],"BuildCache":[{"Size":40,"InUse":true},{"Size":60,"InUse":false}]}`
	agg3, err := decodeDockerSystemDF(strings.NewReader(body3))
	if err != nil {
		t.Fatal(err)
	}
	if !agg3.Containers.Supported || agg3.Containers.Count != 2 || agg3.Containers.TotalBytes != 150 || agg3.Containers.ReclaimableBytes != 50 {
		t.Fatalf("containers wrong: %+v", agg3.Containers)
	}
	if !agg3.LocalVolumes.Supported || agg3.LocalVolumes.TotalBytes != 50 || agg3.LocalVolumes.ReclaimableBytes != 20 {
		t.Fatalf("volumes wrong: %+v", agg3.LocalVolumes)
	}
	if !agg3.BuildCache.Supported || agg3.BuildCache.TotalBytes != 100 || agg3.BuildCache.ReclaimableBytes != 60 {
		t.Fatalf("buildcache wrong: %+v", agg3.BuildCache)
	}
	// Malformed category marks only itself unsupported.
	body4 := `{"LayersSize":10,"Images":[],"Containers":[{"State":"running","SizeRw":-5}],"Volumes":[{"UsageData":{"Size":20,"RefCount":0}}],"BuildCache":[]}`
	agg4, err := decodeDockerSystemDF(strings.NewReader(body4))
	if err != nil {
		t.Fatal(err)
	}
	if agg4.Containers.Supported {
		t.Fatal("negative SizeRw must mark containers unsupported")
	}
	if !agg4.LocalVolumes.Supported {
		t.Fatal("volumes must stay supported when containers malformed")
	}
}

func TestI2_StorageExactAndOversize(t *testing.T) {
	base := `{"LayersSize":10,"Images":[],"Containers":[],"Volumes":[],"BuildCache":[]}`
	if len(base) >= MaxDockerSystemDFBytes {
		t.Fatal("fixture too large")
	}
	pad := strings.Repeat(" ", MaxDockerSystemDFBytes-len(base))
	exact := base + pad
	if len(exact) != MaxDockerSystemDFBytes {
		t.Fatalf("exact len=%d want %d", len(exact), MaxDockerSystemDFBytes)
	}
	if _, err := decodeDockerSystemDF(strings.NewReader(exact)); err != nil {
		t.Fatalf("exact-limit response must be accepted: %v", err)
	}
	over := exact + " "
	if _, err := decodeDockerSystemDF(strings.NewReader(over)); err == nil {
		t.Fatal("limit+1 response must be rejected")
	}
}

func TestI2_ForbiddenFields(t *testing.T) {
	body := `{"LayersSize":10,"Images":[{"Size":5,"SharedSize":1,"Name":"secret-img","Id":"sha256:abc","Labels":{"x":"y"}}],"Containers":[{"State":"running","SizeRw":1,"Name":"web","Mounts":[{"Source":"/secret"}],"Env":["SECRET=hunter2"]}],"Volumes":[{"UsageData":{"Size":1,"RefCount":0},"Name":"vol-secret","Mountpoint":"/secret"}],"BuildCache":[]}`
	agg, err := decodeDockerSystemDF(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(agg)
	s := string(raw)
	for _, banned := range []string{"secret-img", "sha256", "Labels", "Mounts", "Env", "hunter2", "vol-secret", "Mountpoint", "volumeName", "mountPoint", "layerId", "cacheRecord", "objectName", "Name", "Names", "ID", "Id\""} {
		if strings.Contains(s, `"`+banned+`"`) || strings.Contains(s, banned+`":`) {
			// Only fail for actual key leakage; value "secret-img" must never appear.
			if banned == "secret-img" || banned == "hunter2" || banned == "vol-secret" {
				t.Fatalf("storage leaked forbidden value %q: %s", banned, s)
			}
		}
	}
	for _, banned := range []string{`"Env"`, `"Labels"`, `"Mounts"`, `"Command"`, `"hunter2"`, `"volumeName"`, `"mountPoint"`, `"layerId"`, `"cacheRecord"`, `"objectName"`, `"secret-img"`, `"vol-secret"`} {
		if strings.Contains(s, banned) {
			t.Fatalf("storage must not contain %s: %s", banned, s)
		}
	}
	// Full Docker payload with helpers must also stay within the forbidden set.
	m := DockerMetrics{
		AgentInstanceID: strings.Repeat("a", 32),
		SnapshotID:      strings.Repeat("b", 64), Available: true,
		Containers: []DockerContainer{{ContainerKey: strings.Repeat("k", 32), ID: "abc", Name: "web", Image: "img", State: "running"}},
		Storage:    agg,
	}
	out, _ := json.Marshal(m)
	os := string(out)
	for _, banned := range []string{`"env"`, `"Env"`, `"labels"`, `"Labels"`, `"command"`, `"Command"`, `"args"`, `"Args"`, `"entrypoint"`, `"Entrypoint"`, `"secret"`, `"Secret"`, `"config"`, `"Config"`, `"inspect"`, `"Inspect"`, `"volumeName"`, `"mountPoint"`, `"layerId"`, `"cacheRecord"`, `"objectName"`, `"hunter2"`} {
		if strings.Contains(os, banned) {
			t.Fatalf("docker payload must not contain %s: %s", banned, os)
		}
	}
}

func TestI2_SingleObjectOversize(t *testing.T) {
	// A single object larger than the byte budget must surface oversize
	// without growing framing memory, at both decode and window layers.
	big := `{"Type":"container","Action":"die","Actor":{"ID":"actor-0001","Attributes":{"pad":"` + strings.Repeat("x", 2048) + `"}},"time":1767225600,"timeNano":1767225600000000000}`
	got, oversize, err := decodeDockerEventStream(strings.NewReader(big), 100, 1024)
	if err != nil || !oversize {
		t.Fatalf("single oversize object must be oversize: got=%d oversize=%v err=%v", len(got), oversize, err)
	}
	since := "1767225590000000000"
	until := "1767225620000000000"
	inst := strings.Repeat("a", 32)
	huge := `{"Type":"container","Action":"die","Actor":{"ID":"actor-0001","Attributes":{"pad":"` + strings.Repeat("x", dockerDecodeMaxBytes+100) + `"}},"time":1767225600,"timeNano":1767225600000000000}`
	evs, win, prop, err := collectDockerEventWindow(context.Background(), strings.NewReader(huge), since, until, inst, nil, testKeyForID)
	if err != nil {
		t.Fatalf("oversize object must map to gap, not error: %v", err)
	}
	if !win.Lossy || win.GapReason != DockerGapResponseOversize || prop.TimeNano != until {
		t.Fatalf("oversize object must abandon through U: %+v prop=%+v evs=%d", win, prop, len(evs))
	}
}

func TestI2_NonObjectFramingRejected(t *testing.T) {
	// Non-object top-level input must be a hard error, never a clean EOF
	// that silently drops malformed data.
	if _, oversize, err := decodeDockerEventStream(strings.NewReader(`[1,2,3]`), 100, 1<<20); err == nil || oversize {
		t.Fatalf("array input must error: oversize=%v err=%v", oversize, err)
	}
	since := "1767225590000000000"
	until := "1767225620000000000"
	inst := strings.Repeat("a", 32)
	if _, _, _, err := collectDockerEventWindow(context.Background(), strings.NewReader(`[1,2,3]`), since, until, inst, nil, testKeyForID); err == nil {
		t.Fatal("array input must error in window collection, not break clean")
	}
	// Trailing garbage after a valid object must also error, not parse clean.
	trailing := testEventJSON(1, 1767225600000000000) + `garbage`
	if _, _, err := decodeDockerEventStream(strings.NewReader(trailing), 100, 1<<20); err == nil {
		t.Fatal("trailing garbage must error")
	}
}

func TestI2_BudgetAndCadence(t *testing.T) {
	start := time.Now()
	if !dockerRemainingBudget(start, 5*time.Second, 250*time.Millisecond) {
		t.Fatal("fresh budget must allow a bounded op")
	}
	aged := start.Add(-5 * time.Second)
	if dockerRemainingBudget(aged, 5*time.Second, 250*time.Millisecond) {
		t.Fatal("exhausted budget must not allow another op")
	}
	now := time.Now()
	if !dockerStorageDue(time.Time{}, now) {
		t.Fatal("first cycle must be due")
	}
	if dockerStorageDue(now, now) {
		t.Fatal("immediate second cycle must defer")
	}
	if !dockerStorageDue(now.Add(-6*time.Minute), now) {
		t.Fatal("cycle after cadence must be due")
	}
}
