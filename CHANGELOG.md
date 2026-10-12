# Changelog

## Unreleased — Termius-inspired natural-flow landing hero

- Replace the 200vh pinned hero storytelling scroll controller with a Termius-inspired natural-flow hero.
- Add an animated layered lime atmospheric aurora backdrop with radial gradients and subtle pulsing/drifting CSS keyframe animations, replacing heavy video backgrounds while staying true to the brand lime palette.
- Introduce a staggered one-time Motion entry reveal (`motion/react`) for hero eyebrow, title, subtitle, CTAs, and capability highlights.
- Implement a 3D perspective dashboard preview (1200px perspective on desktop, 800px on mobile) easing smoothly into a level alignment as it enters the viewport using Motion's `useScroll` and `useTransform`.
- Preserve all existing content, links, CTAs, caveat notices, keyboard focusability, and Features storytelling behavior.
- Support `prefers-reduced-motion: reduce`: static layout without initial entrance opacity hiding, static aurora glow without infinite CSS keyframe animations, and flat preview without scroll-linked 3D transforms.
- Remove superseded CSS attributes, scroll variables (`--scene-progress`), and the scroll affordance hint (`.landing-hero-scene-hint`).

## Unreleased — jsdom scrolling support

- Provide `Element.scrollTo` coordinate updates in the shared web test environment so mobile Features navigation can mount under jsdom. Production scrolling behavior is unchanged.

## Unreleased — Universal Features pinned storytelling on desktop and mobile

- Implement full stationary stage pinned storytelling universally across all viewport widths and heights on the landing page, inspired by reference stationary showcases.
- Desktop (>= 64rem) retains stationary two-column pinned stage (navigation list + synchronized realistic preview) with positive header clearance and measured proportional scaling (`transform: scale(--story-scale) origin top center`) when natural stage height exceeds available window height.
- Mobile (< 64rem) replaces the multi-article flow with a stationary single-column stage featuring an in-stage horizontal tab bar, real-time counter and progress bar, and single active feature description and preview, swapping all six steps in place via native document scroll.
- Apply measured proportional scaling universally on mobile and desktop without a minimum scale clamp, guaranteeing complete stage visibility without text clipping, overlap, wheel interception, or nested scroll traps.
- Unify native scroll progress calculations, target scroll offsets, and active tab scroll alignment across both viewport modes.
- Extend pinning to `prefers-reduced-motion` environments so stage geometry and step swaps remain identical while disabling transition animations and smooth scroll.
- Remove obsolete fallback rendering, dead static override CSS, and superseded mobile natural-flow scroll listeners.
## Unreleased — pinned dashboard preview grid

- Display sample hosts in the landing page's pinned dashboard preview as a two-column grid from 512px, preserving a single-column list on smaller screens and existing native scroll pinning. The live VPS dashboard is unchanged.

## Unreleased — Motion tooling

- Add `motion` to the web workspace for animation imports from `motion/react`.
- Install Motion AI Kit skills for OMP and OpenCode, and configure the hosted `motion` and `motion-plus` MCP servers in OpenCode. Motion+ requires account sign-in.

## Unreleased — read-only container logs independent of Docker management flag

- Make read-only container logs available by default for non-system VPS records in local mode without a new toggle. Read-only streams and the logs broker policy snapshot now depend on `logsSupported` (non-system VPS in local mode) instead of the management action capability or `dockerManagementEnabled`, and demo mode still reports unsupported with an explicit reason rather than faking a source.
- Keep `dockerManagementEnabled` defaulting to `false` and protecting confirmed `start`, `stop`, and `restart` actions; read-only log access does not authorize mutations. System VPS records remain excluded.
- Keep authentication, session/origin checks, authenticated agent credentials bound to the VPS, agent identity, and current inventory membership for the exact `agentInstanceId`/`containerKey` pair required for every stream, and keep log content out of jobs, audit, metrics, monitoring, and every JSON/PostgreSQL repository.
- Populate target discovery when management is enabled or logs are supported, and use `logsSupported` for both opening and ongoing stream policy checks. The logs broker policy snapshot contains only `logsSupported` and targets; Linux agent reads still require the real `/var/run/docker.sock` source and fail explicitly on unsupported transports.

## Unreleased — brand identity and logo integration

- Integrate supplied FlexServer brand identity assets while keeping original source art in `prompt-images/` (`logo.png`, `logo_with_name.png`) untouched. Add derived lossless assets in `packages/web/src/assets/brand/`: `flexserver-mark.webp` (256x246 mark), `flexserver-wordmark.webp` (960x216 wordmark), and `favicon.png` (64x64 PNG).
- Introduce shared identity components in `packages/web/src/components/Brand.tsx` with styling in `brand.css` (`BrandMark`, `Brand`, `FooterBrand`), replacing previous branding across all four public page headers and footers (`Landing`, `Pricing`, `Enterprise`, `Security`), the dashboard header (`DashboardShell`), the fleet sidebar (`FleetSidebar`), the login gate (`LoginGate`), and the document favicon in `index.html`.
- Enforce brand contrast rules: dark headers and sidebar surfaces pair the icon mark with live high-contrast text (`text-text`); the supplied dark-letter wordmark is rendered exclusively on a dedicated white backing plate (`.brand-wordmark-surface`) across dark public footers without recoloring or altering the original lettering. Retain existing layouts, responsive navigation, and focus styling without scope creep.

## Unreleased — public palette alignment

- Align the public pages' marketing palette with the dashboard by aliasing the existing dashboard semantic tokens: public shell aliases the charcoal surfaces/text tokens for all four public pages, with lime `--l-accent`/`--l-ok` for primary actions and emphasis, and dashboard-hued telemetry `--telemetry-cpu` (lime) and `--telemetry-memory` (cyan) kept without overrides.
- Update DESIGN.md palette wording accordingly: the landing reuses dashboard charcoal/lime tokens instead of its own navy/blue (`--l-blue`/`--l-violet`) tokens, Features uses a lime indicator, and the Enterprise hero is lime-lit.
- No changes to layout, behavior, accessibility, navigation, or dashboard UI/tokens; only the palette aliases on public pages are aligned.

## Unreleased — simplified public navigation

- Limit desktop and mobile top navigation on all public pages to Feature, Security, Pricing, and Enterprise, in that order. Preserve existing footer links, branding, and page action buttons.

## Unreleased — public security page

- Add `/security` with a shield hero, three overview cards, layered-control strip, and grouped security explanations with keyboard-focusable anchor targets. Describe implemented SSH trust, sessions, credential handling, API protections, optional terminal/Docker access, and operator responsibilities without unsupported certifications, encryption, uptime, or SLA claims.
- Add Security navigation/footer links across public pages and an API direct-load fallback. Collapse the expanded public navigation below 80rem to avoid crowding. Documentation and email CTAs work without authentication, forms, or fake report downloads.

## Unreleased — public enterprise page

- Add `/enterprise` with a blue-lit hero, value panels, alternating capability previews, security cards, deployment overview, FAQ, and email contact actions. All previews are labeled illustrative; copy describes existing self-hosted capabilities without invented customer metrics, certifications, SSO/RBAC, or SLA promises.
- Add Enterprise links to landing and pricing navigation/footers, and extend the API's public SPA fallback for direct loading. Contact emails include infrastructure requirement prompts; no Enterprise subscription, checkout, or backend form is introduced.

## Unreleased — public pricing page

- Add `/pricing` with Termius-inspired Free ($0), Plus ($3/month USD, Recommended), and Pro ($5/month USD) cards, a grouped comparison table, and native FAQ disclosures. Proposed limits are 2/5/15 servers, 24-hour/7-day/30-day metrics history, and 7-day/30-day/90-day audit history; all plans list one user and shared core security and server-management capabilities.
- Clearly disclose that these are proposed plans, their limits are not enforced, and paid subscriptions are not purchasable. Free links to deployment documentation; Plus/Pro and larger-plan actions open contact emails only. Hosting is not included; no billing, license enforcement, or checkout is introduced.
- Add Pricing to landing navigation/footer, keep the route public without dashboard authentication, and support direct loading through the API SPA fallback. Reuse the navy/blue landing palette with responsive cards and a horizontally scrollable comparison table on small screens.

## Unreleased — pinned feature scrolling

- Replace individually pinned cards with one Termius-style two-column scene: a left-hand list highlights and expands the current capability while a matching illustrative app preview appears on the right. Native scrolling selects all six features in order and reverses naturally; no wheel interception or new dependencies.
- Keep feature selection keyboard accessible and retain all descriptions and previews in normal flow on mobile, short viewports, reduced motion, or when the scene cannot fit. Preserve inline links, anchor clearance, and the existing hero effect.

## Unreleased — web CI test environment fixes

- Provide the missing `matchMedia` browser API in the shared jsdom setup so the public landing authentication-boundary test can mount its responsive scroll effect without changing production behavior.
- Wait for the deferred edit-server dialog's provider field before clearing it, removing the CI timing race while preserving the provider-clearing regression assertion.

## Unreleased — dark navy landing redesign

- Restyle the public landing in a Termius-style dark navy/blue palette scoped entirely to `.landing-page` in `pages/landing.css` via local tokens (`--l-bg`, `--l-panel`, `--l-raised`, `--l-line`, `--l-line-soft`, `--l-text`, `--l-dim`, `--l-blue`, `--l-ok`, `--l-warn`, `--l-violet`) with re-hued telemetry tokens, replacing the charcoal/lime marketing styles. Dashboard tokens, dashboard UI, and auth are unchanged; no new dependencies.
- Center the hero on a single-line regular-weight title ("Modern VPS Management"), a concise lead ("Server health, Docker and SSH jobs. One workspace, on your infrastructure."), docs-primary/GitHub-secondary actions, a compact centered capability row, then a wide rounded static preview card with a blue atmospheric glow; tighten hero spacing so the preview starts higher on desktop.
- Keep every landing invariant: all existing sections and anchor navigation, mobile menu/Escape/scroll lock, FAQ disclosures, contact email, external doc/repo links, and the no-hosted-account/no-public-demo caveat below the preview. No dashboard entry, signup, login, fetch, or `/vps` link.

## Unreleased — pinned hero storytelling on the landing

- Turn the landing hero into a native scroll-driven pinned storytelling scene on desktop: `.landing-hero-scene` becomes a 200vh scroll track with `.landing-hero-stage` as a `position: sticky` block pinned directly under the header, so the hero stays in view for the first scroll length while the rest of the document keeps scrolling normally. No wheel interception, no scrolljacking, no new dependencies; all content, CTAs, anchors, mobile menu/Escape/scroll lock, FAQ disclosures, and the auth/no-dashboard-entry contract are unchanged.
- Map scroll to a single CSS custom property (`--scene-progress`, 0..1) written from a `requestAnimationFrame`-throttled passive `scroll` listener plus one remeasure on `resize` and on `matchMedia` changes; never set React state during scroll. Hero copy and the capability row fade and drift upward directly from progress, and the console preview is absolutely positioned below the measured copy bottom with a 40px clear gap, then translates upward and scales into focus ~24px below the sticky header at `progress = 1`.
- Fit the full preview — console + caption + self-hosted caveat — inside the sticky stage at every supported desktop height (1000/900/768/640) using a measured fit scale (`--preview-start-scale`/`--preview-scale-delta`) and centering the final preview (`targetTop`), so nothing is ever clipped. Disable the scene (safe static stacked layout) when the viewport is under 600px tall or the console cannot fit at ≥60% scale.
- Keep the effect desktop-only and reversible: gate the pin on `matchMedia("(min-width: 64rem) and (min-height: 40rem)")` and `!matchMedia("(prefers-reduced-motion: reduce)")`, applying the `data-scene-active` attribute only when both hold and clearing all scene properties/attributes otherwise, so mobile, short viewports, and reduced-motion users get the original stacked flow with zero extra scroll distance and no 200vh track. Scroll-driven opacity/transform carry no time-based CSS transitions, so reversing scroll reverses the scene directly with no transition lag.
- Preserve hero copy accessibility during the transition: `:focus-within` on the hero copy restores full opacity, transform, and pointer events with a raised stacking context; pointer events stay enabled through mid-fade and are only disabled once progress ≥ 0.85 marks the copy as faded, so CTAs and links stay clickable without blocking the preview console.

## Unreleased — Docker realtime container logs

- Move realtime container logs from the Docker list page to a dedicated container detail page at `/vps/:vpsId/docker/containers/:agentInstanceId/:containerKey`: each container row in `DockerMetricsPanel` links to its own detail route (carrying the full `agentInstanceId` + `containerKey` pair, both URI-encoded), the detail page renders a "Back to containers" affordance, its own container metadata, and the confirmed `start`/`stop`/`restart` controls plus the bounded realtime log viewer, and the Docker list page (`/vps/:vpsId/docker`) no longer mounts the management panel so browsing the list opens zero log subscriptions.
- Keep the detail page bound to the container named by its URL: the target selector is replaced by fixed metadata, a container that is no longer in the server's current inventory is reported as unavailable with no log stream and no fallback to another container, and switching scope/container on the detail page clears the log buffer so a stream from a previous container can never deliver into another page.

- Replace the manual Docker log refresh with on-demand realtime viewing: opening the container log view subscribes automatically to its target's log stream, and the agent opens one Docker `GET /containers/{id}/logs` follow request that returns the last 200 lines and then continues live. There is no snapshot-then-follow pair, so the fixed 200-line tail is read exactly once and never replayed within a subscription.
- Stream logs over a dedicated SSE endpoint (`docker.logs.state`, `docker.logs.lines`, `docker.logs.closed`) backed by an ephemeral in-RAM broker (`DockerLogsService`, agent routes under `/api/agent/logs`). Log content stays out of `monitoring.snapshot`/`metrics.updated`, dashboards overview data, audit, jobs, metrics, and every JSON/PostgreSQL repository; there is no background collection, indexing, search, or download.
- Publish the monitoring exception explicitly: this is an approved on-demand exception to the Phase 1 no-log-ingestion rule, bounded at 4 KiB UTF-8 per line, 100 lines or 32 KiB per batch, 15-second keepalive, 30-second claim/ready, 10-second heartbeat grace, and a 2-hour subscription lifetime.
- Report failures with safe error codes only (`container_not_found`, `target_mismatch`, `daemon_unreachable`, `logs_unavailable`, `invalid_docker_stream`, `agent_unavailable`, `stream_lost`, `slow_consumer`, `session_expired`) and never surface daemon error bodies or log text.
- Bound the browser buffer to 2,000 displayed lines or 1 MiB, discard the oldest lines with a visible notice, throttle updates to at most one render per 100 ms, and render text-only with auto-scroll that yields to a scrolled-up reader plus a "jump to latest" control.
- Make reconnect an explicit new subscription: the browser `EventSource` never auto-reconnects, the displayed buffer is cleared, and Docker re-serves the latest 200 lines, so lines emitted during a network gap are not silently replayed.
- Require a matching rollout: demo mode reports `logsSupported: false` with an explicit reason, the agent log source is Linux-only over `/var/run/docker.sock` and fails explicitly elsewhere, an old agent shows `agent_unavailable` instead of fabricated lines, and an old API stops the agent logs worker without disturbing commands or metrics. Real Docker E2E verification is not claimed here.

## Unreleased — uniform fleet cards

- Remove the Docker section and monitoring toggle from fleet grid cards so Docker availability no longer changes card layout. Docker monitoring remains available in the individual VPS Docker page; fleet summaries are unchanged.

## Unreleased — Linux server icon

- Show a compact Linux penguin beside fleet card names when reported OS metadata identifies Linux; leave unknown and non-Linux systems unmarked.

## Unreleased — agent installer CLI smoke fix

- Move backend URL resolution into an undecorated shared module so the standalone agent installer can show `--help` from the repository root without loading NestJS services or requiring experimental decorator transforms. Preserve URL validation and API error behavior.

## Unreleased — compact VPS cards

- Keep fleet grid identity to server name, health and OS alongside live resource indicators and existing controls. Move connection, hardware, host ID, provider/location, tags, notes and runtime metadata to the individual VPS Overview's system details; table view and stored data are unchanged.

## Unreleased — agent backend URL cutover operations

- Document `flexserverctl set-backend <URL> [--mode auto|systemd|user] [--dry-run]` plus `flexserverctl validate-url <URL> [--updater]` and `flexserverctl help` in the README install section and `docs/local-agent-upgrade-operations.md` as the way to repoint an **existing** agent, with an explicit cross-reference that rerunning `install.sh --backend-url` (or the standalone installers) only sets the public setting and the default for newly written configs and deliberately leaves an already-installed config untouched rather than resetting its backend URL. No credential rotation is part of a URL change, so `--rotate` is never suggested for it. `--mode auto` is the default (systemd when root with a root-owned install, else user when `~/.vps-manager-agent` exists, otherwise a hint to pass `--mode`), while `--mode systemd|user` remain the only explicit forms; systemd rewrites `backendUrl` and `apiBase` only when the updater config exists, user rewrites `~/.vps-manager-agent/config.json` only; reading root-owned configs may need `sudo`; `--dry-run` is the only safe preview (no write, no stop, no start, no backup file; `dry-run: no changes applied`, exit 0) and `validate-url` has zero side effects.
- Document the migration URL policy: a migration target must be HTTPS and the updater `apiBase` stays `https`; validation is shape-only with no hostname allowlist or denylist, so DNS/TLS are settled by the health probe rather than a name check. Keep this distinct from the installers' URL allowance, which still accepts plain `http` for exact loopback (`localhost`, `127.0.0.1`, `[::1]`) for a fresh bootstrap install.
- Document the ordered transaction and verification: credential-free `GET <url>/api/health` (`User-Agent: flexserverctl/1.0`, system TLS verification, no redirect followed, bounded timeout/body and HTTP 200 + `{"ok": true}`) before any write; delivery preflight as `<agent> -config <cfg> -state <tempdir>/state.json -once -host-only`; same-URL apply still restarts the agent (and updater when installed) unit; updater in-flight guard requiring quiescent state (persisted settled helper record with phase `restarted` or `rolled_back` is permitted only when no daemon journal and no pending queue entries exist, while an active daemon run, pending entries, or corrupt/in-flight helper phase triggers refusal before mutation; updater daemon is stopped before the write and re-checked); on success the only on-disk artifact left behind is `.flexserverctl.bak`, which is deleted. Outcomes verbatim: `applied-with-heartbeat-confirmation-required`, `restored`, `rollback-failed`, `dry-run: no changes applied`; exit codes are `0` for success or a clean dry-run and `1` for any refusal, with pre-write refusals printing `Error: <reason>` to stderr and no `--yes`/`--force` override. A restart is liveness only — delivery is confirmed by a fresh parent-API heartbeat and updater proof is capped at `updater-process-observed`.
- Document rollback semantics: each touched config is restored from its `<config>.flexserverctl.bak` companion with the original bytes/owner/mode, the newly started loop is stopped, and the original loop is restarted with its preserved argv and cwd; backups are deleted only after a verified-successful restore and are retained deliberately on `rollback-failed` as operator recovery material. Endpoint or service recovery is not promised. Token preservation (never printed or rotated), config contents never logged, and rotation as a separate lossy bootstrap are documented alongside the installer CLI packaging surface (`/usr/local/bin/flexserverctl` by default, `--install-cli` default on, `--skip-cli`, `--cli-source`, `--cli-dest`, deliberately not removed by `--uninstall` since the CLI is shared tooling), the dashboard origin kept separate with deployment-dependent `TRUST_PROXY_HOPS`, and the canonical `AGENT_PUBLIC_BASE_URL`.
- Stable domain prerequisite documented: DNS must resolve, TLS must validate, and the reverse proxy must `proxy_pass` `/api/` (the cutover validation does not follow redirects). `api.flexserver.tech` DNS resolves and its HTTPS API origin is operational and verified, served through Nginx Proxy Manager with a managed certificate — it is an accepted backend URL once the health probe passes; `flexserver.tech` remains a working origin. Host cutover to `https://api.flexserver.tech` is verified (endpoint-only: `applied-with-heartbeat-confirmation-required` plus a fresh heartbeat); the canonical `AGENT_PUBLIC_BASE_URL` GitHub repo Variable persistently holds `https://api.flexserver.tech`. This does not verify the binary-upgrade production gate. Existing agents are not automatically migrated, so repoint each one explicitly with `flexserverctl set-backend`. No new docs files, no code or test changes.

## Unreleased — English landing with no dashboard entry

- Rewrite the landing page fully in English with expanded coverage: capability groups, audience and non-goals, a web/API/storage/agent architecture and data-flow overview, startup workflow, deployment options with demo/local limits, pre-adoption FAQ, and deployment CTAs.
- Remove every landing link to the dashboard: primary CTAs point to the deployment docs and secondary CTAs to the GitHub repository. Auth, API, and dashboard routes are unchanged.
- Set the landing `lang` to English with English metadata, keep the black/lime identity and the labeled static sample preview, and preserve mobile navigation, sticky-header anchor offsets, and reduced-motion support.

## Unreleased — FlexTechnology branding

- Update the company name to FlexTechnology and the contact address to `contact@flexserver.tech` across the landing page and SEO metadata.
- Add a direct GitHub repository link to the landing footer and point landing documentation/issue links to the current ArseneLupin0111 repository.

## Unreleased — landing clarity and Vietnamese access

- Rework the charcoal/lime landing hero, readable static preview, five benefit groups, startup workflow, mode explanation, FAQ and deployment CTA.
- Correct the public-demo promise: `/vps` retains local password protection; simulated demo requires a demo-mode deployment. Link deployment actions to the existing README instructions.
- Localize dashboard access, loading and errors into Vietnamese, add a home link, and keep credentials/session behavior unchanged.
- Improve mobile preview typography, keyboard focus, anchor offsets and responsive layouts without new dependencies. Keep authentication regressions behavioral instead of pinning incidental copy.

## Unreleased — SaaS landing page

- Add a Vietnamese FlexServer landing page at `/` for Sondoan Technology, with a sample console, feature overview, deployment workflow, accessible FAQ and `contact@sondoan.dev` contact links.
- Keep `/vps` behind the existing local-mode authentication; do not fetch dashboard data or start monitoring on the public homepage.
- Add responsive desktop/mobile navigation, keyboard focus states, reduced-motion support and an authentication-boundary regression test.

## Unreleased — proxy address security patch

- Override and lock `proxy-addr` to 2.0.8 for Express consumers, fixing CVE-2026-90711 / GHSA-jqcg-44mw-7w3h (client-IP spoofing through short IPv4-mapped IPv6 trust prefixes).
- Keep the fixable-CRITICAL image security gate unchanged; the dependency patch replaces the vulnerable 2.0.7 package reported in the API image.

## Unreleased — Overview operational clarity

- Separate host health, recent job outcomes and container counts; show recent failed-job notices with a Jobs link, while treating non-running containers neutrally with a Docker link.
- Make Overview audit events readable without truncated identifiers or redundant server columns; retain full metadata in the details drawer.
- Increase secondary-text contrast and use explicit binary capacity units across host and Docker views; remove the duplicate Overview byte formatter.
- Show failed-job completion percentage, failure reason and finish time instead of an active progress bar; omit missing worker/duration metadata and replace the developer-facing network hint.
- Compact status cards, let recent jobs size to content, move static system facts below activity, and display the CPU model only once.

## Unreleased — scripts directory layout

- Group operational scripts into `agent/`, `vps/`, `admin/`, and `install/`; retain `ci/`, `release/`, and `tests/`.
- Update npm commands, CI filters, installer download URLs, relative imports, shell checks, and operator instructions to the new paths. npm command names and production `dist/scripts/` paths are unchanged.
- Restore the tracked executable bit on `scripts/install/install-updater.sh` after relocation so Linux bootstrap smoke checks and documented direct invocation do not fail with `Permission denied`.

## Unreleased — Recharts telemetry charts

- Replace custom SVG history charts for CPU/RAM, network RX/TX, and Docker CPU/memory with responsive Recharts components; resource meters remain unchanged.
- Add unit-aware hover and keyboard tooltips, numeric timestamp axes, and readable percentage/throughput/memory labels using the existing dark telemetry palette.
- Preserve missing samples as gaps and real zero values; retain empty/loading/error states, Docker coverage metadata, and single-sample indicators.

## Unreleased — compact agent status

- Reduce fleet cards to agent/access status, a short version, and one update badge; omit repeated labels, heartbeat text, commit hashes, and completed upgrade confirmations from compact card/table summaries.
- Keep active upgrade progress and recovery warnings visible; retain full build identity, heartbeat details, and upgrade history in workspace settings and confirmation dialogs.
## Unreleased — overview operational clarity

- Keep the breadcrumb header in document flow so it does not obscure overview cards when scrolling or capturing a full page; retain the sticky fleet sidebar.
- Label workspace health as host status, separate from job outcomes, and show an overview failure summary linking to the failed-jobs filter.
- Show recent job timestamps, available failure messages and log links, with explicit failed-at progress and a neutral zero-running badge.
- Reduce overview audit rows to Time, Event, Result, and Details while retaining the full audit filters and details drawer.

## Unreleased — Docker ingest replay recovery

- Use receive-time-independent ingest digests so retained agent batches can retry after a lost acknowledgment.
- Authenticate previously committed digest-v1 batches using their original ledger receipt time, identity, sequence, and committed watermark; changed bound payloads remain conflicts. No database migration or agent checkpoint reset is required.

## Unreleased — host metric charts

- Project bounded per-VPS CPU, memory, RX, and TX history into metrics, dashboard, and live monitoring responses.
- Standardize Go and local Linux network collectors on explicit bytes-per-second rates; mark first samples and counter resets unavailable rather than plotting false zero/spikes.
- Persist network units and availability in JSON and PostgreSQL (migration `022_metric_network_fields.sql`).
- Connect overview and metrics charts to timestamped same-host history, with separate RX/TX series, gap handling, and unit-aware readouts.
- Handle bounded SSE snapshots containing `refreshRequired` by reloading dashboard data over HTTP instead of dereferencing an absent overview and crashing after login.

## Unreleased — reference dashboard design

- Restyle FlexServer using the supplied VPS Management Dashboard reference: ink/lime palette, compact header, square panels, fleet cards/table, and workspace tabs.
- Align overview, metrics, Docker monitoring, jobs, audit, terminal, settings, forms, and overlays with shared design tokens while retaining API-backed controls and access restrictions.
- Keep missing telemetry explicit instead of presenting unrelated metric history as memory or network data.

## Unreleased — CI/CD optimization

- Scope PR checks through a lightweight change-detection job; keep the full verification matrix on main and honor manual force-build inputs.
- Run database integrations alongside verification, generate SBOMs only for publishable main runs, and avoid redundant standalone Node/Go builds.
- Transfer checksummed, verified Docker images to publish without rebuilding; verify loaded image identities and deploy the pushed digest references.
- Fix fail-fast migration asset smoke checks and grant change detection the pull-request read permission it requires.

## Unreleased — local agent upgrade

- Add bundled binary local agent upgrade architecture: Linux amd64/arm64 agent and updater binaries are packaged directly in the deployed API image, served over HTTPS with scoped credentials, SHA-256 verification, and updater protocol v2, eliminating manual Ed25519 signing keys and external catalog requirements for local updates.
- Add a separately installed, pull-only host updater with scoped credentials, protocol v2 support, in-place migration (`--upgrade`), a constrained privileged helper, durable journal, lease/fencing, SHA-256 artifact verification, automatic rollback, and backup retention when recovery is unverified.
- Add persistent local-upgrade jobs for JSON and PostgreSQL, admin confirmation and audit, idempotent outcomes, and fresh-heartbeat verification before success or verified rollback.
- Show installed build, release availability, updater health, manual instructions, confirmation, durable progress, and recovery guidance in local VPS card, table, and workspace views. Remote SSH upgrades remain separate.
- Harden installer signature gates, updater credential rotation, post-swap failure handling, filesystem boundaries, and confirmation-dialog focus restoration.

Production rollout is **not yet verified**. Local smoke verification passed using simulated updater and heartbeat processes, not live production systemd hosts. Complete the disposable Linux staging and fault-injection gate in `docs/local-agent-upgrade-operations.md` before performing an authorized production canary. API/web deployment alone does not replace the host agent on disk.
