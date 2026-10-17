---
version: 1
slug: "packages-web-src-pages-landing-tsx"
primary_target: "packages/web/src/pages/Landing.tsx"
related_targets: []
---

# FlexServer Landing Page Surface Brief

<!-- impeccable:surface-brief-schema 1 -->

## Scope and mode

- Target: packages/web/src/pages/Landing.tsx
- Mode: persuade
- Seed: d2ab7c74

## Direction contract

### THESIS
Workspace as proof: lead with the operator's actual working surface rather than abstract marketing claims, generic hero cards, or split hero marketing templates. Refuses split-hero SaaS clichés, decorative gradients, glowing borders, and fake benchmarks.

### OWN-WORLD
Dark technical operational console with deep charcoal panels (`--ink`, `--panel`, `--raised`), hairline borders (`--line`), crisp lime action signals (`--signal`), cyan memory telemetry, and tabular numerals. Distinct flat surfaces with zero blur glass and zero drop shadows.

### STORY
The visitor immediately recognizes FlexServer as a self-hosted, operator-controlled VPS console. They inspect the realistic multi-host workspace proof, verify the core capabilities, understand the direct architecture and security guarantees, review deployment prerequisites, and proceed to self-deploy via Docker Compose.

### FIRST VIEWPORT
Top bar matches the shared public header: brand, navigation, GitHub and Deploy Guide desktop actions; the mobile menu includes Deploy Guide and GitHub Repository. The shared header retains the same translucent sticky surface as sibling public pages. A concise headline and one-sentence description form a left-aligned stack, with Deploy Guide (primary) and View Source (secondary) directly below; actions stack full-width on mobile. Omit redundant trust facts. An expansive, full-width fleet workspace preview follows, with an interactive host selector rail, resource telemetry gauges, decoupled Docker daemon state, and SSH job evidence—all clearly labeled as static sample data. Keep subsequent explanations brief and link to documentation for implementation details. The closing section retains a single Deploy Guide primary CTA.
### FORM
Technical precision operational console; high-order, structured, deterministic layout adhering to strict craft-floor rules. Refuses eyebrows/kickers and floating cards; uses balanced section rhythm and accessible semantic controls.

### SIGNATURE
A full-width operational fleet workspace preview where visitors can select between sample hosts to inspect live-styled telemetry gauges, decoupled Docker daemon state, and isolated SSH execution evidence without mistaking it for live infrastructure.

## Implementation notes

- Use plain capability labels: Host Metrics, Docker Containers, SSH Jobs, History & Audit, Data Storage, and Access & Security.
- Describe SSH keys as AES-256-GCM encrypted at rest and decrypted only in memory; do not imply raw private-key storage.
- Wrap sample host metadata on narrow screens. Buttons, feature tabs, menu controls, and footer links have at least 44px touch height.
- Public routes load independently of the lazy dashboard module. Authentication is checked only when entering dashboard routes.
- Preview grid tracks use zero minimum widths so content fits the viewport rather than being clipped. Docker and SSH rows wrap; only host and capability selection rails scroll horizontally, with thin themed scrollbars.
