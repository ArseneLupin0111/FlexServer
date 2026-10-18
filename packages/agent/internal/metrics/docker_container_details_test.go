package metrics

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func inspectTestID(i int) string { return fmt.Sprintf("%064x", i+1) }
func inspectTestBody(id, state, extra string) string {
	return `{"Id":"` + id + `","State":{"Status":"` + state + `"` + extra + `},"NetworkSettings":{"Ports":{"80/tcp":null}},"Mounts":[],"Config":{}}`
}
func TestDecodeDockerInspectProjection(t *testing.T) {
	id := inspectTestID(0)
	body := `{"Id":"` + id + `","State":{"Status":"exited","ExitCode":0,"OOMKilled":false,"Health":{"Status":"healthy","FailingStreak":0}},"NetworkSettings":{"Ports":{"80/tcp":[{"HostIp":"::1","HostPort":"8080"}],"53/udp":null},"Networks":{"z":{"IPAddress":"10.0.0.2"},"a":{"GlobalIPv6Address":"::2"}}},"Mounts":[{"Type":"bind","Source":"/secret","Destination":"/data","RW":false}],"Config":{"Env":["hunter2"],"Labels":{"secret":"hunter2"},"Healthcheck":{"Test":["secret-command"],"Interval":2000000,"Timeout":3000000,"Retries":2}}}`
	d, e := decodeDockerInspect([]byte(body), id, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	if d.ExitCode == nil || *d.ExitCode != 0 || d.OOMKilled == nil || *d.OOMKilled || len(d.Ports) != 2 || len(d.Mounts) != 1 || !d.Mounts[0].ReadOnly || len(d.Networks) != 2 || d.Healthcheck.IntervalMs == nil || *d.Healthcheck.IntervalMs != 2 {
		t.Fatalf("bad projection %+v", d)
	}
	raw, _ := json.Marshal(d)
	for _, s := range []string{"hunter2", "secret-command", "Labels", "Env"} {
		if strings.Contains(string(raw), s) {
			t.Fatalf("leak %s", raw)
		}
	}
}
func TestInspectNoHealthAndExplicitOOM(t *testing.T) {
	id := inspectTestID(0)
	d, e := decodeDockerInspect([]byte(inspectTestBody(id, "running", `,"OOMKilled":true`)), id, time.Now())
	if e != nil || d.OOMKilled == nil || !*d.OOMKilled || d.ExitCode != nil || d.Healthcheck.Status != "none" || d.Ports[0].HostPort != 0 {
		t.Fatalf("projection %+v %v", d, e)
	}
	d, e = decodeDockerInspect([]byte(inspectTestBody(id, "exited", `,"ExitCode":7,"OOMKilled":false`)), id, time.Now())
	if e != nil || d.ExitCode == nil || *d.ExitCode != 7 || d.OOMKilled == nil || *d.OOMKilled {
		t.Fatalf("projection %+v %v", d, e)
	}
}
func TestDecodeDockerInspectRejectsBoundsAndIdentity(t *testing.T) {
	id := inspectTestID(0)
	for _, b := range [][]byte{[]byte(strings.Repeat(" ", dockerInspectResponseMax+1)), []byte(`{"Id":"` + id + `"} {}`), []byte(`{"Id":"` + inspectTestID(1) + `"}`)} {
		if _, e := decodeDockerInspect(b, id, time.Now()); e == nil {
			t.Fatal("expected rejection")
		}
	}
}
func TestInspectRejectsMalformedProjectedMetadata(t *testing.T) {
	id := inspectTestID(0)
	for _, extra := range []string{`,"Health":{"Status":"bogus","FailingStreak":0}`, `,"Health":{"Status":"healthy","FailingStreak":-1}`} {
		if _, err := decodeDockerInspect([]byte(inspectTestBody(id, "running", extra)), id, time.Now()); err == nil {
			t.Fatalf("accepted malformed daemon health: %s", extra)
		}
	}
}
func TestDockerInspectRequestRequiresFullID(t *testing.T) {
	if _, e := dockerInspectRequest(nil, "http://docker", strings.Repeat("a", 16)); e == nil {
		t.Fatal("accepted truncated ID")
	}
}
func TestInspectHTTPStatusesAndTimeout(t *testing.T) {
	for _, tc := range []struct {
		status int
		reason string
	}{{403, "permission_denied"}, {404, "not_found"}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status) }))
		c := NewCollector()
		c.dockerHTTPClient = srv.Client()
		c.dockerBaseURL = srv.URL
		col := collectionFixture(1)
		col.Containers[0].fullID = inspectTestID(0)
		got := dockerSnapshotFromCollection(col, nil)
		c.collectDockerInspect(context.Background(), col, got, 0)
		if got.Containers[0].Details.Reason != tc.reason {
			t.Fatalf("status %d: %+v", tc.status, got.Containers[0].Details)
		}
		srv.Close()
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(250 * time.Millisecond) }))
	c := NewCollector()
	c.dockerHTTPClient = srv.Client()
	c.dockerBaseURL = srv.URL
	col := collectionFixture(1)
	col.Containers[0].fullID = inspectTestID(0)
	got := dockerSnapshotFromCollection(col, nil)
	c.collectDockerInspect(context.Background(), col, got, 0)
	if got.Containers[0].Details.Reason != "timeout" {
		t.Fatalf("timeout %+v", got.Containers[0].Details)
	}
	srv.Close()
}
func TestInspectBudgetRotationAndBaseFields(t *testing.T) {
	var ids []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/containers/"), "/json")
		ids = append(ids, id)
		fmt.Fprintf(w, `{"Id":%q,"State":{"Status":"running"},"NetworkSettings":{"Ports":{}},"Mounts":[],"Config":{}}`, id)
	}))
	defer srv.Close()
	c := NewCollector()
	c.dockerHTTPClient, c.dockerBaseURL = srv.Client(), srv.URL
	col := collectionFixture(2)
	for i := range col.Containers {
		col.Containers[i].fullID = inspectTestID(i)
	}
	got := dockerSnapshotFromCollection(col, nil)
	got.CPUPercent = 55
	got.Events = new([]DockerEvent)
	expected := make([]string, 0, 2)
	for n := range got.Containers {
		key := got.Containers[(1+n)%len(got.Containers)].ContainerKey
		for _, candidate := range col.Containers {
			if defaultDockerContainerKey(candidate.fullID) == key {
				expected = append(expected, candidate.fullID)
			}
		}
	}
	c.collectDockerInspect(context.Background(), col, got, 1)
	if got.CPUPercent != 55 || got.Events == nil || len(ids) != 2 || ids[0] != expected[0] || ids[1] != expected[1] {
		t.Fatalf("snapshot rotation cpu=%v requests=%v expected=%v", got.CPUPercent, ids, expected)
	}
}
