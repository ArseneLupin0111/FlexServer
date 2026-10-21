//go:build linux

// Real canonical model resolution using only the verified Compose runtime.
package applications

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// preparePreview resolves the Compose model, authenticates and pulls its images
// in a private operation workspace, then pins every service to an observed digest.
// It returns canonical model bytes, a redacted projection, image digest map,
// removed-service candidates derived from the live inventory of `project`
// (only services absent from the canonical model, opaque container keys only),
// and the canonical digest. Empty `project` means read-only resolution: no
// inventory is sampled and removals stay empty (fail closed).
// The inventory fingerprint shares the deploy-side capture format so any
// inventory change between preview approval and deploy authorization fails closed.
func preparePreview(ctx context.Context, opID string, composeY, envY []byte, composeArgs []string, secretValues []string, rawCredentials []json.RawMessage, engine *engineClient, keyForID func(string) string, project string, appIDs ...string) ([]byte, []byte, map[string]string, []string, []previewRemoval, string, string, map[string]int, error) {
	rt, rtErr := DetectRuntime()
	if rtErr != nil {
		return nil, nil, nil, nil, nil, "", "", nil, errors.New(ErrRuntimeUnavailable)
	}
	runner, rErr := newComposeRunner(rt, "preview", opID)
	if rErr != nil {
		return nil, nil, nil, nil, nil, "", "", nil, rErr
	}
	defer runner.close()
	credentialVersions, authErr := prepareRegistryAuth(runner, rawCredentials, nil)
	if authErr != nil {
		return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("invalid registry credential configuration")
	}
	args := append([]string{}, composeArgs...)
	out, _, runErr := runner.runStdout(ctx, RegistryWorkflowTimeout, MaxComposeOutputBytes, "", composeY, envY, args...)
	if runErr != nil {
		return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("%s", ErrApplyFailed)
	}
	var model map[string]any
	if err := strictDecodeJSON(out, &model); err != nil {
		return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("%s", ErrMalformed)
	}
	if name, _ := model["name"].(string); name != "" && safeDirComponent(name) != nil {
		return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("%s", ErrMalformed)
	}
	services, ok := model["services"].(map[string]any)
	if !ok || len(services) == 0 {
		return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("canonical model has no services")
	}
	if _, _, err := runner.runStdout(ctx, RegistryWorkflowTimeout, MaxComposeOutputBytes, "", composeY, envY, deployArgsFromComposeConfig(args, "pull")...); err != nil {
		return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("image pull failed")
	}
	imageDigests := make(map[string]string, len(services))
	for name, value := range services {
		svc, ok := value.(map[string]any)
		if !ok {
			return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("%s", ErrMalformed)
		}
		image, _ := svc["image"].(string)
		if image == "" {
			return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("image_digest_mandatory:%s", name)
		}
		full, imgErr := InspectImageDigest(ctx, image)
		if imgErr != nil {
			return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("image digest resolution failed")
		}
		svc["image"] = full
		imageDigests[name] = full
	}
	var bindModel deployComposeModel
	bindBytes, bindErr := json.Marshal(model)
	if bindErr != nil || json.Unmarshal(bindBytes, &bindModel) != nil {
		return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("invalid_bind_model")
	}
	appID := ""
	if len(appIDs) == 1 {
		appID = appIDs[0]
	}
	hasBinds := false
	for _, svc := range bindModel.Services {
		for _, vol := range svc.Volumes {
			if vol.Type == "bind" {
				hasBinds = true
			}
		}
	}
	if hasBinds {
		if err := verifyAppBindSources(bindModel, appID, 256); err != nil {
			return nil, nil, nil, nil, nil, "", "", nil, err
		}
	}
	// Removal candidates come AFTER canonical resolution so only verified
	// canonical service names compete against the live inventory. Fail closed:
	// any inventory error (incomplete/over cap/invalid identity) aborts the
	// preview instead of silently producing an empty removal list.
	modelServices := make([]string, 0, len(services))
	for name := range services {
		modelServices = append(modelServices, name)
	}
	removals, inventoryFP, removalErr := deriveRemovedServiceCandidates(ctx, engine, keyForID, project, modelServices)
	if removalErr != nil {
		return nil, nil, nil, nil, nil, "", "", nil, fmt.Errorf("removed_service_inventory_failed: %s", removalErr)
	}
	removed := make([]string, 0, len(removals))
	for _, item := range removals {
		removed = append(removed, item.ServiceName)
	}
	canonical, redacted, images, _, digest, err := canonicalVerifiedModel(model, imageDigests, removed, secretValues)
	return canonical, redacted, images, removed, removals, digest, inventoryFP, credentialVersions, err
}

func deployArgsFromComposeConfig(configArgs []string, command string) []string {
	args := make([]string, 0, len(configArgs))
	for _, arg := range configArgs {
		if arg == "config" {
			break
		}
		args = append(args, arg)
	}
	return append(args, command)
}

// canonicalVerifiedModel marshals the resolved canonical model (full data,
// stored securely server-side) and a redacted copy, computes the canonical
// SHA-256 digest over the canonical bytes, and always refuses to report any
// secret material into the redacted projection.
func canonicalVerifiedModel(model any, imageDigests map[string]string, removed []string, secretValues []string) ([]byte, []byte, map[string]string, []string, string, error) {
	canonical, err := json.Marshal(model)
	if err != nil {
		return nil, nil, nil, nil, "", fmt.Errorf("%s", ErrMalformed)
	}
	redacted := redactDecoded("", model, secretValues)
	redBytes, marshalErr := json.Marshal(redacted)
	if marshalErr != nil {
		return nil, nil, nil, nil, "", fmt.Errorf("%s", ErrMalformed)
	}
	sum := sha256.Sum256(canonical)
	return canonical, redBytes, imageDigests, removed, hex.EncodeToString(sum[:]), nil
}

// redactDecoded substitutes every literal secret value found in the decoded
// canonical model before public serialization, so values containing JSON
// escapes (quotes, backslashes, newlines) cannot survive byte-level filters.
func redactDecoded(path string, node any, secretValues []string) any {
	if strings.HasSuffix(path, "/environment") {
		switch env := node.(type) {
		case map[string]any:
			out := make(map[string]any, len(env))
			for k := range env {
				out[k] = "[REDACTED]"
			}
			return out
		case []any:
			out := make([]any, len(env))
			for i := range env {
				out[i] = "[REDACTED]"
			}
			return out
		}
	}
	switch t := node.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, v := range t {
			childPath := k
			if path != "" {
				childPath = path + "/" + k
			}
			if s, ok := v.(string); ok {
				out[k] = redactString(childPath, s, secretValues)
				continue
			}
			out[k] = redactDecoded(childPath, v, secretValues)
		}
		return out
	case []any:
		out := make([]any, 0, len(t))
		for _, v := range t {
			out = append(out, redactDecoded(path, v, secretValues))
		}
		return out
	case string:
		return redactString(path, t, secretValues)
	default:
		return node
	}
}

// redactString replaces any literal secret value found inside one string,
// and always redacts protected fields regardless of their content.
func redactString(path, s string, secretValues []string) string {
	if inlineProtected(path) || strings.Contains(path, "/environment/") || strings.HasSuffix(path, "/environment") {
		return "[REDACTED]"
	}
	for _, sv := range secretValues {
		if sv != "" && strings.Contains(s, sv) {
			return "[REDACTED]"
		}
	}
	return s
}

// inlineProtected marks canonical paths that can carry credential material
// regardless of whether the underlying value is registered on the server.
func inlineProtected(path string) bool {
	for _, suffix := range []string{"/command", "/entrypoint", "/healthcheck/test", "/healthcheck.test"} {
		if strings.HasSuffix(path, suffix) {
			return true
		}
	}
	return false
}

// InspectImageDigest resolves one image reference to its immutable pinned
// digest exactly as observed by the engine daemon (never by a Compose tag
// resolution and never invented). Intersection with the upstream registry
// follows engine-side observed RepoDigests.
func InspectImageDigest(ctx context.Context, image string) (string, error) {
	if image == "" || len(image) > MaxComposeImagePathBytes {
		return "", fmt.Errorf("%s", ErrMalformed)
	}
	if strings.ContainsAny(image, "\x00\n\r") {
		return "", fmt.Errorf("%s", ErrMalformed)
	}
	engine, err := NewEngineClient(30 * time.Second)
	if err != nil {
		return "", errors.New(ErrRuntimeUnavailable)
	}
	full, err := engine.InspectImage(ctx, image)
	if err != nil {
		return "", fmt.Errorf("%s", err)
	}
	return full, nil
}
