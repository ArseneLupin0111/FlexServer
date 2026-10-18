package metrics

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"
)

// Inspect enrichment is optional and cannot extend the shared collection deadline.
func (c *Collector) collectDockerInspect(ctx context.Context, collection *DockerCollectionSnapshot, out *DockerMetrics, rotation uint64) {
	if collection == nil || out == nil || len(out.Containers) == 0 {
		return
	}
	for i := range out.Containers {
		out.Containers[i].Details = unavailableDockerDetails("budget_exhausted", time.Now())
	}
	c.dockerMu.RLock()
	client, base := c.dockerHTTPClient, c.dockerBaseURL
	c.dockerMu.RUnlock()
	if client == nil || base == "" {
		return
	}
	byKey := make(map[string]string, len(collection.Containers))
	keyForID := c.containerKeyFunc()
	for _, candidate := range collection.Containers {
		if isDockerRawContainerID(candidate.fullID) {
			byKey[keyForID(candidate.fullID)] = candidate.fullID
		}
	}
	inspectCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	start := int(rotation % uint64(len(out.Containers)))
	for n := range out.Containers {
		container := &out.Containers[(start+n)%len(out.Containers)]
		if inspectCtx.Err() != nil {
			break
		}
		id := byKey[container.ContainerKey]
		if id == "" {
			container.Details = unavailableDockerDetails("invalid_response", time.Now())
			continue
		}
		container.Details = collectOneDockerInspect(inspectCtx, client, base, id)
	}
}

func collectOneDockerInspect(ctx context.Context, client *http.Client, base, id string) *DockerContainerDetails {
	requestCtx, cancel := context.WithTimeout(ctx, 150*time.Millisecond)
	defer cancel()
	unavailable := func(reason string) *DockerContainerDetails { return unavailableDockerDetails(reason, time.Now()) }
	request, err := dockerInspectRequest(requestCtx, base, id)
	if err != nil {
		return unavailable("invalid_response")
	}
	response, err := client.Do(request)
	if err != nil {
		if requestCtx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
			return unavailable("timeout")
		}
		return unavailable("daemon_unreachable")
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNotFound:
		return unavailable("not_found")
	case http.StatusForbidden:
		return unavailable("permission_denied")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return unavailable("daemon_unreachable")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, dockerInspectResponseMax+1))
	if err != nil {
		if requestCtx.Err() != nil {
			return unavailable("timeout")
		}
		return unavailable("invalid_response")
	}
	if len(body) > dockerInspectResponseMax {
		return unavailable("invalid_response")
	}
	details, err := decodeDockerInspect(body, id, time.Now())
	if err != nil {
		return unavailable("invalid_response")
	}
	return details
}
