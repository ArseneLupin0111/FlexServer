import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Info,
  Menu,
  Server,
  X,
} from "lucide-react";
import "./landing.css";
import "./pricing.css";

const CONTACT_EMAIL = "contact@flexserver.tech";
const REPO_URL = "https://github.com/ArseneLupin0111/vps-manager-nodejs";
const README_URL = `${REPO_URL}#readme`;
const DEPLOY_URL = `${REPO_URL}#deploy-with-docker-compose`;
const ISSUES_URL = `${REPO_URL}/issues`;

// Desktop + mobile nav shared by the pricing header. Anchor targets point at
// the landing page because this page has no such sections of its own.
const PRICING_NAV_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#audience", label: "Who it's for" },
  { href: "/#architecture", label: "How it works" },
  { href: "/#deploy", label: "Deploy" },
  { href: "/pricing", label: "Pricing", current: true },
  { href: "/enterprise", label: "Enterprise" },
  { href: "/#faq", label: "FAQ" },
];

// ── Single plan data source ─────────────────────────────────────────────
// Cards, comparison table, and FAQ all read from PLANS below. There is no
// second tier model: comparison rows pick values off these records so the
// numbers cannot drift between sections.
type Plan = {
  id: "free" | "plus" | "pro";
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  servers: string;
  users: string;
  metrics: string;
  audit: string;
  support: string;
  ctaLabel: string;
  ctaHref: string;
  ctaExternal: boolean;
  recommended?: boolean;
};

const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    cadence: "free forever",
    blurb: "For personal servers and trying FlexServer on your own hardware.",
    servers: "Up to 2 servers",
    users: "1 user",
    metrics: "24-hour metrics history",
    audit: "7-day audit log",
    support: "Community support",
    ctaLabel: "Get started",
    ctaHref: DEPLOY_URL,
    ctaExternal: true,
  },
  {
    id: "plus",
    name: "Plus",
    price: "$3",
    cadence: "per month, USD",
    blurb: "For growing setups that need more servers and longer history.",
    servers: "Up to 5 servers",
    users: "1 user",
    metrics: "7-day metrics history",
    audit: "30-day audit log",
    support: "Community support",
    ctaLabel: "Contact about Plus",
    ctaHref: `mailto:${CONTACT_EMAIL}?subject=FlexServer%20Plus%20plan%20interest`,
    ctaExternal: false,
    recommended: true,
  },
  {
    id: "pro",
    name: "Pro",
    price: "$5",
    cadence: "per month, USD",
    blurb:
      "For larger self-hosted estates that want the longest retention and email support.",
    servers: "Up to 15 servers",
    users: "1 user",
    metrics: "30-day metrics history",
    audit: "90-day audit log",
    support: "Email support (no SLA)",
    ctaLabel: "Contact about Pro",
    ctaHref: `mailto:${CONTACT_EMAIL}?subject=FlexServer%20Pro%20plan%20interest`,
    ctaExternal: false,
  },
];

const SHARED_CORE =
  "Every plan includes core host telemetry, Docker monitoring and container actions, SSH key management, scheduled jobs, the optional web terminal, and built-in security controls.";

// ── Comparison table model (values picked from PLANS, never re-typed) ────
type CompareRow = { label: string; values: [string, string, string] };
type CompareGroup = { title: string; rows: CompareRow[] };

function planValues(pick: (plan: Plan) => string): [string, string, string] {
  return [pick(PLANS[0]), pick(PLANS[1]), pick(PLANS[2])];
}

function shared(value: string): [string, string, string] {
  return [value, value, value];
}

const COMPARISON: CompareGroup[] = [
  {
    title: "Monitoring",
    rows: [
      {
        label: "Core host telemetry (CPU, memory, disk, network)",
        values: shared("Included"),
      },
      { label: "Metrics history", values: planValues((plan) => plan.metrics) },
    ],
  },
  {
    title: "Docker",
    rows: [
      { label: "Container monitoring", values: shared("Included") },
      {
        label: "Container actions (start, stop, restart)",
        values: shared("Included"),
      },
    ],
  },
  {
    title: "SSH & jobs",
    rows: [
      { label: "SSH key management", values: shared("Included") },
      { label: "Scheduled jobs and run history", values: shared("Included") },
      {
        label: "Web terminal (optional, needs explicit setup)",
        values: shared("Included"),
      },
    ],
  },
  {
    title: "History",
    rows: [
      { label: "Audit log retention", values: planValues((plan) => plan.audit) },
    ],
  },
  {
    title: "Limits",
    rows: [
      { label: "Servers", values: planValues((plan) => plan.servers) },
      { label: "Users", values: planValues((plan) => plan.users) },
    ],
  },
  {
    title: "Support",
    rows: [
      { label: "Support channel", values: planValues((plan) => plan.support) },
      {
        label: "Hosting",
        values: shared("Software only, self-hosted — hosting not included"),
      },
      { label: "More than 15 servers", values: shared("Contact us") },
    ],
  },
];

const SCALE_MAILTO = `mailto:${CONTACT_EMAIL}?subject=FlexServer%20plans%20for%20more%20than%2015%20servers`;

export function PricingPage() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  return (
    <div className="landing-page" id="top" lang="en">
      <a className="landing-skip" href="#main-content">
        Skip to main content
      </a>

      <header className="landing-header">
        <div className="landing-wrap landing-header-inner">
          <a
            className="landing-brand"
            href="/"
            onClick={() => setMenuOpen(false)}
            aria-label="FlexServer — home"
          >
            <span className="landing-brand-mark" aria-hidden="true">
              <Server size={18} strokeWidth={2.25} />
            </span>
            <span className="landing-brand-text">
              <span className="landing-brand-name">FlexServer</span>
              <span className="landing-brand-sub">by FlexTechnology</span>
            </span>
          </a>

          <nav className="landing-nav" aria-label="Primary">
            <ul className="landing-nav-links">
              {PRICING_NAV_LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    className="landing-nav-link"
                    href={link.href}
                    aria-current={link.current ? "page" : undefined}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="landing-header-actions">
            <a
              className="landing-btn landing-btn-primary landing-btn-small"
              href={DEPLOY_URL}
              target="_blank"
              rel="noreferrer"
            >
              Deployment docs
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <button
              type="button"
              className="landing-menu-button"
              aria-expanded={menuOpen}
              aria-controls="pricing-mobile-menu"
              aria-label={
                menuOpen ? "Close navigation menu" : "Open navigation menu"
              }
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? (
                <X size={20} aria-hidden="true" />
              ) : (
                <Menu size={20} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {menuOpen ? (
          <div className="landing-mobile-panel" id="pricing-mobile-menu">
            <nav aria-label="Mobile">
              <ul className="landing-mobile-links">
                {PRICING_NAV_LINKS.map((link) => (
                  <li key={link.label}>
                    <a
                      className="landing-mobile-link"
                      href={link.href}
                      aria-current={link.current ? "page" : undefined}
                      onClick={() => setMenuOpen(false)}
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
                Deployment docs
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
              <a
                className="landing-btn landing-btn-secondary landing-btn-block"
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => setMenuOpen(false)}
              >
                GitHub repository
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            </div>
          </div>
        ) : null}
      </header>

      <main id="main-content" tabIndex={-1}>
        <section className="pricing-hero" aria-labelledby="pricing-title">
          <div className="landing-wrap pricing-hero-inner">
            <p className="pricing-status">
              <Info size={16} aria-hidden="true" />
              <span>
                Proposed plans — these tiers and limits are not yet enforced,
                and paid subscriptions cannot be purchased today. Emailing
                about Plus or Pro only registers interest.
              </span>
            </p>
            <p className="landing-section-eyebrow">Pricing</p>
            <h1 className="landing-section-title" id="pricing-title">
              Simple plans for your VPS workspace
            </h1>
            <p className="landing-section-sub pricing-lead">
              Start free. Upgrade as your infrastructure grows.
            </p>
          </div>
        </section>

        <section
          className="landing-section pricing-plans-section"
          id="plans"
          aria-label="Plans"
        >
          <div className="landing-wrap">
            <ul className="pricing-grid">
              {PLANS.map((plan) => (
                <li
                  key={plan.id}
                  className={
                    plan.recommended
                      ? "pricing-card is-recommended"
                      : "pricing-card"
                  }
                >
                  {plan.recommended ? (
                    <p className="pricing-badge">Recommended</p>
                  ) : null}
                  <h2 className="pricing-plan-name">{plan.name}</h2>
                  <p className="pricing-price">
                    <span className="pricing-amount">{plan.price}</span>{" "}
                    <span className="pricing-cadence">{plan.cadence}</span>
                  </p>
                  <p className="pricing-blurb">{plan.blurb}</p>
                  <a
                    className={
                      plan.recommended
                        ? "landing-btn landing-btn-primary landing-btn-block"
                        : "landing-btn landing-btn-secondary landing-btn-block"
                    }
                    href={plan.ctaHref}
                    target={plan.ctaExternal ? "_blank" : undefined}
                    rel={plan.ctaExternal ? "noreferrer" : undefined}
                  >
                    {plan.ctaLabel}
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </a>
                  {plan.ctaExternal ? null : (
                    <p className="pricing-cta-note">
                      Not purchasable yet — email only registers interest.
                    </p>
                  )}
                  <ul className="pricing-features">
                    {[
                      plan.servers,
                      plan.users,
                      plan.metrics,
                      plan.audit,
                      plan.support,
                    ].map((feature) => (
                      <li key={feature} className="pricing-feature">
                        <Check size={15} aria-hidden="true" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="pricing-shared">{SHARED_CORE}</p>
          </div>
        </section>

        <section
          className="landing-section landing-section-alt"
          id="compare"
          aria-labelledby="pricing-compare-title"
        >
          <div className="landing-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">Compare</p>
              <h2 className="landing-section-title" id="pricing-compare-title">
                Compare plans by feature area
              </h2>
              <p className="landing-section-sub">
                The same tiers as above, broken down by area. Limits shown are
                proposed and not currently enforced.
              </p>
            </div>
            <div
              className="pricing-table-scroll"
              role="region"
              aria-label="Plan comparison table, scrollable horizontally on small screens"
              tabIndex={0}
            >
              <table className="pricing-table">
                <caption className="pricing-table-caption">
                  Free, Plus, and Pro across monitoring, Docker, SSH and jobs,
                  history, limits, and support.
                </caption>
                <colgroup>
                  <col />
                  <col />
                  <col className="pricing-col-hot" />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Feature</th>
                    <th scope="col">Free</th>
                    <th scope="col">Plus</th>
                    <th scope="col">Pro</th>
                  </tr>
                </thead>
                {COMPARISON.map((group) => (
                  <tbody key={group.title}>
                    <tr className="pricing-group-row">
                      <th colSpan={4} scope="rowgroup">
                        {group.title}
                      </th>
                    </tr>
                    {group.rows.map((row) => (
                      <tr key={row.label}>
                        <th scope="row">{row.label}</th>
                        {row.values.map((value, index) => (
                          <td key={`${row.label}-${PLANS[index].id}`}>
                            {value}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          </div>
        </section>

        <section
          className="landing-section"
          id="scale"
          aria-labelledby="pricing-scale-title"
        >
          <div className="landing-wrap">
            <div className="landing-contact-panel">
              <p className="landing-section-eyebrow">Large estates</p>
              <h2 className="landing-contact-title" id="pricing-scale-title">
                Need more than 15 servers?
              </h2>
              <p className="landing-contact-sub">
                Pro covers up to 15 servers for 1 user. If your infrastructure
                is bigger than that, tell us about your setup and we will talk
                through options, or read about the capabilities available for
                larger estates. FlexServer is software only and self-hosted —
                hosting is never included.
              </p>
              <div className="landing-contact-actions">
                <a
                  className="landing-btn landing-btn-primary"
                  href={SCALE_MAILTO}
                >
                  Contact us about larger plans
                  <ArrowUpRight size={17} aria-hidden="true" />
                </a>
                <a className="landing-btn landing-btn-secondary" href="/enterprise">
                  See Enterprise overview
                </a>
              </div>
            </div>
          </div>
        </section>

        <section
          className="landing-section landing-section-alt"
          id="pricing-faq"
          aria-labelledby="pricing-faq-title"
        >
          <div className="landing-wrap landing-faq-wrap">
            <div className="landing-section-head">
              <p className="landing-section-eyebrow">FAQ</p>
              <h2 className="landing-section-title" id="pricing-faq-title">
                Pricing questions, answered honestly
              </h2>
            </div>
            <div className="landing-faq">
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Can I buy Plus or Pro today?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  No. There is no checkout, no billing, and no license
                  enforcement right now. The prices and limits on this page are
                  a proposal, and the{" "}
                  <a
                    className="landing-inline-link"
                    href={SCALE_MAILTO}
                  >
                    contact links
                  </a>{" "}
                  only open an email so you can register interest.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>What do I actually get on Free today?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Everything the software can do. Every self-hosted deployment
                  currently has the full feature set with no enforced server,
                  history, or user limits. Free describes the proposed
                  long-term shape, not a restriction in the code today.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>Do plans include hosting for my servers?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  No. FlexServer is software only and runs on infrastructure
                  you provide — see the{" "}
                  <a
                    className="landing-inline-link"
                    href={README_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    README
                  </a>{" "}
                  for install options. Hosting is never included in any plan.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>What happens when I email about a paid plan?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Your mail app opens a message to {CONTACT_EMAIL} with the
                  plan already in the subject line. Send it and we will reply
                  about your use case. No payment details are involved at any
                  point.
                </p>
              </details>
              <details className="landing-faq-item">
                <summary className="landing-faq-question">
                  <span>How do I start for free?</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="landing-faq-answer">
                  Follow the{" "}
                  <a
                    className="landing-inline-link"
                    href={DEPLOY_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    deployment docs
                  </a>{" "}
                  to run FlexServer on your own machine or server. Questions go
                  to{" "}
                  <a
                    className="landing-inline-link"
                    href={ISSUES_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    GitHub issues
                  </a>{" "}
                  or {CONTACT_EMAIL}.
                </p>
              </details>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-wrap landing-footer-grid">
          <div className="landing-footer-brand">
            <span className="landing-brand" aria-hidden="true">
              <span className="landing-brand-mark">
                <Server size={18} strokeWidth={2.25} />
              </span>
              <span className="landing-brand-text">
                <span className="landing-brand-name">FlexServer</span>
                <span className="landing-brand-sub">by FlexTechnology</span>
              </span>
            </span>
            <p className="landing-footer-tagline">
              A self-hosted dashboard for many servers in one place — resource
              tracking, Docker checks, and SSH jobs.
            </p>
          </div>
          <nav className="landing-footer-col" aria-label="Product">
            <p className="landing-footer-heading">Product</p>
            <a className="landing-footer-link" href="/#features">
              Features
            </a>
            <a className="landing-footer-link" href="/#audience">
              Who it is for
            </a>
            <a className="landing-footer-link" href="/#architecture">
              How it works
            </a>
            <a className="landing-footer-link" href="/#deploy">
              Deploy
            </a>
            <a
              className="landing-footer-link"
              href="/pricing"
              aria-current="page"
            >
              Pricing
            </a>
            <a className="landing-footer-link" href="/enterprise">
              Enterprise
            </a>
            <a
              className="landing-footer-link"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              GitHub repository
            </a>
          </nav>
          <nav className="landing-footer-col" aria-label="Support">
            <p className="landing-footer-heading">Support</p>
            <a className="landing-footer-link" href="/#faq">
              FAQ
            </a>
            <a
              className="landing-footer-link"
              href={ISSUES_URL}
              target="_blank"
              rel="noreferrer"
            >
              Report an issue
            </a>
            <a
              className="landing-footer-link"
              href={`mailto:${CONTACT_EMAIL}`}
            >
              {CONTACT_EMAIL}
            </a>
          </nav>
        </div>
        <div className="landing-wrap landing-footer-bottom">
          <p>© 2026 FlexTechnology. FlexServer — centralized VPS operations.</p>
        </div>
      </footer>
    </div>
  );
}
