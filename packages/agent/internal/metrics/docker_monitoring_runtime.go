package metrics

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"time"
)

// Docker monitoring runtime collection link (metrics scope only).
//
// The collector reuses the existing Docker collection (same bounded
// list/stats data under the global 5s collection context) and derives an
// additive monitoring snapshot: authoritative counts, selected container samples
// with explicit coverage, and stable opaque containerKey values. When Runner
// supplies durable event-window input through the narrow provider below, the
// existing bounded fixed-window /events helper populates the event branch.
// When storage is enabled and its five-minute cadence is due, the existing
// bounded /system/df decoder populates sanitized storage aggregates.
// No state/run/push imports.
//
// The collector never fabricates durable identity: BatchID, SnapshotID,
// AgentInstanceID, and watermark advancement/binding remain Runner/state
// responsibilities. The narrow FinalizeHook is the attachment point Runner
// uses after collection.
//
// Failure isolation: any Docker derivation, provider, request, decode, or hook
// failure clears or omits only the affected Docker branch; collection output and host
// metrics are always preserved.

// DockerContainerKeyFunc maps a daemon container ID to an opaque
// containerKey. It must return a value that passes
// validateDockerContainerKey, or the container is skipped.
type DockerContainerKeyFunc func(fullID string) string

// DockerFinalizeFunc is the narrow runner attachment hook. It runs
// synchronously after the minimal snapshot is built and may attach durable
// batch metadata (agentInstanceId/snapshotId/batchId/event branch/storage)
// before push. It must be non-blocking and must not perform I/O.
type DockerFinalizeFunc func(*DockerMetrics)

// DockerEventInput is durable event-window input supplied by Runner/state.
type DockerEventInput struct {
	SinceNano       string
	UntilNano       string
	AgentInstanceID string
	FromDigests     []string
}

// DockerEventInputProvider supplies durable event-window input without
// importing state/run. Nil means events are omitted for this cycle.
type DockerEventInputProvider func() (DockerEventInput, bool)

// SetDockerEventInputProvider configures durable event inputs.
func (c *Collector) SetDockerEventInputProvider(p DockerEventInputProvider) {
	c.dockerMu.Lock()
	defer c.dockerMu.Unlock()
	c.dockerEventInput = p
}

// SetDockerStorageEnabled enables /system/df on its five-minute cadence.
func (c *Collector) SetDockerStorageEnabled(enabled bool) {
	c.dockerMu.Lock()
	defer c.dockerMu.Unlock()
	c.dockerStorage = enabled
	if !enabled {
		c.dockerLastStorage = time.Time{}
	}
}

// Docker event/storage calls use the existing Docker client and base URL.
func (c *Collector) collectDockerAPI(ctx context.Context, out *DockerMetrics, starts ...time.Time) {
	// Keep optional Docker work inside the same five-second upper bound as the
	// base collection. The caller's cancellation/deadline remains
	// authoritative: the caller owns the single shared collection deadline.
	// Do not create a second timeout here.
	c.dockerMu.RLock()
	client, base, eventProvider, storageEnabled, lastStorage := c.dockerHTTPClient, c.dockerBaseURL, c.dockerEventInput, c.dockerStorage, c.dockerLastStorage
	c.dockerMu.RUnlock()
	if client == nil || base == "" {
		return
	}
	start := time.Now()
	if len(starts) > 0 {
		start = starts[0]
	}
	if eventProvider != nil && dockerRemainingBudget(start, 5*time.Second, 100*time.Millisecond) {
		if in, ok := eventProvider(); ok && in.AgentInstanceID != "" {
			if req, err := dockerEventsRequest(ctx, base, in.SinceNano, in.UntilNano); err == nil {
				if resp, err := client.Do(req); err == nil {
					func() {
						defer resp.Body.Close()
						if resp.StatusCode >= 200 && resp.StatusCode < 300 {
							evs, win, prop, err := collectDockerEventWindow(ctx, resp.Body, in.SinceNano, in.UntilNano, in.AgentInstanceID, in.FromDigests, c.containerKeyFunc())
							if err == nil {
								if evs == nil {
									// A complete window always transmits an
									// array; nil would marshal as null.
									evs = []DockerEvent{}
								}
								out.Events, out.EventWindow, out.FromWatermark, out.ProposedWatermark = &evs, win, &DockerEventWatermark{TimeNano: in.SinceNano, BoundaryDigests: append([]string{}, in.FromDigests...)}, prop
							}
						}
					}()
				}
			}
		}
	}
	if storageEnabled && dockerStorageDue(lastStorage, time.Now()) && dockerRemainingBudget(start, 5*time.Second, 100*time.Millisecond) {
		if req, err := dockerSystemDFRequest(ctx, base); err == nil {
			if resp, err := client.Do(req); err == nil {
				func() {
					defer resp.Body.Close()
					if resp.StatusCode >= 200 && resp.StatusCode < 300 {
						if s, err := decodeDockerSystemDF(resp.Body); err == nil {
							out.Storage = s
							c.dockerMu.Lock()
							c.dockerLastStorage = time.Now()
							c.dockerMu.Unlock()
						}
					}
				}()
			}
		}
	}
}

func (c *Collector) containerKeyFunc() func(string) string {
	c.dockerMu.RLock()
	defer c.dockerMu.RUnlock()
	if c.dockerKeyFunc != nil {
		return c.dockerKeyFunc
	}
	return defaultDockerContainerKey
}

// SetDockerContainerKeyFunc overrides stable containerKey derivation.
// A nil value restores the deterministic local helper.
func (c *Collector) SetDockerContainerKeyFunc(fn DockerContainerKeyFunc) {
	c.dockerMu.Lock()
	defer c.dockerMu.Unlock()
	c.dockerKeyFunc = fn
}

// SetDockerFinalizeHook installs the narrow runner attachment hook for
// durable batch metadata. A nil value clears it.
func (c *Collector) SetDockerFinalizeHook(fn DockerFinalizeFunc) {
	c.dockerMu.Lock()
	defer c.dockerMu.Unlock()
	c.dockerFinalize = fn
}

// defaultDockerContainerKey is the deterministic local helper: opaque,
// stable, charset-safe (base64url, 32 chars), derived from the daemon ID.
// It never embeds raw IDs, names, or labels.
func defaultDockerContainerKey(fullID string) string {
	sum := sha256.Sum256([]byte("vps-manager/docker/container/v2\x00" + fullID))
	return base64.RawURLEncoding.EncodeToString(sum[:])[:MaxContainerKeyLen]
}

// dockerSnapshotFromCollection derives a minimal canonical snapshot from the same
// bounded list/stats data. Counts stay authoritative from the collection
// (full-list totals, not the capped sample). Samples are deterministically
// selected via the existing bounded helper; coverage is explicit, so a
// capped list yields partial coverage with a cohort digest over the sampled
// keys. Events/storage/watermark/batch branches stay nil here.
func dockerSnapshotFromCollection(collection *DockerCollectionSnapshot, keyForID DockerContainerKeyFunc, rotations ...uint64) (out *DockerMetrics) {
	if collection == nil {
		return nil
	}
	if keyForID == nil {
		keyForID = defaultDockerContainerKey
	}
	defer func() {
		// Never let Docker derivation break the host/legacy collection.
		if recover() != nil {
			out = nil
		}
	}()

	out = &DockerMetrics{
		CollectedAt:      collection.CollectedAt,
		EngineVersion:    collection.EngineVersion,
		APIVersion:       collection.APIVersion,
		OS:               collection.OS,
		Architecture:     collection.Architecture,
		SchemaVersion:    DockerMetricsSchemaVersion,
		Available:        collection.Available,
		ErrorCode:        collection.ErrorCode,
		ContainerTotal:   collection.ContainerTotal,
		ContainerRunning: collection.ContainerRunning,
		CPUPercent:       collection.CPUPercent,
		MemoryUsageBytes: collection.MemoryUsageBytes,
		MemoryLimitBytes: collection.MemoryLimitBytes,
		NetworkRxBytes:   collection.NetworkRxBytes,
		NetworkTxBytes:   collection.NetworkTxBytes,
		BlockReadBytes:   collection.BlockReadBytes,
		BlockWriteBytes:  collection.BlockWriteBytes,
		PIDs:             collection.PIDs,
		Containers:       []DockerContainer{},
	}

	// Build the candidate pool from the bounded collection sample, then apply the
	// existing deterministic selection (priority signals unavailable from
	// collection stats are left false; running state is carried over).
	sel := make([]DockerSelection, 0, len(collection.Containers))
	byKey := make(map[string]DockerContainer, len(collection.Containers))
	for _, vc := range collection.Containers {
		id := vc.fullID
		if id == "" {
			// Tests and legacy in-memory callers may not retain fullID; the
			// bounded collection ID remains sufficient for deterministic derivation.
			id = vc.ID
		}
		key := keyForID(id)
		if err := validateDockerContainerKey(key); err != nil {
			continue
		}
		sel = append(sel, DockerSelection{
			ContainerKey: key,
			Running:      vc.State == "running",
		})
		byKey[key] = sanitizeDockerDisplay(DockerContainer{
			ContainerKey:     key,
			Name:             vc.Name,
			Image:            vc.Image,
			State:            vc.State,
			Status:           vc.Status,
			CreatedAt:        vc.CreatedAt,
			CPUPercent:       vc.CPUPercent,
			MemoryUsageBytes: vc.MemoryUsageBytes,
			MemoryLimitBytes: vc.MemoryLimitBytes,
			NetworkRxBytes:   vc.NetworkRxBytes,
			NetworkTxBytes:   vc.NetworkTxBytes,
			BlockReadBytes:   vc.BlockReadBytes,
			BlockWriteBytes:  vc.BlockWriteBytes,
			PIDs:             vc.PIDs,
		})
	}
	var rotation uint64
	if len(rotations) > 0 {
		rotation = rotations[0]
	}
	picked := selectDockerContainers(sel, MaxContainers, rotation)
	for _, s := range picked {
		out.Containers = append(out.Containers, byKey[s.ContainerKey])
	}
	agg := dockerSampledAggregate(out.Containers, collection.ContainerTotal)
	out.SampledContainerAggregate = &agg
	// Event batch (batchId/events/eventWindow/watermarks) and storage stay
	// nil: only safe when durable inputs/cadence are available, which the
	// collector does not have. The finalize hook may attach them.
	return out
}

// collectDocker builds the additive snapshot from an already-collected
// legacy result and applies the finalize hook when set. It returns nil when
// the Docker gate is off, when the legacy input is nil, or on any
// derivation/hook failure, preserving host metrics output by contract.
func (c *Collector) collectDockerSnapshot(ctx context.Context, collection *DockerCollectionSnapshot, starts ...time.Time) (out *DockerMetrics) {
	if collection == nil {
		return nil
	}
	c.dockerMu.RLock()
	keyFunc := c.dockerKeyFunc
	finalize := c.dockerFinalize
	c.dockerMu.RUnlock()

	defer func() {
		if recover() != nil {
			out = nil
		}
	}()
	c.dockerMu.Lock()
	rotation := c.dockerRotation
	c.dockerRotation++
	c.dockerMu.Unlock()
	out = dockerSnapshotFromCollection(collection, keyFunc, rotation)
	if out == nil {
		return nil
	}
	// Reserve the final second for inspect; event/storage remain bounded by
	// the existing outer collection context and never extend its deadline.
	enrichmentDeadline := time.Now().Add(time.Second)
	if len(starts) > 0 {
		enrichmentDeadline = starts[0].Add(4 * time.Second)
	}
	enrichmentCtx, cancelEnrichment := context.WithDeadline(ctx, enrichmentDeadline)
	c.collectDockerAPI(enrichmentCtx, out, starts...)
	cancelEnrichment()
	c.collectDockerInspect(ctx, collection, out, rotation)
	if finalize != nil {
		finalize(out)
	}
	return out
}
