# FlexServer Design System Master File (MASTER.md)

> **LOGIC & CANONICAL TRUTH:** This document is the single source of truth for FlexServer design tokens, visual identity, interaction specifications, and component behaviors. Every landing page element and shared token traces directly to this specification.

---

**Project:** FlexServer (`@vps-manager/web`)  
**Visual Direction:** Technical / Precision Editorial (Self-Hosted VPS Fleet Console)  
**Status:** Approved by User  
**Dials:** Variance 6/10 (Balanced / Modern Asymmetric Split) | Motion 3/10 (Subtle 160/240/480ms Restrained) | Density 4/10 (Standard: Spacious Reading + Compact Console)  

---

## 1. Validated Visual Thesis

> **Thesis Statement:** *Infrastructure, under control.*  
> A restrained, high-density editorial operational console for developers and sysadmins who demand clarity, system truth, and zero synthetic fluff.

- **Palette Continuity:** Preserves the global charcoal/lime identity (`#0b0d0c` ink, `#111412` panel, `#c6f432` lime accent). Lime is strictly reserved for primary actions, active states, and healthy operational telemetry.
- **Surfaces & Radii:** Flat, square panels (`0px` panel radius) with hairline 1px borders (`#232824`). Controls and badges use a crisp `4px` radius. Strictly **zero drop shadows**, zero decorative blur-glass overlays, zero neon glows, and zero perpetual looping aurora animations.
- **Typography:**
  - **Display & Body:** `Instrument Sans` (continuity with the operational dashboard console, high legibility at 14px–64px).
  - **Telemetry & Tabular:** `Geist Mono` (`.tnum`), tabular numerals for all metrics, IP addresses, durations, timestamps, and terminal commands.
- **Layout Architecture:** Asymmetric split hero (~55% editorial title/lead, ~45% illustrative fleet console). Native document scroll throughout; no pinned scroll traps or 3D perspective transforms.

---

## 2. Validated Interaction Thesis

> **Thesis Statement:** *Immediate feedback, deterministic state transitions, respect for user attention.*

- **Interactive Hover & Focus:** `160ms` transition (`color`, `background-color`, `border-color`).
- **Surface & Panel State Transitions:** `240ms` opacity and transform for mobile menu panels and capability preview switching with explicit exit animations (`AnimatePresence mode="wait"`).
- **Section Reveals:** `480ms` one-time viewport reveal (`opacity: 0 -> 1`, `translateY: 16px -> 0px`), cubic-bezier `(0.22, 1, 0.36, 1)`.
- **Stagger Timing:** `60ms` step between consecutive items, strictly capped at `180ms` (maximum 3 steps delay).
- **Accessibility & Reduced Motion:** When `prefers-reduced-motion: reduce` is active:
  - All transforms (`translateY`, scale) and stagger delays are eliminated.
  - Reveals render immediately (`opacity: 1`, `duration: 0s`).
  - Hover and active color transitions remain intact for state clarity.
- **Interactive States (5-State Rule):** Every interactive element (buttons, tabs, links, summary disclosures) explicitly supports:
  1. `default`
  2. `hover`
  3. `focus` (visible `2px` lime outline with `2px` offset)
  4. `active` (pressed state feedback)
  5. `disabled` (`opacity: 0.5`, `cursor: not-allowed`)

---

## 3. Design Tokens

### 3.1 Color Palette

All colors map directly to the established HSL channels in `packages/web/src/index.css`:

| Role | Primitive Channel | Hex Equiv | CSS Variable / Alias | Contrast Ratio (vs Background) | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Ink / Background** | `150 8.333% 4.706%` | `#0b0d0c` | `--ink`, `--background` | Base surface | Deep charcoal black background |
| **Panel Surface** | `140 8.108% 7.255%` | `#111412` | `--panel`, `--card` | N/A | Cards, consoles, disclosures |
| **Raised Surface** | `135 7.692% 10.196%` | `#181c19` | `--raised`, `--secondary` | N/A | Hover surfaces, code blocks, controls |
| **Line / Divider** | `132 6.667% 14.706%` | `#232824` | `--line`, `--border` | N/A | Hairline 1px borders, separators |
| **Text Primary** | `102.857 13.725% 90%` | `#e4e9e2` | `--text`, `--foreground` | **15.8:1** (Passes AAA) | Crisp off-white reading text |
| **Text Dim** | `132 4% 68%` | `#aab1ab` | `--dim`, `--muted-foreground` | **8.9:1** (Passes AAA) | Secondary labels, descriptions |
| **Signal / Primary** | `74.227 89.815% 57.647%` | `#c6f432` | `--signal`, `--primary`, `--telemetry-cpu` | **15.2:1** (Passes AAA) | Lime command buttons, healthy status, CPU |
| **Info / Memory** | `192.889 72.193% 63.333%` | `#5ec8e5` | `--info`, `--telemetry-memory` | **10.1:1** (Passes AAA) | Cyan memory gauges, technical notes |
| **Warn / RX** | `37.321 100% 59.02%` | `#ffb02e` | `--warn`, `--telemetry-rx` | **10.7:1** (Passes AAA) | Amber warnings, network RX throughput |
| **Crit / TX** | `4.382 100% 65.098%` | `#ff5a4d` | `--crit`, `--destructive`, `--telemetry-tx` | **6.3:1** (Passes AA / AAA Large) | Red failure status, network TX throughput |
### 3.2 Typography Scale

- **Display & Body Font:** `"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- **Telemetry & Monospace Font:** `"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`

| Token | Size | Line Height | Tracking | Weight | Typical Application |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `--type-64` | `64px` (`4rem`) | `1.1` | `-0.03em` | 600 SemiBold | Hero Display Title (fluid down to 36px) |
| `--type-36` | `36px` (`2.25rem`) | `1.2` | `-0.025em` | 600 SemiBold | Section Headings |
| `--type-24` | `24px` (`1.5rem`) | `1.3` | `-0.02em` | 600 SemiBold | Subsection Titles, Feature Titles |
| `--type-18` | `18px` (`1.125rem`) | `1.5` | `-0.01em` | 400 Regular / 500 Medium | Hero Lead, Section Subheads |
| `--type-16` | `16px` (`1rem`) | `1.6` | `normal` | 400 Regular / 500 Medium | Body Copy, Navigation Links, Terminal Text |
| `--type-14` | `14px` (`0.875rem`) | `1.5` | `+0.01em` | 400 Regular / 600 SemiBold | Eyebrow Badges, Metadata, Buttons, Code |

### 3.3 Spacing Scale

Base modular spacing scale: `8px`, `16px`, `24px`, `32px`, `48px`, `80px`.

| Token | Value | Typical Application |
| :--- | :--- | :--- |
| `--space-8` | `8px` (`0.5rem`) | Gap between badges, inline tags, small chip padding |
| `--space-16` | `16px` (`1rem`) | Input/button padding, grid gap for dense cards, chrome bar height |
| `--space-24` | `24px` (`1.5rem`) | Card interior padding, capability grid column gap |
| `--space-32` | `32px` (`2rem`) | Section header bottom margin, console card internal spacing |
| `--space-48` | `48px` (`3rem`) | Split hero column gap, desktop group separation |
| `--space-80` | `80px` (`5rem`) | Desktop vertical section padding (`clamp(48px, 8vw, 80px)`) |

### 3.4 Radii & Surfaces

| Token | Value | Description |
| :--- | :--- | :--- |
| `--radius-panel` | `0px` | Strict flat square panels for console cards, feature cards, preview boxes |
| `--radius-control` | `4px` | Controls, action buttons, status pills, tags, input elements |
| `--shadow-panel` | `none` | Strictly zero shadows across all light/dark contexts |

### 3.5 Motion & Easing

| Token | Value | Description |
| :--- | :--- | :--- |
| `--ease-editorial` | `cubic-bezier(0.22, 1, 0.36, 1)` | Signature deceleration curve for all transitions |
| `--dur-hover` | `160ms` | Color, background, and border hover/focus state |
| `--dur-menu` | `240ms` | Mobile menu panel reveal/exit & capability preview swap |
| `--dur-reveal` | `480ms` | Viewport entry one-time section reveal |
| `--stagger-step` | `60ms` | Stagger offset per successive child item |
| `--stagger-cap` | `180ms` | Maximum total stagger delay cap |
| `--reveal-y` | `16px` | Vertical offset for entering elements |

---

## 4. Component Patterns & Guidelines

### 4.1 Navigation Shell
- **Header:** Sticky slim bar (`height: 4.5rem`, `background: hsl(var(--palette-black))`, flat opaque surface for home, hairline bottom border).
- **Brand Lockup:** Shared `Brand` component (`flexserver-mark.webp` + live wordmark text).
- **Navigation Links:** Retains all public links: Capabilities (`#features`), Architecture (`#architecture`), Deployment (`#deploy`), Boundaries (`#boundaries`), FAQ (`#faq`), Security (`/security`), Pricing (`/pricing`), Enterprise (`/enterprise`).
- **Actions:** Secondary "GitHub" button and lime Primary "Deploy Guide" button.
- **Mobile Menu:** Native button toggling slide-fade panel with `AnimatePresence` and full keyboard accessibility.
### 4.2 Hero Section (Asymmetric Split)
- **Left Column (~55%):** Eyebrow badge ("Self-Hosted Fleet Console"), large single-line display title ("Infrastructure, under control."), clear lead paragraph describing the NestJS API and React console architecture, dual CTA buttons (Deploy Guide + GitHub), and a 4-item trust facts row.
- **Right Column (~45%):** Flat illustrative fleet console card with chrome bar, health pill, host facts, 3 distinct resource gauges (CPU lime, RAM cyan, Disk neutral), decoupled Docker container rows, and SSH dispatch execution strip.
- **Watermark:** Truthful indicator pill: `[Illustrative Sample UI · Static Data]`.

### 4.3 Feature Showcase (Engineered Capabilities)
- Native scroll document flow replacing previous scroll-trapping/scroll-pinning.
- Two-column showcase: accessible interactive capability list (single responsive roving-tabindex tablist) paired with synchronized realistic preview on the right.
- Full keyboard navigation (`role="tablist"`, `role="tab"`, Arrow Keys, Home, End, Enter, Space, `aria-selected`, `aria-controls`).
- Previews feature correctly labeled static sample data:
  1. **Host Telemetry:** CPU, RAM, Disk, Load, Network throughput readings pushed via Go agent / local collector.
  2. **Docker Workloads:** Decoupled container health (stopped container does not down the host).
  3. **SSH & Jobs:** Key provisioning, trusted fingerprint verification, command execution, tracked job progress.
  4. **History & Audit:** Distinct CPU (lime) & RAM (cyan) timeline chart, bounded operational metrics, trimmed audit logs.
  5. **Storage & Durability:** Strict `STORAGE_DRIVER` enum (`json` vs `postgres` with optional manual TimescaleDB migrations; SQLite explicitly unsupported).
  6. **Security & Guardrails:** Session auth, mode 0600 file isolation for raw OpenSSH keys, zero password persistence, loopback web terminal.

### 4.4 System Architecture Flow
- Direct 4-node pipeline with descriptive technical headings: Operator Console -> Control Plane API (NestJS) -> Direct Transport (SSH & Go agent) -> Managed Fleet.
- 3 technical guarantee cards: Key Isolation (mode 0600 OpenSSH files on private disk, zero stored passwords), Configurable Storage Drivers (json / postgres), Air-Gapped Viable.

### 4.5 Startup & Deployment
- Two-column layout: Deployment components (Node.js API service, React dashboard, PostgreSQL with optional TimescaleDB, persistent data/key volume isolation) and clear Demo Mode vs Local Mode distinction.
- Code Terminal Card: Quick Start shell command sequence from single-source `DEPLOY_COMMANDS` (`git clone`, `cd`, `cp .env.example .env`, `docker compose up --build -d`) with explicit configuration prerequisite callout and 1-click "Copy Commands" button providing accessible feedback and truthful error state handling.

### 4.6 Scope & Boundaries (Audience / Non-Goals)
- Side-by-side comparison:
  - **Built For (Intended Use Cases):** Developers & operations teams managing self-hosted Linux VPS instances, homelab/self-hosters, privacy-conscious teams (credentials and keys remain on infrastructure), low-resource environments.
  - **What We Are Not (Explicit Boundaries):** Not a hyperscale cloud orchestrator, not a Kubernetes control plane, hardware-governed uptime (no synthetic marketing SLAs), not a SaaS subscription.

### 4.7 Technical FAQ
- Native keyboard-operable `<details>` and `<summary>` elements with smooth hover, focus-visible outlines, and SVG chevron rotation.
- Answers real operational questions: credential storage, agent requirements, decoupled Docker crashes, air-gapped operation, and dashboard demo access.

### 4.8 Footer
- Shared `FooterBrand` on dark backing surface.
- Comprehensive column navigation linking to Product, Documentation, Security, Architecture, GitHub, and Support.
- Copyright and all-rights-reserved notice.
---

## 5. Non-Negotiable Boundaries (Anti-Patterns)

- ❌ **No aurora/neon glow animations:** No heavy floating gradient meshes or perpetual keyframe pulses.
- ❌ **No blur-glass overlays:** No `backdrop-filter: blur(40px)` panels; surfaces are solid flat dark charcoal.
- ❌ **No drop shadows:** Panels rely strictly on hairline borders (`#232824`) for elevation separation.
- ❌ **No scroll traps or pinned hijacking:** Native document scroll is strictly preserved across all devices.
- ❌ **No fabricated live data:** Illustrative previews must always carry an explicit sample indicator tag.
- ❌ **No dashboard bypass or public demo link:** The public landing provides no unauthorized dashboard shortcut (`/vps`).
