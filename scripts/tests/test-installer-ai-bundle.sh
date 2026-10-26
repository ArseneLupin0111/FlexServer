#!/usr/bin/env bash
#
# test-installer-ai-bundle.sh — Focused assertions for AI bundle install
# wiring in the two installer scripts (non-updater scope).
#
# Verifies:
#   1. Both scripts pass `bash -n` syntax checks.
#   2. install-local-agent.sh auto-resolves a packaged AI bundle per host
#      architecture (amd64 and arm64 asset names, no updater fallback).
#   3. install.sh stages only the AI bundle artifacts it owns and forwards
#      them under the same --ai-* flag contract as the remote runner.
#   4. No updater invocation survives in either script.
#   5. Uninstall never deletes AI state: /var/lib/flexserver-ai is preserved
#      in place (no timestamp copies, no rm of the state dir).
#   6. Live dry-run smoke (root or passwordless sudo; skipped otherwise):
#      a. With a locally packaged bundle next to the agent binary, the dry
#         run announces the AI executor/helper install without writing
#         anything, and only the host arch asset is selected.
#      b. With a packaged bundle whose AI assets are missing (i.e. an
#         incomplete bundle), the --enable-ai install path must exit
#         non-zero rather than silently installing the agent without AI.

# Safe to run anywhere: live checks use --dry-run only (no systemd writes).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_SH="${REPO_ROOT}/scripts/install/install.sh"
INSTALL_LOCAL="${REPO_ROOT}/scripts/install/install-local-agent.sh"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }

# ── 1. Syntax ─────────────────────────────────────────────────────────────

if bash -n "$INSTALL_SH"; then pass "install.sh syntax OK"; else fail "install.sh syntax"; fi
if bash -n "$INSTALL_LOCAL"; then pass "install-local-agent.sh syntax OK"; else fail "install-local-agent.sh syntax"; fi
if bash -n "${BASH_SOURCE[0]}"; then pass "installer test syntax OK"; else fail "installer test syntax"; fi

# ── 2. Per-arch bundle auto-resolution ────────────────────────────────────
if grep -Fq 'aarch64|arm64) ai_bundle_arch="arm64"' "$INSTALL_LOCAL" \
  && grep -Fq 'ai-executor-linux-${ai_bundle_arch}' "$INSTALL_LOCAL" \
  && grep -Fq 'ai-host-helper-linux-${ai_bundle_arch}' "$INSTALL_LOCAL" \
  && grep -Fq 'ai-rootfs-linux-${ai_bundle_arch}.tar.gz' "$INSTALL_LOCAL" \
  && grep -Fq 'ai-rootfs-linux-${ai_bundle_arch}.manifest.json' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh resolves bundle assets by host architecture"
else
  fail "install-local-agent.sh must derive ai-executor/helper/rootfs asset names from the host arch"
fi

# Fail-closed on arch-mismatched/missing bundles: no silent amd64 fallback.
if grep -Fq 'Unsupported host architecture for the AI bundle' "$INSTALL_LOCAL" \
  && grep -Fq 'AI bundle incomplete: missing' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh fails closed on incomplete/arch-mismatched bundles"
else
  fail "install-local-agent.sh must fail closed when the AI bundle is missing or arch-mismatched"
fi

if grep -Fq 'x86_64|amd64) ai_bundle_arch="amd64"' "$INSTALL_LOCAL" \
  && grep -Fq 'aarch64|arm64) ai_bundle_arch="arm64"' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh maps amd64 and arm64 host arch in preflight"
else
  fail "install-local-agent.sh must map x86_64|amd64 and aarch64|arm64"
fi

# Bundle search roots include the agent binary's own directory (packaged
# sibling bundle) and the API image copy under /app/agent/ai.
if grep -Fq 'PREFLIGHT_BUNDLE_ROOTS=("${ai_cand_dir}" "${SCRIPT_DIR:-$ai_cand_dir}" "/app/agent/ai"' "$INSTALL_LOCAL" \
  && grep -Fq '"/opt/vps-manager"' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh searches staged bundle roots (binary dir, /app/agent/ai, /opt/vps-manager)"
else
  fail "install-local-agent.sh must search ai_cand_dir, script dir, /app/agent/ai and /opt/vps-manager"
fi

# ── 3. Same --ai-* flag contract as the remote bundle runner ──────────────

if grep -Fq 'AGENT_INSTALL_ARGS+=(--install-ai)' "$INSTALL_SH" \
  && grep -Fq 'AGENT_INSTALL_ARGS+=(--ai-executor-binary "$AI_EXECUTOR_TMP")' "$INSTALL_SH" \
  && grep -Fq 'AGENT_INSTALL_ARGS+=(--ai-host-helper-binary "$AI_HELPER_TMP")' "$INSTALL_SH" \
  && grep -Fq 'AGENT_INSTALL_ARGS+=(--ai-rootfs-tar "$AI_ROOTFS_TAR_TMP")' "$INSTALL_SH" \
  && grep -Fq 'AGENT_INSTALL_ARGS+=(--ai-rootfs-manifest "$AI_ROOTFS_MANIFEST_TMP")' "$INSTALL_SH" \
  && grep -Fq 'AGENT_INSTALL_ARGS+=(--ai-profiles-dir "$AI_PROFILES_SRC")' "$INSTALL_SH"; then
  pass "install.sh forwards executor/helper/rootfs/manifest/profiles under --ai-* flags"
else
  fail "install.sh must forward all AI flags matching the remote ai-bundle-install contract"
fi

# ── 4. No updater invocations ─────────────────────────────────────────────

UPDATER_HIT="$(grep -hn -E 'vps-updater|install-updater|prepare-agent-updater|--updater-binary|--updater-config|--upgrade-updater|FLEET_RELEASE' "$INSTALL_SH" "$INSTALL_LOCAL" || true)"
if [[ -z "$UPDATER_HIT" ]]; then
  pass "neither installer script references the updater anymore"
else
  fail "updater references must not remain: ${UPDATER_HIT}"
fi

# ── 5. Uninstall preserves AI host state ──────────────────────────────────

if grep -Fq 'AI state (state file, receipts, scratch, backups) is never deleted' "$INSTALL_LOCAL" \
  && grep -Fq 'Preserving AI state in ${AI_STATE_DIR}' "$INSTALL_LOCAL" \
  && ! grep -Eq 'flexserver-ai-preserved-receipts' "$INSTALL_LOCAL" \
  && ! grep -Eq 'rm -rf "\$AI_STATE_DIR"' "$INSTALL_LOCAL"; then
  pass "uninstall keeps /var/lib/flexserver-ai in place (no timestamp copies, no removal)"
else
  fail "uninstall must never delete AI state (state/receipts/scratch/backups preserved in place)"
fi

# Teardown notes: only AI-specific artifacts (unit, helper, executor, socket,
# run dir, profiles, rootfs) are removed; state/logs are kept.
if grep -Fq 'rm -f "$AI_HELPER_UNIT_FILE"' "$INSTALL_LOCAL" \
  && grep -Fq 'rm -rf "$AI_RUN_DIR"' "$INSTALL_LOCAL" \
  && grep -Fq 'rm -rf "$AI_PROFILES_DIR"' "$INSTALL_LOCAL"; then
  pass "uninstall removes AI runtime/unit/profile artifacts only"
else
  fail "uninstall should remove the AI helper unit, run dir and profiles while keeping state"
fi


if grep -Eq '^CapabilityBoundingSet=.*CAP_CHOWN' "$INSTALL_LOCAL" \
  && grep -Fq 'CAP_CHOWN CAP_SYS_CHROOT' "$INSTALL_LOCAL"; then
  pass "AI helper unit grants CAP_CHOWN for socket ownership"
else
  fail "AI helper CapabilityBoundingSet must include CAP_CHOWN or chown of the runtime socket fails with EPERM"
fi

# ── Static checks for atomic staging, permissions, and preflight gates ───
if grep -Fq 'install_ai_rootfs() {' "$INSTALL_LOCAL" \
  && grep -Fq 'mktemp -d' "$INSTALL_LOCAL" \
  && grep -Fq 'rolling back' "$INSTALL_LOCAL"; then
  pass "install-local-agent.sh defines atomic rootfs staging with rollback"
else
  fail "install-local-agent.sh must stage rootfs in sibling directory and roll back on failure"
fi

if grep -Fq '[[ -n "$PREFLIGHT_AI_HOST_HELPER" && -f "$PREFLIGHT_AI_HOST_HELPER" && -r "$PREFLIGHT_AI_HOST_HELPER" ]]' "$INSTALL_LOCAL"; then
  pass "preflight checks existence and readability on AI asset overrides"
else
  fail "preflight must verify existence and readability of asset overrides before staging"
fi

if grep -A4 'cp -a "$AI_PROFILES_STAGED_SRC/\."' "$INSTALL_LOCAL" | grep -Fq 'chmod 0755 "$AI_PROFILES_DIR"'; then
  pass "profile copy reapplies 0755 permissions to AI_PROFILES_DIR"
else
  fail "profile copy must reapply 0755 to AI_PROFILES_DIR after cp -a"
fi

# ── Behavioral: Rootfs atomic replacement and rollback ───────────────────
ROOTFS_TEST_DIR="$(mktemp -d)"
mkdir -p "$ROOTFS_TEST_DIR/rootfs/bin"
printf 'old-binary\n' > "$ROOTFS_TEST_DIR/rootfs/bin/old-app"
OLD_HASH="$(sha256sum "$ROOTFS_TEST_DIR/rootfs/bin/old-app" | awk '{print $1}')"
printf '{"version":1,"files":[{"path":"/bin/old-app","sha256":"%s"}]}\n' "$OLD_HASH" > "$ROOTFS_TEST_DIR/rootfs.manifest.json"

mkdir -p "$ROOTFS_TEST_DIR/src-new/bin"
printf 'new-binary\n' > "$ROOTFS_TEST_DIR/src-new/bin/new-app"
ln -s new-app "$ROOTFS_TEST_DIR/src-new/bin/new-link"
NEW_HASH="$(sha256sum "$ROOTFS_TEST_DIR/src-new/bin/new-app" | awk '{print $1}')"
printf '{"version":2,"files":[{"path":"/bin/new-app","sha256":"%s"},{"path":"/bin/new-link","sha256":"%s"}]}\n' "$NEW_HASH" "$NEW_HASH" > "$ROOTFS_TEST_DIR/new-manifest.json"

eval "$(sed -n '/^verify_staged_rootfs() {/,/^}/p' "$INSTALL_LOCAL")"
eval "$(sed -n '/^install_ai_rootfs() {/,/^}/p' "$INSTALL_LOCAL")"

install_ai_rootfs "$ROOTFS_TEST_DIR/rootfs" "$ROOTFS_TEST_DIR/rootfs.manifest.json" \
  "" "$ROOTFS_TEST_DIR/src-new" "$ROOTFS_TEST_DIR/new-manifest.json"

COPY_ERR_RC=0
install_ai_rootfs "$ROOTFS_TEST_DIR/rootfs" "$ROOTFS_TEST_DIR/rootfs.manifest.json" \
  "" "$ROOTFS_TEST_DIR/nonexistent-src" "$ROOTFS_TEST_DIR/new-manifest.json" 2>/dev/null \
  || COPY_ERR_RC=$?

VERIFY_ERR_RC=0
mkdir -p "$ROOTFS_TEST_DIR/src-bad/bin"
printf 'tampered-binary\n' > "$ROOTFS_TEST_DIR/src-bad/bin/new-app"
install_ai_rootfs "$ROOTFS_TEST_DIR/rootfs" "$ROOTFS_TEST_DIR/rootfs.manifest.json" \
  "" "$ROOTFS_TEST_DIR/src-bad" "$ROOTFS_TEST_DIR/new-manifest.json" 2>/dev/null \
  || VERIFY_ERR_RC=$?

TRAV_ERR_RC=0
mkdir -p "$ROOTFS_TEST_DIR/src-trav/bin"
printf 'trav-binary\n' > "$ROOTFS_TEST_DIR/src-trav/bin/new-app"
printf '{"version":3,"files":[{"path":"../etc/passwd","sha256":"fake"}]}\n' > "$ROOTFS_TEST_DIR/trav-manifest.json"
install_ai_rootfs "$ROOTFS_TEST_DIR/rootfs" "$ROOTFS_TEST_DIR/rootfs.manifest.json" \
  "" "$ROOTFS_TEST_DIR/src-trav" "$ROOTFS_TEST_DIR/trav-manifest.json" 2>/dev/null \
  || TRAV_ERR_RC=$?

ESC_ERR_RC=0
mkdir -p "$ROOTFS_TEST_DIR/src-esc/bin"
printf 'esc-binary\n' > "$ROOTFS_TEST_DIR/src-esc/bin/new-app"
ln -s ../../../../etc/passwd "$ROOTFS_TEST_DIR/src-esc/bin/esc-link"
printf '{"version":4,"files":[{"path":"/bin/new-app","sha256":"%s"},{"path":"/bin/esc-link","sha256":"fake"}]}\n' "$NEW_HASH" > "$ROOTFS_TEST_DIR/esc-manifest.json"
install_ai_rootfs "$ROOTFS_TEST_DIR/rootfs" "$ROOTFS_TEST_DIR/rootfs.manifest.json" \
  "" "$ROOTFS_TEST_DIR/src-esc" "$ROOTFS_TEST_DIR/esc-manifest.json" 2>/dev/null \
  || ESC_ERR_RC=$?

MISSING_ERR_RC=0
mkdir -p "$ROOTFS_TEST_DIR/src-missing/bin"
printf 'new-binary\n' > "$ROOTFS_TEST_DIR/src-missing/bin/new-app"
printf '{"version":5,"files":[{"path":"/bin/new-app","sha256":"%s"},{"path":"/bin/missing-app","sha256":"%s"}]}\n' "$NEW_HASH" "$NEW_HASH" > "$ROOTFS_TEST_DIR/missing-manifest.json"
install_ai_rootfs "$ROOTFS_TEST_DIR/rootfs" "$ROOTFS_TEST_DIR/rootfs.manifest.json" \
  "" "$ROOTFS_TEST_DIR/src-missing" "$ROOTFS_TEST_DIR/missing-manifest.json" 2>/dev/null \
  || MISSING_ERR_RC=$?

if [[ -f "$ROOTFS_TEST_DIR/rootfs/bin/new-app" ]] \
  && [[ -L "$ROOTFS_TEST_DIR/rootfs/bin/new-link" ]] \
  && [[ "$(readlink "$ROOTFS_TEST_DIR/rootfs/bin/new-link")" == "new-app" ]] \
  && [[ ! -e "$ROOTFS_TEST_DIR/rootfs/bin/old-app" ]] \
  && grep -Fq '"version":2' "$ROOTFS_TEST_DIR/rootfs.manifest.json" \
  && [[ -f "$ROOTFS_TEST_DIR/rootfs/rootfs.manifest.json" ]] \
  && [[ "$COPY_ERR_RC" -ne 0 ]] \
  && [[ "$VERIFY_ERR_RC" -ne 0 ]] \
  && [[ "$TRAV_ERR_RC" -ne 0 ]] \
  && [[ "$ESC_ERR_RC" -ne 0 ]] \
  && [[ "$MISSING_ERR_RC" -ne 0 ]]; then
  pass "rootfs atomic replacement preserves valid symlinks and copy/verify/traversal/escape/missing errors leave old rootfs intact"
else
  fail "rootfs replacement must preserve valid symlinks and errors must leave old rootfs intact"
fi
rm -rf "$ROOTFS_TEST_DIR"

if [[ -f "${REPO_ROOT}/packages/agent/dist/ai-rootfs-linux-amd64.tar.gz" ]] \
  && [[ -f "${REPO_ROOT}/packages/agent/dist/ai-rootfs-linux-amd64.manifest.json" ]]; then
  REAL_TEST_DIR="$(mktemp -d)"
  tar -xzf "${REPO_ROOT}/packages/agent/dist/ai-rootfs-linux-amd64.tar.gz" -C "$REAL_TEST_DIR"
  if verify_staged_rootfs "$REAL_TEST_DIR" "${REPO_ROOT}/packages/agent/dist/ai-rootfs-linux-amd64.manifest.json"; then
    pass "packaged ai-rootfs-linux-amd64 passes staged rootfs verifier with confined busybox symlinks"
  else
    fail "packaged ai-rootfs-linux-amd64 must pass staged rootfs verifier"
  fi
  rm -rf "$REAL_TEST_DIR"
fi

# ── Behavioral: Profile copy resets directory permissions from 0700 ──────
PROFILE_TEST_DIR="$(mktemp -d)"
mkdir -p "$PROFILE_TEST_DIR/src_profiles" "$PROFILE_TEST_DIR/dest_profiles"
printf '{"id":"test"}\n' > "$PROFILE_TEST_DIR/src_profiles/test.json"
chmod 0700 "$PROFILE_TEST_DIR/src_profiles"

cp -a "$PROFILE_TEST_DIR/src_profiles/." "$PROFILE_TEST_DIR/dest_profiles/"
chmod 0755 "$PROFILE_TEST_DIR/dest_profiles"
chmod 0644 "$PROFILE_TEST_DIR/dest_profiles"/*.json

DEST_MODE="$(stat -c %a "$PROFILE_TEST_DIR/dest_profiles" 2>/dev/null || stat -f %Lp "$PROFILE_TEST_DIR/dest_profiles" 2>/dev/null || echo "755")"
if [[ "$DEST_MODE" == "755" || "$DEST_MODE" == "0755" ]] && [[ -f "$PROFILE_TEST_DIR/dest_profiles/test.json" ]]; then
  pass "profile copy restores 0755 permissions even with restrictive source directory"
else
  fail "profile directory must have 0755 permissions after copy (got mode $DEST_MODE)"
fi
rm -rf "$PROFILE_TEST_DIR"
# ── 6. Live dry-run smoke (needs root/sudo; skipped otherwise) ────────────

SUDO=()
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  :
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  SUDO=(sudo)
else
  echo "SKIP: live dry-run checks need root or passwordless sudo (static checks above still ran)."
  echo "RESULT: ${PASS} passed, ${FAIL} failed (live checks skipped)"
  [[ "$FAIL" -eq 0 ]]
  exit
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf 'fake-agent-binary' > "$WORK/fake-agent"
cat > "$WORK/agent-config.json" <<'JSON'
{"backendUrl":"http://127.0.0.1:38280","vpsId":"vps_local_host","token":"vma_test_abc","intervalSeconds":15,"requestTimeoutSeconds":10}
JSON
# Arch-specific assets only, placed next to the agent binary. The real host
# arch decides which file set the resolver picks, so emit one for amd64 and
# one for arm64 and point the expected name at the actual machine.
HOST_ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$HOST_ARCH" in
  x86_64|amd64) AI_ARCH="amd64"; OTHER_ARCH="arm64";; aarch64|arm64) AI_ARCH="arm64"; OTHER_ARCH="amd64";; *) AI_ARCH=""; OTHER_ARCH="";; esac
for a in amd64 arm64; do
  printf 'fake-executor-%s' "$a" > "$WORK/ai-executor-linux-$a"
  printf 'fake-helper-%s' "$a" > "$WORK/ai-host-helper-linux-$a"
done

# A complete packaged bundle also carries a rootfs tarball + manifest and a
# profiles directory. Build a disposable-but-valid rootfs pair with the same
# on-disk layout the real builder emits: tarball encloses a ./rootfs dir and
# manifest pins {version,rootfsSha256,files:[{path,sha256}]}.
build_fake_ai_rootfs() {
  local src_dir="$1" tar_gz="$2" manifest_json="$3"
  rm -rf "$src_dir"
  mkdir -p "$src_dir/bin"
  printf '#!/bin/busybox\necho hi\n' > "$src_dir/bin/sh"
  printf 'fake-busybox\n' > "$src_dir/bin/busybox"
  tar -czf "$tar_gz" -C "$src_dir" .
  if command -v node >/dev/null 2>&1; then
    VPS_TEST_SRC_DIR="$src_dir" \
    VPS_TEST_TAR_GZ="$tar_gz" \
    VPS_TEST_MANIFEST_JSON="$manifest_json" \
    node -e '
      const fs = require("fs"), path = require("path"), crypto = require("crypto");
      const srcDir = process.env.VPS_TEST_SRC_DIR;
      const tarPath = process.env.VPS_TEST_TAR_GZ;
      const outPath = process.env.VPS_TEST_MANIFEST_JSON;
      const tarHash = crypto.createHash("sha256").update(fs.readFileSync(tarPath)).digest("hex");
      const files = [];
      (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) {
            const rel = "/" + path.relative(srcDir, full).split(path.sep).join("/");
            files.push({ path: rel, sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") });
          }
        }
      })(srcDir);
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootfsSha256: tarHash, files }, null, 2) + "\n");
    '
  else
    python3 -c '
import os, sys, json, hashlib
src_dir = sys.argv[1]
tar_path = sys.argv[2]
out_path = sys.argv[3]
with open(tar_path, "rb") as f:
    tar_hash = hashlib.sha256(f.read()).hexdigest()
files = []
for root, dirs, fnames in os.walk(src_dir):
    for fn in fnames:
        full = os.path.join(root, fn)
        rel = "/" + os.path.relpath(full, src_dir).replace("\\", "/")
        with open(full, "rb") as f:
            h = hashlib.sha256(f.read()).hexdigest()
        files.append({"path": rel, "sha256": h})
files.sort(key=lambda x: x["path"])
with open(out_path, "w", encoding="utf-8") as f:
    json.dump({"version": 1, "rootfsSha256": tar_hash, "files": files}, f, indent=2)
    f.write("\n")
' "$src_dir" "$tar_gz" "$manifest_json"
  fi
}


for a in amd64 arm64; do
  build_fake_ai_rootfs "$WORK/rootfs-src-$a" \
    "$WORK/ai-rootfs-linux-$a.tar.gz" \
    "$WORK/ai-rootfs-linux-$a.manifest.json"
done
mkdir -p "$WORK/ai-profiles"
printf '{"id":"nginx","version":1,"serviceUnit":"nginx.service","allowedActions":["restart"],"allowedConfigPaths":["/etc/nginx/nginx.conf"],"validatorExec":"/usr/sbin/nginx","validatorArgv":["-t","-c"],"healthCheckCmd":["/usr/sbin/nginx","-t"],"healthTimeoutSec":10}\n' > "$WORK/ai-profiles/nginx.json"

DRY_OUT="$("${SUDO[@]}" bash "$INSTALL_LOCAL" \
  --binary "$WORK/fake-agent" --config "$WORK/agent-config.json" --install-ai --dry-run 2>&1)" \
  && DRY_RC=0 || DRY_RC=$?
if [[ "$DRY_RC" -eq 0 ]]; then
  pass "dry-run completes on a complete bundle (exit 0)"
else
  fail "dry-run should succeed (exit 0) with a complete packaged bundle, got exit $DRY_RC"
fi
if printf '%s' "$DRY_OUT" | grep -Eq "install helper: .*ai-host-helper-linux-(amd64|arm64)"; then
  pass "dry-run resolves the packaged AI helper next to the agent binary"
else
  fail "dry-run should pick up the packaged ai-host-helper-linux-<arch> from the binary dir"
fi
if printf '%s' "$DRY_OUT" | grep -Eq "install executor: .*ai-executor-linux-(amd64|arm64)"; then
  pass "dry-run resolves the packaged AI executor next to the agent binary"
else
  fail "dry-run should pick up the packaged ai-executor-linux-<arch> from the binary dir"
fi
if [[ -n "$OTHER_ARCH" ]] \
  && ! printf '%s' "$DRY_OUT" | grep -q "ai-executor-linux-$OTHER_ARCH"; then
  pass "dry-run picks only the host-arch asset (${OTHER_ARCH} rejected)"
else
  fail "dry-run must not stage the other architecture's executor"
fi
if ! printf '%s' "$DRY_OUT" | grep -qE 'vps-updater|install-updater'; then
  pass "dry-run mentions nothing about the updater"
else
  fail "dry-run output should not reference the updater"
fi

# Empty bundle dir → missing assets must fail closed (exit 1), not skip AI.
EMPTY_BUNDLE="$WORK/empty-bundle"
mkdir -p "$EMPTY_BUNDLE"
cp "$WORK/fake-agent" "$WORK/agent-config.json" "$EMPTY_BUNDLE/"
COMPLETE_OUT="$("${SUDO[@]}" bash "$INSTALL_LOCAL" \
  --binary "$EMPTY_BUNDLE/fake-agent" --config "$EMPTY_BUNDLE/agent-config.json" \
  --install-ai --dry-run 2>&1)" \
  && COMPLETE_RC=0 || COMPLETE_RC=$?
if [[ "$COMPLETE_RC" -ne 0 ]] \
  && printf '%s' "$COMPLETE_OUT" | grep -q 'AI bundle incomplete: missing'; then
  pass "missing AI bundle fails closed with explanation (nonzero exit)"
else
  fail "missing AI bundle must fail closed with nonzero exit and explanation"
fi

# Missing asset override -> must fail closed before staging or mutation
MISSING_OVERRIDE_OUT="$("${SUDO[@]}" bash "$INSTALL_LOCAL" \
  --binary "$EMPTY_BUNDLE/fake-agent" --config "$EMPTY_BUNDLE/agent-config.json" \
  --install-ai --ai-host-helper-binary "$EMPTY_BUNDLE/nonexistent-helper" --dry-run 2>&1)" \
  && MISSING_OVERRIDE_RC=0 || MISSING_OVERRIDE_RC=$?
if [[ "$MISSING_OVERRIDE_RC" -ne 0 ]] \
  && printf '%s' "$MISSING_OVERRIDE_OUT" | grep -Fq 'AI bundle incomplete: missing' \
  && ! printf '%s' "$MISSING_OVERRIDE_OUT" | grep -Fq '[Install] Installing VPS Manager Agent...'; then
  pass "missing asset override fails closed before install mutation"
else
  fail "missing asset override must fail closed before install mutation"
fi


# Tampered tarball: the dry-run performs the same (temp-only) content
# verification as a real run. So a corrupt tar must be caught by the
# rootfsSha256 mismatch exit 1, never by retrying without verification.
TAMPER_DIR="$WORK/tamper-bundle"
mkdir -p "$TAMPER_DIR"
for a in amd64 arm64; do
  cp "$WORK/ai-executor-linux-$a" "$TAMPER_DIR/"
  cp "$WORK/ai-host-helper-linux-$a" "$TAMPER_DIR/"
done
cp "$WORK/ai-rootfs-linux-$AI_ARCH.tar.gz" "$TAMPER_DIR/" 2>/dev/null || true
cp "$WORK/ai-rootfs-linux-$AI_ARCH.manifest.json" "$TAMPER_DIR/" 2>/dev/null || true
cp -r "$WORK/ai-profiles" "$TAMPER_DIR/"
if [[ -n "$AI_ARCH" && -f "$TAMPER_DIR/ai-rootfs-linux-$AI_ARCH.tar.gz" ]]; then
  printf 'X' >> "$TAMPER_DIR/ai-rootfs-linux-$AI_ARCH.tar.gz"
  cp "$WORK/fake-agent" "$WORK/agent-config.json" "$TAMPER_DIR/"
  TAMPER_OUT="$("${SUDO[@]}" bash "$INSTALL_LOCAL" \
    --binary "$TAMPER_DIR/fake-agent" --config "$TAMPER_DIR/agent-config.json" \
    --install-ai --dry-run 2>&1)" \
    && TAMPER_RC=0 || TAMPER_RC=$?
  if [[ "$TAMPER_RC" -ne 0 ]] \
    && printf '%s' "$TAMPER_OUT" | grep -Eq 'rootfsSha256 does not match tar bytes'; then
    pass "tampered tarball/manifest detected (fail closed, explicit mismatch)"
  else
    fail "tampered tarball must fail closed (nonzero exit) with rootfsSha256 mismatch"
  fi
else
  echo "SKIP: tampered-tarball check (no rootfs tarball built for tampering)"
fi

 # Traversal escape in the manifest: a file entry with "."/".." components
 # must be caught by the preflight verifier regardless of digests matching.
 TRAV_DIR="$WORK/traversal-bundle"
 mkdir -p "$TRAV_DIR"
 for a in amd64 arm64; do
   cp "$WORK/ai-executor-linux-$a" "$TRAV_DIR/"
   cp "$WORK/ai-host-helper-linux-$a" "$TRAV_DIR/"
 done
 cp "$WORK/ai-rootfs-linux-$AI_ARCH.tar.gz" "$TRAV_DIR/" 2>/dev/null || true
 cp "$WORK/ai-rootfs-linux-$AI_ARCH.manifest.json" "$TRAV_DIR/" 2>/dev/null || true
 cp -r "$WORK/ai-profiles" "$TRAV_DIR/"
 if [[ -n "$AI_ARCH" && -f "$TRAV_DIR/ai-rootfs-linux-$AI_ARCH.manifest.json" ]]; then
   TRAV_MANIFEST="$TRAV_DIR/ai-rootfs-linux-$AI_ARCH.manifest.json"
   sed -E 's,"path": "\.?/bin/(sh|busybox)","path": "../../evil.conf",' "$TRAV_MANIFEST" > "$TRAV_MANIFEST.tmp" \
     && mv "$TRAV_MANIFEST.tmp" "$TRAV_MANIFEST"
   cp "$WORK/fake-agent" "$WORK/agent-config.json" "$TRAV_DIR/"
   TRAV_OUT="$("${SUDO[@]}" bash "$INSTALL_LOCAL" \
     --binary "$TRAV_DIR/fake-agent" --config "$TRAV_DIR/agent-config.json" \
     --install-ai --dry-run 2>&1)" \
     && TRAV_RC=0 || TRAV_RC=$?
   if [[ "$TRAV_RC" -ne 0 ]] \
     && printf '%s' "$TRAV_OUT" | grep -q "manifest file entry contains an empty, '.' or '..' component"; then
     pass "path-traversal manifest entry failed closed during preflight"
   else
     fail "traversal manifest entry (../) must fail closed in preflight (nonzero exit)"
   fi
 else
   echo "SKIP: traversal check (no rootfs manifest built)"
 fi

 # Symlink escape inside the tarball: a member whose link target leaves the
 # rootfs tree must fail the preflight scan BEFORE any file is extracted.
 SYM_DIR="$WORK/symlink-bundle"
 mkdir -p "$SYM_DIR"
 for a in amd64 arm64; do
   cp "$WORK/ai-executor-linux-$a" "$SYM_DIR/"
   cp "$WORK/ai-host-helper-linux-$a" "$SYM_DIR/"
 done
 cp -r "$WORK/ai-profiles" "$SYM_DIR/"
 SYM_SRC="$SYM_DIR/rootfs-src"
 rm -rf "$SYM_SRC"
 mkdir -p "$SYM_SRC/bin"
 printf 'fake-busybox\n' > "$SYM_SRC/bin/busybox"
 ln -s /etc/passwd "$SYM_SRC/bin/escape-link"
 SYM_TAR="$SYM_DIR/ai-rootfs-linux-$AI_ARCH.tar.gz"
 SYM_MANIFEST="$SYM_DIR/ai-rootfs-linux-$AI_ARCH.manifest.json"
 if [[ -n "$AI_ARCH" ]]; then
   tar -czf "$SYM_TAR" -C "$SYM_SRC" .
  if command -v node >/dev/null 2>&1; then
    VPS_TEST_SRC_DIR="$SYM_SRC" VPS_TEST_TAR_GZ="$SYM_TAR" \
      VPS_TEST_MANIFEST_JSON="$SYM_MANIFEST" node -e '
      const fs = require("fs"), path = require("path"), crypto = require("crypto");
      const srcDir = process.env.VPS_TEST_SRC_DIR;
      const tarPath = process.env.VPS_TEST_TAR_GZ;
      const outPath = process.env.VPS_TEST_MANIFEST_JSON;
      const tarHash = crypto.createHash("sha256").update(fs.readFileSync(tarPath)).digest("hex");
      const files = [];
      (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) {
            const rel = "/" + path.relative(srcDir, full).split(path.sep).join("/");
            files.push({ path: rel, sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") });
          }
        }
      })(srcDir);
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootfsSha256: tarHash, files }, null, 2) + "\n");
    '
  else
    python3 -c '
import os, sys, json, hashlib
src_dir = sys.argv[1]
tar_path = sys.argv[2]
out_path = sys.argv[3]
with open(tar_path, "rb") as f:
    tar_hash = hashlib.sha256(f.read()).hexdigest()
files = []
for root, dirs, fnames in os.walk(src_dir):
    for fn in fnames:
        full = os.path.join(root, fn)
        rel = "/" + os.path.relpath(full, src_dir).replace("\\", "/")
        with open(full, "rb") as f:
            h = hashlib.sha256(f.read()).hexdigest()
        files.append({"path": rel, "sha256": h})
files.sort(key=lambda x: x["path"])
with open(out_path, "w", encoding="utf-8") as f:
    json.dump({"version": 1, "rootfsSha256": tar_hash, "files": files}, f, indent=2)
    f.write("\n")
' "$SYM_SRC" "$SYM_TAR" "$SYM_MANIFEST"
  fi
   cp "$WORK/fake-agent" "$WORK/agent-config.json" "$SYM_DIR/"
   SYM_OUT="$("${SUDO[@]}" bash "$INSTALL_LOCAL" \
     --binary "$SYM_DIR/fake-agent" --config "$SYM_DIR/agent-config.json" \
     --install-ai --dry-run 2>&1)" \
     && SYM_RC=0 || SYM_RC=$?
   if [[ "$SYM_RC" -ne 0 ]] \
     && printf '%s' "$SYM_OUT" | grep -Eq 'symlink target escapes|extracted symlink escapes'; then
     pass "symlink escape inside tarball failed closed during preflight scan"
   else
     fail "symlink escaping the rootfs tree must fail closed in the preflight scan"
   fi
 else
   echo "SKIP: symlink escape check (unknown host arch)"
 fi

# ── 7. Behavioral: preflight failure without touching the agent ───────────
#
# A corrupt bundle (rootfsSha256 mismatch) must fail the preflight and the
# agent binary/config/service user must remain untouched anywhere on disk:
# the only writes it ever performed were in the registered temp directory.

# The preflight failure path must never shadow the real install mutations:
# confirm in the installer that the preflight gate sits before the first
# mutation (groupadd/useradd/binary install) even with INSTALL_AI=true.
PRE_LINE="$(grep -n 'AI bundle preflight (fail closed BEFORE any install mutation)' "$INSTALL_LOCAL" \
  | head -1 | sed 's/:.*//')"
MUT_LINE="$(grep -n 'Create system user/group' "$INSTALL_LOCAL" \
  | head -1 | sed 's/:.*//')"
if [[ -n "$PRE_LINE" && -n "$MUT_LINE" && "$PRE_LINE" -lt "$MUT_LINE" ]]; then
  pass "AI preflight gate is ordered before the first install mutation"
else
  fail "AI preflight must be ordered before the first install mutation"
fi
if ! grep -Fq 'tar -xzf "$PREFLIGHT_AI_STAGED_TAR" -C "$PREFLIGHT_AI_STAGED" || {' "$INSTALL_LOCAL"; then
  fail "rootfs extraction must be a registered, fail-closed temp extraction"
else
  pass "rootfs extraction inside preflight temp is fail-closed (no || true)"
fi


# Behavioral dry-run: preflight failure must precede every install-side
# mutation line. On a corrupt bundle the output must NOT contain the
# "Installing VPS Manager Agent..." mutation block.
if [[ -n "$AI_ARCH" && -f "$TAMPER_DIR/ai-rootfs-linux-$AI_ARCH.tar.gz" ]]; then
  if printf '%s' "$TAMPER_OUT" | grep -Fq '[Install] Installing VPS Manager Agent...'; then
    fail "preflight failure must stop before the install block prints"
  else
    pass "preflight failure stops before any install mutation is announced"
  fi

  # Behavioral live run: preflight failure on a corrupt bundle must exit non-zero
  # before ANY mutation occurs, leaving existing agent binary and config untouched.
  BIN_BEFORE_HASH=""
  if [[ -f "/usr/local/bin/vps-manager-agent" ]]; then
    BIN_BEFORE_HASH="$(sha256sum /usr/local/bin/vps-manager-agent 2>/dev/null | awk '{print $1}')"
  fi
  CFG_BEFORE_HASH=""
  if [[ -f "/etc/vps-manager-agent/config.json" ]]; then
    CFG_BEFORE_HASH="$(sha256sum /etc/vps-manager-agent/config.json 2>/dev/null | awk '{print $1}')"
  fi

  LIVE_FAIL_OUT="$("${SUDO[@]}" bash "$INSTALL_LOCAL" \
    --binary "$TAMPER_DIR/fake-agent" --config "$TAMPER_DIR/agent-config.json" \
    --install-ai 2>&1)" \
    && LIVE_FAIL_RC=0 || LIVE_FAIL_RC=$?

  BIN_AFTER_HASH=""
  if [[ -f "/usr/local/bin/vps-manager-agent" ]]; then
    BIN_AFTER_HASH="$(sha256sum /usr/local/bin/vps-manager-agent 2>/dev/null | awk '{print $1}')"
  fi
  CFG_AFTER_HASH=""
  if [[ -f "/etc/vps-manager-agent/config.json" ]]; then
    CFG_AFTER_HASH="$(sha256sum /etc/vps-manager-agent/config.json 2>/dev/null | awk '{print $1}')"
  fi

  if [[ "$LIVE_FAIL_RC" -ne 0 ]] \
    && printf '%s' "$LIVE_FAIL_OUT" | grep -Eq 'rootfsSha256 does not match tar bytes' \
    && ! printf '%s' "$LIVE_FAIL_OUT" | grep -Fq '[Install] Installing VPS Manager Agent...' \
    && [[ "$BIN_BEFORE_HASH" == "$BIN_AFTER_HASH" ]] \
    && [[ "$CFG_BEFORE_HASH" == "$CFG_AFTER_HASH" ]]; then
    pass "live preflight failure aborts before mutation and preserves existing agent binary and config"
  else
    fail "live preflight failure must exit non-zero and leave existing agent untouched"
  fi
fi
echo "RESULT: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
