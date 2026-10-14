# FlexServer

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Independent operators: developers, self-hosters, and sysadmins managing their own VPS fleet. The current product uses a single dashboard administrator per deployment. Team accounts, organizational access, RBAC, and multi-tenancy are not established product commitments.

## Product Purpose

A self-hosted operational workspace for inspecting fleet health and resource history, investigating Docker state, and performing controlled SSH operations. The operator controls application storage and access.

Success means an operator can identify the relevant host, understand available evidence, perform an explicitly permitted operation, and review its outcome without confusing simulated data, stale snapshots, or unavailable measurements with live infrastructure state.

## Positioning

FlexServer brings host monitoring, SSH jobs, Docker visibility, and audit activity into one operator-controlled deployment. It manages infrastructure the operator supplies; it is not a VPS hosting service.

Commercial strategy remains undecided. The public Free / Plus / Pro prices and Enterprise messaging describe proposed offers, not purchasable subscriptions or current enterprise guarantees. Plan limits are not enforced. Do not imply checkout, licensing enforcement, organizational access controls, certifications, or a support SLA exists.

## Operating Context

- Operators inspect a fleet inventory, then enter a host-specific workspace for overview, metrics, Docker, jobs, audit activity, terminal access, or settings.
- Demo mode supports exploration with simulated infrastructure. It does not establish real SSH connections; demo records must not be presented as real servers or live telemetry.
- Real infrastructure requires a separately configured local-mode deployment, administrator authentication, permitted targets, and SSH host-key trust. Demo and real infrastructure should use separate storage.
- The application includes a React web dashboard, a NestJS API, and an optional Go host agent. Source, Docker Compose, and Linux amd64 installer workflows are documented in the repository.
- Public pages explain the product and its boundaries. The homepage is not a public demo or an authentication-bypass shortcut.

## Capabilities and Constraints

- Fleet inventory and host health summaries; resource readings and retained histories for CPU, memory, disk, load, network throughput, and uptime where supported.
- SSH key provisioning and verification, command jobs, execution output, and audit activity.
- Agent-backed Docker inventory and status, with read-only container logs requiring compatible real-agent data and Docker permissions. Monitoring, logs, and management have separate capability boundaries.
- Confirmed Docker start, stop, and restart operations; management is disabled by default.
- Optional web terminal, disabled by default. Demo terminal output is canned, not a real connection. Client-side command guards are accidental-action protection, not a security boundary.
- Missing telemetry must remain unavailable; stale snapshots must be identified. Host health, job outcomes, and container state are distinct facts, not interchangeable health signals.
- Real SSH and Docker access are blocked in demo mode. Local mode requires authentication and host trust; private-network targets are blocked by default.
- Provisioning passwords are one-time inputs, not persisted credentials. Private keys stay server-side; optional encryption and other deployment controls are documented in `docs/security.md`.
- Docker permissions are privileged and must not be implied by agent installation. The API must not be described as using direct host Docker-socket access.
- Single-administrator access is current functionality. SSO, SAML, MFA, team roles, and compliance certifications must not be represented as available.

Implementation and deployment details remain authoritative in `README.md`, `.env.example`, `docs/architecture.md`, and `docs/security.md`; verify those sources before changing capability claims.

## Brand Commitments

- Product name: **FlexServer**. Attribution: **by FlexTechnology**.
- Existing tagline: “Your VPS fleet. One operational workspace.”
- Preserve the supplied identity assets and shared branding implementation in `packages/web/src/components/Brand.tsx`.
- Supplied originals are in `prompt-images/`; derived application assets are in `packages/web/src/assets/brand/`.
- Existing visual and interaction rules remain in `DESIGN.md` and `MASTER.md`. This product record neither replaces them nor establishes a new visual direction.
- Keep public claims technically grounded. Illustrative UI and simulated data must be labeled rather than presented as customer evidence or live results.

## Evidence on Hand

- `README.md`: purpose, capabilities, demo/local distinction, operational boundaries, and deployment entry points.
- `docs/architecture.md` and `docs/security.md`: component boundaries and documented security model.
- `.env.example`: runtime flags and configuration constraints.
- `packages/web/src/App.tsx` and `packages/web/src/pages/`: implemented public and operational surfaces.
- Existing dashboard captures linked from `README.md`: illustrative workspace evidence, not a guarantee of current runtime data or a public demo.
- `DESIGN.md` and `MASTER.md`: incumbent design documentation; not independent proof of product capabilities.
- Proposed pricing is not evidence of an active billing system. Do not fabricate customers, testimonials, performance benchmarks, certifications, or enterprise commitments.

## Product Principles

1. Operator control: preserve self-hosted ownership of access, credentials, and storage.
2. Evidence before status: distinguish live, simulated, stale, missing, and unsupported data.
3. Controlled operations: make prerequisites and consequential actions explicit; keep monitoring separate from management permissions.
4. Host-centered investigation: keep health, history, jobs, Docker state, and audit evidence attributable to the selected host.
5. Truthful scope: describe shipped functionality separately from proposed commercial offers and undecided direction.
