import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronDown,
  Container,
  Database,
  History,
  KeyRound,
  Menu,
  Server,
  ShieldCheck,
  TerminalSquare,
  X,
  Copy,
} from "lucide-react";
import "./landing.css";
import { Brand, FooterBrand } from "../components/Brand";

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "/security", label: "Security" },
  { href: "/pricing", label: "Pricing" },
  { href: "/enterprise", label: "Enterprise" },
];

const CONTACT_EMAIL = "contact@flexserver.tech";
const REPO_URL = "https://github.com/ArseneLupin0111/vps-manager-nodejs";
const README_URL = `${REPO_URL}#readme`;
const DEPLOY_URL = `${REPO_URL}#deploy-with-docker-compose`;
const SECURITY_URL = `${REPO_URL}/blob/main/docs/security.md`;
const ISSUES_URL = `${REPO_URL}/issues`;
const ARCHITECTURE_URL = `${REPO_URL}/blob/main/docs/architecture.md`;
const DEMO_GUIDE_URL = `${REPO_URL}/blob/main/docs/demo.md`;

const DEPLOY_COMMANDS = `git clone ${REPO_URL}.git
cd vps-manager-nodejs
cp .env.example .env
docker compose up --build -d`;

interface FeatureItem {
  id: string;
  title: string;
  shortTitle: string;
  desc: string;
  icon: typeof Activity;
}

const FEATURES: FeatureItem[] = [
  {
    id: "health",
    title: "Host Metrics",
    shortTitle: "Telemetry",
    desc: "Track CPU, memory, disk, and network usage.",
    icon: Activity,
  },
  {
    id: "docker",
    title: "Docker Containers",
    shortTitle: "Containers",
    desc: "Inspect Docker state independently from host health.",
    icon: Container,
  },
  {
    id: "ssh",
    title: "SSH Jobs",
    shortTitle: "Jobs",
    desc: "Run SSH jobs and review their output.",
    icon: TerminalSquare,
  },
  {
    id: "history",
    title: "History & Audit",
    shortTitle: "History",
    desc: "Review metric history and audit activity.",
    icon: History,
  },
  {
    id: "storage",
    title: "Data Storage",
    shortTitle: "Storage",
    desc: "Keep data in local JSON or PostgreSQL.",
    icon: Database,
  },
  {
    id: "security",
    title: "Access & Security",
    shortTitle: "Security",
    desc: "Authenticated access. Server-side keys. No saved passwords.",
    icon: ShieldCheck,
  },
];

/* ── Static Sample Preview Components ── */

function HealthPreview() {
  return (
    <div className="showcase-preview-card">
      <div className="preview-chrome">
        <div className="preview-title-box">
          <Server size={14} className="landing-inline-icon" aria-hidden="true" />
          <span>vps-prod-01 · Host Health</span>
        </div>
        <span className="chrome-pill">
          <span className="pulse-dot" />
          Healthy (42d 8h)
        </span>
      </div>

      <div className="preview-body-content">
        <div className="console-meta-strip">
          <span>Ubuntu 24.04 LTS (x86_64)</span>
          <span className="tnum">198.51.100.24</span>
          <span>Last poll: 2s ago</span>
        </div>

        <div className="preview-metric-grid">
          <div className="metric-gauge-box">
            <div className="gauge-top">
              <span>CPU Usage</span>
              <span className="gauge-val tnum">18.4%</span>
            </div>
            <div className="gauge-meter-track">
              <div className="gauge-meter-fill" style={{ width: "18.4%" }} />
            </div>
            <span className="gauge-subtext">4 vCPUs (EPYC 7763) · Load 0.34</span>
          </div>

          <div className="metric-gauge-box">
            <div className="gauge-top">
              <span>Memory</span>
              <span className="gauge-val tnum">42.2%</span>
            </div>
            <div className="gauge-meter-track">
              <div className="gauge-meter-fill is-mem" style={{ width: "42.2%" }} />
            </div>
            <span className="gauge-subtext tnum">3.38 / 8.00 GB · 1.15 GB cache</span>
          </div>

          <div className="metric-gauge-box">
            <div className="gauge-top">
              <span>Disk (/)</span>
              <span className="gauge-val tnum">40.1%</span>
            </div>
            <div className="gauge-meter-track">
              <div className="gauge-meter-fill is-disk" style={{ width: "40.1%" }} />
            </div>
            <span className="gauge-subtext tnum">31.8 / 79.3 GB · NVMe</span>
          </div>
        </div>

        <div className="preview-watermark-row">
          <span>System metrics polled via OS primitives (/proc, sysfs)</span>
          <span className="preview-sample-badge">Illustrative preview · sample data</span>
        </div>
      </div>
    </div>
  );
}

function DockerPreview() {
  return (
    <div className="showcase-preview-card">
      <div className="preview-chrome">
        <div className="preview-title-box">
          <Container size={14} className="landing-inline-icon" aria-hidden="true" />
          <span>vps-prod-01 · Docker Daemon</span>
        </div>
        <span className="chrome-pill">
          <span className="pulse-dot" />
          Daemon Active (4 containers)
        </span>
      </div>

      <div className="preview-body-content">
        <div className="container-list">
          <div className="container-row">
            <div className="container-name-box">
              <span className="dot-running" />
              <strong>caddy-edge</strong>
              <code className="tnum">2.8-alpine</code>
            </div>
            <div className="chrome-left">
              <span className="tnum">0.4% CPU</span>
              <span className="tnum">28 MB</span>
              <span className="tnum">Ports 80/443</span>
            </div>
          </div>

          <div className="container-row">
            <div className="container-name-box">
              <span className="dot-running" />
              <strong>postgres-16</strong>
              <code className="tnum">16.3-alpine</code>
            </div>
            <div className="chrome-left">
              <span className="tnum">1.2% CPU</span>
              <span className="tnum">184 MB</span>
              <span className="chrome-pill">Healthy</span>
            </div>
          </div>

          <div className="container-row">
            <div className="container-name-box">
              <span className="dot-running" />
              <strong>redis-cache</strong>
              <code className="tnum">7.2.5</code>
            </div>
            <div className="chrome-left">
              <span className="tnum">0.1% CPU</span>
              <span className="tnum">14 MB</span>
              <span className="tnum">6379/tcp</span>
            </div>
          </div>

          <div className="container-row">
            <div className="container-name-box">
              <span className="dot-exited" />
              <strong>node-worker</strong>
              <code className="tnum">job-runner</code>
            </div>
            <div className="chrome-left">
              <span className="tnum">Exited (0)</span>
              <span className="tnum">2m ago</span>
            </div>
          </div>
        </div>

        <div className="preview-watermark-row">
          <span>Decoupled daemon inspection handles containers independently from host reachability</span>
          <span className="preview-sample-badge">Illustrative preview · sample data</span>
        </div>
      </div>
    </div>
  );
}

function SshPreview() {
  return (
    <div className="showcase-preview-card">
      <div className="preview-chrome">
        <div className="preview-title-box">
          <TerminalSquare size={14} className="landing-inline-icon" aria-hidden="true" />
          <span>vps-prod-01 · SSH Playbook Execution</span>
        </div>
        <span className="chrome-pill">
          <KeyRound size={12} aria-hidden="true" />
          Ed25519 Verified
        </span>
      </div>

      <div className="preview-body-content">
        <div className="code-terminal-card">
          <div className="code-terminal-header">
            <span>Job #8841 · Playbook: backup-verify</span>
            <span className="ssh-status-ok">Exit 0 (1.4s)</span>
          </div>
          <pre className="code-content">
            <span className="code-comment">[14:32:01] Initiating SSH channel to 198.51.100.24:22</span>{'\n'}
            <span className="code-comment">[14:32:01] Host key verified: SHA256:7uK8x... (trusted host fingerprint)</span>{'\n'}
            <span className="code-comment">[14:32:02] $ pg_dump --format=custom flexserver_db &gt; /backups/daily.dump</span>{'\n'}
            <span className="code-val">[14:32:03] Backup completed successfully (42.8 MB written)</span>{'\n'}
            <span className="ssh-status-ok">[14:32:03] Playbook finished with returncode 0</span>
          </pre>
        </div>

        <div className="preview-watermark-row">
          <span>Standard OpenSSH protocol dispatch without non-standard cloud relays</span>
          <span className="preview-sample-badge">Illustrative preview · sample data</span>
        </div>
      </div>
    </div>
  );
}

function HistoryPreview() {
  return (
    <div className="showcase-preview-card">
      <div className="preview-chrome">
        <div className="preview-title-box">
          <History size={14} className="landing-inline-icon" aria-hidden="true" />
          <span>vps-prod-01 · Metric Window & Audit</span>
        </div>
        <span className="tnum">Retention: Bounded</span>
      </div>

      <div className="preview-body-content">
        <div className="preview-timeline-box">
          <div className="preview-chart-legend">
            <span>Recent Metric History:</span>
            <span className="legend-cpu">━ CPU %</span>
            <span className="legend-mem">━ RAM %</span>
          </div>

          <svg className="preview-svg-chart" viewBox="0 0 500 80" preserveAspectRatio="none" aria-hidden="true">
            {/* Grid Lines */}
            <line x1="0" y1="20" x2="500" y2="20" stroke="hsl(var(--l-line))" strokeDasharray="3 3" />
            <line x1="0" y1="40" x2="500" y2="40" stroke="hsl(var(--l-line))" strokeDasharray="3 3" />
            <line x1="0" y1="60" x2="500" y2="60" stroke="hsl(var(--l-line))" strokeDasharray="3 3" />

            {/* RAM Path (Cyan, distinct ~42%) */}
            <path
              d="M 0 46 L 50 45 L 100 48 L 150 46 L 200 44 L 250 46 L 300 45 L 350 47 L 400 46 L 450 45 L 500 46"
              fill="none"
              stroke="hsl(var(--palette-cyan))"
              strokeWidth="2"
            />

            {/* CPU Path (Lime, distinct ~18-35% with spikes) */}
            <path
              d="M 0 65 L 50 68 L 100 62 L 150 30 L 200 64 L 250 66 L 300 25 L 350 63 L 400 65 L 450 61 L 500 65"
              fill="none"
              stroke="hsl(var(--palette-lime))"
              strokeWidth="2"
            />
          </svg>
        </div>

        <div className="container-list">
          <div className="container-row">
            <span className="tnum">14:32:03</span>
            <span>cron-runner</span>
            <span>backup-verify playbook</span>
            <span className="ssh-status-ok">Exit 0</span>
          </div>
          <div className="container-row">
            <span className="tnum">12:15:40</span>
            <span>admin</span>
            <span>caddy-edge container inspect</span>
            <span className="ssh-status-ok">OK</span>
          </div>
        </div>

        <div className="preview-watermark-row">
          <span>Recent metrics and bounded audit records maintained within configured storage limits</span>
          <span className="preview-sample-badge">Illustrative preview · sample data</span>
        </div>
      </div>
    </div>
  );
}

function StoragePreview() {
  return (
    <div className="showcase-preview-card">
      <div className="preview-chrome">
        <div className="preview-title-box">
          <Database size={14} className="landing-inline-icon" aria-hidden="true" />
          <span>Control Plane · Storage Drivers</span>
        </div>
        <span className="chrome-pill">Drivers Validated</span>
      </div>

      <div className="preview-body-content">
        <div className="preview-metric-grid">
          <div className="metric-gauge-box">
            <div className="gauge-top">
              <strong>Local JSON Driver</strong>
              <span className="decoupled-tag">STORAGE_DRIVER=json</span>
            </div>
            <p className="gauge-subtext">Single-file storage in data/vps.json for single-node development and lightweight environments without external databases.</p>
          </div>

          <div className="metric-gauge-box">
            <div className="gauge-top">
              <strong>PostgreSQL + TimescaleDB</strong>
              <span className="decoupled-tag">STORAGE_DRIVER=postgres</span>
            </div>
            <p className="gauge-subtext">Relational database storage with schema migrations and optional manual TimescaleDB hypertable migrations for metric series.</p>
          </div>

          <div className="metric-gauge-box">
            <div className="gauge-top">
              <strong>Strict Driver Validation</strong>
              <span className="decoupled-tag">Strict Enum</span>
            </div>
            <p className="gauge-subtext">The backend validates storage drivers at startup and rejects unsupported configurations (such as SQLite) immediately.</p>
          </div>
        </div>

        <div className="preview-watermark-row">
          <span>Configurable persistence via environment variables without hidden cloud lock-in</span>
          <span className="preview-sample-badge">Illustrative preview · sample data</span>
        </div>
      </div>
    </div>
  );
}
function SecurityPreview() {
  return (
    <div className="showcase-preview-card">
      <div className="preview-chrome">
        <div className="preview-title-box">
          <ShieldCheck size={14} className="landing-inline-icon" aria-hidden="true" />
          <span>Security Architecture & Policies</span>
        </div>
        <span className="chrome-pill">Enforced</span>
      </div>

      <div className="preview-body-content">
        <div className="preview-metric-grid">
          <div className="metric-gauge-box">
            <div className="gauge-top">
              <strong>Session Authentication</strong>
            </div>
            <p className="gauge-subtext">Session-based dashboard authentication with secret masking, non-sensitive error responses, and CSRF protection.</p>
          </div>

          <div className="metric-gauge-box">
            <div className="gauge-top">
              <strong>Encrypted Key Storage</strong>
            </div>
            <p className="gauge-subtext">SSH keys use AES-256-GCM envelope encryption at rest and are decrypted only in memory. Provisioning passwords are never saved.</p>
          </div>

          <div className="metric-gauge-box">
            <div className="gauge-top">
              <strong>Host Key Trust & Loopback</strong>
            </div>
            <p className="gauge-subtext">Known host key verification on SSH dispatch; web terminal listens on loopback only. Demo mode blocks real dispatch commands.</p>
          </div>
        </div>

        <div className="preview-watermark-row">
          <span>Transparent threat model and zero cloud telemetry phoning home</span>
          <span className="preview-sample-badge">Illustrative preview · sample data</span>
        </div>
      </div>
    </div>
  );
}

/* ── Fleet Workspace Sample Data & Component ── */

interface SampleHost {
  id: string;
  name: string;
  ip: string;
  region: string;
  os: string;
  uptime: string;
  load: string;
  vcpus: number;
  cpuModel: string;
  cpuPercent: number;
  memoryUsedGb: string;
  memoryTotalGb: string;
  memoryCacheGb: string;
  memoryPercent: number;
  diskUsedGb: string;
  diskTotalGb: string;
  diskType: string;
  diskPercent: number;
  containers: Array<{
    name: string;
    image: string;
    cpu: string;
    memory: string;
    port: string;
    healthy?: boolean;
  }>;
  recentJob: {
    id: string;
    name: string;
    status: string;
    duration: string;
    keyType: string;
  };
}

const SAMPLE_FLEET: SampleHost[] = [
  {
    id: "vps-prod-01",
    name: "vps-prod-01",
    ip: "198.51.100.24",
    region: "US-East (N. Virginia)",
    os: "Ubuntu 24.04 LTS (x86_64)",
    uptime: "42d 8h",
    load: "0.34, 0.41, 0.38",
    vcpus: 4,
    cpuModel: "EPYC 7763",
    cpuPercent: 18.4,
    memoryUsedGb: "3.38",
    memoryTotalGb: "8.00",
    memoryCacheGb: "1.15",
    memoryPercent: 42.2,
    diskUsedGb: "31.8",
    diskTotalGb: "79.3",
    diskType: "NVMe",
    diskPercent: 40.1,
    containers: [
      { name: "caddy-edge", image: "2.8-alpine", cpu: "0.4%", memory: "28 MB", port: "80/443" },
      { name: "postgres-16", image: "16.3-alpine", cpu: "1.2%", memory: "184 MB", port: "5432", healthy: true },
      { name: "redis-cache", image: "7.2-alpine", cpu: "0.1%", memory: "14 MB", port: "6379" },
      { name: "node-api", image: "v20.14-distroless", cpu: "0.8%", memory: "92 MB", port: "3001" },
    ],
    recentJob: {
      id: "8841",
      name: "cron-backup-check",
      status: "Exit 0",
      duration: "1.4s",
      keyType: "Ed25519 · mode 0600",
    },
  },
  {
    id: "vps-db-02",
    name: "vps-db-02",
    ip: "198.51.100.32",
    region: "EU-West (Frankfurt)",
    os: "Debian 12 Bookworm (x86_64)",
    uptime: "128d 4h",
    load: "1.12, 0.98, 0.84",
    vcpus: 8,
    cpuModel: "Xeon Gold 6338",
    cpuPercent: 34.8,
    memoryUsedGb: "10.96",
    memoryTotalGb: "16.00",
    memoryCacheGb: "3.40",
    memoryPercent: 68.5,
    diskUsedGb: "148.8",
    diskTotalGb: "240.0",
    diskType: "NVMe RAID1",
    diskPercent: 62.0,
    containers: [
      { name: "postgres-primary", image: "16.3-alpine", cpu: "2.8%", memory: "4.2 GB", port: "5432", healthy: true },
      { name: "timescale-ext", image: "pg16-ts2.14", cpu: "1.6%", memory: "2.1 GB", port: "5433" },
      { name: "wal-g-backup", image: "v3.0.1", cpu: "0.0%", memory: "48 MB", port: "cron" },
    ],
    recentJob: {
      id: "8839",
      name: "pg-wal-archive-verify",
      status: "Exit 0",
      duration: "3.2s",
      keyType: "Ed25519 · mode 0600",
    },
  },
  {
    id: "vps-edge-03",
    name: "vps-edge-03",
    ip: "198.51.100.45",
    region: "AP-South (Singapore)",
    os: "Alpine Linux 3.20 (x86_64)",
    uptime: "15d 19h",
    load: "0.12, 0.15, 0.09",
    vcpus: 2,
    cpuModel: "EPYC 7443P",
    cpuPercent: 8.2,
    memoryUsedGb: "0.96",
    memoryTotalGb: "4.00",
    memoryCacheGb: "0.41",
    memoryPercent: 24.1,
    diskUsedGb: "9.7",
    diskTotalGb: "50.0",
    diskType: "SSD",
    diskPercent: 19.4,
    containers: [
      { name: "traefik-proxy", image: "v3.0", cpu: "0.6%", memory: "42 MB", port: "80/443" },
      { name: "prom-node-agent", image: "v1.8.1", cpu: "0.2%", memory: "18 MB", port: "9100" },
    ],
    recentJob: {
      id: "8835",
      name: "reload-tls-certificates",
      status: "Exit 0",
      duration: "0.8s",
      keyType: "Ed25519 · mode 0600",
    },
  },
];

function FleetWorkspacePreview({
  shouldReduceMotion,
}: {
  shouldReduceMotion: boolean | null;
}) {
  const [selectedHostIndex, setSelectedHostIndex] = useState(0);
  const hostTabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleHostKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const count = SAMPLE_FLEET.length;
    let targetIndex = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      targetIndex = (selectedHostIndex + 1) % count;
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      targetIndex = (selectedHostIndex - 1 + count) % count;
    } else if (e.key === "Home") {
      e.preventDefault();
      targetIndex = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      targetIndex = count - 1;
    }

    if (targetIndex >= 0) {
      setSelectedHostIndex(targetIndex);
      hostTabRefs.current[targetIndex]?.focus();
    }
  };

  const host = SAMPLE_FLEET[selectedHostIndex];

  return (
    <div className="workspace-showcase-card" aria-label="Illustrative Fleet Workspace Console">
      {/* Top Chrome Bar */}
      <div className="workspace-chrome-bar">
        <div className="workspace-chrome-left">
          <div className="chrome-dots" aria-hidden="true">
            <span className="chrome-dot" />
            <span className="chrome-dot" />
            <span className="chrome-dot" />
          </div>
          <div className="workspace-chrome-title">
            <Server size={14} className="landing-inline-icon" aria-hidden="true" />
            <span>OPERATOR CONSOLE</span>
          </div>
          <span className="workspace-mode-pill">Local Mode</span>
          <span className="chrome-pill">
            <span className="pulse-dot" />
            3 Hosts Connected
          </span>
        </div>

        <div className="workspace-chrome-right">
          <span className="preview-sample-badge">[Illustrative Preview · Static Sample Telemetry]</span>
        </div>
      </div>

      {/* Main Workspace Interior */}
      <div className="workspace-interior">
        {/* Left Host Rail */}
        <aside className="workspace-host-rail" aria-label="Sample Fleet Rail">
          <div className="workspace-rail-head">
            <span>FLEET INVENTORY</span>
            <span className="tnum">3 Nodes</span>
          </div>

          <div
            className="workspace-rail-list"
            role="tablist"
            aria-label="Sample Fleet Hosts"
            onKeyDown={handleHostKeyDown}
          >
            {SAMPLE_FLEET.map((item, idx) => {
              const isSelected = selectedHostIndex === idx;
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    hostTabRefs.current[idx] = el;
                  }}
                  id={`workspace-tab-${item.id}`}
                  type="button"
                  role="tab"
                  tabIndex={isSelected ? 0 : -1}
                  aria-selected={isSelected}
                  aria-controls="workspace-panel"
                  className="workspace-host-btn"
                  onClick={() => setSelectedHostIndex(idx)}
                >
                  <div className="workspace-host-btn-top">
                    <div className="workspace-host-name-row">
                      <span className="status-indicator-dot" />
                      <span className="workspace-host-name">{item.name}</span>
                    </div>
                    <span className="workspace-host-status">Healthy</span>
                  </div>
                  <div className="workspace-host-btn-meta">
                    <span className="tnum">{item.ip}</span>
                    <span>{item.region}</span>
                  </div>
                  <div className="workspace-host-btn-metrics">
                    <span className="tnum">CPU {item.cpuPercent}%</span>
                    <span className="metric-sep">·</span>
                    <span className="tnum">RAM {item.memoryPercent}%</span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="workspace-rail-footer">
            <span className="workspace-rail-note">Select host to inspect state</span>
          </div>
        </aside>

        {/* Right Selected Host Detail Stage */}
        <section
          className="workspace-host-detail"
          id="workspace-panel"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`workspace-tab-${host.id}`}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={host.id}
              initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={shouldReduceMotion ? { opacity: 1 } : { opacity: 0 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="workspace-panel-inner"
            >
              {/* Host Metadata Header */}
              <div className="workspace-host-header">
                <div className="workspace-host-header-left">
                  <div className="workspace-host-title-line">
                    <Server size={15} className="landing-inline-icon" aria-hidden="true" />
                    <strong className="workspace-host-title">{host.name}</strong>
                    <span className="workspace-host-os-tag">{host.os}</span>
                  </div>
                  <div className="workspace-host-substrip">
                    <span className="tnum">{host.ip}</span>
                    <span>Region: {host.region}</span>
                    <span className="tnum">Uptime: {host.uptime}</span>
                    <span>Polled 2s ago via Go host agent</span>
                  </div>
                </div>
                <div className="workspace-host-header-right">
                  <span className="chrome-pill">
                    <span className="pulse-dot" />
                    Healthy ({host.uptime})
                  </span>
                </div>
              </div>

              {/* 3-Column Telemetry Gauges */}
              <div className="preview-metric-grid">
                <div className="metric-gauge-box">
                  <div className="gauge-top">
                    <span>CPU Usage</span>
                    <span className="gauge-val tnum">{host.cpuPercent}%</span>
                  </div>
                  <div className="gauge-meter-track">
                    <div className="gauge-meter-fill" style={{ width: `${host.cpuPercent}%` }} />
                  </div>
                  <span className="gauge-subtext">
                    {host.vcpus} vCPUs ({host.cpuModel}) · Load {host.load}
                  </span>
                </div>

                <div className="metric-gauge-box">
                  <div className="gauge-top">
                    <span>Memory</span>
                    <span className="gauge-val tnum">{host.memoryPercent}%</span>
                  </div>
                  <div className="gauge-meter-track">
                    <div className="gauge-meter-fill is-mem" style={{ width: `${host.memoryPercent}%` }} />
                  </div>
                  <span className="gauge-subtext tnum">
                    {host.memoryUsedGb} / {host.memoryTotalGb} GB · {host.memoryCacheGb} GB cache
                  </span>
                </div>

                <div className="metric-gauge-box">
                  <div className="gauge-top">
                    <span>Disk (/)</span>
                    <span className="gauge-val tnum">{host.diskPercent}%</span>
                  </div>
                  <div className="gauge-meter-track">
                    <div className="gauge-meter-fill is-disk" style={{ width: `${host.diskPercent}%` }} />
                  </div>
                  <span className="gauge-subtext tnum">
                    {host.diskUsedGb} / {host.diskTotalGb} GB · {host.diskType}
                  </span>
                </div>
              </div>

              {/* Decoupled Docker Daemon Panel */}
              <div className="docker-decoupled-panel">
                <div className="decoupled-head">
                  <div className="decoupled-title-row">
                    <Container size={14} className="landing-inline-icon" aria-hidden="true" />
                    <span>Decoupled Docker Daemon</span>
                  </div>
                  <span className="decoupled-tag">
                    {host.containers.length} Containers · Decoupled Socket Inspection
                  </span>
                </div>
                <div className="container-list">
                  {host.containers.map((c) => (
                    <div key={c.name} className="container-row">
                      <div className="container-name-box">
                        <span className="dot-running" />
                        <strong>{c.name}</strong>
                        <code className="tnum">{c.image}</code>
                      </div>
                      <div className="chrome-left">
                        <span className="tnum">{c.cpu} CPU</span>
                        <span className="tnum">{c.memory}</span>
                        <span className="tnum">{c.port}</span>
                        {c.healthy && <span className="chrome-pill">Healthy</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Isolated SSH Execution Audit Strip */}
              <div className="ssh-audit-strip">
                <div className="chrome-left">
                  <TerminalSquare size={13} aria-hidden="true" />
                  <span>Recent SSH Dispatch: Job #{host.recentJob.id} ({host.recentJob.name})</span>
                </div>
                <div className="chrome-left">
                  <span className="ssh-status-ok">{host.recentJob.status} ({host.recentJob.duration})</span>
                  <span className="tnum">{host.recentJob.keyType}</span>
                </div>
              </div>

              {/* Bottom Watermark Row */}
              <div className="preview-watermark-row">
                <span>Storage driver: STORAGE_DRIVER=postgres · Single administrator · Zero cloud intermediary</span>
                <span className="preview-sample-badge">Illustrative preview · static sample telemetry</span>
              </div>
            </motion.div>
          </AnimatePresence>
        </section>
      </div>
    </div>
  );
}

/* ── Main Landing Page Component ── */

export function LandingPage() {
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeFeatureIndex, setActiveFeatureIndex] = useState(0);
  const [copiedCommands, setCopiedCommands] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && menuOpen) {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const desktop = window.matchMedia("(min-width: 55rem)");
    function onViewportChange(event: MediaQueryListEvent) {
      if (event.matches) setMenuOpen(false);
    }
    desktop.addEventListener("change", onViewportChange);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktop.removeEventListener("change", onViewportChange);
    };
  }, [menuOpen]);


  const handleCopyCommands = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(DEPLOY_COMMANDS);
        setCopiedCommands(true);
        setCopyError(false);
        setTimeout(() => setCopiedCommands(false), 2000);
      } else {
        throw new Error("Clipboard API unavailable");
      }
    } catch {
      setCopyError(true);
      setCopiedCommands(false);
      setTimeout(() => setCopyError(false), 2500);
    }
  };

  const handleTabKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const count = FEATURES.length;
    let targetIndex = -1;

    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      targetIndex = (activeFeatureIndex + 1) % count;
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      targetIndex = (activeFeatureIndex - 1 + count) % count;
    } else if (e.key === "Home") {
      e.preventDefault();
      targetIndex = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      targetIndex = count - 1;
    }

    if (targetIndex >= 0) {
      setActiveFeatureIndex(targetIndex);
      tabRefs.current[targetIndex]?.focus();
    }
  };

  const activeFeature = FEATURES[activeFeatureIndex];

  return (
    <div className="landing-page landing-home" id="top">
      <a href="#main-content" className="landing-skip">
        Skip to main content
      </a>

      {/* ── Sticky Operational Header ── */}
      <header className="landing-header">
        <div className="landing-wrap landing-header-inner">
          <a href="#top" className="landing-brand" aria-label="FlexServer — home">
            <Brand />
          </a>

          <nav className="landing-nav" aria-label="Primary">
            <ul className="landing-nav-links">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className="landing-nav-link">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="landing-header-actions">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="landing-btn landing-btn-secondary landing-btn-small"
            >
              GitHub
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
            <a
              href={DEPLOY_URL}
              target="_blank"
              rel="noreferrer"
              className="landing-btn landing-btn-primary landing-btn-small"
            >
              Deploy Guide
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
            <button
              ref={menuButtonRef}
              type="button"
              className="landing-menu-button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
            </button>
          </div>
        </div>

        {/* Mobile Navigation Drawer with Motion exits */}
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              id="mobile-navigation"
              className="landing-mobile-panel"
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, height: "auto" }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <nav aria-label="Mobile">
                <ul className="landing-mobile-links">
                  {NAV_LINKS.map((link) => (
                    <li key={link.href}>
                      <a
                        href={link.href}
                        className="landing-mobile-link"
                        onClick={() => {
                          setMenuOpen(false);
                          menuButtonRef.current?.focus();
                        }}
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="landing-mobile-cta">
                <a
                  className="landing-btn landing-btn-primary landing-btn-block"
                  href={DEPLOY_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setMenuOpen(false)}
                >
                  Deploy Guide
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
                <a
                  className="landing-btn landing-btn-secondary landing-btn-block"
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setMenuOpen(false)}
                >
                  GitHub Repository
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <main id="main-content" tabIndex={-1}>
        {/* ── 1. Workspace-As-Proof Hero Opening ── */}
        <section className="landing-home-hero" id="hero" aria-labelledby="hero-title">
          <div className="landing-wrap">
            {/* Top Generous Message Row */}
            <div className="hero-message-row">
              <div className="hero-editorial-col">
                <h1 className="hero-display-title" id="hero-title">
                  Infrastructure, under control.
                </h1>

                <p className="hero-lead-text">
                  Monitor hosts, inspect containers, and run SSH jobs. One self-hosted workspace.
                </p>
                <div className="hero-cta-row">
                  <a
                    href={DEPLOY_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="landing-btn landing-btn-primary"
                  >
                    Deploy Guide
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </a>

                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="landing-btn landing-btn-secondary"
                  >
                    View Source
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </a>
                </div>
              </div>
            </div>

            {/* Dominant Full-Width Fleet Workspace Preview */}
            <FleetWorkspacePreview shouldReduceMotion={shouldReduceMotion} />
          </div>
        </section>

        {/* ── 2. Engineered Capabilities Showcase (Accessible User-Selected Previews) ── */}
        <section
          className="landing-section landing-section-alt"
          id="features"
          aria-labelledby="capabilities-title"
        >
          <div className="landing-wrap">
            <div className="landing-section-head">
              <h2 className="landing-section-title" id="capabilities-title">
                Core tools for VPS operations.
              </h2>
            </div>

            <div className="showcase-layout">
              {/* Unified Accessible Tablist (Responsive Stack/Pills via CSS) */}
              <div
                className="showcase-tablist"
                role="tablist"
                aria-label="Capabilities"
                onKeyDown={handleTabKeyDown}
              >
                {FEATURES.map((feat, idx) => {
                  const Icon = feat.icon;
                  const isSelected = activeFeatureIndex === idx;
                  return (
                    <button
                      key={feat.id}
                      ref={(el) => {
                        tabRefs.current[idx] = el;
                      }}
                      id={`capability-tab-${feat.id}`}
                      type="button"
                      role="tab"
                      tabIndex={isSelected ? 0 : -1}
                      className="showcase-tab-btn"
                      aria-selected={isSelected}
                      aria-controls="capability-preview-panel"
                      onClick={() => setActiveFeatureIndex(idx)}
                    >
                      <div className="showcase-tab-title">
                        <Icon size={16} aria-hidden="true" />
                        <span>{feat.title}</span>
                      </div>
                      <p className="showcase-tab-desc">{feat.desc}</p>
                    </button>
                  );
                })}
              </div>

              {/* Synchronized Preview Stage */}
              <div
                className="showcase-stage-col"
                id="capability-preview-panel"
                role="tabpanel"
                tabIndex={0}
                aria-labelledby={`capability-tab-${activeFeature.id}`}
              >
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeFeature.id}
                    initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={shouldReduceMotion ? { opacity: 1 } : { opacity: 0 }}
                    transition={{ duration: shouldReduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {activeFeature.id === "health" && <HealthPreview />}
                    {activeFeature.id === "docker" && <DockerPreview />}
                    {activeFeature.id === "ssh" && <SshPreview />}
                    {activeFeature.id === "history" && <HistoryPreview />}
                    {activeFeature.id === "storage" && <StoragePreview />}
                    {activeFeature.id === "security" && <SecurityPreview />}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </section>

        {/* ── 3. Architecture & Data Flow Section ── */}
        <section className="landing-section" id="architecture" aria-labelledby="arch-title">
          <div className="landing-wrap">
            <div className="landing-section-head">
              <h2 className="landing-section-title" id="arch-title">
                How it connects.
              </h2>
              <p className="landing-section-sub">
                Your console, API, and servers. No SaaS intermediary.
              </p>
            </div>

            <div className="arch-flow-diagram">
              <div className="arch-flow-node">
                <h3 className="arch-node-title">Operator Console</h3>
                <p className="arch-node-desc">
                  Authenticated React dashboard.
                </p>
              </div>

              <div className="arch-flow-node">
                <h3 className="arch-node-title">Control Plane API</h3>
                <p className="arch-node-desc">
                  NestJS API for storage, access, and jobs.
                </p>
              </div>

              <div className="arch-flow-node">
                <h3 className="arch-node-title">Direct Transport</h3>
                <p className="arch-node-desc">
                  SSH for commands. Go agent for metrics.
                </p>
              </div>

              <div className="arch-flow-node">
                <h3 className="arch-node-title">Managed Fleet</h3>
                <p className="arch-node-desc">
                  Linux hosts and agent-backed Docker monitoring.
                </p>
              </div>
            </div>

            <div className="arch-notes-box">
              <div className="arch-note-item">
                <strong>Encrypted SSH keys</strong>
                <span>Encrypted at rest. Decrypted only in memory.</span>
              </div>
              <div className="arch-note-item">
                <strong>Your choice of storage</strong>
                <span>Local JSON or PostgreSQL, with optional TimescaleDB.</span>
              </div>
              <div className="arch-note-item">
                <strong>Your own network</strong>
                <span>Self-contained backend operations on your own network.</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── 4. Startup & Deployment Section ── */}
        <section className="landing-section landing-section-alt" id="deploy" aria-labelledby="deploy-title">
          <div className="landing-wrap">
            <div className="landing-section-head">
              <h2 className="landing-section-title" id="deploy-title">
                Run it on your infrastructure.
              </h2>
              <p className="landing-section-sub">
                Demo mode for simulated hosts. Local mode for real infrastructure.
              </p>
            </div>

            <div className="deploy-split">
              <div>
                <p>
                  Deploy with Docker Compose. Keep application data and SSH keys in separate volumes.
                </p>

                <div className="sys-req-list">
                  <div className="sys-req-item">
                    <span>Control Plane API</span>
                    <strong>Node.js / NestJS API service</strong>
                  </div>
                  <div className="sys-req-item">
                    <span>Operator Console</span>
                    <strong>React single-page dashboard</strong>
                  </div>
                  <div className="sys-req-item">
                    <span>Database Engine</span>
                    <strong>PostgreSQL (optional TimescaleDB)</strong>
                  </div>
                  <div className="sys-req-item">
                    <span>Storage Isolation</span>
                    <strong>Persistent data & private key volumes</strong>
                  </div>
                </div>

                <div style={{ marginTop: "1.5rem" }}>
                  <a
                    href={DEPLOY_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="landing-inline-link"
                  >
                    Full deployment guide →
                  </a>
                </div>
              </div>

              {/* Code Terminal Card with Copy Commands functionality */}
              <div className="code-terminal-card">
                <div className="code-terminal-header">
                  <span>Quick Start · Docker Compose</span>
                  <button
                    type="button"
                    className="landing-btn landing-btn-secondary landing-btn-small"
                    onClick={handleCopyCommands}
                    aria-label={copiedCommands ? "Deployment commands copied to clipboard" : copyError ? "Failed to copy deployment commands" : "Copy deployment commands"}
                  >
                    {copiedCommands ? (
                      <>
                        <Check size={12} aria-hidden="true" />
                        <span>Copied!</span>
                      </>
                    ) : copyError ? (
                      <>
                        <X size={12} aria-hidden="true" />
                        <span>Copy Failed</span>
                      </>
                    ) : (
                      <>
                        <Copy size={12} aria-hidden="true" />
                        <span>Copy Commands</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="code-prereq-note">
                  <strong>Before running:</strong> Set <code>POSTGRES_PASSWORD</code> and secrets in <code>.env</code>.
                </div>
                <pre className="code-content">{DEPLOY_COMMANDS}</pre>
                <div className="code-terminal-footer">
                  <span>Web Console: <code>http://localhost:3000</code></span>
                  <span>API Health: <code>http://127.0.0.1:3001/api/health</code></span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── 5. Clear Scope & Boundaries Section ── */}
        <section className="landing-section" id="boundaries" aria-labelledby="boundaries-title">
          <span id="audience" className="landing-anchor-target" aria-hidden="true" />
          <div className="landing-wrap">
            <div className="landing-section-head">
              <h2 className="landing-section-title" id="boundaries-title">
                Built for your own fleet.
              </h2>
            </div>

            <div className="boundaries-grid">
              <div className="boundary-card">
                <div className="boundary-header">
                  <h3 className="boundary-title">Built For</h3>
                </div>
                <ul className="boundary-list">
                  <li>
                    <Check size={16} className="landing-inline-icon" aria-hidden="true" />
                    <span>Developers and operators managing Linux VPS hosts.</span>
                  </li>
                  <li>
                    <Check size={16} className="landing-inline-icon" aria-hidden="true" />
                    <span>Homelabs needing metrics, Docker visibility, and SSH jobs.</span>
                  </li>
                  <li>
                    <Check size={16} className="landing-inline-icon" aria-hidden="true" />
                    <span>Self-hosters who want control of data and credentials.</span>
                  </li>
                </ul>
              </div>

              <div className="boundary-card">
                <div className="boundary-header">
                  <h3 className="boundary-title">What We Are Not</h3>
                </div>
                <ul className="boundary-list">
                  <li>
                    <X size={16} className="landing-inline-icon" aria-hidden="true" />
                    <span>No cloud infrastructure provisioning.</span>
                  </li>
                  <li>
                    <X size={16} className="landing-inline-icon" aria-hidden="true" />
                    <span>No Kubernetes orchestration.</span>
                  </li>
                  <li>
                    <X size={16} className="landing-inline-icon" aria-hidden="true" />
                    <span>Uptime depends on your infrastructure, not a product SLA.</span>
                  </li>
                  <li>
                    <X size={16} className="landing-inline-icon" aria-hidden="true" />
                    <span>Single administrator today; no team access controls.</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ── 6. Technical FAQ (Accessible Native Details/Summary) ── */}
        <section className="landing-section landing-section-alt" id="faq" aria-labelledby="faq-title">
          <div className="landing-wrap landing-faq-wrap">
            <div className="landing-section-head">
              <h2 className="landing-section-title" id="faq-title">
                Common questions.
              </h2>
            </div>

            <div className="landing-faq">
              <details className="landing-faq-item">
                <summary className="landing-faq-question" tabIndex={0}>
                  <span>Where are SSH credentials and keys stored?</span>
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <div className="landing-faq-answer">
                  SSH keys stay server-side with mode 0600 permissions. Provisioning passwords are never saved.
                </div>
              </details>

              <details className="landing-faq-item">
                <summary className="landing-faq-question" tabIndex={0}>
                  <span>Is a custom agent required on every managed node?</span>
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <div className="landing-faq-answer">
                  Remote metrics require the Go host agent. SSH jobs and terminal access connect directly over SSH.
                </div>
              </details>

              <details className="landing-faq-item">
                <summary className="landing-faq-question" tabIndex={0}>
                  <span>What happens if a Docker container crashes on a host?</span>
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <div className="landing-faq-answer">
                  Container state is separate from host health. Read-only logs require a compatible agent and Docker permissions.
                </div>
              </details>

              <details className="landing-faq-item">
                <summary className="landing-faq-question" tabIndex={0}>
                  <span>Can FlexServer run completely offline or in air-gapped VPCs?</span>
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <div className="landing-faq-answer">
                  Backend and agent operations are self-contained. Offline web clients use system fonts.
                </div>
              </details>

              <details className="landing-faq-item">
                <summary className="landing-faq-question" tabIndex={0}>
                  <span>Can I open a dashboard demo directly from this page?</span>
                  <ChevronDown size={18} aria-hidden="true" />
                </summary>
                <div className="landing-faq-answer">
                  No public dashboard shortcut. Follow the deployment guide to run Demo mode locally with simulated hosts.
                </div>
              </details>
            </div>
          </div>
        </section>

        {/* ── 7. Final Call to Action Section ── */}
        <section className="final-cta-section" id="get-started" aria-labelledby="cta-title">
          <div className="landing-wrap">
            <div className="final-cta-inner">
              <h2 className="final-title" id="cta-title">
                Deploy your workspace.
              </h2>
              <div className="hero-cta-row">
                <a
                  href={DEPLOY_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="landing-btn landing-btn-primary"
                >
                  Deploy Guide
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="landing-footer">
        <div className="landing-wrap">
          <div className="landing-footer-grid">
            <div className="landing-footer-brand">
              <FooterBrand />
              <p className="landing-footer-tagline">
                Your VPS fleet. One operational workspace.
              </p>
            </div>

            <div className="landing-footer-col">
              <span className="landing-footer-heading">Documentation</span>
              <a
                href={README_URL}
                target="_blank"
                rel="noreferrer"
                className="landing-footer-link"
              >
                README Overview
              </a>
              <a
                href={DEPLOY_URL}
                target="_blank"
                rel="noreferrer"
                className="landing-footer-link"
              >
                Docker Compose Deploy
              </a>
              <a
                href={SECURITY_URL}
                target="_blank"
                rel="noreferrer"
                className="landing-footer-link"
              >
                Security &amp; Threat Model
              </a>
              <a
                href={ARCHITECTURE_URL}
                target="_blank"
                rel="noreferrer"
                className="landing-footer-link"
              >
                Architecture Specs
              </a>
            </div>

            <div className="landing-footer-col">
              <span className="landing-footer-heading">Project</span>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="landing-footer-link"
              >
                GitHub Repository
              </a>
              <a
                href={ISSUES_URL}
                target="_blank"
                rel="noreferrer"
                className="landing-footer-link"
              >
                Issue Tracker
              </a>
              <a
                href={DEMO_GUIDE_URL}
                target="_blank"
                rel="noreferrer"
                className="landing-footer-link"
              >
                Demo Mode Guide
              </a>
              <a href={`mailto:${CONTACT_EMAIL}`} className="landing-footer-link">
                {CONTACT_EMAIL}
              </a>
            </div>
          </div>

          <div className="landing-footer-bottom">
            <p>© {new Date().getFullYear()} FlexServer. All rights reserved.</p>
            <p>Built for operators who value control.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
