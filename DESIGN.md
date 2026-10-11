# FlexServer Dashboard Design System

The dashboard follows `VPS Management Dashboard/src`: a compact dark operational console with lime command accents and square panels.

## Tokens

`packages/web/src/index.css` defines three token layers: `--palette-*` primitive HSL channels, semantic surface/status aliases, and `--fleet-*` / `--telemetry-*` component aliases. Tailwind exposes `ink`, `panel`, `raised`, `line`, `dim`, `text`, `signal`, `warn`, `crit`, and `info`; shadcn semantic tokens map to this palette. Use tokens rather than component-local color literals.

- `ink`: page background and inputs; `panel`: cards and dialogs.
- `raised`: secondary and hover surfaces; `line`: borders and separators.
- `text`: primary text; `dim`: secondary text.
- `signal`: lime commands, healthy states, active tabs.
- `warn`, `crit`, `info`: amber warning, red failure, blue information.

## Layout and typography

- Fleet sidebar: 272px desktop host navigation, active host indicator, health count, CPU/RAM snapshots, and create action. Below `lg`, hosts become a horizontally scrollable rail.
- Fleet page: operational summaries, search/status filters, card/table switch, two-column cards collapsing to one on narrow screens. Search filters the page results, not the persistent host navigation.
- Workspace: server identity and seven horizontal section links; compact host/container/job summaries, failure notice, three resource gauges, two telemetry panels, recent audit and jobs, then static system facts.
- Flat square surfaces, no decorative gradients or panel shadows.
- Body text is compact; `.tnum` provides monospace tabular numerals for telemetry and identifiers.
- Progress bars are thin. Status pills retain text labels, not color alone.
- Secondary text uses the shared `dim` token at 68% lightness. Capacity labels use explicit binary units (KiB/MiB/GiB/TiB), consistent across host and Docker byte counts.
- Overview audit rows prioritize time/actor and event/outcome; redundant server and opaque identifiers stay in the details drawer. Compact job panels size to content rather than stretching to match audit height.

## Data and interaction

Retain existing API-backed actions, dialogs, authentication, capability restrictions, and terminal lifecycle. Missing telemetry must be labeled unavailable; charts must not relabel CPU history as memory or network history. Docker monitoring remains a separate workspace tab.

Keep keyboard focus visible and dialogs dismissible. Tables may scroll within their containers on narrow screens. Pulse indicators respect reduced motion; existing overlay transitions remain in the shared primitives.

- Host health is independent of job outcomes and container counts. Recent failed jobs produce a notice linking to Jobs; non-running containers have a neutral count and Docker link, not an inferred failure. Stale Docker counts retain an explicit snapshot label.
- Failed jobs display the percentage reached, reported failure reason and finish time when available. Progress bars appear only while jobs are running; absent worker/duration metadata is omitted. Existing log links remain available.

### Public landing and access

The English landing at `/` uses its own dark navy/blue marketing palette scoped to `.landing-page` in `landing.css` (`--l-bg`, `--l-panel`, `--l-raised`, `--l-line`, `--l-line-soft`, `--l-text`, `--l-dim`, `--l-blue`, `--l-ok`, `--l-warn`, `--l-violet`, plus re-hued `--telemetry-cpu`/`--telemetry-memory`), overriding the dashboard's charcoal/lime tokens without touching them. It uses 16–20px reading text, 72–112px desktop section spacing and 48–72px mobile spacing. Keep a centered hero with a large regular-weight single-line title ("Modern VPS Management"), a concise lead, docs-primary/GitHub-secondary actions, a compact capability row, then a wide centered static, labeled English preview (server rows, resource readings, one chart, one task area) with the self-hosted/no-hosted-account/no-public-demo caveat below it. On desktop viewports with motion allowed, the hero acts as a native scroll-driven pinned storytelling scene: the sticky stage remains pinned under the header while scrolling through the 200vh track, copy fades and drifts upward without lag, and the preview lifts into focus ~24px below the header with measured fit-scale centering to fit standard and shorter desktop heights (900/768/640) without clipping. Reversing scroll reverses the effect smoothly without time-based transition lag. Focus inside copy (`:focus-within`) restores full opacity and interaction, and pointer events are preserved during mid-fade. Mobile, viewports under 600px or unable to fit the console, and `prefers-reduced-motion: reduce` safely render the plain stacked flow with zero extra scroll distance. On mobile, hero copy and CTAs precede the contained preview; do not scale a desktop console down.

Use capability groups, an audience and non-goals block, a four-part architecture and data-flow overview, a short startup workflow, deployment options with explicit demo/local explanation, native keyboard-operable FAQ disclosures, then deployment actions. The landing offers no dashboard entry and no public demo: primary CTAs link to the deployment docs and secondary CTAs to the GitHub repository. Dashboard access states must retain session authentication and non-sensitive errors. Preserve visible focus, a focusable skip target, sticky-header anchor clearance and reduced-motion support.

The Features section uses one shared two-column sticky scene on fitting desktop viewports: a left-hand capability list expands the selected description with a blue indicator, while the right-hand illustrative app preview changes with the same scroll-selected step. All six capabilities share the stationary stage rather than pinning separate cards. Native scrolling advances and reverses selection without wheel interception. Feature controls also support keyboard navigation. Measure the tallest expanded content before enabling the scene; mobile, short viewports, reduced motion, and content too tall for the available viewport show every capability and its preview in normal flow without extra scroll distance. Preserve feature copy, inline links, focus visibility, and sticky-header anchor clearance.

The public `/pricing` page uses the landing palette and shell with Free/Plus/Pro cards, Plus highlighted as Recommended, a grouped comparison table, and native FAQ disclosures. Display the approved proposed monthly USD prices ($0/$3/$5) and limits consistently from one plan data source. State upfront that limits are not enforced and paid subscriptions cannot be purchased; contact actions only register interest by email, and Free links to deployment docs. Do not imply checkout, licensing, hosted VPS, or a support SLA exists. Keep this route outside dashboard authentication and include it in the API's direct-load SPA fallback.

The public `/enterprise` page follows the reference's blue-lit hero and alternating feature-layout structure using the same landing shell and palette. Show labeled static previews for fleet health, SSH/jobs, and security layers; replace unsupported customer statistics and compliance badges with truthful self-hosted value panels, security cards, and deployment options. Contact CTAs use an email with requirement prompts, not a submission form or checkout. Explicitly distinguish existing evaluation capabilities from an Enterprise subscription, organizational access controls, certifications, or SLA commitments. Keep navigation consistent across all public pages and support direct API SPA loading.

The public `/security` page follows the reference's shield hero, overview cards, review CTA, layered-control strip, and grouped two-column sidebar/card layout. Keep claims grounded in `docs/security.md` and implementation, with explicit self-hosted operator responsibilities and unsupported enterprise/compliance boundaries. Sidebar anchors focus their card targets with sticky-header clearance; narrow layouts stack the groups. Documentation links and email contact replace certification reports or fake submission forms. Include Security in all public navigation/footers and the API SPA fallback; expanded navigation collapses below 80rem.

## Reusable components

- `components/layout/FleetSidebar.tsx`: fleet navigation from VPS records and metric snapshots; `FleetHostItem.tsx`: route-aware selectable host row.
- `components/dashboard/shared/ResourceGauge.tsx`: labelled percentage, capacity/detail, segmented meter, unavailable state, and warning/critical thresholds.
- `components/dashboard/shared/SystemFacts.tsx`: responsive labelled facts strip from `{ label, value }` pairs.
- `components/dashboard/metrics/MetricsPanel.tsx` exports `ChartPanel`: shared telemetry history panel used by metrics and overview, with series legends, current readouts, and missing-history states.

Overview histories must match the selected VPS: CPU and memory render two percent series from that host's own `history` window, and network I/O renders separate RX/TX bytes-per-second series on a shared axis. RX/TX rows carry an explicit `networkUnit: "bytes/s"` stamp with `networkAvailable: false` on first/reset samples (projected to gaps, never zero); absent unit means unknown and renders `n/a` — never a guessed unit. Null gaps break chart lines without interpolation or zero-fill, and empty windows render `History unavailable` vs `Not enough history yet`. No fabricated network lines, no percent network threshold, and no relabelled CPU history.

