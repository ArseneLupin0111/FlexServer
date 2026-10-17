# FlexServer Dashboard Design System

The dashboard follows `VPS Management Dashboard/src`: a compact dark operational console with lime command accents and square panels.

## Tokens

`packages/web/src/index.css` defines three token layers: `--palette-*` primitive HSL channels, semantic surface/status aliases, and `--fleet-*` / `--telemetry-*` component aliases. Tailwind exposes `ink`, `panel`, `raised`, `line`, `dim`, `text`, `signal`, `warn`, `crit`, and `info`; shadcn semantic tokens map to this palette. Use tokens rather than component-local color literals.

- `ink`: page background and inputs; `panel`: cards and dialogs.
- `raised`: secondary and hover surfaces; `line`: borders and separators.
- `text`: primary text; `dim`: secondary text.
- `signal`: lime commands, healthy states, active tabs.
- `warn`, `crit`, `info`: amber warning, red failure, blue information.

## Branding

Supplied originals stay in `prompt-images/` (`logo.png`, `logo_with_name.png`) as untouched source art. The derived lossless assets live in `packages/web/src/assets/brand/`: `flexserver-mark.webp` (256x246 mark), `flexserver-wordmark.webp` (960x216 wordmark), and `favicon.png` (64x64, PNG only for icon compatibility). `packages/web/src/components/Brand.tsx` is the single identity source, exporting `BrandMark` (mark alone), `Brand` (mark plus the "FlexServer" / "by FlexTechnology" wordmark text), and `FooterBrand` (wordmark lockup link). The four public page headers and footers (`Landing`, `Pricing`, `Enterprise`, `Security`), the dashboard header, the fleet sidebar, and the login/loading screen all render these shared components instead of local logos or inline SVG. `packages/web/index.html` links `src/assets/brand/favicon.png` as the page icon, and `public/` keeps the hashed build copies.

- Mark: 2rem square with `object-fit: contain`, alt text "FlexServer logo", placed on dark charcoal header surfaces next to live `text-text` wordmark text — no invert, recolor, gradient, or SVG variant.
- Footer wordmark: the supplied dark-letter wordmark is only ever rendered on its white backing (`.brand-wordmark-surface`: `background: #fff`, 0.75rem/1rem padding, 0.25rem radius, 15rem wide and height-auto) above the `dim`-token "by FlexTechnology" line; never place the wordmark directly on charcoal or any other surface, and never lighten its lettering.
- No layout scope changes, no new logo files per page, and no re-creating the identity; update `Brand.tsx`/`brand.css` when the brand changes.

## Layout and typography

- Fleet sidebar: 272px desktop host navigation, active host indicator, health count, CPU/RAM snapshots, and create action. Below `lg`, hosts become a horizontally scrollable rail.
- Fleet page: operational summaries, search/status filters, card/table switch, two-column cards collapsing to one on narrow screens. Agent updates are configured and triggered from the host Settings tab rather than fleet list cards or tables. Search filters the page results, not the persistent host navigation.
- Workspace: server identity header with responsive host name, status pill, independent human-formatted agent status pill (`Agent online`, `Agent not installed`), host coordinates and resource readouts.
- Workspace navigation: seven horizontal section links with discoverable thin scrollbar on narrow viewports, consistent active indicator, and accessible focus rings.
- Workspace subpages: consistent subpage `h2` headings across all workspace tabs (`Overview for <host>`, `Metrics for <host>`, `Jobs for <host>`, etc.).
- Overview workload summaries: balanced 3-column operational summary grid (`Host`, `Containers`, `Jobs`) preventing single-card desktop whitespace gaps while maintaining decoupled Docker and job states.
- Overview telemetry panels: responsive header layout wrapping legends and live readouts cleanly on mobile, with styled empty states for unavailable history without fabricating data or assuming zero.
- System facts: clear section grouping (Hardware & Platform, Host & Runtime, Configuration & Notes), overflow-safe long ID/hostname wrapping, and panel-matched backgrounds preventing excess dark dividers on ragged final rows while preserving missing facts.
- Flat square surfaces, no decorative gradients or panel shadows.
- Body text is compact; `.tnum` provides monospace tabular numerals for telemetry and identifiers.
- Progress bars are thin. Status pills retain text labels, not color alone.
- Secondary text uses the shared `dim` token at 68% lightness. Capacity labels use explicit binary units (KiB/MiB/GiB/TiB), consistent across host and Docker byte counts.
- Overview audit rows prioritize time/actor and event/outcome; redundant server and opaque identifiers stay in the details drawer. Compact job panels size to content rather than stretching to match audit height.
- VPS Settings is one compact stack of real controls: the global Terminal & safety card (two toggle rows, each with its own pending/error state) sits directly above the host-specific Agent updates card, whose upgrade action is the primary control. The scope badge marks the global card as `All hosts`. Repeated host connection/type facts already present in the workspace header are not repeated; build, updater, heartbeat, job, and compatibility facts collapse into native disclosures on each card. Keep the root-session and non-security-boundary warnings visible; input limitations stay in the Terminal card disclosure.

## Data and interaction

Retain existing API-backed actions, dialogs, authentication, capability restrictions, and terminal lifecycle. Missing telemetry must be labeled unavailable; charts must not relabel CPU history as memory or network history. Docker monitoring remains a separate workspace tab.

Metrics contains host resource telemetry only. Docker workload summaries and container resource utilization belong in the Docker workspace, not Metrics.

Docker prioritizes a current-container list and an inline workspace: snapshot resources, confirmed controls, realtime logs, and expandable container history. The list stacks above the workspace on narrow screens. Selection uses the full agent-instance/container-key pair; stale snapshot rows never become actionable targets. Snapshot/monitoring configuration, host history, events, alerts, and storage stay in collapsed disclosures. Preserve dedicated container deep links and capability restrictions; keep explanatory copy out of the primary work area.

Container lifecycle text uses shared semantic colors: running → signal; created/exited/stopped/paused/restarting → warning; dead/unhealthy/failed → critical; unknown → dim. Preserve the written state as the non-color cue.

Keep keyboard focus visible and dialogs dismissible. Tables may scroll within their containers on narrow screens. Pulse indicators respect reduced motion; existing overlay transitions remain in the shared primitives.

Boolean configuration controls (web terminal, command guard, Docker monitoring and Docker management) use the shared sliding `Switch` with `role="switch"` and `aria-checked`. Lime/right means on; neutral/left means off, with a written state alongside. Keep provider-confirmed state during updates, disable pending interactions, preserve errors and monitoring consent dialogs. Start/stop/restart remain command buttons.

- Host health is independent of job outcomes and container counts. Recent failed jobs produce a notice linking to Jobs; non-running containers have a neutral count and Docker link, not an inferred failure. Stale Docker counts retain an explicit snapshot label.
- Failed jobs display the percentage reached, reported failure reason and finish time when available. Progress bars appear only while jobs are running; absent worker/duration metadata is omitted. Existing log links remain available.

### Public landing and access

The English landing at `/` reuses the dashboard's semantic tokens from `index.css` (charcoal `--ink`/`--panel`/`--raised`/`--line`, text `--text`/`--dim`, lime `--l-accent`/`--l-ok`, and `--l-warn`/`--l-crit`) scoped to `.landing-page` in `landing.css` via aliases (`--l-bg`, `--l-panel`, `--l-raised`, `--l-line`, `--l-line-soft`, `--l-text`, `--l-dim`, `--l-accent`, `--l-ok`, `--l-warn`, `--l-crit`), without redefining the dashboard palette or overriding telemetry hues (`--telemetry-cpu` lime, `--telemetry-memory` cyan). It follows the **Technical / Precision Editorial** direction: flat dark surfaces, zero drop shadows, zero aurora gradients, and zero blur glass on the home page (`.landing-home .landing-header { background: hsl(var(--l-bg)); backdrop-filter: none; }`). The header navigation is distilled to brand and primary navigation links only (collapsing to a mobile drawer with links and focus-restoring dismissal preserved), removing duplicated action buttons from the top bar. Primary conversion actions are concentrated in the hero message row (`Deploy Guide` primary + `View Source on GitHub` secondary), the deployment section preserves copy commands and guide link, and the closing section distills to a single `Deploy Guide` primary CTA.

The hero uses a single left-aligned editorial stack: title "Infrastructure, under control.", one concise product description, then Deploy Guide (primary) and View Source (secondary) directly underneath. On mobile the buttons stack at full width. A full-width illustrative fleet console follows, displaying static sample telemetry (distinct CPU, memory, disk meters, decoupled Docker container states, and SSH job execution strip), with explicit static-data labeling. Redundant trust facts are omitted. Native document scroll is preserved universally; no scroll trapping, no 3D perspective pitch, and no universal stage pinning.

The Capabilities showcase replaces the previous scroll-pinned story with an accessible, native-scroll two-column interactive showcase. An accessible roving-tabindex tablist (`role="tablist"`, `role="tab"`, Arrow Keys / Home / End keyboard navigation, `aria-selected`, `aria-controls`) is paired with synchronized static sample previews for Host Telemetry, Decoupled Containers, Remote SSH Dispatch, Retained History & Audit, Storage Durability, and Session Security. Previews transition via Motion with explicit exit animations (`AnimatePresence mode="wait"`, 240ms duration, `[0.22, 1, 0.36, 1]` cubic bezier); when `prefers-reduced-motion` is active, transitions and transforms are bypassed.

System Architecture summarizes the 4-node control pipeline (Operator Console -> Control Plane API -> Direct Transport -> Managed Fleet) and key isolation, configurable storage, and self-contained backend operation in short statements. Deployment retains the stack summary, Quick Start commands from `DEPLOY_COMMANDS`, and visible configuration prerequisites. Capabilities, Scope & Boundaries, and native FAQ disclosures use concise copy; implementation details remain in linked documentation. Preserve simulated-versus-real deployment boundaries, single-administrator scope, and no public dashboard bypass.

Public-page polish preserves each page's approved visual treatment and factual claims. Navigation uses “Features” consistently; mobile links retain at least 44px touch height. Landing preview and deployment grids use zero-minimum tracks, wrapping Docker/SSH metadata instead of clipping it. Horizontal host/capability rails retain visible, themed scroll affordances; other content must fit the viewport, including at 320px.

The landing header matches the other public pages: shared sticky translucent surface, GitHub then Deploy Guide on desktop, and Deploy Guide then GitHub Repository inside the mobile menu. This shared header is the exception to the home page's flat-surface treatment; hero Deploy Guide/View Source actions remain unchanged.

Pricing cards stack below 64rem to keep plan details readable; their comparison table retains keyboard-accessible horizontal scrolling. Enterprise feature previews keep equal width across alternating rows and stack on mobile. Public headings stand without decorative eyebrows; Security sidebar links keep 44px targets and highlight the selected anchor card.
The public `/pricing` page uses the landing palette and shell with Free/Plus/Pro cards, Plus highlighted as Recommended, a grouped comparison table, and native FAQ disclosures. Display the approved proposed monthly USD prices ($0/$3/$5) and limits consistently from one plan data source. State upfront that limits are not enforced and paid subscriptions cannot be purchased; contact actions only register interest by email, and Free links to deployment docs. Do not imply checkout, licensing, hosted VPS, or a support SLA exists. Keep this route outside dashboard authentication and include it in the API's direct-load SPA fallback.

The public `/enterprise` page follows the reference's lime-lit hero and alternating feature-layout structure using the same landing shell and palette. Show labeled static previews for fleet health, SSH/jobs, and security layers; replace unsupported customer statistics and compliance badges with truthful self-hosted value panels, security cards, and deployment options. Contact CTAs use an email with requirement prompts, not a submission form or checkout. Explicitly distinguish existing evaluation capabilities from an Enterprise subscription, organizational access controls, certifications, or SLA commitments. Keep navigation consistent across all public pages and support direct API SPA loading.

The public `/security` page follows the reference's shield hero, overview cards, review CTA, layered-control strip, and grouped two-column sidebar/card layout. Keep claims grounded in `docs/security.md` and implementation, with explicit self-hosted operator responsibilities and unsupported enterprise/compliance boundaries. Sidebar anchors focus their card targets with sticky-header clearance; narrow layouts stack the groups. Documentation links and email contact replace certification reports or fake submission forms. Include Security in all public navigation/footers and the API SPA fallback; expanded navigation collapses below 80rem.

Security refinements keep the shield hero and existing charcoal/lime surfaces. Below 48rem, overview cards pair the icon with a compact text column and the capability strip retains two columns. Below 64rem, topic anchors wrap into bordered 44px-minimum targets instead of a long vertical index. Detail copy uses 15px text with 1.75 line height; sidebar links retain explicit keyboard focus and card targets retain sticky-header clearance. The security-document CTA uses the book icon without a decorative eyebrow.

## Reusable components

- `components/layout/FleetSidebar.tsx`: fleet navigation from VPS records and metric snapshots; `FleetHostItem.tsx`: route-aware selectable host row.
- `components/dashboard/shared/ResourceGauge.tsx`: labelled percentage, capacity/detail, segmented meter, unavailable state, and warning/critical thresholds.
- `components/dashboard/shared/SystemFacts.tsx`: responsive labelled facts strip from `{ label, value }` pairs.
- `components/dashboard/metrics/MetricsPanel.tsx` exports `ChartPanel`: shared telemetry history panel used by metrics and overview, with series legends, current readouts, and missing-history states.

Overview histories must match the selected VPS: CPU and memory render two percent series from that host's own `history` window, and network I/O renders separate RX/TX bytes-per-second series on a shared axis. RX/TX rows carry an explicit `networkUnit: "bytes/s"` stamp with `networkAvailable: false` on first/reset samples (projected to gaps, never zero); absent unit means unknown and renders `n/a` — never a guessed unit. Null gaps break chart lines without interpolation or zero-fill, and empty windows render `History unavailable` vs `Not enough history yet`. No fabricated network lines, no percent network threshold, and no relabelled CPU history.

