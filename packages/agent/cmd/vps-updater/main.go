// Command vps-updater is the pull-only local-agent safe-upgrade executable.
//
// Subcommands (all unprivileged except helper, which systemd runs as root):
//
//	daemon  — claim → download → verify → stage → restart → heartbeat loop
//	helper  — root oneshot: drain pending actions, perform the fixed swap/
//	          restart/rollback/cleanup operations, write results. Accepts NO
//	          positional arguments: the daemon can only ask for actions the
//	          helper already knows, never pass commands, paths or units.
//	status  — print the durable journal, helper journal and pending actions
//	ack     — operator acknowledgement: clear the hold flag so new jobs may
//	          proceed after rollback_unverified or an unclear mutation
//	version — print the updater's own build identity and exit
//
// The updater binary is static Go (stdlib only) and never shells out to
// node. scripts/agent/build-agent.mjs builds it for Linux/amd64 alongside the
// metrics agent; the signed release manifest publishes both artifacts.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/vps-manager/agent/internal/updater"
	"github.com/vps-manager/agent/internal/version"
)

const defaultConfigPath = "/etc/vps-updater/config.json"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "vps-updater: "+err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: vps-updater [-config path] <daemon|helper|status|ack|version|verify>")
	}
	fs := flag.NewFlagSet("vps-updater", flag.ContinueOnError)
	configPath := fs.String("config", defaultConfigPath, "path to root-owned updater config")
	// -version mirrors the agent convention: print identity and exit.
	showVersion := fs.Bool("version", false, "print updater version and exit")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) == 0 {
		if *showVersion {
			fmt.Println(version.Identity())
			return nil
		}
		return fmt.Errorf("usage: vps-updater [-config path] <daemon|helper|status|ack|version|verify>")
	}
	sub := rest[0]
	if sub == "verify" {
		return runVerify(rest[1:])
	}
	// Accept flags after the subcommand too (`vps-updater status -config X`).
	subArgs := rest[1:]
	if len(subArgs) > 0 {
		if err := fs.Parse(subArgs); err != nil {
			return err
		}
		subArgs = fs.Args() // positionals left after flags — forbidden for every subcommand
	}
	if *showVersion {
		fmt.Println(version.Identity())
		return nil
	}

	switch sub {
	case "version":
		if len(subArgs) > 0 {
			return fmt.Errorf("version takes no arguments")
		}
		fmt.Println(version.Identity())
		return nil
	case "helper":
		// The helper accepts no positional arguments: systemd invokes it
		// with a fixed argv and it learns the action from the pending dir.
		if len(subArgs) > 0 {
			return fmt.Errorf("helper takes no arguments (got %q)", subArgs)
		}
		return runHelper(*configPath)
	case "daemon", "status", "ack":
		if len(subArgs) > 0 {
			return fmt.Errorf("%s takes no arguments (got %q)", sub, subArgs)
		}
		cfg, err := updater.LoadConfig(*configPath)
		if err != nil {
			return err
		}
		switch sub {
		case "daemon":
			return runDaemon(cfg)
		case "status":
			return runStatus(cfg)
		case "ack":
			return runAck(cfg)
		}
	}
	return fmt.Errorf("unknown subcommand %q (want daemon|helper|status|ack|version|verify)", sub)
}

func runVerify(args []string) error {
	vfs := flag.NewFlagSet("verify", flag.ContinueOnError)
	manifestPath := vfs.String("manifest", "", "path to release manifest file")
	pubKeyFile := vfs.String("pubkey-file", "", "path to Ed25519 public key PEM")
	pubKey := vfs.String("pubkey", "", "pinned Ed25519 public key (PEM or base64)")
	if err := vfs.Parse(args); err != nil {
		return err
	}
	if *manifestPath == "" {
		return fmt.Errorf("verify requires -manifest <path>")
	}
	var pubKeyBytes []byte
	if *pubKey != "" {
		pubKeyBytes = []byte(*pubKey)
	} else {
		var err error
		pubKeyBytes, err = updater.LoadPublicKeyPEM(*pubKeyFile)
		if err != nil {
			return fmt.Errorf("load public key: %w", err)
		}
	}
	manifestRaw, err := os.ReadFile(*manifestPath)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	payload, err := updater.VerifyFleetManifest(manifestRaw, pubKeyBytes)
	if err != nil {
		legacy, legacyErr := updater.VerifyManifest(manifestRaw, string(pubKeyBytes))
		if legacyErr != nil {
			return fmt.Errorf("manifest verification failed: %w (legacy check failed: %v)", err, legacyErr)
		}
		fmt.Printf(`{"verified":true,"type":"legacy","releaseId":%q,"version":%q,"buildId":%q}`+"\n", legacy.ReleaseID, legacy.Version, legacy.BuildID)
		return nil
	}
	fmt.Printf(`{"verified":true,"type":"fleet","releaseId":%q,"version":%q,"buildId":%q,"artifactsCount":%d}`+"\n", payload.ReleaseID, payload.Version, payload.BuildID, len(payload.Artifacts))
	return nil
}

// runDaemon blocks until SIGINT/SIGTERM. Exactly one daemon per state dir
// (filesystem lock); a second copy exits with the lock error.
func runDaemon(cfg *updater.Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	d := updater.NewDaemon(cfg, updater.NewClient(cfg))
	if err := d.Run(ctx); err != nil {
		return err
	}
	return nil
}

// runHelper is the root oneshot entrypoint: no argv, fixed operations only.
func runHelper(configPath string) error {
	cfg, err := updater.LoadConfig(configPath)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return updater.RunHelper(ctx, cfg)
}

// runStatus prints the durable job journal, the root helper journal and any
// pending actions, for operators and the offline runbook.
func runStatus(cfg *updater.Config) error {
	store := updater.NewJournalStore(cfg.StateDir)
	j, err := store.Load()
	if err != nil {
		return fmt.Errorf("journal: %w", err)
	}
	if j == nil {
		fmt.Println("job: none (no journal — idle, no upgrade in flight)")
	} else {
		fmt.Println("job:")
		fmt.Println(updater.MarshalJob(j))
		kind := j.Kind
		if kind == "" {
			kind = updater.JobKindUpdate
		}
		fmt.Printf("job kind: %s\n", kind)
	}
	hj, err := updater.LoadHelperJournal(cfg.StateDir)
	if err != nil {
		return fmt.Errorf("helper journal: %w", err)
	}
	if hj == nil {
		fmt.Println("helper: no privileged mutation recorded")
	} else {
		fmt.Printf("helper: job=%s phase=%s old=%s new=%s backup=%s\n",
			hj.JobID, hj.Phase, shortHash(hj.OldSha256), shortHash(hj.NewSha256), hj.BackupPath)
		if hj.Provision != nil {
			rec := hj.Provision
			fmt.Printf("helper ai-provision: unit=%s (backup=%s) config=%s (backup=%s) groupCreated=%v userCreated=%v uid=%d gid=%d\n",
				rec.UnitPath, orNone(rec.UnitBackupPath), rec.ConfigPath, orNone(rec.ConfigBackupPath),
				rec.GroupCreated, rec.UserCreated, rec.UID, rec.GID)
		}
	}
	pending, err := updater.PendingActions(cfg.StateDir)
	if err != nil {
		return fmt.Errorf("pending: %w", err)
	}
	if len(pending) == 0 {
		fmt.Println("pending: none")
	} else {
		fmt.Printf("pending: %s\n", pending)
	}
	// AI subsystem diagnostics: which fixed components exist, helper binary
	// version and unit activity. Read-only; bounded timeouts inside.
	ai := updater.DetectAIHealth(cfg)
	if !ai.Installed {
		fmt.Println("ai: not installed (no AI components found)")
	} else {
		version := ai.Version
		if version == "" {
			version = "unknown"
		}
		state := "healthy"
		if !ai.Healthy {
			state = "unhealthy: " + ai.Detail
		}
		fmt.Printf("ai: installed version=%s state=%s components=%s\n",
			version, state, strings.Join(ai.Components, ","))
	}
	return nil
}

func orNone(s string) string {
	if s == "" {
		return "(absent)"
	}
	return s
}

// runAck clears the hold flag after an operator has inspected a held job
// (rollback_unverified or unclear mutation). It refuses when there is no
// held job, so ack can never disturb an in-flight upgrade.
func runAck(cfg *updater.Config) error {
	store := updater.NewJournalStore(cfg.StateDir)
	j, err := store.Load()
	if err != nil {
		return fmt.Errorf("journal: %w", err)
	}
	if j == nil {
		return fmt.Errorf("no job journal — nothing to acknowledge")
	}
	if !j.Hold {
		return fmt.Errorf("job %s is not on hold (phase %s) — nothing to acknowledge", j.JobID, j.Phase)
	}
	// The journal is private to the updater service. Running ack as root
	// replaces it with a root-owned file and prevents the daemon from resuming.
	if os.Geteuid() == 0 {
		return fmt.Errorf("run ack as the vps-updater service user, not root")
	}
	j.Hold = false
	j.Reason = "operator acknowledged hold; cleared by vps-updater ack"
	if err := store.Save(j); err != nil {
		return fmt.Errorf("clear hold: %w", err)
	}
	fmt.Printf("job %s hold cleared — daemon may claim new jobs\n", j.JobID)
	return nil
}

func shortHash(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
