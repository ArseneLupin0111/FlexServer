<p align="center">
  <img src="logo.png" alt="FlexServer logo" width="112">
</p>
<h1 align="center">FlexServer</h1>
<p align="center"><strong>by FlexTechnology</strong></p>
<p align="center">Your VPS fleet. One operational workspace.</p>
<p align="center">
  Self-hosted server monitoring and management with a NestJS API,<br>
  a React dashboard, and an optional Go host agent.
</p>
<p align="center">
  <a href="#capabilities">Capabilities</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#deployment-and-documentation">Documentation</a> ·
  <a href="#operational-boundaries">Security</a>
</p>

---

## A clearer view of your infrastructure

FlexServer brings server health, resource history, SSH workflows, jobs, and audit activity into one self-hosted dashboard. Start with simulated infrastructure to explore the interface, then configure a separate local-mode deployment for real hosts.

**You run the application and control its storage and access.** Demo data is not live telemetry, and switching modes does not turn simulated records into real servers.

## Capabilities

| Workspace | What it provides |
| --- | --- |
| **Fleet overview** | VPS inventory and health summaries, with a focused workspace for each host. |
| **Host metrics** | CPU, memory, disk, load, network throughput, and uptime; retained per-host CPU/RAM histories and availability-aware network charts. |
| **SSH operations** | Key provisioning and verification, command jobs, and audit activity. Real connections require local mode, allowed targets, and trusted host keys. |
| **Docker visibility** | Agent-backed container monitoring. Read-only container logs are available by default for non-system VPS records in local mode, with a compatible real agent and Docker access. |
| **Controlled Docker actions** | Confirmed start, stop, and restart operations. Management is disabled by default and remains separate from monitoring and read-only logs. |
| **Deployment choices** | Run from source, use Docker Compose with PostgreSQL, or deploy with the Linux amd64 installer. An optional Go agent collects host metrics. |

The web terminal is optional and disabled by default. Demo mode shows canned output only; it never opens a real SSH connection.

## Screenshots

Existing dashboard captures show the visual workspace; they are not a public demo or a guarantee of current live data. Select an image to inspect the full-size capture.

### Fleet inventory

Browse hosts and their status before opening a server workspace.

[![FlexServer VPS inventory with server cards and health summaries](vps.sondoan.dev_vps-list.png)](vps.sondoan.dev_vps-list.png)

<details>
<summary><strong>Server overview</strong> — health, resource summaries, and operational activity</summary>

[![FlexServer server overview with resource gauges, charts, jobs, and audit activity](vps.sondoan.dev_vps-overview.png)](vps.sondoan.dev_vps-overview.png)

</details>

<details>
<summary><strong>Host metrics</strong> — resource history and system readings</summary>

[![FlexServer metrics workspace with CPU, memory, disk, and network charts](vps.sondoan.dev_vps-metrics.png)](vps.sondoan.dev_vps-metrics.png)

</details>

<details>
<summary><strong>Docker monitoring</strong> — container inventory and resource visibility</summary>

[![FlexServer Docker workspace with container inventory and monitoring details](vps.sondoan.dev_vps-docker.png)](vps.sondoan.dev_vps-docker.png)

</details>

## Quick start

### Explore without a VPS

Use **Node.js 22**, npm, and Git. Run these commands from the repository root:

```bash
git clone https://github.com/sondoan17/vps-manager-nodejs.git
cd vps-manager-nodejs
npm ci
npm run build
npm start
```

The default is `APP_MODE=demo`. If using an existing configuration, set `APP_MODE=demo` and keep `ENABLE_WEB_TERMINAL=false` in `.env` before starting.

- Open the deployed demo dashboard at <http://localhost:3000/vps>; no real VPS, SSH credentials, or dashboard password are required in demo mode.
- <http://localhost:3000> is the FlexServer homepage, **not a public demo or dashboard-entry shortcut**.
- Check API health at <http://localhost:3000/api/health>.

Demo mode simulates servers, metrics, jobs, audit events, and terminal output. Real SSH is disabled. Docker monitoring needs real agent snapshots and permissions; read-only container logs are not available in demo mode.

For development, run `npm run dev` and `npm run dev:web` in separate terminals. See the [demo guide](../docs/demo.md) and [environment reference](../.env.example).

### Connect real infrastructure

Follow the [local-mode setup](../README.md#run-in-local-mode) to configure `APP_MODE=local`, generate a session secret of at least 32 characters, and set the dashboard administrator password. Keep the terminal disabled initially. Add real VPS records, establish SSH host-key trust, and configure agents as needed.

Use separate storage for demo exploration and real infrastructure. Read the [security model](../docs/security.md) before enabling remote access or granting an agent Docker permissions.

## Deployment and documentation

| Start here | Reference |
| --- | --- |
| **Source installation and configuration** | [Main project README](../README.md) · [Environment variables](../.env.example) |
| **Docker Compose** | [Deployment instructions](../README.md#deploy-with-docker-compose) — PostgreSQL, migrations, and persistent volumes |
| **Linux amd64 installation** | [Installer instructions](../README.md#install-on-a-linux-amd64-vps) — review the script before running it with `sudo` |
| **Architecture and data flow** | [Architecture](../docs/architecture.md) |
| **Storage** | [PostgreSQL and TimescaleDB guide](../docs/postgres-timescale-storage.md) |
| **Safe exploration** | [Demo guide](../docs/demo.md) |
| **Access and host permissions** | [Security model](../docs/security.md) |
| **Project history** | [Changelog](../CHANGELOG.md) |

The API, web interface, and agent live in `packages/api/`, `packages/web/`, and `packages/agent/`. Direct source runs use JSON storage by default; Docker Compose uses PostgreSQL. Local data and private keys are not served as public assets.

## Operational boundaries

- **Authentication is not optional for real infrastructure.** Local mode requires the administrator password and an HttpOnly session cookie. The public homepage does not bypass that gate.
- **Use HTTPS for public deployments.** Do not expose the local-mode dashboard over plain HTTP. Configure the public origin and secure-cookie settings for your deployment.
- **SSH is policy-gated.** Demo blocks real SSH. Local connections require an allowed target and trusted host key; private-network targets need explicit configuration.
- **Docker access is privileged.** The host agent has no Docker access by default. Opting into Docker group membership is effectively root-equivalent on the host. The API does not open the Docker socket.
- **Logs are read-only and ephemeral.** Local-mode streams need real agent capability, current container inventory, and Docker access. They do not enable container mutations and are not persisted to jobs, audit, or storage. System VPS records and demo mode are excluded.
- **Treat volumes and secrets as operational assets.** `docker compose down` preserves volumes; `docker compose down -v` deletes the data. Never commit `.env`, passwords, SSH keys, or tokens.

See the [security model](../docs/security.md) for the full configuration boundaries. Do not post vulnerability details or credentials in public issues; follow the [private reporting guidance](../README.md#reporting-security-issues).

## Support and license status

Report bugs and suggest features through [GitHub Issues](https://github.com/sondoan17/vps-manager-nodejs/issues). For contribution requirements, see [Contributing and support](../README.md#contributing-and-support).

> **License status:** This repository does not currently contain a `LICENSE` file. No license to use, modify, or distribute the source code has been granted. Contact the maintainer before using it beyond the permissions provided by GitHub's terms.

<p align="center"><strong>FlexServer</strong> · by FlexTechnology</p>
