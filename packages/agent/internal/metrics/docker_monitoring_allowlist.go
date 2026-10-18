package metrics

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Docker monitoring Phase 1 increment I0 — allowlisted GET request builders.
//
// Invariant (plan section 1): agent Docker access remains an explicit GET
// allowlist. No generic request helper may accept a path from API or UI
// input. These named private builders use hardcoded paths only. /events
// filters are built internally from the fixed compile-time container type
// and the approved action allowlist below; callers supply only numeric
// since/until bounds. New builders are NOT called by any collection path
// in I0 (no new collection calls enabled).

const (
	dockerPathVersion      = "/version"
	dockerPathContainers   = "/containers/json"
	dockerPathEvents       = "/events"
	dockerPathSystemDF     = "/system/df"
	dockerStatsPathPrefix  = "/containers/"
	dockerStatsPathSuffix  = "/stats"
	dockerInspectPathSuffix = "/json"
	dockerMaxContainerID64 = 64

	// Fixed compile-time /events type filter (container scope only).
	dockerEventsType = "container"
)

// dockerEventActionAllowlist is the fixed compile-time set of container
// lifecycle actions surfaced by monitoring. It is a subset of the wire
// action allowlist; stream_gap/daemon_restarted are synthesized locally,
// never requested from the daemon.
var dockerEventActionAllowlist = []string{
	DockerActionCreate,
	DockerActionStart,
	DockerActionRestart,
	DockerActionDie,
	DockerActionStop,
	DockerActionKill,
	DockerActionDestroy,
	DockerActionRemove,
	DockerActionHealthStatus,
}

// dockerEventsFilters is the fixed JSON-encoded /events filters value:
// type=container plus the compile-time action allowlist above. It is never
// caller-supplied; dockerEventsRequest is the only user.
const dockerEventsFilters = `{"event":["create","start","restart","die","stop","kill","destroy","remove","health_status"],"type":["container"]}`

// dockerBase validates baseURL exactly: scheme must be http, host must be
// present, and no userinfo, path, query, or fragment is permitted. The
// allowlisted builders append hardcoded paths only.
func dockerBase(baseURL string) (string, error) {
	trimmed := strings.TrimRight(baseURL, "/")
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("invalid docker base url")
	}
	if u.Scheme != "http" {
		return "", fmt.Errorf("invalid docker base url scheme")
	}
	if u.Host == "" || u.User != nil {
		return "", fmt.Errorf("invalid docker base url host")
	}
	if u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", fmt.Errorf("invalid docker base url")
	}
	return "http://" + u.Host, nil
}

// dockerNewGET builds a GET request for a hardcoded allowlisted path.
func dockerNewGET(ctx context.Context, base, path, rawQuery string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return nil, err
	}
	if rawQuery != "" {
		req.URL.RawQuery = rawQuery
	}
	return req, nil
}

// dockerVersionRequest is GET /version (no query).
func dockerVersionRequest(ctx context.Context, baseURL string) (*http.Request, error) {
	base, err := dockerBase(baseURL)
	if err != nil {
		return nil, err
	}
	return dockerNewGET(ctx, base, dockerPathVersion, "")
}

// dockerListRequest is GET /containers/json?all=1&size=false.
func dockerListRequest(ctx context.Context, baseURL string) (*http.Request, error) {
	base, err := dockerBase(baseURL)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Set("all", "1")
	q.Set("size", "false")
	return dockerNewGET(ctx, base, dockerPathContainers, q.Encode())
}

// isDockerRawContainerID reports whether id is a full 64-char lowercase
// hex Docker container ID. Only full IDs reach the daemon stats path.
func isDockerRawContainerID(id string) bool {
	if len(id) != dockerMaxContainerID64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// dockerStatsRequest is GET /containers/{fullID}/stats?stream=false.
// Only full 64-char hex IDs are accepted; anything else fails closed so a
// truncated display ID, name, key, or crafted segment can never reach the
// daemon path.
func dockerStatsRequest(ctx context.Context, baseURL, id string) (*http.Request, error) {
	if !isDockerRawContainerID(id) {
		return nil, fmt.Errorf("invalid container id")
	}
	base, err := dockerBase(baseURL)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Set("stream", "false")
	return dockerNewGET(ctx, base, dockerStatsPathPrefix+id+dockerStatsPathSuffix, q.Encode())
}

// dockerInspectRequest is the sole allowlisted inspect request. Only a full
// daemon ID is accepted; keys, names, and truncated IDs cannot reach Docker.
func dockerInspectRequest(ctx context.Context, baseURL, id string) (*http.Request, error) {
	if !isDockerRawContainerID(id) {
		return nil, fmt.Errorf("invalid container id")
	}
	base, err := dockerBase(baseURL)
	if err != nil {
		return nil, err
	}
	return dockerNewGET(ctx, base, dockerStatsPathPrefix+id+dockerInspectPathSuffix, "")
}

// formatDockerEventTimestamp encodes canonical decimal-string nanoseconds
// as base-10 Unix seconds with nanosecond fractions accepted by the Engine
// API. Input must already be canonical; non-canonical input fails closed.
func formatDockerEventTimestamp(nano string) (string, error) {
	if !isCanonicalNanoDecimal(nano) {
		return "", fmt.Errorf("non-canonical nanosecond value")
	}
	// Strip to integer division without int64 overflow: split seconds/fraction.
	n := strings.TrimLeft(nano, "0")
	if n == "" {
		n = "0"
	}
	var sec, frac string
	if len(n) <= 9 {
		sec = "0"
		frac = strings.Repeat("0", 9-len(n)) + n
	} else {
		sec = n[:len(n)-9]
		frac = n[len(n)-9:]
	}
	return sec + "." + frac, nil
}

// dockerEventsRequest is GET /events?since=S&until=U with filters built
// internally: fixed type=container plus the compile-time action allowlist.
// Callers supply only canonical decimal-string since/until bounds; no
// caller-supplied filter, path, or query is accepted.
func dockerEventsRequest(ctx context.Context, baseURL, sinceNano, untilNano string) (*http.Request, error) {
	if !isCanonicalNanoDecimal(sinceNano) || !isCanonicalNanoDecimal(untilNano) {
		return nil, fmt.Errorf("non-canonical nanosecond value")
	}
	if cmpCanonicalNano(sinceNano, untilNano) >= 0 {
		return nil, fmt.Errorf("invalid event window")
	}
	since, err := formatDockerEventTimestamp(sinceNano)
	if err != nil {
		return nil, err
	}
	until, err := formatDockerEventTimestamp(untilNano)
	if err != nil {
		return nil, err
	}
	base, err := dockerBase(baseURL)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Set("since", since)
	q.Set("until", until)
	// Fixed internal filters: type=container plus the compile-time action
	// allowlist. Never caller-supplied.
	q.Set("filters", dockerEventsFilters)
	return dockerNewGET(ctx, base, dockerPathEvents, q.Encode())
}

// dockerSystemDFRequest is GET /system/df (no query, no params).
func dockerSystemDFRequest(ctx context.Context, baseURL string) (*http.Request, error) {
	base, err := dockerBase(baseURL)
	if err != nil {
		return nil, err
	}
	return dockerNewGET(ctx, base, dockerPathSystemDF, "")
}
