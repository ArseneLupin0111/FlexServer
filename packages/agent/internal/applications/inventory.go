// Package applications implements the phase-2 Compose agent slice: a
// separate, bounded metadata inventory of Docker Compose projects, safe
// read-only external-source verification, trusted runtime capability, and
// durable managed-operation execution — never through ambient proxy env, a
// writable registry auth dir, or inherited DOCKER_/COMPOSE_/helper
// configuration.
//
// Transport (ComposeApi contract, v1):
//
//	POST {backend}/api/agent/applications/inventory
//	  Body: CompactInventory (canonical JSON, sha256 digest in header
//	  `x-inventory-digest`); response {"data":{"ok":true}}.
//
//	POST /api/agent/applications/operations/claim     → {"data":{"work":{...}|null}}
//	POST /api/agent/applications/operations/progress  → {"data":{"ok":true}}
//	POST /api/agent/applications/operations/authorize → authorization receipt
//	POST /api/agent/applications/operations/result    → {"data":{"ok":true}}
//
// All routes use the agent bearer token, mirroring /api/agent/commands/*.
// Operation payloads are bounded; protocol version `applications-v1`.
//
// Design invariants (plan/annex): metadata projection only — opaque keys,
// never raw IDs outside this host; completeness=false over cap or partial
// failure with a reason, never inferred absence; sequence strictly
// monotonic per inventory, not the metrics watermark.
package applications

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Bounded caps are explicit contract values (annex §1: one hard cap per
// dimension; exceeding one yields completeness=false, never truncation).
const (
	// InventoryProtocolVersion identifies the wire contract understood here.
	InventoryProtocolVersion = "applications-v1"

	// MaxInventoryContainers is the participation cap for one inventory pass.
	MaxInventoryContainers = 500
	// MaxInventoryProjects bounds distinct project names per pass.
	MaxProjectsPerInventory = 100
	// MaxServicesPerProject bounds services per project pass.
	MaxServicesPerProject = 64
	// MaxReplicasPerService bounds replicas listed per service.
	MaxReplicasPerService = 100

	// MaxInventoryBodyBytes bounds the raw daemon list response (2 MiB).
	MaxInventoryBodyBytes = 2 * 1024 * 1024

	// InventoryBudget bounds one collection pass (2 s; the separate optional
	// cadence lives in options.InventorierSchedule).
	InventoryBudget = 2 * time.Second

	// MaxProjectNameBytes bounds an untrusted compose project name.
	MaxProjectNameBytes = 128
	// MaxServiceNameBytes bounds an untrusted compose service name.
	MaxServiceNameBytes = 128
	// MaxLabelValueBytes bounds any mirrored label value.
	MaxLabelValueBytes = 128
)

// Compose label keys mirrored into the safe projection (allowlist).
const (
	LabelProject  = "com.docker.compose.project"
	LabelService  = "com.docker.compose.service"
	LabelNumber   = "com.docker.compose.container-number"
	LabelOneoff   = "com.docker.compose.oneoff"
	LabelConfigHK = "com.docker.compose.config-hash"
)

// InventoryReason enumerates completeness reasons; stable contract values.
const (
	ReasonOverRepo        = "over_repo_cap"
	ReasonOverTotal       = "over_total_cap"
	ReasonOverPayload     = "over_payload_cap"
	ReasonOverProjectCap  = "over_project_cap"
	ReasonOverServiceCap  = "over_service_cap"
	ReasonOverReplicaCap  = "over_replica_cap"
	ReasonMalformed       = "malformed_response"
	ReasonIncomplete      = "partial_failure"
	ReasonInvalidMetadata = "invalid_metadata"
	ReasonTruncatedList   = "truncated_list"
	ReasonTransport       = "transport_failure"
	ReasonEncode          = "encode_failure"
	ReasonProjection      = "projection_failure"
	ReasonContention      = "in_progress_contention"
)

// ContainerRole classifies compose membership in the projection.
const (
	RoleStandalone = "standalone"
	RoleReplica    = "replica"
	RoleOneoff     = "oneoff"
)

// Health values mirrored from monitoring constants (same contract meaning).
const (
	HealthRunning   = "running"
	HealthExited    = "exited"
	HealthOther     = "other"
	HealthHealthy   = "healthy"
	HealthUnhealthy = "unhealthy"
	HealthStarting  = "starting"
	HealthNone      = "none"
)

// Oneoff values mirrored from the compose label.
const (
	OneoffTrue  = "True"
	OneoffFalse = "False"
)

// OpaqueKey mirrors the opaque identity computed by state (32 chars).
// Wired through Options.ContainerKey to avoid an import cycle.
type OpaqueKey = string

// ServiceSummary is one projected (project, service) group.
type ServiceSummary struct {
	Service       string    `json:"service"`
	OccupiedSlots []int     `json:"occupiedSlots"`
	MaxSlot       int       `json:"maxSlot"`
	Replicas      []Replica `json:"replicas"`
	Health        string    `json:"health"`
	IsOneoff      bool      `json:"isOneoff"`
	ConfigDigest  string    `json:"configHash"`
}

// Replica is one bounded observed container row.
type Replica struct {
	ContainerKey string `json:"containerKey"`
	Slot      int    `json:"slot"`
	State     string `json:"state"`
	Status    string `json:"status"`
	Health    string `json:"health,omitempty"`
	Image     string `json:"image,omitempty"`
	Oneoff    bool   `json:"oneoff,omitempty"`
	CreatedAt string `json:"createdAt"`
}

// ProjectSummary is one projected project grouping.
type ProjectSummary struct {
	Project      string           `json:"project"`
	Services     []ServiceSummary `json:"services"`
	ReplicaTotal int              `json:"replicaTotal"`
}

// Capability is the safe runtime pose reported beside inventory.
type Capability struct {
	ProtocolVersion string `json:"protocolVersion"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
	AgentVersion    string `json:"agentVersion"`
	DockerAvailable bool   `json:"dockerAvailable"`
	DockerVersion   string `json:"dockerVersion,omitempty"`
	ComposeMode     string `json:"composeMode"`
	ComposeVersion  string `json:"composeVersion,omitempty"`
	InstallState    string `json:"installState"`
	// ManagementGate mirrors the VPS flag known locally (never authoritative).
	ManagementGate bool `json:"managementGate"`
	// Features lists validated capability keys (helpers.MajorOK etc.).
	Features []string `json:"features"`
	// Reasons explain degraded/unknown pose; bounded human strings.
	Reasons []string `json:"reasons"`
}

// Capability feature keys (stable contract strings).
const (
	FeatureComposeMajor2      = "compose_major_2"
	FeatureComposeConfigHash  = "compose_config_hash"
	FeatureComposeProfileFlag = "compose_profile_flag"
	FeatureComposeDetachWait  = "compose_detached_wait"
)

// Capability install states (stable contract strings).
const (
	InstallMissing = "missing"
	InstallCLIOnly = "cli_only"
	InstallPlugin  = "plugin"
	InstallUnknown = "unknown"
)

// Invocation modes for the compose entrypoint (mode of use, not a version).
const (
	ModePlugin     = "plugin"
	ModeStandalone = "standalone"
)

// Inventory is one bounded projection pass.
type Inventory struct {
	ProtocolVersion string           `json:"protocolVersion"`
	AgentInstanceID string           `json:"agentInstanceId"`
	DaemonEpoch     int64            `json:"daemonEpoch"`
	Sequence        uint64           `json:"inventorySequence"`
	CollectedAt     string           `json:"collectedAt"`
	Complete        bool             `json:"completeness"`
	Reason          string           `json:"completionReason"`
	ContainerTotal  int              `json:"containerTotal"`
	ProjectTotal    int              `json:"projectTotal"`
	ReplicaTotal    int              `json:"replicaTotal"`
	Projects        []ProjectSummary `json:"projects"`
	Capability      Capability       `json:"capability"`
}

// InventoryOptions is the per-pass identity/schedule/config bundle.
type InventoryOptions struct {
	// AgentInstanceID is the stable opaque per-install identity.
	AgentInstanceID string
	// DaemonEpoch resolves the locally tracked daemon identity guidance.
	DaemonEpoch func() int64
	// Sequence is a durable monotonic inventory counter source.
	Sequence func() (uint64, error)
	// ContainerKey derives the opaque identity of one raw container ID.
	ContainerKey func(fullID string) string
	// Capabilities computes the current runtime capability pose.
	Capabilities func(ctx context.Context) (Capability, error)
	// Now is the clock (defaults to time.Now).
	Now func() time.Time
	// Timeout is the overall pass deadline (default InventoryBudget).
	Timeout time.Duration
	// MaxContainers overrides MaxInventoryContainers (tests).
	MaxContainers int
}

func (o *InventoryOptions) defaults() {
	if o.ContainerKey == nil {
		o.ContainerKey = func(string) string { return "" }
	}
	if o.Capabilities == nil {
		o.Capabilities = func(context.Context) (Capability, error) { return Capability{}, nil }
	}
	if o.DaemonEpoch == nil {
		o.DaemonEpoch = func() int64 { return 0 }
	}
}

// InventoryError carries a completion reason for typed handling.
type InventoryError struct {
	Reason string
	Cause  error
}

func (e *InventoryError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("applications: inventory incomplete (%s): %v", e.Reason, e.Cause)
	}
	return fmt.Sprintf("applications: inventory incomplete (%s)", e.Reason)
}

func (e *InventoryError) Unwrap() error { return e.Cause }

// inventoryRaw is the bounded raw container list row read from the daemon.
type inventoryRaw struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Created int64             `json:"Created"`
	Labels  map[string]string `json:"Labels"`
}

// project mirrors the safe compose.project label source.
func (r inventoryRaw) project() string { return r.Labels[LabelProject] }

// service mirrors the safe compose.service label source.
func (r inventoryRaw) service() string { return r.Labels[LabelService] }

// slotNumber maps compose container-number into the bounded integer slot
// domain; oneoff rows collapse to slot -1.
func (r inventoryRaw) slotNumber() int {
	if r.Labels[LabelOneoff] == OneoffTrue {
		return -1
	}
	n := 0
	for i := 0; i < len(r.Labels[LabelNumber]) && n < 1_000_000; i++ {
		c := r.Labels[LabelNumber][i]
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// buildInventory projects raw rows into the bounded compact Inventory.
// completeness=false with a typed reason on cap/partial failure; raw IDs
// never cross this boundary (keys only).
func buildInventory(raw []inventoryRaw, opts InventoryOptions) (*Inventory, error) {
	opts.defaults()
	if opts.Now == nil {
		opts.Now = time.Now
	}
	limit := opts.MaxContainers
	if limit == 0 {
		limit = MaxInventoryContainers
	}
	maxProjects := MaxProjectsPerInventory
	maxServices := MaxServicesPerProject
	maxReplicas := MaxReplicasPerService

	ensureCap := func(c bool, reason string) error {
		if !c {
			return &InventoryError{Reason: reason}
		}
		return nil
	}
	if err := ensureCap(len(raw) <= limit, ReasonOverTotal); err != nil {
		return nil, err
	}
	type serviceKey struct{ project, service string }
	orders := []serviceKey{}
	services := map[serviceKey]*ServiceSummary{}
	projectSeen := map[string]bool{}
	var replicaTotal int
	for _, row := range raw {
		project, service := row.project(), row.service()
		if project == "" || service == "" {
			continue
		}
		if _, err := SanitizeProjectName(project); err != nil {
			return nil, &InventoryError{Reason: ReasonInvalidMetadata}
		}
		if _, err := SanitizeServiceName(service); err != nil {
			return nil, &InventoryError{Reason: ReasonInvalidMetadata}
		}
		containerKey := opts.ContainerKey(row.ID)
		if len(containerKey) != 32 {
			return nil, &InventoryError{Reason: ReasonInvalidMetadata}
		}
		key := serviceKey{project, service}
		svc, created := services[key]
		if !created {
			if len(orders) >= maxProjects*maxServices {
				return nil, &InventoryError{Reason: ReasonOverServiceCap}
			}
			orders = append(orders, key)
			svc = &ServiceSummary{Service: service}
			services[key] = svc
		}
		// Slot: numeric container-number, oneoff→slot -1.
		slot := row.slotNumber()
		svc.OccupiedSlots = append(svc.OccupiedSlots, slot)
		svc.Replicas = append(svc.Replicas, Replica{
			ContainerKey: containerKey,
			Slot:      slot,
			State:     row.State,
			Status:    row.Status,
			Image:     row.Image,
			Oneoff:    row.Labels[LabelOneoff] == OneoffTrue,
			CreatedAt: time.Unix(row.Created, 0).UTC().Format(time.RFC3339),
		})
		svc.IsOneoff = svc.IsOneoff || row.Labels[LabelOneoff] == OneoffTrue
		replicaTotal++
	}

	// Collapse to projected services in stable first-seen order.
	projects := []ProjectSummary{}
	var synthesisErr error
	for i := range orders {
		k := orders[i]
		svc := services[k]
		if len(svc.OccupiedSlots) > maxReplicas {
			synthesisErr = &InventoryError{Reason: ReasonOverReplicaCap}
			break
		}
		sortInts(svc.OccupiedSlots)
		sortReplicas(svc.Replicas)
		svc.MaxSlot = 0
		for _, s := range svc.OccupiedSlots {
			if s > svc.MaxSlot {
				svc.MaxSlot = s
			}
		}
		p := &ProjectSummary{Project: k.project}
		projects, p = appendProject(projects, p, k.project, projectSeen, svc)
	}

	// Cap per-project services (may still breach cap if many distinct).
	for i := range projects {
		if len(projects[i].Services) > maxServices {
			synthesisErr = &InventoryError{Reason: ReasonOverServiceCap}
			break
		}
	}
	if err := ensureCap(len(projects) <= maxProjects, ReasonOverProjectCap); err != nil {
		return nil, err
	}
	if synthesisErr != nil {
		return nil, synthesisErr
	}

	// Assemble the compact inventory.
	inv := &Inventory{
		ProtocolVersion: InventoryProtocolVersion,
		AgentInstanceID: opts.AgentInstanceID,
		DaemonEpoch:     opts.DaemonEpoch(),
		CollectedAt:     opts.Now().UTC().Format(time.RFC3339Nano),
		Complete:        true,
		ContainerTotal:  len(raw),
		ProjectTotal:    len(projects),
		ReplicaTotal:    replicaTotal,
		Projects:        projects,
	}
	if opts.Sequence != nil {
		seq, err := opts.Sequence()
		if err != nil {
			return nil, &InventoryError{Reason: ReasonEncode, Cause: err}
		}
		inv.Sequence = seq
	}
	cap, err := opts.Capabilities(context.TODO())
	if err != nil {
		return nil, &InventoryError{Reason: ReasonProjection, Cause: err}
	}
	inv.Capability = cap
	inv.Capability.ProtocolVersion = InventoryProtocolVersion
	return inv, nil
}

// appendProject reduces the first-seen service into the projected grouping.
func appendProject(
	projects []ProjectSummary,
	p *ProjectSummary, project string,
	seen map[string]bool, svc *ServiceSummary,
) ([]ProjectSummary, *ProjectSummary) {
	if !seen[project] {
		seen[project] = true
		projects = append(projects, ProjectSummary{Project: project})
	}
	var p2 *ProjectSummary
	for i := range projects {
		if projects[i].Project == project {
			p2 = &projects[i]
			break
		}
	}
	p2.Services = append(p2.Services, *svc)
	p2.ReplicaTotal += len(svc.OccupiedSlots)
	return projects, p2
}

func sortReplicas(v []Replica) {
	sort.SliceStable(v, func(a, b int) bool { return v[a].Slot < v[b].Slot })
}

func sortInts(v []int) {
	sort.Slice(v, func(a, b int) bool { return v[a] < v[b] })
}

// InventoryIngestTransport pushes one compact inventory once.
type InventoryIngestTransport interface {
	// Push compacts and pushes the projected inventory once.
	Push(ctx context.Context, inv *Inventory) error
}

// SanitizeProjectName validates untrusted compose project metadata:
// bounded metadata (bounded; control chars rejected; UTF-8 required).
func SanitizeProjectName(s string) (string, error) {
	return sanitizeComposeComponent(s, MaxProjectNameBytes)
}

// SanitizeServiceName validates untrusted compose service metadata.
func SanitizeServiceName(s string) (string, error) {
	return sanitizeComposeComponent(s, MaxServiceNameBytes)
}

// sanitizeComposeComponent is the shared bounded-metadata validator:
// bounded length, UTF-8 required, no control bytes anywhere.
func sanitizeComposeComponent(s string, max int) (string, error) {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" || len(trimmed) > max {
		return "", fmt.Errorf("applications: metadata length")
	}
	for _, r := range trimmed {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("applications: metadata control char")
		}
	}
	if !utf8.ValidString(trimmed) {
		return "", fmt.Errorf("applications: metadata not UTF-8")
	}
	return trimmed, nil
}

// urlLabel escapes a label key for a Docker list querystring.
func urlLabel(k string) string { return url.QueryEscape(k) }

// ensure json import retains encoding/json for downstream modules sharing
// the package transport helpers in this file.
var _ = json.Marshal
