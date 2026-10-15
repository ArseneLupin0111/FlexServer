import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkMarkdownFiles,
  slugifyHeading,
} from "../../../scripts/docs/check-links.mjs";

describe("check-links docs checker", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vps-docs-link-test-"));

    // 1. Target markdown file with various headings and explicit HTML IDs
    const targetMd = [
      "# First Section",
      "Content here.",
      "## Target Section",
      '<a name="legacy-name"></a>',
      '<h3 id="custom-id">Custom Subheading</h3>',
      "## Duplicate Title",
      "First duplicate body.",
      "## Duplicate Title",
      "Second duplicate body.",
      "## Duplicate Title",
      "Third duplicate body.",
      "## Local agent upgrades & operations",
      "Body here.",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "valid-target.md"), targetMd, "utf8");

    // 2. Dummy image asset
    fs.writeFileSync(path.join(tmpDir, "logo.png"), "dummy-png-bytes");

    // 3. Subfolder with spaces and percent-encoded candidates
    const subDir = path.join(tmpDir, "folder with spaces");
    fs.mkdirSync(subDir, { recursive: true });
    const encodedTargetMd = [
      "# Features & Options",
      "Detail content.",
      "## Simple Subheading",
    ].join("\n");
    fs.writeFileSync(path.join(subDir, "target doc.md"), encodedTargetMd, "utf8");
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports failure when link target path does not exist", () => {
    const fixturePath = path.join(tmpDir, "missing-path.md");
    fs.writeFileSync(
      fixturePath,
      [
        "# Test Missing Path",
        "[broken markdown link](nonexistent-file.md)",
        '<img src="missing-image.png" alt="Missing">',
        '<a href="missing-page.html">HTML broken</a>',
      ].join("\n"),
      "utf8"
    );

    const result = checkMarkdownFiles([fixturePath], { repoRoot: tmpDir });
    expect(result.totalErrors).toBe(3);
    expect(result.filesWithErrors).toBe(1);
    expect(result.failures[0].reason).toContain("Target path does not exist");
    expect(result.failures[1].reason).toContain("Target path does not exist");
    expect(result.failures[2].reason).toContain("Target path does not exist");
  });

  it("reports failure when heading anchor is missing in markdown target", () => {
    const fixturePath = path.join(tmpDir, "missing-heading.md");
    fs.writeFileSync(
      fixturePath,
      [
        "# Local Test",
        "[valid link with missing anchor](valid-target.md#absent-heading)",
        "[missing local anchor](#nonexistent-local-heading)",
      ].join("\n"),
      "utf8"
    );

    const result = checkMarkdownFiles([fixturePath], { repoRoot: tmpDir });
    expect(result.totalErrors).toBe(2);
    expect(result.failures[0].reason).toContain("Heading anchor not found: #absent-heading");
    expect(result.failures[1].reason).toContain("Heading anchor not found: #nonexistent-local-heading");
  });

  it("validates nested markdown image links and HTML href/src tags", () => {
    const fixturePath = path.join(tmpDir, "valid-nested.md");
    fs.writeFileSync(
      fixturePath,
      [
        "# Valid Nested Test",
        // Nested markdown image inside markdown link
        "[![FlexServer logo](logo.png)](valid-target.md#target-section)",
        // HTML anchor wrapping an image tag
        '<a href="valid-target.md#custom-id"><img src="logo.png" alt="logo"></a>',
        // HTML legacy name anchor
        '<a href="valid-target.md#legacy-name">Legacy Link</a>',
        // Top-of-page bare hash
        "[Back to top](#)",
      ].join("\n"),
      "utf8"
    );

    const result = checkMarkdownFiles([fixturePath], { repoRoot: tmpDir });
    expect(result.totalErrors).toBe(0);
    expect(result.totalLinks).toBe(6); // 1 md img + 1 md link + 2 html hrefs + 1 html img src + 1 bare hash
  });

  it("resolves duplicate heading slugs with GitHub-style numeric suffixes and avoids collision with natural headings", () => {
    const collisionMd = [
      "# Item",
      "# Item-1",
      "# Item",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "dup-target.md"), collisionMd, "utf8");

    const fixturePath = path.join(tmpDir, "duplicate-headings.md");
    fs.writeFileSync(
      fixturePath,
      [
        "# Duplicate Headings Test",
        "[first duplicate](dup-target.md#item)",
        "[natural suffix](dup-target.md#item-1)",
        "[collision avoided duplicate](dup-target.md#item-2)",
        "[fourth missing](dup-target.md#item-3)",
      ].join("\n"),
      "utf8"
    );

    const result = checkMarkdownFiles([fixturePath], { repoRoot: tmpDir });
    expect(result.totalErrors).toBe(1);
    expect(result.failures[0].target).toBe("dup-target.md#item-3");
    expect(result.failures[0].reason).toContain("Heading anchor not found: #item-3");
  });

  it("handles percent-encoded paths and headings including '&' double-hyphen slugs", () => {
    const fixturePath = path.join(tmpDir, "percent-encoded.md");
    fs.writeFileSync(
      fixturePath,
      [
        "# Percent Encoded Test",
        // Percent-encoded directory and filename with double-hyphen '&' heading slug
        "[encoded path](folder%20with%20spaces/target%20doc.md#features--options)",
        // Percent-encoded heading hash (%2D is '-')
        "[encoded slug](folder%20with%20spaces/target%20doc.md#features%2D%2Doptions)",
        // Target in root with '&' double hyphen
        "[upgrades and operations](valid-target.md#local-agent-upgrades--operations)",
        // Invalid anchor in encoded path
        "[invalid anchor](folder%20with%20spaces/target%20doc.md#missing-slug)",
      ].join("\n"),
      "utf8"
    );

    const result = checkMarkdownFiles([fixturePath], { repoRoot: tmpDir });
    expect(result.totalErrors).toBe(1);
    expect(result.failures[0].reason).toContain("Heading anchor not found: #missing-slug");
  });
  it("rejects collapsed-hyphen aliases for '&' headings", () => {
    const fixturePath = path.join(tmpDir, "double-hyphen-rejection.md");
    fs.writeFileSync(
      fixturePath,
      [
        "# Double Hyphen Strictness Test",
        "[valid double hyphen](valid-target.md#local-agent-upgrades--operations)",
        "[invalid collapsed alias](valid-target.md#local-agent-upgrades-operations)",
      ].join("\n"),
      "utf8"
    );

    const result = checkMarkdownFiles([fixturePath], { repoRoot: tmpDir });
    expect(result.totalErrors).toBe(1);
    expect(result.failures[0].target).toBe("valid-target.md#local-agent-upgrades-operations");
    expect(result.failures[0].reason).toContain(
      "Heading anchor not found: #local-agent-upgrades-operations"
    );
  });

  it("ignores code fences and inline code examples", () => {
    const fixturePath = path.join(tmpDir, "code-fences.md");
    fs.writeFileSync(
      fixturePath,
      [
        "# Code Fences Test",
        "```markdown",
        "[broken code link](completely-nonexistent-file.md#nowhere)",
        '<a href="also-fake.html">Fake</a>',
        "```",
        "Here is inline code: `[inline broken](fake.md)` and `<img src=\"missing.png\">`.",
        "And valid link: [valid target](valid-target.md)",
      ].join("\n"),
      "utf8"
    );

    const result = checkMarkdownFiles([fixturePath], { repoRoot: tmpDir });
    expect(result.totalErrors).toBe(0);
    expect(result.totalLinks).toBe(1);
  });

  it("slugifies headings conforming to GFM punctuation stripping and space conversion", () => {
    expect(slugifyHeading("Quick start")).toBe("quick-start");
    expect(slugifyHeading("Features & Options")).toBe("features--options");
    expect(slugifyHeading("What's new? (v2.0!)")).toBe("whats-new-v20");
    expect(slugifyHeading("Heading with `inline code` and **bold**")).toBe("heading-with-inline-code-and-bold");
  });
});
