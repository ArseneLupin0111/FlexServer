package metrics

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	dockerInspectResponseMax = 256 * 1024
	dockerDetailsBytesMax    = 16 * 1024
	dockerDetailsPortsMax    = 32
	dockerDetailsMountsMax   = 16
	dockerDetailsNetworksMax = 16
)

type DockerContainerDetails struct {
	CollectedAt   string                      `json:"collectedAt"`
	Status        string                      `json:"status"`
	Reason        string                      `json:"reason,omitempty"`
	CreatedAt     string                      `json:"createdAt,omitempty"`
	StartedAt     string                      `json:"startedAt,omitempty"`
	FinishedAt    string                      `json:"finishedAt,omitempty"`
	ExitCode      *int                        `json:"exitCode,omitempty"`
	OOMKilled     *bool                       `json:"oomKilled,omitempty"`
	RestartCount  *int                        `json:"restartCount,omitempty"`
	RestartPolicy *DockerDetailsRestartPolicy `json:"restartPolicy,omitempty"`
	Ports         []DockerDetailsPort         `json:"ports,omitempty"`
	Mounts        []DockerDetailsMount        `json:"mounts,omitempty"`
	Networks      []DockerDetailsNetwork      `json:"networks,omitempty"`
	Healthcheck   *DockerDetailsHealthcheck   `json:"healthcheck,omitempty"`
}

func (d DockerContainerDetails) MarshalJSON() ([]byte, error) {
	type plain DockerContainerDetails
	if d.Status != "available" {
		return json.Marshal(plain(d))
	}
	return json.Marshal(struct {
		plain
		Ports    []DockerDetailsPort    `json:"ports"`
		Mounts   []DockerDetailsMount   `json:"mounts"`
		Networks []DockerDetailsNetwork `json:"networks"`
	}{plain(d), d.Ports, d.Mounts, d.Networks})
}

type DockerDetailsRestartPolicy struct {
	Name              string `json:"name"`
	MaximumRetryCount int    `json:"maximumRetryCount"`
}
type DockerDetailsPort struct {
	ContainerPort int    `json:"containerPort"`
	Protocol      string `json:"protocol"`
	HostIP        string `json:"hostIp,omitempty"`
	HostPort      int    `json:"hostPort,omitempty"`
}
type DockerDetailsMount struct {
	Type        string `json:"type"`
	Source      string `json:"source,omitempty"`
	Destination string `json:"destination"`
	ReadOnly    bool   `json:"readOnly"`
}
type DockerDetailsNetwork struct {
	Name    string `json:"name"`
	IPv4    string `json:"ipv4,omitempty"`
	IPv6    string `json:"ipv6,omitempty"`
	Gateway string `json:"gateway,omitempty"`
}
type DockerDetailsHealthcheck struct {
	Status        string `json:"status"`
	FailingStreak *int   `json:"failingStreak,omitempty"`
	IntervalMs    *int64 `json:"intervalMs,omitempty"`
	TimeoutMs     *int64 `json:"timeoutMs,omitempty"`
	StartPeriodMs *int64 `json:"startPeriodMs,omitempty"`
	Retries       *int   `json:"retries,omitempty"`
}

type dockerInspectRaw struct {
	ID      string `json:"Id"`
	Created string `json:"Created"`
	State   struct {
		Status     string `json:"Status"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
		ExitCode   *int   `json:"ExitCode"`
		OOMKilled  *bool  `json:"OOMKilled"`
		Health     *struct {
			Status        string `json:"Status"`
			FailingStreak int    `json:"FailingStreak"`
		} `json:"Health"`
	} `json:"State"`
	RestartCount *int `json:"RestartCount"`
	HostConfig   struct {
		RestartPolicy struct {
			Name              string `json:"Name"`
			MaximumRetryCount int    `json:"MaximumRetryCount"`
		} `json:"RestartPolicy"`
	} `json:"HostConfig"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
		Networks map[string]struct {
			IPv4    string `json:"IPAddress"`
			IPv6    string `json:"GlobalIPv6Address"`
			Gateway string `json:"Gateway"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
	Mounts []struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		RW          bool   `json:"RW"`
	} `json:"Mounts"`
	Config struct {
		Healthcheck *struct {
			Interval    int64 `json:"Interval"`
			Timeout     int64 `json:"Timeout"`
			StartPeriod int64 `json:"StartPeriod"`
			Retries     int   `json:"Retries"`
		} `json:"Healthcheck"`
	} `json:"Config"`
}

func unavailableDockerDetails(reason string, now time.Time) *DockerContainerDetails {
	return &DockerContainerDetails{CollectedAt: now.UTC().Format(time.RFC3339Nano), Status: "unavailable", Reason: reason}
}

func decodeDockerInspect(data []byte, expectedID string, now time.Time) (*DockerContainerDetails, error) {
	if len(data) > dockerInspectResponseMax {
		return nil, fmt.Errorf("oversized inspect")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	var raw dockerInspectRaw
	if err := dec.Decode(&raw); err != nil {
		return nil, err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("trailing inspect data")
	}
	if !isDockerRawContainerID(raw.ID) || raw.ID != expectedID {
		return nil, fmt.Errorf("inspect identity mismatch")
	}
	d := &DockerContainerDetails{CollectedAt: now.UTC().Format(time.RFC3339Nano), Status: "available", Ports: []DockerDetailsPort{}, Mounts: []DockerDetailsMount{}, Networks: []DockerDetailsNetwork{}}
	var err error
	if d.CreatedAt, err = dockerInspectTimestamp(raw.Created); err != nil {
		return nil, err
	}
	if d.StartedAt, err = dockerInspectTimestamp(raw.State.StartedAt); err != nil {
		return nil, err
	}
	if d.FinishedAt, err = dockerInspectTimestamp(raw.State.FinishedAt); err != nil {
		return nil, err
	}
	if raw.State.Status == "exited" || raw.State.Status == "dead" {
		d.ExitCode = raw.State.ExitCode
	}
	d.OOMKilled = raw.State.OOMKilled
	d.RestartCount = raw.RestartCount
	if raw.HostConfig.RestartPolicy.Name != "" {
		d.RestartPolicy = &DockerDetailsRestartPolicy{Name: raw.HostConfig.RestartPolicy.Name, MaximumRetryCount: raw.HostConfig.RestartPolicy.MaximumRetryCount}
	}
	for key, bindings := range raw.NetworkSettings.Ports {
		parts := strings.Split(key, "/")
		if len(parts) != 2 || parts[1] == "" {
			return nil, fmt.Errorf("invalid port")
		}
		port, err := strconv.Atoi(parts[0])
		if err != nil || port < 1 || port > 65535 || len(parts[1]) > 32 {
			return nil, fmt.Errorf("invalid port")
		}
		protocol := parts[1]
		if len(bindings) == 0 {
			d.Ports = append(d.Ports, DockerDetailsPort{ContainerPort: port, Protocol: protocol})
			continue
		}
		for _, b := range bindings {
			hp := 0
			if b.HostPort != "" {
				hp, err = strconv.Atoi(b.HostPort)
				if err != nil || hp < 1 || hp > 65535 {
					return nil, fmt.Errorf("invalid host port")
				}
			}
			d.Ports = append(d.Ports, DockerDetailsPort{ContainerPort: port, Protocol: protocol, HostIP: b.HostIP, HostPort: hp})
		}
	}
	for _, m := range raw.Mounts {
		d.Mounts = append(d.Mounts, DockerDetailsMount{Type: m.Type, Source: m.Source, Destination: m.Destination, ReadOnly: !m.RW})
	}
	for name, n := range raw.NetworkSettings.Networks {
		d.Networks = append(d.Networks, DockerDetailsNetwork{Name: name, IPv4: n.IPv4, IPv6: n.IPv6, Gateway: n.Gateway})
	}
	sort.Slice(d.Ports, func(i, j int) bool {
		a, b := d.Ports[i], d.Ports[j]
		if a.Protocol != b.Protocol {
			return a.Protocol < b.Protocol
		}
		if a.ContainerPort != b.ContainerPort {
			return a.ContainerPort < b.ContainerPort
		}
		if a.HostIP != b.HostIP {
			return a.HostIP < b.HostIP
		}
		return a.HostPort < b.HostPort
	})
	sort.Slice(d.Mounts, func(i, j int) bool {
		if d.Mounts[i].Destination != d.Mounts[j].Destination {
			return d.Mounts[i].Destination < d.Mounts[j].Destination
		}
		return d.Mounts[i].Source < d.Mounts[j].Source
	})
	sort.Slice(d.Networks, func(i, j int) bool { return d.Networks[i].Name < d.Networks[j].Name })
	d.Healthcheck = &DockerDetailsHealthcheck{Status: "none"}
	if raw.State.Health != nil {
		d.Healthcheck.Status = raw.State.Health.Status
		d.Healthcheck.FailingStreak = &raw.State.Health.FailingStreak
	}
	if hc := raw.Config.Healthcheck; hc != nil {
		var ok bool
		if d.Healthcheck.IntervalMs, ok = durationMillis(hc.Interval); !ok {
			return nil, fmt.Errorf("invalid health interval")
		}
		if d.Healthcheck.TimeoutMs, ok = durationMillis(hc.Timeout); !ok {
			return nil, fmt.Errorf("invalid health timeout")
		}
		if d.Healthcheck.StartPeriodMs, ok = durationMillis(hc.StartPeriod); !ok {
			return nil, fmt.Errorf("invalid health start period")
		}
		if hc.Retries < 0 {
			return nil, fmt.Errorf("invalid health retries")
		}
		d.Healthcheck.Retries = &hc.Retries
	}
	if err := validateDockerContainerDetails(d); err != nil {
		return nil, err
	}
	b, err := json.Marshal(d)
	if err != nil || len(b) > dockerDetailsBytesMax {
		return nil, fmt.Errorf("details envelope exceeded")
	}
	return d, nil
}
func dockerInspectTimestamp(s string) (string, error) {
	if s == "" || strings.HasPrefix(s, "0001-01-01T00:00:00Z") {
		return "", nil
	}
	t, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		return "", fmt.Errorf("invalid inspect timestamp")
	}
	return t.UTC().Format(time.RFC3339Nano), nil
}
func durationMillis(n int64) (*int64, bool) {
	if n < 0 {
		return nil, false
	}
	v := n / 1_000_000
	if v > 9007199254740991 {
		return nil, false
	}
	return &v, true
}
func validDetailString(s string, max int) bool { return utf8.ValidString(s) && len([]byte(s)) <= max }
