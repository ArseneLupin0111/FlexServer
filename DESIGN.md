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
- Fleet page: operational summaries, search/status filters, card/table switch, two-column cards collapsing to one on narrow screens. Search filters the page results, not the persistent host navigation.
- Workspace: server identity and seven horizontal section links; compact host/container/job summaries, failure notice, three resource gauges, two telemetry panels, recent audit and jobs, then static system facts.
- Flat square surfaces, no decorative gradients or panel shadows.
- Body text is compact; `.tnum` provides monospace tabular numerals for telemetry and identifiers.
- Progress bars are thin. Status pills retain text labels, not color alone.
- Secondary text uses the shared `dim` token at 68% lightness. Capacity labels use explicit binary units (KiB/MiB/GiB/TiB), consistent across host and Docker byte counts.
- Overview audit rows prioritize time/actor and event/outcome; redundant server and opaque identifiers stay in the details drawer. Compact job panels size to content rather than stretching to match audit height.
- VPS Settings uses a two-column layout at `xl`: Terminal & safety and host-specific Agent updates in the main column, Runtime posture and Dashboard access in the side column. Narrow layouts retain that reading order. Global terminal controls carry a scope badge; repeated terminal/guard runtime facts are omitted. Keep root-session and non-security-boundary warnings visible, with technical explanations and input limitations in native disclosures. Dashboard session details are collapsed by default.

## Data and interaction

Retain existing API-backed actions, dialogs, authentication, capability restrictions, and terminal lifecycle. Missing telemetry must be labeled unavailable; charts must not relabel CPU history as memory or network history. Docker monitoring remains a separate workspace tab.

Keep keyboard focus visible and dialogs dismissible. Tables may scroll within their containers on narrow screens. Pulse indicators respect reduced motion; existing overlay transitions remain in the shared primitives.

- Host health is independent of job outcomes and container counts. Recent failed jobs produce a notice linking to Jobs; non-running containers have a neutral count and Docker link, not an inferred failure. Stale Docker counts retain an explicit snapshot label.
- Failed jobs display the percentage reached, reported failure reason and finish time when available. Progress bars appear only while jobs are running; absent worker/duration metadata is omitted. Existing log links remain available.

### Public landing and access

The English landing at `/` reuses the dashboard's semantic tokens from `index.css` (charcoal `--ink`/`--panel`/`--raised`/`--line`, text `--text`/`--dim`, lime `--l-accent`/`--l-ok`, and `--l-warn`/`--l-crit`) scoped to `.landing-page` in `landing.css` via aliases (`--l-bg`, `--l-panel`, `--l-raised`, `--l-line`, `--l-line-soft`, `--l-text`, `--l-dim`, `--l-accent`, `--l-ok`, `--l-warn`, `--l-crit`), without redefining the dashboard palette or overriding telemetry hues (`--telemetry-cpu` lime, `--telemetry-memory` cyan). It follows the **Technical / Precision Editorial** direction: flat dark surfaces, zero drop shadows, zero aurora gradients, and zero blur glass on the home page (`.landing-home .landing-header { background: hsl(var(--l-bg)); backdrop-filter: none; }`).

The hero uses an asymmetric split layout: an editorial column on the left with title "Infrastructure, under control.", concise technical description, docs-primary and GitHub-secondary actions, and a 4-item trust facts row; paired with a realistic illustrative fleet console on the right displaying static sample telemetry (distinct CPU, memory, disk meters, decoupled Docker container states, and SSH job execution strip) labeled `[Illustrative Sample UI · Static Data]`. Native document scroll is preserved universally; no scroll trapping, no 3D perspective pitch, and no universal stage pinning.

The Capabilities showcase replaces the previous scroll-pinned story with an accessible, native-scroll two-column interactive showcase. An accessible roving-tabindex tablist (`role="tablist"`, `role="tab"`, Arrow Keys / Home / End keyboard navigation, `aria-selected`, `aria-controls`) is paired with synchronized static sample previews for Host Telemetry, Decoupled Containers, Remote SSH Dispatch, Retained History & Audit, Storage Durability, and Session Security. Previews transition via Motion with explicit exit animations (`AnimatePresence mode="wait"`, 240ms duration, `[0.22, 1, 0.36, 1]` cubic bezier); when `prefers-reduced-motion` is active, transitions and transforms are bypassed.

System Architecture details the direct 4-node control pipeline (Operator Console -> Control Plane API -> Direct Transport -> Managed Fleet) and 3 technical guarantees (mode 0600 OpenSSH key isolation with zero stored passwords, dual JSON/PostgreSQL storage drivers, air-gapped viability). Startup & Deployment presents core stack components (Node.js API, React dashboard, PostgreSQL with optional TimescaleDB, isolated volumes) and Quick Start commands from `DEPLOY_COMMANDS` with explicit configuration prerequisites. Scope & Boundaries and native FAQ disclosures provide grounded, truthful positioning with no synthetic marketing claims or dashboard bypass shortcuts.
The public `/pricing` page uses the landing palette and shell with Free/Plus/Pro cards, Plus highlighted as Recommended, a grouped comparison table, and native FAQ disclosures. Display the approved proposed monthly USD prices ($0/$3/$5) and limits consistently from one plan data source. State upfront that limits are not enforced and paid subscriptions cannot be purchased; contact actions only register interest by email, and Free links to deployment docs. Do not imply checkout, licensing, hosted VPS, or a support SLA exists. Keep this route outside dashboard authentication and include it in the API's direct-load SPA fallback.

The public `/enterprise` page follows the reference's lime-lit hero and alternating feature-layout structure using the same landing shell and palette. Show labeled static previews for fleet health, SSH/jobs, and security layers; replace unsupported customer statistics and compliance badges with truthful self-hosted value panels, security cards, and deployment options. Contact CTAs use an email with requirement prompts, not a submission form or checkout. Explicitly distinguish existing evaluation capabilities from an Enterprise subscription, organizational access controls, certifications, or SLA commitments. Keep navigation consistent across all public pages and support direct API SPA loading.

The public `/security` page follows the reference's shield hero, overview cards, review CTA, layered-control strip, and grouped two-column sidebar/card layout. Keep claims grounded in `docs/security.md` and implementation, with explicit self-hosted operator responsibilities and unsupported enterprise/compliance boundaries. Sidebar anchors focus their card targets with sticky-header clearance; narrow layouts stack the groups. Documentation links and email contact replace certification reports or fake submission forms. Include Security in all public navigation/footers and the API SPA fallback; expanded navigation collapses below 80rem.

## Reusable components

- `components/layout/FleetSidebar.tsx`: fleet navigation from VPS records and metric snapshots; `FleetHostItem.tsx`: route-aware selectable host row.
- `components/dashboard/shared/ResourceGauge.tsx`: labelled percentage, capacity/detail, segmented meter, unavailable state, and warning/critical thresholds.
- `components/dashboard/shared/SystemFacts.tsx`: responsive labelled facts strip from `{ label, value }` pairs.
- `components/dashboard/metrics/MetricsPanel.tsx` exports `ChartPanel`: shared telemetry history panel used by metrics and overview, with series legends, current readouts, and missing-history states.

Overview histories must match the selected VPS: CPU and memory render two percent series from that host's own `history` window, and network I/O renders separate RX/TX bytes-per-second series on a shared axis. RX/TX rows carry an explicit `networkUnit: "bytes/s"` stamp with `networkAvailable: false` on first/reset samples (projected to gaps, never zero); absent unit means unknown and renders `n/a` — never a guessed unit. Null gaps break chart lines without interpolation or zero-fill, and empty windows render `History unavailable` vs `Not enough history yet`. No fabricated network lines, no percent network threshold, and no relabelled CPU history.

