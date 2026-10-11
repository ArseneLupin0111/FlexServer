import mark from "../assets/brand/flexserver-mark.webp";
import wordmark from "../assets/brand/flexserver-wordmark.webp";
import "./brand.css";

export function BrandMark() {
  return <img className="brand-mark" src={mark} width={256} height={246} alt="FlexServer logo" />;
}

export function Brand() {
  return <>
    <BrandMark />
    <span className="landing-brand-text">
      <span className="landing-brand-name">FlexServer</span>
      <span className="landing-brand-sub">by FlexTechnology</span>
    </span>
  </>;
}

export function FooterBrand() {
  return <a className="brand-footer-link" href="/" aria-label="FlexServer — home">
    <span className="brand-wordmark-surface">
      <img className="brand-wordmark" src={wordmark} width={960} height={216} alt="FlexServer" loading="lazy" />
    </span>
    <span className="landing-brand-sub">by FlexTechnology</span>
  </a>;
}
