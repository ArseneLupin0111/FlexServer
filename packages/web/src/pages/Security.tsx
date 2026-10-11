import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, BookOpen, Check, Container, Database, Fingerprint, KeyRound, LockKeyhole, Menu, Network, Server, ShieldCheck, TerminalSquare, X } from "lucide-react";
import "./landing.css";
import "./security.css";
import { Brand, FooterBrand } from "../components/Brand";

const REPO_URL = "https://github.com/ArseneLupin0111/vps-manager-nodejs";
const SECURITY_URL = `${REPO_URL}/blob/main/docs/security.md`;
const DEPLOY_URL = `${REPO_URL}#deploy-with-docker-compose`;
const CONTACT_EMAIL = "contact@flexserver.tech";
const SECURITY_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("FlexServer security review")}`;
const NAV_LINKS = [
  { href: "/#features", label: "Feature" },
  { href: "/security", label: "Security", current: true },
  { href: "/pricing", label: "Pricing" },
  { href: "/enterprise", label: "Enterprise" },
];
const FOOTER_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#audience", label: "Who it's for" },
  { href: "/#architecture", label: "How it works" },
  { href: "/#deploy", label: "Deploy" },
  { href: "/pricing", label: "Pricing" },
  { href: "/enterprise", label: "Enterprise" },
  { href: "/security", label: "Security", current: true },
  { href: "/#faq", label: "FAQ" },
];

type SecurityCard = { id: string; title: string; icon: LucideIcon; paragraphs: string[] };
type SecurityGroup = { id: string; title: string; description: string; cards: SecurityCard[] };
const GROUPS: SecurityGroup[] = [
  {
    id: "data-access", title: "Data & access protection", description: "Understand where credentials live and how access is established.", cards: [
      { id: "dashboard-sessions", title: "Dashboard sessions", icon: LockKeyhole, paragraphs: ["In local mode, dashboard access requires the configured administrator password. Password verification uses salted scrypt hashing; sessions use an HttpOnly cookie.", "Origin checks guard unsafe requests. Cookie security settings depend on deployment configuration, with Secure enforced for an HTTPS dashboard origin."] },
      { id: "ssh-trust", title: "SSH host identity", icon: Fingerprint, paragraphs: ["Real SSH connections require strict verification against an approved host key. An unknown or changed fingerprint needs operator review rather than a silent bypass.", "Verify the fingerprint through a trusted, independent channel before approving it. Host-key verification establishes host identity; it does not replace careful access management."] },
      { id: "credential-handling", title: "Credential handling", icon: KeyRound, paragraphs: ["SSH provisioning passwords are accepted only for the provisioning request and are not persisted. Generated SSH private keys stay on the server and are never returned to the browser by the API.", "Redaction helpers remove secret-looking content from errors and audit metadata. They are a safeguard, not an absolute guarantee against every possible disclosure. Protect key storage and review what commands emit."] },
    ],
  },
  {
    id: "application-host", title: "Application & host security", description: "Sensitive capabilities stay behind explicit configuration and policy.", cards: [
      { id: "http-controls", title: "HTTP and API controls", icon: ShieldCheck, paragraphs: ["The API applies Helmet security headers and a restrictive Content Security Policy, including protection against framing. Login and sensitive mutation routes have independent rate limits.", "Static serving is limited to the public directory. Application data and server-side key directories are not exposed as public assets."] },
      { id: "target-policy", title: "SSH target policy", icon: Network, paragraphs: ["SSH target rules block localhost, cloud metadata, and link-local destinations. Private-network targets are blocked unless explicitly enabled in local mode.", "Use the private-network opt-in only for networks you intend the deployment to reach. Network policy is a layer of protection, not a substitute for firewall rules."] },
      { id: "terminal-access", title: "Optional web terminal", icon: TerminalSquare, paragraphs: ["The real web terminal is available only in local mode with ENABLE_WEB_TERMINAL explicitly enabled. Access uses an authenticated dashboard session.", "Demo mode uses simulated data and canned terminal output. It disables real SSH, real terminal network access, and real mutation actions."] },
      { id: "docker-access", title: "Deliberate Docker access", icon: Container, paragraphs: ["Host agents are installed without Docker access by default. Docker metrics access requires an explicit installer opt-in; Docker group or socket access is effectively root-equivalent.", "Container management actions are separately gated by policy and confirmation. Grant these capabilities only after evaluating the host-level risk and intended scope."] },
    ],
  },
  {
    id: "operations", title: "Operational responsibilities", description: "Self-hosting keeps deployment decisions—and their responsibilities—with you.", cards: [
      { id: "secure-deployment", title: "Secure deployment", icon: Server, paragraphs: ["The operator supplies TLS, reverse-proxy configuration, firewall rules, and a strong dashboard password and session secret. Keep the dashboard's exposure as narrow as your use case permits.", "Patch the application, operating system, and dependencies. Protect the server-side key directory and storage credentials with appropriate filesystem permissions and access controls."] },
      { id: "backup-recovery", title: "Backup and recovery", icon: Database, paragraphs: ["Availability depends on your infrastructure and operational practices. Plan backups for your application data and required key material, protect those backups, and test restoration.", "FlexServer does not provide an uptime guarantee or SLA. Your deployment, monitoring, and recovery procedures determine service continuity."] },
      { id: "security-review", title: "Review and disclosure", icon: BookOpen, paragraphs: ["Review the published security model and source code against your own requirements before deployment. Built-in SSO, SAML, MFA, role-based access control, and compliance certification are not provided.", "Do not post vulnerability details, credentials, or exploit steps in public issues. Use the repository's private vulnerability reporting feature if available; otherwise contact the maintainer privately through their GitHub profile before disclosing details. No response-time commitment is published."] },
    ],
  },
];


export function SecurityPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && menuOpen) { setMenuOpen(false); menuButton.current?.focus(); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const desktop = window.matchMedia("(min-width: 80rem)");
    function onViewportChange(event: MediaQueryListEvent) { if (event.matches) setMenuOpen(false); }
    desktop.addEventListener("change", onViewportChange);
    return () => { document.body.style.overflow = previousOverflow; desktop.removeEventListener("change", onViewportChange); };
  }, [menuOpen]);

  return <div className="landing-page security-page" id="top" lang="en">
    <a className="landing-skip" href="#main-content">Skip to main content</a>
    <header className="landing-header"><div className="landing-wrap landing-header-inner">
      <a className="landing-brand" href="/" aria-label="FlexServer — home" onClick={() => setMenuOpen(false)}><Brand /></a>
      <nav className="landing-nav" aria-label="Primary"><ul className="landing-nav-links">{NAV_LINKS.map((link) => <li key={link.href}><a className="landing-nav-link" href={link.href} aria-current={link.current ? "page" : undefined}>{link.label}</a></li>)}</ul></nav>
      <div className="landing-header-actions"><a className="landing-btn landing-btn-primary landing-btn-small" href={DEPLOY_URL} target="_blank" rel="noreferrer">Deployment docs<ArrowUpRight size={15} aria-hidden="true" /></a><button ref={menuButton} type="button" className="landing-menu-button" aria-expanded={menuOpen} aria-controls="security-mobile-menu" aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"} onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}</button></div>
    </div>{menuOpen ? <div className="landing-mobile-panel" id="security-mobile-menu"><nav aria-label="Mobile"><ul className="landing-mobile-links">{NAV_LINKS.map((link) => <li key={link.href}><a className="landing-mobile-link" href={link.href} aria-current={link.current ? "page" : undefined} onClick={() => setMenuOpen(false)}>{link.label}</a></li>)}</ul></nav><div className="landing-mobile-cta"><a className="landing-btn landing-btn-primary landing-btn-block" href={DEPLOY_URL} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>Deployment docs<ArrowUpRight size={16} aria-hidden="true" /></a></div></div> : null}</header>

    <main id="main-content" tabIndex={-1}>
      <section className="security-hero" aria-labelledby="security-title"><div className="landing-wrap">
        <div className="security-shield" aria-hidden="true"><ShieldCheck size={52} strokeWidth={1.25} /></div>
        <p className="landing-section-eyebrow">Built for infrastructure you control</p>
        <h1 id="security-title">Security you can inspect</h1>
        <p className="security-lead">Clear boundaries. Explicit access. Source you can review.<br className="security-desktop-break" /> Understand how FlexServer handles credentials and operations before you deploy.</p>
        <div className="security-overview"><article><Fingerprint size={32} aria-hidden="true" /><h2>SSH trust</h2><p>Approved host keys and target policies help keep connections deliberate.</p></article><article><LockKeyhole size={32} aria-hidden="true" /><h2>Session protection</h2><p>Local-mode password authentication, HttpOnly cookies, and origin guards.</p></article><article><ShieldCheck size={32} aria-hidden="true" /><h2>Explicit access</h2><p>Opt in to terminal and Docker capabilities, with their risks in view.</p></article></div>
      </div></section>

      <section className="security-assurance" aria-labelledby="security-assurance-title"><div className="landing-wrap"><div className="security-doc-mark" aria-hidden="true"><BookOpen size={34} strokeWidth={1.4} /><span>OPEN SOURCE</span></div><h2 id="security-assurance-title">Take an in-depth<br />look at our security model</h2><p>Inspect the implementation, configuration, and limits.<br />Evaluate the fit for your environment.</p><a className="landing-btn landing-btn-primary" href={SECURITY_URL} target="_blank" rel="noreferrer">Review security docs<ArrowUpRight size={16} aria-hidden="true" /></a></div></section>

      <section className="security-layers-section" aria-labelledby="security-layers-title"><div className="landing-wrap"><h2 id="security-layers-title">Protection is a set of layers</h2><p>Application controls and your deployment work together.</p><ol className="security-layers"><li><LockKeyhole size={22} aria-hidden="true" /><strong>Dashboard session</strong><span>Authenticate access</span></li><li><Fingerprint size={22} aria-hidden="true" /><strong>Host trust & policy</strong><span>Verify connections</span></li><li><Check size={22} aria-hidden="true" /><strong>Explicit capabilities</strong><span>Enable with intent</span></li><li><Server size={22} aria-hidden="true" /><strong>Your infrastructure</strong><span>Operate and maintain</span></li></ol><p className="security-layer-note">A capability overview—not a certification or availability guarantee.</p></div></section>

      <div className="landing-wrap security-details">{GROUPS.map((group) => <section className="security-group" id={group.id} key={group.id} aria-labelledby={`${group.id}-title`}>
        <aside className="security-group-sidebar"><h2 id={`${group.id}-title`}>{group.title}</h2><p>{group.description}</p><nav aria-label={`${group.title} topics`}><ul>{group.cards.map((card) => <li key={card.id}><a href={`#${card.id}`}><Check size={13} aria-hidden="true" />{card.title}</a></li>)}</ul></nav></aside>
        <div className="security-group-cards">{group.cards.map((card) => { const Icon = card.icon; return <article className="security-detail-card" id={card.id} tabIndex={-1} key={card.id} aria-labelledby={`${card.id}-title`}><h3 id={`${card.id}-title`}><Icon size={21} aria-hidden="true" />{card.title}</h3>{card.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</article>; })}</div>
      </section>)}<p className="security-boundary">What FlexServer does not provide: two-factor authentication, SSO/SAML, role-based access control, SOC 2 or other compliance certification, a certified Enterprise security tier, end-to-end encrypted cloud sync, and any guarantee of encryption at rest.</p></div>

      <section className="security-contact" aria-labelledby="security-contact-title"><div className="landing-wrap"><div className="security-contact-panel"><p className="landing-section-eyebrow">Make an informed decision</p><h2 id="security-contact-title">Start your security evaluation</h2><p>Review the model and discuss your deployment requirements.<br />No guaranteed response time or service commitment.</p><div className="security-contact-actions"><a className="landing-btn landing-btn-primary" href={SECURITY_MAILTO}>Discuss security requirements<ArrowUpRight size={16} aria-hidden="true" /></a><a className="landing-btn landing-btn-secondary" href={DEPLOY_URL} target="_blank" rel="noreferrer">Deployment guide<ArrowUpRight size={16} aria-hidden="true" /></a></div></div></div></section>
    </main>

    <footer className="landing-footer"><div className="landing-wrap landing-footer-grid"><div className="landing-footer-brand"><FooterBrand /><p className="landing-footer-tagline">A self-hosted dashboard for many servers in one place — resource tracking, Docker checks, and SSH jobs.</p></div><nav className="landing-footer-col" aria-label="Product"><p className="landing-footer-heading">Product</p>{FOOTER_LINKS.filter((link) => link.label !== "FAQ").map((link) => <a className="landing-footer-link" key={link.href} href={link.href} aria-current={link.current ? "page" : undefined}>{link.label}</a>)}<a className="landing-footer-link" href={REPO_URL} target="_blank" rel="noreferrer">GitHub repository</a></nav><nav className="landing-footer-col" aria-label="Support"><p className="landing-footer-heading">Support</p><a className="landing-footer-link" href="/#faq">FAQ</a><a className="landing-footer-link" href={SECURITY_URL} target="_blank" rel="noreferrer">Security model docs</a><a className="landing-footer-link" href={DEPLOY_URL} target="_blank" rel="noreferrer">Deployment guide</a><a className="landing-footer-link" href={SECURITY_MAILTO}>{CONTACT_EMAIL}</a></nav></div><div className="landing-wrap landing-footer-bottom"><p>© 2026 FlexTechnology. FlexServer — centralized VPS operations.</p></div></footer>
  </div>;
}
