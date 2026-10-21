package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/vps-manager/agent/internal/applications"
	"github.com/vps-manager/agent/internal/ai"
	"github.com/vps-manager/agent/internal/commands"
	"github.com/vps-manager/agent/internal/config"
	"github.com/vps-manager/agent/internal/geo"
	"github.com/vps-manager/agent/internal/lock"
	"github.com/vps-manager/agent/internal/logs"
	"github.com/vps-manager/agent/internal/metrics"
	"github.com/vps-manager/agent/internal/push"
	"github.com/vps-manager/agent/internal/run"
	"github.com/vps-manager/agent/internal/state"
	"github.com/vps-manager/agent/internal/version"
	"path/filepath"
)

func main() {
	configPath := flag.String("config", "", "path to config file")
	stateFlag := flag.String("state", "", "path to persisted state file")
	once := flag.Bool("once", false, "collect and push metrics once then exit")
	hostOnly := flag.Bool("host-only", false, "with -once, push host metrics without Docker durable state")
	validateConfig := flag.Bool("validate-config", false, "validate config file and exit without network or state side effects")
	showVersion := flag.Bool("version", false, "print agent version and exit")
	provision := flag.Bool("provision-docker-state", false, "provision Docker identity and runtime keys, then exit")
	identityPath := flag.String("docker-identity-path", "", "Docker identity output path")
	runtimeKeysPath := flag.String("docker-runtime-keys-path", "", "Docker runtime keys output path")
	runtimeOwnerUID := flag.String("docker-runtime-owner-uid", "", "expected runtime keys owner UID (nonnegative integer)")
	provisionLock := flag.Bool("provision-lock", false, "provision singleton lock directory, file and tmpfiles, then exit")
	flag.Parse()

	if *provision {
		if *identityPath == "" || *runtimeKeysPath == "" || *runtimeOwnerUID == "" {
			fmt.Fprintln(os.Stderr, "provisioning requires explicit identity/runtime-key paths and a runtime owner UID")
			os.Exit(1)
		}
		uid, err := strconv.ParseUint(*runtimeOwnerUID, 10, 0)
		if err != nil {
			fmt.Fprintln(os.Stderr, "runtime owner UID must be a nonnegative integer")
			os.Exit(1)
		}
		runtimeUID := int(uid)
		if os.Geteuid() != 0 && runtimeUID != os.Geteuid() {
			fmt.Fprintln(os.Stderr, "unprivileged provisioning requires the runtime owner UID to match the executing user")
			os.Exit(1)
		}
		if err := state.Provision(*identityPath, *runtimeKeysPath, state.ProvisionOptions{RuntimeOwnerUID: &runtimeUID}); err != nil {
			log.Fatalf("docker state provisioning failed: %v", err)
		}
		return
	}
	if *provisionLock {
		if *configPath == "" {
			fmt.Fprintln(os.Stderr, "provision-lock requires -config <path>")
			os.Exit(1)
		}
		cfg, err := config.Load(*configPath)
		if err != nil {
			log.Fatalf("config error: %v", err)
		}
		if err := lock.Provision(cfg.VpsId); err != nil {
			log.Fatalf("lock provisioning failed: %v", err)
		}
		fmt.Printf("lock provisioned for VPS %s at %s\n", cfg.VpsId, lock.LockPath(cfg.VpsId))
		return
	}

	if *showVersion {
		fmt.Println(version.Identity())
		return
	}

	if *configPath == "" {
		fmt.Fprintf(os.Stderr, "Usage: vps-agent -config <path> [-once] [-validate-config]\n")
		os.Exit(1)
	}

	log.SetFlags(log.LstdFlags | log.Lshortfile)

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	if *validateConfig {
		if cfg.AI.Enabled {
			caps := ai.DetectCapabilities(cfg.AI.RootfsDirPath, cfg.AI.RootfsManifestPath, cfg.AI.ProfilesDirPath)
			log.Printf("ai configuration validated (supported=%v, reason=%q)", caps.Supported, caps.UnsupportedReason)
		}
		return
	}

	instanceLock, err := lock.Acquire(cfg.VpsId)
	if err != nil {
		log.Fatalf("instance lock error: %v", err)
	}
	defer func() {
		if err := instanceLock.Release(); err != nil {
			log.Printf("error releasing instance lock: %v", err)
		}
	}()

	log.Printf("starting agent: %s", cfg)
	if *hostOnly && !*once {
		log.Fatal("-host-only requires -once")
	}

	collector := metrics.NewCollector()
	statePath := cfg.StatePath
	if *stateFlag != "" {
		statePath = *stateFlag
	}
	if statePath == "" {
		if home, e := os.UserHomeDir(); e == nil {
			statePath = filepath.Join(home, ".vps-manager-agent", "state.json")
		} else {
			statePath = "/var/lib/vps-manager-agent/state.json"
		}
	}
	detector := geo.New(statePath)
	detector.Start()
	pushClient := push.NewClient(cfg)

	// Docker state reads only the provisioned runtime keys and its authenticated
	// mutable delivery record. The immutable identity file is never read here.
	base := filepath.Dir(statePath)
	runtimeKeysFile := filepath.Join(base, "runtime-keys.json")
	deliveryPath := filepath.Join(base, "delivery-state.json")
	var runner *run.Runner
	if *hostOnly {
		runner = run.New(cfg, collector, pushClient)
	} else if st, e := state.LoadStore(runtimeKeysFile, deliveryPath); e != nil {
		// Fail closed: without durable identity the runner strips any Docker
		// branch and pushes host metrics only.
		log.Printf("docker durable state unavailable; host metrics only (docker branch suppressed): %v", e)
		runner = run.New(cfg, collector, pushClient)
	} else {
		collector.SetDockerContainerKeyFunc(st.ContainerKey)
		collector.SetDockerFinalizeHook(run.FinalizeDocker(st))
		collector.SetDockerEventInputProvider(run.DockerEventInput(st))
		collector.SetDockerStorageEnabled(true)
		runner = run.NewWithState(cfg, collector, pushClient, st)
	}
	pushClient.SetLocationProvider(func() *metrics.Location {
		l := detector.Location()
		if l == nil {
			return nil
		}
		return &metrics.Location{City: l.City, Country: l.Country, DetectedAt: l.DetectedAt}
	})

	// Wire server response config callback so dashboard toggle updates the
	// collector's Docker metrics state on every successful push.
	pushClient.SetConfigHandler(func(cfg *push.ConfigResponse) {
		collector.SetDockerMetricsEnabled(cfg.DockerMetricsEnabled)
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Commands run independently from metrics so a slow/failing command can
	// never delay collection or create a second metrics owner.
	if !*hostOnly {
		if st, e := state.LoadStore(runtimeKeysFile, deliveryPath); e == nil {
			if e := applications.StartInventory(ctx, cfg, st, func(err error) { log.Printf("%v", err) }); e != nil {
				log.Printf("applications inventory unavailable: %v", e)
			}
			if worker, we := applications.NewWorker(cfg, st.InstanceID(), filepath.Join(base, "compose-receipt.json"), st.ContainerKey); we != nil {
				log.Printf("applications worker unavailable: %v", we)
			} else {
				go func() {
					ticker := time.NewTicker(time.Duration(cfg.IntervalSeconds) * time.Second)
					defer ticker.Stop()
					for {
						cycleCtx, cycleCancel := context.WithTimeout(ctx, 45*time.Minute)
						if err := worker.ProcessOne(cycleCtx); err != nil && ctx.Err() == nil { log.Printf("applications worker cycle failed: %v", err) }
						cycleCancel()
						select { case <-ctx.Done(): return; case <-ticker.C: }
					}
				}()
			}
			resolver, re := commands.NewDockerTargetResolver("", time.Duration(cfg.RequestTimeoutSeconds)*time.Second, st.ContainerKey)
			control, ce := commands.DefaultDockerControl("", time.Duration(cfg.RequestTimeoutSeconds)*time.Second)
			receipts, se := commands.NewFileReceiptStore(filepath.Join(base, "command-receipt.json"))
			client := commands.NewClient(cfg)
			if re != nil || ce != nil || se != nil {
				log.Printf("command worker unavailable: resolver=%v controller=%v receipt=%v", re, ce, se)
			} else if commandWorker, we := commands.NewWorker(st.InstanceID(), cfg.VpsId, client, control, receipts, resolver); we != nil {
				log.Printf("command worker unavailable: %v", we)
			} else {
				commandWorker.SetMutationFence(applicationCommandFence{})
				go func() {
					ticker := time.NewTicker(time.Duration(cfg.IntervalSeconds) * time.Second)
					defer ticker.Stop()
					for {
						cycleCtx, cycleCancel := context.WithTimeout(ctx, time.Duration(cfg.RequestTimeoutSeconds)*time.Second)
						if err := commandWorker.ProcessOne(cycleCtx); err != nil && ctx.Err() == nil { log.Printf("command cycle failed: %v", err) }
						cycleCancel()
						select { case <-ctx.Done(): return; case <-ticker.C: }
					}
				}()
			}
			// Docker realtime logs run in their own goroutine beside the
			// command worker: a slow log source can never delay commands or
			// metrics, and it shares their durable identity and shutdown
			// context. The source is on-demand only (a viewer subscription
			// exists); nothing is collected, stored, or replayed in the
			// background.
			logsSource, le := logs.NewDockerLogSource("", time.Duration(cfg.RequestTimeoutSeconds)*time.Second)
			if le != nil {
				log.Printf("logs worker unavailable: %v", le)
			} else {
				logsClient := logs.NewClient(cfg)
				logsSourcePort := logs.NewDockerSourcePort(logsSource)
				if logsWorker, lwe := logs.NewClaimWorker(st.InstanceID(), logsClient, logsSourcePort, func(containerKey string) (string, bool) {
					return resolver(containerKey)
				}, logs.ClaimWorkerOptions{Logger: log.Default()}); lwe != nil {
					log.Printf("logs worker unavailable: %v", lwe)
				} else {
					go func() {
						defer logsWorker.Stop()
						logsWorker.Run(ctx)
					}()
				}
			}
			if cfg.AI.Enabled {
				aiLogger := log.New(os.Stderr, "[ai] ", log.LstdFlags)
				if aiWorker, we := ai.NewWorker(cfg, st.InstanceID(), aiLogger); we != nil {
					log.Printf("ai worker unavailable: %v", we)
				} else {
					go func() {
						aiWorker.Run(ctx)
					}()
				}
			}
		} else if cfg.AI.Enabled {
			log.Printf("ai worker unavailable: durable identity required: %v", e)
		}
	}

	// Handle SIGINT/SIGTERM for graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		log.Printf("received signal %v, shutting down...", sig)
		cancel()
	}()

	if *once {
		log.Println("mode: once")
		if err := runner.RunOnce(ctx); err != nil {
			log.Fatalf("run failed: %v", err)
		}
		log.Println("completed successfully")
		return
	}

	log.Println("mode: loop")
	if err := runner.RunLoop(ctx); err != nil && err != context.Canceled {
		log.Fatalf("run loop failed: %v", err)
	}
	log.Println("agent stopped")
}

type applicationCommandFence struct{}

func (applicationCommandFence) Acquire(ctx context.Context, scope, ownerID string) error {
	if err := ctx.Err(); err != nil { return err }
	return applications.AcquireHostScope(scope, "container-command", ownerID, true, 0)
}

func (applicationCommandFence) MarkMutating(ctx context.Context, scope, ownerID string) error {
	if err := ctx.Err(); err != nil { return err }
	return applications.MarkHostScopeMutating(scope, "container-command", ownerID)
}

func (applicationCommandFence) Release(ctx context.Context, scope, ownerID string) error {
	if err := ctx.Err(); err != nil { return err }
	return applications.ReleaseHostScope(scope, "container-command", ownerID)
}
