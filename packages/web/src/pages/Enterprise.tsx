import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Activity, ArrowUpRight, Check, ChevronDown, Container, Database, Fingerprint, History, KeyRound, LockKeyhole, Menu, Server, ShieldCheck, TerminalSquare, Workflow, X } from "lucide-react";
import "./landing.css";
import "./enterprise.css";

const REPO_URL = "https://github.com/ArseneLupin0111/vps-manager-nodejs";
const DEPLOY_URL = `${REPO_URL}#deploy-with-docker-compose`;
const SECURITY_URL = `${REPO_URL}/blob/main/docs/security.md`;
const CONTACT_EMAIL = "contact@flexserver.tech";
const ENTERPRISE_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("FlexServer Enterprise infrastructure discussion")}&body=${encodeURIComponent("Hello FlexServer,\n\nI would like to discuss evaluating FlexServer for our infrastructure.\n\nOrganization / use case:\nNumber of servers:\nDeployment environment:\nMonitoring and SSH requirements:\nSecurity and access requirements:\nOther questions:\n\nThank you.")}`;
const NAV_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#audience", label: "Who it's for" },
  { href: "/#architecture", label: "How it works" },
  { href: "/#deploy", label: "Deploy" },
  { href: "/pricing", label: "Pricing" },
  { href: "/enterprise", label: "Enterprise", current: true },
  { href: "/security", label: "Security" },
  { href: "/#faq", label: "FAQ" },
];

function Brand() {
  return <><span className="landing-brand-mark" aria-hidden="true"><Server size={18} strokeWidth={2.25} /></span><span className="landing-brand-text"><span className="landing-brand-name">FlexServer</span><span className="landing-brand-sub">by FlexTechnology</span></span></>;
}

function Preview({ title, children, caption }: { title: string; children: ReactNode; caption: string }) {
  return <figure className="enterprise-preview">
    <div className="landing-preview-chrome"><div className="landing-preview-chrome-left"><span className="landing-preview-dots" aria-hidden="true"><i /><i /><i /></span><span className="landing-preview-title">{title}</span></div><span className="landing-preview-pill is-info">Demo data</span></div>
    <div className="enterprise-preview-body">{children}</div>
    <figcaption className="landing-preview-caption"><span className="landing-preview-sample-tag">Static illustration</span><span>{caption}</span></figcaption>
  </figure>;
}

function FleetPreview() {
  return <Preview title="Infrastructure / Fleet overview" caption="Sample hosts and metrics, not live telemetry.">
    <div className="enterprise-preview-summary"><span className="enterprise-preview-icon"><Activity size={20} aria-hidden="true" /></span><div><strong>Fleet health</strong><span>Resource signals, host by host</span></div></div>
    <div className="enterprise-fleet-labels"><span>Host</span><span>Status</span><span>CPU / RAM</span></div>
    {[{ name: "production-01", status: "Online", cpu: 38, ram: 62 }, { name: "staging-02", status: "Online", cpu: 12, ram: 34 }, { name: "worker-03", status: "Stale data", cpu: 26, ram: 48 }].map((host) => <div className="enterprise-fleet-row" key={host.name}><span className="tnum"><Server size={14} aria-hidden="true" />{host.name}</span><span className={host.status === "Online" ? "enterprise-status" : "enterprise-status is-stale"}>{host.status}</span><span className="tnum">{host.cpu}% / {host.ram}%</span></div>)}
    <div className="enterprise-metric-pair">{[{ name: "CPU", value: 38 }, { name: "Memory", value: 62 }].map((metric) => <div className="landing-preview-metric-box" key={metric.name}><div className="landing-preview-box-head"><span className="landing-preview-box-label">{metric.name}</span><span className="landing-preview-box-val tnum">{metric.value}%</span></div><div className="landing-preview-meter" aria-hidden="true"><div className="landing-preview-meter-fill" style={{ width: `${metric.value}%` }} /></div><span className="landing-preview-tag-dim">production-01 · sample</span></div>)}</div>
  </Preview>;
}

function OperationsPreview() {
  return <Preview title="Host operations / Keys & jobs" caption="Illustrative states; no commands run here.">
    <div className="enterprise-key-card"><span className="enterprise-preview-icon"><KeyRound size={21} aria-hidden="true" /></span><div><strong>production-01</strong><span>SSH key provisioned · host key trusted</span></div><ShieldCheck size={18} aria-hidden="true" /></div>
    <p className="enterprise-preview-label">Tracked command jobs</p>
    <div className="enterprise-job"><span><TerminalSquare size={16} aria-hidden="true" /><strong>Check disk usage</strong><small className="tnum">df -h</small></span><span className="enterprise-status">Succeeded</span></div>
    <div className="enterprise-job"><span><Workflow size={16} aria-hidden="true" /><strong>Scheduled health check</strong><small>Execution history retained</small></span><span className="landing-preview-pill is-info">Scheduled</span></div>
    <div className="enterprise-terminal tnum"><span>$ df -h /</span><span>Filesystem   Size  Used  Avail</span><span>/dev/vda1    120G   48G    72G</span><span className="enterprise-terminal-note">Sample output · exit code 0</span></div>
  </Preview>;
}

function SecurityPreview() {
  return <Preview title="Explicit security layers" caption="A capability diagram, not a security certification.">
    <div className="enterprise-security-orbit" aria-hidden="true"><div><ShieldCheck size={42} strokeWidth={1.4} /></div><span className="enterprise-orbit-dot" /></div>
    <div className="enterprise-layer"><LockKeyhole size={16} aria-hidden="true" /><span>Dashboard session authentication</span><Check size={15} aria-hidden="true" /></div>
    <div className="enterprise-layer"><Fingerprint size={16} aria-hidden="true" /><span>SSH host-key trust checks</span><Check size={15} aria-hidden="true" /></div>
    <div className="enterprise-layer"><History size={16} aria-hidden="true" /><span>Recorded operational audit events</span><Check size={15} aria-hidden="true" /></div>
  </Preview>;
}

export function EnterprisePage() {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") setMenuOpen(false); }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    if (menuOpen) document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [menuOpen]);

  return <div className="landing-page enterprise-page" id="top" lang="en">
    <a className="landing-skip" href="#main-content">Skip to main content</a>
    <header className="landing-header">
      <div className="landing-wrap landing-header-inner">
        <a className="landing-brand" href="/" aria-label="FlexServer — home" onClick={() => setMenuOpen(false)}><Brand /></a>
        <nav className="landing-nav" aria-label="Primary"><ul className="landing-nav-links">{NAV_LINKS.map((link) => <li key={link.href}><a className="landing-nav-link" href={link.href} aria-current={link.current ? "page" : undefined}>{link.label}</a></li>)}</ul></nav>
        <div className="landing-header-actions"><a className="landing-btn landing-btn-primary landing-btn-small" href={DEPLOY_URL} target="_blank" rel="noreferrer">Deployment docs<ArrowUpRight size={15} aria-hidden="true" /></a><button type="button" className="landing-menu-button" aria-expanded={menuOpen} aria-controls="enterprise-mobile-menu" aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"} onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}</button></div>
      </div>
      {menuOpen ? <div className="landing-mobile-panel" id="enterprise-mobile-menu"><nav aria-label="Mobile"><ul className="landing-mobile-links">{NAV_LINKS.map((link) => <li key={link.href}><a className="landing-mobile-link" href={link.href} aria-current={link.current ? "page" : undefined} onClick={() => setMenuOpen(false)}>{link.label}</a></li>)}</ul></nav><div className="landing-mobile-cta"><a className="landing-btn landing-btn-primary landing-btn-block" href={DEPLOY_URL} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>Deployment docs<ArrowUpRight size={16} aria-hidden="true" /></a><a className="landing-btn landing-btn-secondary landing-btn-block" href={ENTERPRISE_MAILTO} onClick={() => setMenuOpen(false)}>Discuss your infrastructure<ArrowUpRight size={16} aria-hidden="true" /></a></div></div> : null}
    </header>

    <main id="main-content" tabIndex={-1}>
      <section className="enterprise-hero" aria-labelledby="enterprise-title">
        <div className="enterprise-rays" aria-hidden="true" />
        <div className="landing-wrap enterprise-hero-inner"><p className="landing-section-eyebrow">FlexServer for your organization</p><h1 id="enterprise-title">Modern VPS management<br /><span>Built for your infrastructure</span></h1><p className="enterprise-lead">Bring server health, Docker visibility, and SSH operations into one calm view. Evaluate FlexServer on the infrastructure you control.</p><div className="enterprise-actions"><a className="landing-btn landing-btn-primary" href={ENTERPRISE_MAILTO}>Discuss your infrastructure<ArrowUpRight size={17} aria-hidden="true" /></a><a className="landing-btn landing-btn-secondary" href={DEPLOY_URL} target="_blank" rel="noreferrer">Explore deployment<ArrowUpRight size={17} aria-hidden="true" /></a></div><p className="enterprise-availability">Self-hosted capabilities available to evaluate today. Contact us to discuss requirements — not to purchase an Enterprise tier.</p></div>
      </section>

      <section className="enterprise-values-section" aria-labelledby="enterprise-values-title"><div className="landing-wrap"><h2 className="enterprise-centered-title" id="enterprise-values-title">A clearer way to work with your servers</h2><ul className="enterprise-values"><li><Server size={24} aria-hidden="true" /><h3>Your infrastructure</h3><p>Run the dashboard and keep operational data in your own deployment.</p></li><li><Activity size={24} aria-hidden="true" /><h3>One fleet view</h3><p>See host resources, Docker state, and job history without switching tools.</p></li><li><ShieldCheck size={24} aria-hidden="true" /><h3>Explicit controls</h3><p>Enable real SSH and container actions deliberately, with policy gates.</p></li></ul></div></section>

      <section className="landing-section enterprise-feature-section" aria-labelledby="enterprise-fleet-title"><div className="landing-wrap enterprise-feature"><div className="enterprise-feature-copy"><p className="landing-section-eyebrow">See the whole picture</p><h2 className="landing-section-title" id="enterprise-fleet-title">Less context switching.<br />More operational clarity.</h2><p className="landing-section-sub">Keep your hosts in one view, then follow the signals into per-server metrics and Docker monitoring. Distinguish current readings from stale data before deciding what to do next.</p><ul className="enterprise-checks"><li><Check size={17} aria-hidden="true" />CPU, memory, disk, and network history</li><li><Check size={17} aria-hidden="true" />Docker visibility with explicit agent access</li></ul><a className="landing-inline-link" href="/#features">Explore the dashboard features <ArrowUpRight size={15} aria-hidden="true" /></a></div><FleetPreview /></div></section>

      <section className="landing-section enterprise-feature-section" aria-labelledby="enterprise-operations-title"><div className="landing-wrap enterprise-feature is-reversed"><div className="enterprise-feature-copy"><p className="landing-section-eyebrow">From visibility to action</p><h2 className="landing-section-title" id="enterprise-operations-title">Make everyday operations<br />easier to follow.</h2><p className="landing-section-sub">Manage SSH keys and run tracked or scheduled command jobs on configured hosts. Keep execution status and output close to the server they belong to, instead of losing the context in separate terminal windows.</p><ul className="enterprise-checks"><li><Check size={17} aria-hidden="true" />SSH key provisioning and verification</li><li><Check size={17} aria-hidden="true" />Job history and an optional local-mode web terminal</li></ul><p className="enterprise-small-note">Real SSH requires local mode, configured access, and host-policy approval.</p></div><OperationsPreview /></div></section>

      <section className="landing-section enterprise-feature-section" aria-labelledby="enterprise-controls-title"><div className="landing-wrap enterprise-feature"><div className="enterprise-feature-copy"><p className="landing-section-eyebrow">Deliberate by design</p><h2 className="landing-section-title" id="enterprise-controls-title">Keep sensitive operations<br />behind explicit controls.</h2><p className="landing-section-sub">Local-mode dashboard sessions, SSH host-key trust, and operational audit records help you understand how access and actions work. Docker management is disabled by default and limited to confirmed, scoped container actions.</p><ul className="enterprise-checks"><li><Check size={17} aria-hidden="true" />Demo mode cannot make real SSH calls</li><li><Check size={17} aria-hidden="true" />Secrets stay out of public assets and API responses</li></ul><a className="landing-inline-link" href={SECURITY_URL} target="_blank" rel="noreferrer">Read the security model <ArrowUpRight size={15} aria-hidden="true" /></a></div><SecurityPreview /></div></section>

      <section className="landing-section enterprise-security-section" aria-labelledby="enterprise-security-title"><div className="landing-wrap"><div className="enterprise-section-head"><p className="landing-section-eyebrow">Security you can inspect</p><h2 className="landing-section-title" id="enterprise-security-title">Understand the layers.<br />Evaluate the fit.</h2></div><div className="enterprise-security-grid"><article><Fingerprint size={28} aria-hidden="true" /><h3>Host-key verification</h3><p>Review SSH host identity and trust before connecting. A changed host key needs attention, not a silent bypass.</p></article><article><LockKeyhole size={28} aria-hidden="true" /><h3>Session authentication</h3><p>Local mode uses an admin password and HttpOnly dashboard session cookie. This is dashboard-wide access, not per-user roles.</p></article><article><History size={28} aria-hidden="true" /><h3>Audit visibility</h3><p>Review recorded operational events with secret-looking metadata redacted. Audit history is not a compliance certification.</p></article></div><a className="landing-btn landing-btn-secondary" href="/security">Explore the security overview<ArrowUpRight size={17} aria-hidden="true" /></a></div></section>

      <section className="landing-section enterprise-deployment-section" aria-labelledby="enterprise-deployment-title"><div className="landing-wrap"><div className="enterprise-deployment-panel"><div><p className="landing-section-eyebrow">On your own terms</p><h2 className="landing-section-title" id="enterprise-deployment-title">Deploy where your servers live.</h2><p className="landing-section-sub">A browser-based dashboard with a self-hosted API and Linux host agents. Your organization supplies the infrastructure and operates the deployment.</p><a className="landing-inline-link" href={DEPLOY_URL} target="_blank" rel="noreferrer">Read the deployment guide <ArrowUpRight size={15} aria-hidden="true" /></a></div><ul className="enterprise-deployment-options"><li><Container size={23} aria-hidden="true" /><strong>Docker Compose</strong><span>Self-hosted stack</span></li><li><TerminalSquare size={23} aria-hidden="true" /><strong>Demo / local modes</strong><span>Simulated or configured real access</span></li><li><Database size={23} aria-hidden="true" /><strong>JSON / PostgreSQL</strong><span>Configurable persistence</span></li></ul></div></div></section>

      <section className="landing-section" id="enterprise-faq" aria-labelledby="enterprise-faq-title"><div className="landing-wrap landing-faq-wrap"><div className="landing-section-head"><p className="landing-section-eyebrow">Before you evaluate</p><h2 className="landing-section-title" id="enterprise-faq-title">A clear scope, from the start.</h2></div><div className="landing-faq"><details className="landing-faq-item"><summary className="landing-faq-question"><span>Is there an Enterprise product or subscription today?</span><ChevronDown size={17} aria-hidden="true" /></summary><p className="landing-faq-answer">No. This page describes existing self-hosted capabilities you can evaluate, not a separate Enterprise tier. There is no Enterprise price, checkout, billing, or license enforcement. Contact opens your mail app to discuss your requirements.</p></details><details className="landing-faq-item"><summary className="landing-faq-question"><span>Does FlexServer include organizational access controls?</span><ChevronDown size={17} aria-hidden="true" /></summary><p className="landing-faq-answer">No SSO, SAML, RBAC, team onboarding, or shared-workspace permissions are currently provided. A local deployment uses dashboard-wide admin session access; there is no per-VPS authorization boundary. Evaluate this access model against your organization's needs before deployment.</p></details><details className="landing-faq-item"><summary className="landing-faq-question"><span>Are hosting, compliance certification, or an SLA included?</span><ChevronDown size={17} aria-hidden="true" /></summary><p className="landing-faq-answer">No managed hosting, SOC 2 certification, or contractual SLA is offered here. You are responsible for infrastructure, backups, network exposure, and access reviews. The documented security controls are capabilities, not a compliance guarantee.</p></details><details className="landing-faq-item"><summary className="landing-faq-question"><span>How should we begin an evaluation?</span><ChevronDown size={17} aria-hidden="true" /></summary><p className="landing-faq-answer">Start with the <a className="landing-inline-link" href={DEPLOY_URL} target="_blank" rel="noreferrer">deployment guide</a> and simulated demo mode. Review the security model before enabling real local-mode access. For larger estates, email your server count, environment, and operational or security requirements; do not send credentials or private keys.</p></details></div></div></section>

      <section className="landing-section enterprise-contact-section" aria-labelledby="enterprise-contact-title"><div className="landing-wrap"><div className="landing-contact-panel"><p className="landing-section-eyebrow">Let's talk infrastructure</p><h2 className="landing-contact-title" id="enterprise-contact-title">Your environment.<br />Your requirements.</h2><p className="landing-contact-sub">Tell us what you run and what you need from a VPS operations dashboard. We can discuss the current self-hosted capabilities and whether they fit your setup.</p><div className="landing-contact-actions"><a className="landing-btn landing-btn-primary" href={ENTERPRISE_MAILTO}>Discuss your infrastructure<ArrowUpRight size={17} aria-hidden="true" /></a><a className="landing-btn landing-btn-secondary" href={DEPLOY_URL} target="_blank" rel="noreferrer">Read deployment docs<ArrowUpRight size={17} aria-hidden="true" /></a></div><p className="enterprise-small-note">Opens your mail app. No form submission, purchase, or hosting commitment.</p></div></div></section>
    </main>

    <footer className="landing-footer"><div className="landing-wrap landing-footer-grid"><div className="landing-footer-brand"><span className="landing-brand" aria-hidden="true"><Brand /></span><p className="landing-footer-tagline">A self-hosted dashboard for many servers in one place — resource tracking, Docker checks, and SSH jobs.</p></div><nav className="landing-footer-col" aria-label="Product"><p className="landing-footer-heading">Product</p>{NAV_LINKS.filter((link) => link.label !== "FAQ").map((link) => <a className="landing-footer-link" key={link.href} href={link.href} aria-current={link.current ? "page" : undefined}>{link.label}</a>)}<a className="landing-footer-link" href={REPO_URL} target="_blank" rel="noreferrer">GitHub repository</a></nav><nav className="landing-footer-col" aria-label="Support"><p className="landing-footer-heading">Support</p><a className="landing-footer-link" href="#enterprise-faq">Enterprise questions</a><a className="landing-footer-link" href={SECURITY_URL} target="_blank" rel="noreferrer">Security model</a><a className="landing-footer-link" href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">Report an issue</a><a className="landing-footer-link" href={ENTERPRISE_MAILTO}>{CONTACT_EMAIL}</a></nav></div><div className="landing-wrap landing-footer-bottom"><p>© 2026 FlexTechnology. FlexServer — centralized VPS operations.</p></div></footer>
  </div>;
}
