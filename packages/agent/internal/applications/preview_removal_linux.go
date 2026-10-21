//go:build linux

// Bounded pre-approval removal candidate derivation. The canonical Compose
// model is compared against a fresh inventory of the target project so only
// services absent from the revision are offered for teardown; the fingerprint
// shares the exact captureRemovedOwnership format so the deploy side fails
// closed whenever the inventory changed between approval and mutation.
package applications

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
)

// deriveRemovedServiceCandidates samples the live inventory for one target
// project (`project` – never leaked beyond the opaque-key boundary), selects
// only compose services NOT present in `modelServices` (the canonical Compose
// service names of the pre-approval revision), and reports one manifest entry
// per removed service with the opaque ContainerKey of every owned container.
// inventoryFingerprint is byte-identical to the deploy-side capture fingerprint
// (same row set, same ordering, same JSON encoding), so any observed change
// between preview resolution and deploy authorization is always rejected.
//
// Fail closed, never guess absence: over project caps, incomplete or errored
// inventories, or invalid identities return an error — the caller aborts the
// preview instead of silently dropping candidates.
func deriveRemovedServiceCandidates(ctx context.Context, e *engineClient, keyForID func(string) string, project string, modelServices []string) ([]previewRemoval, string, error) {
	if e == nil || keyForID == nil || project == "" {
		return nil, "", fmt.Errorf("ownership_identity_unavailable")
	}
	present := make(map[string]bool, len(modelServices))
	for _, name := range modelServices {
		if name == "" {
			return nil, "", fmt.Errorf("invalid_canonical_service_name")
		}
		present[name] = true
	}
	ids, err := e.listAllIDs(ctx)
	if err != nil {
		return nil, "", err
	}
	if len(ids) > MaxInventoryContainers {
		return nil, "", fmt.Errorf("%s", ReasonOverTotal)
	}
	rows := make([]removalInventoryRow, 0, len(ids))
	keyToID := make(map[string]string, len(ids))
	for _, id := range ids {
		snap, er := e.InspectContainer(ctx, id)
		if er != nil {
			return nil, "", fmt.Errorf("inventory_incomplete")
		}
		key := keyForID(id)
		if len(key) != 32 || keyToID[key] != "" {
			return nil, "", fmt.Errorf("duplicate_or_invalid_container_key")
		}
		keyToID[key] = id
		if snap.Labels[LabelProject] != project {
			continue
		}
		slot := 0
		if n, parseErr := strconv.Atoi(snap.Labels[LabelNumber]); parseErr == nil && n >= 0 {
			slot = n
		}
		rows = append(rows, removalInventoryRow{ContainerKey: key, Project: snap.Labels[LabelProject], Service: snap.Labels[LabelService], Slot: slot, State: snap.State})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ContainerKey < rows[j].ContainerKey })
	encoded, err := json.Marshal(rows)
	if err != nil {
		return nil, "", err
	}
	fingerprint := removalInventoryFingerprint(encoded)
	sort.Slice(rows, func(i, j int) bool { return rows[i].ContainerKey < rows[j].ContainerKey })
	if len(rows) > MaxInventoryContainers {
		return nil, "", fmt.Errorf("%s", ReasonOverTotal)
	}
	// Group every container of an absent canonical service into one manifest
	// entry; nothing observed but unnamed (service label missing) may ever
	// become a candidate because ownership cannot be verified for it.
	orders := make([]string, 0, len(rows))
	byService := make(map[string][]string, len(rows))
	for _, row := range rows {
		if row.Service == "" {
			return nil, "", fmt.Errorf("%s", ReasonInvalidMetadata)
		}
		if present[row.Service] {
			continue
		}
		if _, seen := byService[row.Service]; !seen {
			orders = append(orders, row.Service)
		}
		byService[row.Service] = append(byService[row.Service], row.ContainerKey)
	}
	sort.Strings(orders)
	if len(orders) > 64 {
		return nil, "", fmt.Errorf("removed_service_over_cap")
	}
	removals := make([]previewRemoval, 0, len(orders))
	for _, service := range orders {
		keys := byService[service]
		if len(keys) == 0 || len(keys) > 100 {
			return nil, "", fmt.Errorf("owned_container_over_cap")
		}
		sort.Strings(keys)
		removals = append(removals, previewRemoval{ServiceName: service, ContainerKeys: keys})
	}
	return removals, fingerprint, nil
}

// removalInventoryFingerprint hashes the encoded row bytes exactly like the
// deploy-side capture; both paths MUST use this shared helper so the two
// fingerprints can never drift.
func removalInventoryFingerprint(encoded []byte) string {
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}
