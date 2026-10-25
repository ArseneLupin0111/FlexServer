package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Canonical AI provisioning constants. They mirror
// scripts/install/install-local-agent.sh --install-ai exactly and are compiled
// into the helper: neither the API, the manifest, nor the updater-writable
// apply-spec can ever change a single one of them. The helper may provision
// these fixed targets and nothing else. Only an in-process test harness may
// re-root them (SetTestAIProvisionRoot); no config file field can.
const (
	FixedAIUser           = "flexserver-ai"
	FixedAIGroup          = "flexserver-ai"
	FixedAIStateDir       = "/var/lib/flexserver-ai"
	FixedAIScratchDir     = "/var/lib/flexserver-ai/scratch"
	FixedAIBackupsDir     = "/var/lib/flexserver-ai/backups"
	FixedAIHelperUnitName = "flexserver-ai-helper.service"
	FixedAIHelperUnit     = "/etc/systemd/system/" + FixedAIHelperUnitName
	FixedAIHelperSocket   = "/run/flexserver-ai/helper.sock"
	// FixedAIRootfsManifest is where the sibling manifest.json shipped beside
	// the rootfs/ tree inside the signed ai-rootfs tarball is installed.
	FixedAIRootfsManifest = "/usr/local/share/flexserver-ai/rootfs.manifest.json"
)

// aiProvisionPaths is the resolved set of fixed provisioning targets. In
// production every field equals its FixedAI* constant; the offline harness
// re-roots them under a temp dir.
type aiProvisionPaths struct {
	StateDir       string
	ScratchDir     string
	BackupsDir     string
	ProfilesDir    string
	RootfsDir      string
	RootfsManifest string
	HelperUnit     string
	HelperSocket   string
}

func aiPaths(cfg *Config) aiProvisionPaths {
	p := aiProvisionPaths{
		StateDir:       FixedAIStateDir,
		ScratchDir:     FixedAIScratchDir,
		BackupsDir:     FixedAIBackupsDir,
		ProfilesDir:    FixedAIProfilesDir,
		RootfsDir:      FixedAIRootfsDir,
		RootfsManifest: FixedAIRootfsManifest,
		HelperUnit:     FixedAIHelperUnit,
		HelperSocket:   FixedAIHelperSocket,
	}
	if cfg != nil && cfg.testMode && cfg.testAIProvisionRoot != "" {
		root := filepath.Clean(cfg.testAIProvisionRoot)
		p.StateDir = filepath.Join(root, "var", "lib", "flexserver-ai")
		p.ScratchDir = filepath.Join(p.StateDir, "scratch")
		p.BackupsDir = filepath.Join(p.StateDir, "backups")
		p.ProfilesDir = filepath.Join(root, "etc", "flexserver-ai", "profiles")
		p.RootfsDir = filepath.Join(root, "usr", "local", "share", "flexserver-ai", "rootfs")
		p.RootfsManifest = filepath.Join(root, "usr", "local", "share", "flexserver-ai", "rootfs.manifest.json")
		p.HelperUnit = filepath.Join(root, "etc", "systemd", "system", FixedAIHelperUnitName)
		p.HelperSocket = filepath.Join(root, "run", "flexserver-ai", "helper.sock")
	}
	return p
}

// AIProvisionRecord is the durable record of everything the helper provisioned
// for an ai-install job beyond the component payloads. It lives inside the
// root-owned helper journal so a crash or a rollback can restore the exact
// pre-mutation state of the unit file and the agent config.
type AIProvisionRecord struct {
	UnitPath         string `json:"unitPath,omitempty"`
	UnitBackupPath   string `json:"unitBackupPath,omitempty"` // empty: unit did not exist before
	ConfigPath       string `json:"configPath,omitempty"`
	ConfigBackupPath string `json:"configBackupPath,omitempty"` // empty: config file did not exist before
	// ConfigUID/ConfigGID preserve the pre-mutation owner of the agent config
	// (root:<service-group>) so a root-side rollback cannot lock the service
	// user out of its own config.
	ConfigUID    int  `json:"configUid,omitempty"`
	ConfigGID    int  `json:"configGid,omitempty"`
	GroupCreated bool `json:"groupCreated,omitempty"`
	UserCreated  bool `json:"userCreated,omitempty"`
	UID          int  `json:"uid,omitempty"`
	GID          int  `json:"gid,omitempty"`
}

// Injectable seams so the fault-injection harness can fake user/group lookup
// and creation without a real Linux host. Production defaults shell out to
// fixed argv below; nothing API-controlled reaches them.
var (
	lookupAIGroup = defaultLookupAIGroup
	lookupAIUser  = defaultLookupAIUser
	createAIGroup = defaultCreateAIGroup
	createAIUser  = defaultCreateAIUser
)

func defaultLookupAIGroup(name string) (int, bool, error) {
	g, err := user.LookupGroup(name)
	if err != nil {
		return 0, false, err
	}
	gid, err := strconv.Atoi(g.Gid)
	if err != nil {
		return 0, false, fmt.Errorf("group %s has non-numeric gid %q", name, g.Gid)
	}
	return gid, true, nil
}

func defaultLookupAIUser(name string) (int, bool, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return 0, false, err
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return 0, false, fmt.Errorf("user %s has non-numeric uid %q", name, u.Uid)
	}
	return uid, true, nil
}

// defaultCreateAIGroup runs the exact installer argv: groupadd -r flexserver-ai.
func defaultCreateAIGroup(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "groupadd", "-r", FixedAIGroup)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("groupadd -r %s: %v: %s", FixedAIGroup, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// defaultCreateAIUser runs the exact installer argv: a system account with no
// shell, no home directory and no supplementary groups.
func defaultCreateAIUser(ctx context.Context, gid int) error {
	cmd := exec.CommandContext(ctx, "useradd", "-r",
		"-g", strconv.Itoa(gid),
		"-s", "/usr/sbin/nologin",
		"-d", "/var/empty",
		"-M", FixedAIUser)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("useradd -r %s: %v: %s", FixedAIUser, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// aiHelperUnitContent renders the fixed flexserver-ai-helper.service unit —
// the unit install-local-agent.sh writes, with only the resolved numeric
// uid/gid injected. Everything else is compiled-in.
func aiHelperUnitContent(p aiProvisionPaths, uid, gid int) string {
	return fmt.Sprintf(`[Unit]
Description=FlexServer AI Host Helper
After=network.target

[Service]
Type=simple
User=root
Group=%s
RuntimeDirectory=flexserver-ai
RuntimeDirectoryMode=0770
ExecStart=%s --socket %s --socket-mode 0660 --socket-uid 0 --socket-gid %%G --profiles-dir %s --execution-uid %d --execution-gid %d --executor-binary %s --rootfs-dir %s --backups-dir %s
Restart=on-failure
RestartSec=2
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SYS_CHROOT CAP_MKNOD CAP_SYS_ADMIN CAP_KILL CAP_DAC_OVERRIDE
NoNewPrivileges=no
PrivateTmp=yes
PrivateDevices=no
ProtectSystem=full
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=no
ReadWritePaths=/etc /var/lib/flexserver-ai /run/flexserver-ai
RestrictAddressFamilies=AF_UNIX AF_NETLINK
RestrictRealtime=yes
LockPersonality=yes
SystemCallFilter=@system-service
UMask=0077

[Install]
WantedBy=multi-user.target
`,
		FixedAIGroup,
		FixedAIHostHelperBinary,
		p.HelperSocket,
		p.ProfilesDir,
		uid, gid,
		FixedAIExecutorBinary,
		p.RootfsDir,
		p.BackupsDir,
	)
}

// aiConfigBlock is the `ai` object install-local-agent.sh merges into the agent
// config when installing the AI subsystem.
func aiConfigBlock(p aiProvisionPaths, uid, gid int) map[string]any {
	return map[string]any{
		"enabled":            true,
		"executionUid":       uid,
		"executionGid":       gid,
		"helperSocketPath":   p.HelperSocket,
		"executorPath":       FixedAIExecutorBinary,
		"scratchRootPath":    p.ScratchDir,
		"statePath":          filepath.Join(p.StateDir, "ai-state.json"),
		"rootfsDirPath":      p.RootfsDir,
		"rootfsManifestPath": p.RootfsManifest,
		"profilesDirPath":    p.ProfilesDir,
		"maxConcurrentTasks": 1,
	}
}

// provisionAIDirs creates the fixed AI directories with the installer's
// ownership and modes. It is purely additive and idempotent: existing
// directories are mode-corrected, never emptied. Every path must resolve
// through real directories only — a planted symlink in any parent would
// redirect root-owned provisioning outside the canonical tree.
func provisionAIDirs(p aiProvisionPaths, uid, gid int) error {
	specs := []struct {
		path string
		mode os.FileMode
		uid  int
		gid  int
	}{
		{p.StateDir, 0o750, uid, gid},
		{p.ScratchDir, 0o700, uid, gid},
		{p.BackupsDir, 0o700, uid, gid},
		{p.ProfilesDir, 0o755, 0, 0},
		{p.RootfsDir, 0o755, 0, 0},
	}
	for _, s := range specs {
		if err := RejectSymlinkPath(s.path); err != nil {
			return fmt.Errorf("ai dir %s: %w", s.path, err)
		}
		if fi, err := os.Lstat(s.path); err == nil {
			if !fi.IsDir() {
				return fmt.Errorf("ai dir %s exists and is not a directory", s.path)
			}
		} else if os.IsNotExist(err) {
			if err := os.MkdirAll(s.path, s.mode); err != nil {
				return fmt.Errorf("mkdir %s: %w", s.path, err)
			}
		} else {
			return fmt.Errorf("stat %s: %w", s.path, err)
		}
		if err := os.Chmod(s.path, s.mode); err != nil {
			return fmt.Errorf("chmod %s: %w", s.path, err)
		}
		if os.Geteuid() == 0 {
			if err := os.Chown(s.path, s.uid, s.gid); err != nil {
				return fmt.Errorf("chown %s: %w", s.path, err)
			}
		}
	}
	return nil
}

// provisionAIIdentity ensures the fixed system group and user exist, creating
// them with the installer's exact argv when missing. Created flags are recorded
// for diagnostics; rollback deliberately leaves the no-shell account in place
// (destroying accounts is riskier than the orphan it leaves).
func provisionAIIdentity(ctx context.Context, cfg *Config, rec *AIProvisionRecord) error {
	if runtime.GOOS != "linux" && !(cfg != nil && cfg.testMode) {
		return fmt.Errorf("ai provisioning is supported on linux only (host is %s)", runtime.GOOS)
	}
	gid, ok, err := lookupAIGroup(FixedAIGroup)
	if err != nil {
		if !isUnknownIDErr(err) {
			return fmt.Errorf("lookup group %s: %w", FixedAIGroup, err)
		}
		if err := createAIGroup(ctx); err != nil {
			return err
		}
		rec.GroupCreated = true
		gid, ok, err = lookupAIGroup(FixedAIGroup)
		if err != nil || !ok {
			return fmt.Errorf("group %s still missing after groupadd: %v", FixedAIGroup, err)
		}
	}
	uid, ok, err := lookupAIUser(FixedAIUser)
	if err != nil {
		if !isUnknownIDErr(err) {
			return fmt.Errorf("lookup user %s: %w", FixedAIUser, err)
		}
		if err := createAIUser(ctx, gid); err != nil {
			return err
		}
		rec.UserCreated = true
		uid, ok, err = lookupAIUser(FixedAIUser)
		if err != nil || !ok {
			return fmt.Errorf("user %s still missing after useradd: %v", FixedAIUser, err)
		}
	}
	rec.UID, rec.GID = uid, gid
	return nil
}

// isUnknownIDErr reports whether err is the os/user "unknown user/group"
// sentinel (possibly wrapped), i.e. the account simply does not exist.
func isUnknownIDErr(err error) bool {
	if err == nil {
		return false
	}
	var ue user.UnknownUserError
	if errors.As(err, &ue) {
		return true
	}
	var ge user.UnknownGroupError
	return errors.As(err, &ge)
}

// backupFileForRollback copies path into the job's root-owned backup dir.
// A missing source is not an error: the returned empty backup path means
// "did not exist before — remove on rollback".
func backupFileForRollback(path, bdir, name string) (string, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("stat %s: %w", path, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%s is a symlink; refusing to provision over it", path)
	}
	backupPath := filepath.Join(bdir, name)
	if _, err := copyHashed(path, backupPath, "", 0); err != nil {
		return "", fmt.Errorf("backup %s: %w", path, err)
	}
	_ = os.Chmod(backupPath, fi.Mode().Perm())
	return backupPath, nil
}

// writeAIUnitFile installs the fixed unit file atomically.
func writeAIUnitFile(cfg *Config, p aiProvisionPaths, uid, gid int) error {
	if runtime.GOOS != "linux" && !(cfg != nil && cfg.testMode) {
		return fmt.Errorf("ai unit provisioning is supported on linux only")
	}
	parent := filepath.Dir(p.HelperUnit)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", parent, err)
	}
	return atomicWriteFile(p.HelperUnit, []byte(aiHelperUnitContent(p, uid, gid)), 0o644)
}

// mergeAIConfigBlock merges the fixed `ai` block into the agent config JSON,
// preserving every other field, the file mode and (as root) the owner — the
// agent service user must keep read access to its own config. The file is
// parsed, mutated and written atomically; the pre-image was backed up for
// rollback.
func mergeAIConfigBlock(cfg *Config, p aiProvisionPaths, rec *AIProvisionRecord) error {
	path := cfg.AgentConfig
	if path == "" {
		return fmt.Errorf("agent config path is empty")
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("stat agent config %s: %w", path, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("agent config %s must not be a symlink", path)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read agent config %s: %w", path, err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("parse agent config %s: %w", path, err)
	}
	if doc == nil {
		doc = map[string]json.RawMessage{}
	}
	block, err := json.Marshal(aiConfigBlock(p, rec.UID, rec.GID))
	if err != nil {
		return err
	}
	doc["ai"] = block
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	if err := atomicWriteFile(path, out, fi.Mode().Perm()); err != nil {
		return err
	}
	if os.Geteuid() == 0 {
		if uid, gid, ok := fileUIDGID(fi); ok {
			if err := os.Chown(path, uid, gid); err != nil {
				return fmt.Errorf("restore owner of %s: %w", path, err)
			}
		}
	}
	return nil
}

// rollbackAIProvision restores the pre-mutation state recorded in hj.Provision:
//   - unit file: restore the backup, or remove it when it did not exist before
//   - agent config: restore the backup when one was taken
//
// The AI service is restarted afterwards by the caller when needed.
// Provisioned user/group/directories are intentionally retained (a destructive
// userdel risks more than the harmless no-shell orphan it leaves).
func rollbackAIProvision(cfg *Config, hj *HelperJournal) error {
	rec := hj.Provision
	if rec == nil {
		return nil
	}
	if rec.UnitPath != "" {
		if rec.UnitBackupPath != "" {
			if err := copyFileAtomic(rec.UnitBackupPath, rec.UnitPath, 0); err != nil {
				return fmt.Errorf("restore unit: %w", err)
			}
		} else {
			if err := os.Remove(rec.UnitPath); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("remove provisioned unit: %w", err)
			}
		}
	}
	if rec.ConfigPath != "" && rec.ConfigBackupPath != "" {
		if err := copyFileAtomic(rec.ConfigBackupPath, rec.ConfigPath, 0); err != nil {
			return fmt.Errorf("restore agent config: %w", err)
		}
		if os.Geteuid() == 0 && (rec.ConfigUID != 0 || rec.ConfigGID != 0) {
			if err := os.Chown(rec.ConfigPath, rec.ConfigUID, rec.ConfigGID); err != nil {
				return fmt.Errorf("restore owner of %s: %w", rec.ConfigPath, err)
			}
		}
	}
	return nil
}

// copyFileAtomic copies src to dst via a temp file + rename in dst's directory.
// mode 0 preserves the source file's permission bits (used for rollbacks whose
// backup was taken with the original mode).
func copyFileAtomic(src, dst string, mode os.FileMode) error {
	if mode == 0 {
		fi, err := os.Lstat(src)
		if err != nil {
			return err
		}
		mode = fi.Mode().Perm()
		if mode == 0 {
			mode = 0o644
		}
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	dir := filepath.Dir(dst)
	tmp, err := os.CreateTemp(dir, ".restore-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.ReadFrom(in); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return err
	}
	return fsyncDir(dir)
}
