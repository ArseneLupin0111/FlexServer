//go:build linux

package applications

// Canonical hash contract shared with the API (Compose2 phase-2):
//   deploy:       {approvedDigest,appId,daemonEpoch,generation,operationId,kind,removedServiceIds}
//   lifecycle:    {appId,daemonEpoch,generation,operationId,kind,sourceDigest,observedFingerprint}
//   runtime_prep: {operationId,kind,generation}
// compact ordered JSON, sha256 hex. Keys are emitted in contract order;
// values: daemonEpoch string, generation number, removedServiceIds sorted
// JSON array.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// canonicalHashJSON renders the exact bytes the API digest() agrees on:
// one compact JSON object with keys pre-ordered, sorted arrays when
// present, and no whitespace. Values are limited to the bounded digest
// alphabet (hex ids, lower-case kinds, decimal generation) so plain
// encoding stays byte-identical to the API JSON.stringify contract.
func canonicalHashJSON(pairs ...[2]any) (string, error) {
	var b strings.Builder
	b.WriteByte('{')
	first := true
	for _, kv := range pairs {
		key, ok := kv[0].(string)
		if !ok || key == "" {
			return "", fmt.Errorf("canonical_hash_key")
		}
		enc, err := canonicalHashValue(kv[1])
		if err != nil {
			return "", err
		}
		if !first {
			b.WriteByte(',')
		}
		first = false
		b.WriteString(canonicalJSONString(key))
		b.WriteByte(':')
		b.WriteString(enc)
	}
	b.WriteByte('}')
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:]), nil
}

// canonicalHashValue renders one value: strings raw, integers decimal,
// sorted string lists as JSON arrays; other structures are rejected so
// silent type drift can never change a terminal payload fingerprint.
func canonicalHashValue(v any) (string, error) {
	switch t := v.(type) {
	case string:
		return canonicalJSONString(t), nil
	case int:
		return fmt.Sprintf("%d", t), nil
	case int64:
		return fmt.Sprintf("%d", t), nil
	case uint64:
		return fmt.Sprintf("%d", t), nil
	case []string:
		sorted := append([]string{}, t...)
		sort.Strings(sorted)
		var b strings.Builder
		b.WriteByte('[')
		for i, s := range sorted {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(canonicalJSONString(s))
		}
		b.WriteByte(']')
		return b.String(), nil
	case previewRemoval:
		var b strings.Builder
		b.WriteString(`{"serviceName":`)
		b.WriteString(canonicalJSONString(t.ServiceName))
		b.WriteString(`,"containerKeys":`)
		encoded, err := canonicalHashValue(t.ContainerKeys)
		if err != nil { return "", err }
		b.WriteString(encoded)
		b.WriteByte('}')
		return b.String(), nil
	case ownershipBinding:
		return `{"agentInstanceId":`+canonicalJSONString(t.AgentInstanceID)+`,"daemonEpoch":`+canonicalJSONString(t.DaemonEpoch)+`,"projectName":`+canonicalJSONString(t.ProjectName)+`}`, nil
	case []previewRemoval:
		var b strings.Builder
		b.WriteByte('[')
		for i, item := range t { if i > 0 { b.WriteByte(',') }; encoded, err := canonicalHashValue(item); if err != nil { return "", err }; b.WriteString(encoded) }
		b.WriteByte(']')
		return b.String(), nil
	default:
		return "", fmt.Errorf("canonical_hash_value_type")
	}
}

// canonicalJSONString emits one bounded JSON string literal.
func canonicalJSONString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString("\\\"")
		case '\\':
			b.WriteString("\\\\")
		case '\n':
			b.WriteString("\\n")
		case '\r':
			b.WriteString("\\r")
		case '\t':
			b.WriteString("\\t")
		default:
			if r < 0x20 {
				b.WriteString(fmt.Sprintf("\\u%04x", r))
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// observedFingerprint hashes the agent-instance-scoped observation pair
// exactly as the API digest(JSON.stringify([...])) does: compact JSON
// array [agentInstanceId, daemonEpoch].
func observedFingerprint(agentInstanceID, daemonEpoch string) string {
	var b strings.Builder
	b.WriteByte('[')
	b.WriteString(canonicalJSONString(agentInstanceID))
	b.WriteByte(',')
	b.WriteString(canonicalJSONString(daemonEpoch))
	b.WriteByte(']')
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}
