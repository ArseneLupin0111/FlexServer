#!/usr/bin/env node

/**
 * scripts/docs/check-links.mjs
 *
 * Validates local Markdown links, images, HTML references, and heading anchors.
 * Defaults to README.md in repository root. Accepts optional positional Markdown file paths.
 *
 * Zero external dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function findRepoRoot(startDir = fileURLToPath(new URL(".", import.meta.url))) {
  let curr = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(curr, "package.json"))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(curr, "package.json"), "utf8"));
        if (pkg.name === "vps-manager-nodejs" || fs.existsSync(path.join(curr, ".git"))) {
          return curr;
        }
      } catch {
        // continue walking up
      }
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
}

export function isExternal(target) {
  if (!target) return true;
  const trimmed = target.trim();
  if (trimmed.startsWith("//")) return true;
  // Windows absolute paths (e.g. C:\ or C:/) are local, not a scheme
  if (/^[a-zA-Z]:[/\\]/.test(trimmed)) return false;
  // Standard URI schemes (http:, https:, mailto:, ftp:, data:, javascript:, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return true;
  return false;
}

export function maskCode(content) {
  // 1. Mask fenced code blocks (``` or ~~~), preserving line breaks for accurate line numbers
  let masked = content.replace(
    /(^|\n)([ \t]*)(`{3,}|~{3,})([^\n]*\n)([\s\S]*?)(\n\2\3\s*(?:\n|$))/g,
    (match, prefix, indent, fence, info, body, closing) => {
      return prefix + indent + fence + info + body.replace(/[^\n]/g, " ") + closing;
    }
  );

  // 2. Mask HTML comments <!-- ... -->
  masked = masked.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, " "));

  // 3. Mask inline code: `...` or ``...``
  masked = masked.replace(/(`+)([\s\S]*?)\1/g, (match, fence, body) => {
    if (!body.includes("\n\n")) {
      return fence + body.replace(/[^\n]/g, " ") + fence;
    }
    return match;
  });

  return masked;
}

export function slugifyHeading(text) {
  // Strip HTML tags
  let clean = text.replace(/<[^>]+>/g, "");
  // Strip markdown images: ![alt](url) -> alt
  clean = clean.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  // Strip markdown links: [text](url) -> text
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Strip inline code backticks: `code` -> code
  clean = clean.replace(/`([^`]+)`/g, "$1");
  // Strip bold/italic/strikethrough markers
  clean = clean.replace(/[*_~]/g, "");

  clean = clean.trim().toLowerCase();

  // GitHub Flavored Markdown punctuation stripping:
  // Strip Unicode punctuation and symbols, preserving letters, marks, numbers,
  // connector punctuation (_), hyphens (-), and spaces ( ).
  // Punctuation like '&' is stripped to empty string, leaving surrounding spaces intact.
  clean = clean.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "");

  // Convert each space to a hyphen (e.g. "foo  bar" from "foo & bar" becomes "foo--bar")
  clean = clean.replace(/ /g, "-");

  // Strip leading and trailing hyphens
  clean = clean.replace(/^-+|-+$/g, "");

  return clean;
}

export function extractAnchorsFromMarkdown(content) {
  const anchors = new Set();
  const slugCounts = new Map();

  const masked = maskCode(content);

  // 1. Explicit HTML id / name attributes (e.g. <a name="custom">, <h2 id="custom">, <div id="foo">)
  const htmlAnchorRe = /<[a-zA-Z][a-zA-Z0-9:-]*\b[^>]*?\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let htmlMatch;
  while ((htmlMatch = htmlAnchorRe.exec(masked)) !== null) {
    const id = htmlMatch[1] || htmlMatch[2] || htmlMatch[3];
    if (id) {
      anchors.add(id);
      anchors.add(id.toLowerCase());
    }
  }

  function registerHeading(rawText) {
    const baseSlug = slugifyHeading(rawText);
    if (!baseSlug) return;

    let finalSlug = baseSlug;
    let count = slugCounts.get(baseSlug) || 0;
    while (anchors.has(finalSlug)) {
      count++;
      finalSlug = `${baseSlug}-${count}`;
    }
    slugCounts.set(baseSlug, count);
    anchors.add(finalSlug);
  }

  // 2. HTML heading tags: <h1>...</h1> to <h6>...</h6>
  const htmlHeadingRe = /<(h[1-6])\b[^>]*>(.*?)<\/\1>/gi;
  let hTagMatch;
  while ((hTagMatch = htmlHeadingRe.exec(masked)) !== null) {
    registerHeading(hTagMatch[2]);
  }

  // 3. ATX headings: # Heading through ###### Heading
  const atxHeadingRe = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/gm;
  let atxMatch;
  while ((atxMatch = atxHeadingRe.exec(masked)) !== null) {
    registerHeading(atxMatch[2]);
  }

  // 4. Setext headings:
  // Heading text followed by === or ---
  const setextHeadingRe = /^([^\n#`~<][^\n]*)\n([=-]{3,})\s*$/gm;
  let setextMatch;
  while ((setextMatch = setextHeadingRe.exec(masked)) !== null) {
    registerHeading(setextMatch[1]);
  }

  return anchors;
}

function getLineNumber(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

export function extractLinks(rawContent) {
  const links = [];
  const masked = maskCode(rawContent);

  // 1. Markdown images: ![alt](target)
  const mdImageRe = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:["'][^"']*["']|\([^)]*\)))?\s*\)/g;
  let imgMatch;
  while ((imgMatch = mdImageRe.exec(masked)) !== null) {
    let target = imgMatch[2];
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    links.push({
      type: "markdown-image",
      text: imgMatch[1],
      target,
      index: imgMatch.index,
      line: getLineNumber(rawContent, imgMatch.index),
    });
  }

  // 2. Markdown links: [text](target), allowing nested images [![alt](img)](link)
  const mdLinkRe = /(?<!\!)\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:["'][^"']*["']|\([^)]*\)))?\s*\)/g;
  let linkMatch;
  while ((linkMatch = mdLinkRe.exec(masked)) !== null) {
    let target = linkMatch[2];
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    links.push({
      type: "markdown-link",
      text: linkMatch[1],
      target,
      index: linkMatch.index,
      line: getLineNumber(rawContent, linkMatch.index),
    });
  }

  // 3. HTML href and src attributes: <tag href="..."> and <tag src="...">
  const htmlTagRe = /<([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*)>/g;
  let tagMatch;
  while ((tagMatch = htmlTagRe.exec(masked)) !== null) {
    const tagName = tagMatch[1].toLowerCase();
    const attrs = tagMatch[2];
    const tagIndex = tagMatch.index;

    const attrRe = /\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let attrMatch;
    while ((attrMatch = attrRe.exec(attrs)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      const target = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
      const attrOffset = tagIndex + tagMatch[0].indexOf(attrMatch[0]);

      links.push({
        type: `html-${tagName}-${attrName}`,
        text: `<${tagName} ${attrName}="...">`,
        target,
        index: attrOffset,
        line: getLineNumber(rawContent, attrOffset),
      });
    }
  }

  return links;
}

export function validateLink(target, sourceFilePath, repoRoot, getAnchors) {
  if (typeof target !== "string" || target.trim() === "") {
    return { valid: false, reason: "Empty link target" };
  }

  let rawPath = target.trim();
  let rawHash = null;

  const hashIdx = rawPath.indexOf("#");
  if (hashIdx !== -1) {
    rawHash = rawPath.slice(hashIdx + 1);
    rawPath = rawPath.slice(0, hashIdx);
  }

  // Strip query string if present
  const queryIdx = rawPath.indexOf("?");
  if (queryIdx !== -1) {
    rawPath = rawPath.slice(0, queryIdx);
  }

  // Decode URI components
  let decodedPath = "";
  if (rawPath) {
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      decodedPath = rawPath;
    }
  }

  let decodedHash = null;
  if (rawHash !== null) {
    try {
      decodedHash = decodeURIComponent(rawHash);
    } catch {
      decodedHash = rawHash;
    }
  }

  // Resolve target file path
  let targetFilePath;
  if (!decodedPath) {
    // Current file anchor
    targetFilePath = sourceFilePath;
  } else if (decodedPath.startsWith("/")) {
    // Slash path relative to repository root
    targetFilePath = path.resolve(repoRoot, "." + decodedPath);
  } else {
    // Local path relative to source file directory
    targetFilePath = path.resolve(path.dirname(sourceFilePath), decodedPath);
  }

  // Check file/dir existence
  if (!fs.existsSync(targetFilePath)) {
    return {
      valid: false,
      reason: `Target path does not exist: ${decodedPath || targetFilePath}`,
    };
  }

  // Check anchor if present and non-empty (bare '#' points to top of page, always valid)
  if (decodedHash !== null && decodedHash !== "") {
    let checkAnchorFile = targetFilePath;
    try {
      const stat = fs.statSync(targetFilePath);
      if (stat.isDirectory()) {
        const readmePath = path.join(targetFilePath, "README.md");
        if (fs.existsSync(readmePath)) {
          checkAnchorFile = readmePath;
        }
      }
    } catch {
      // Ignore stat failures; handled below
    }

    if (/\.(md|markdown|mdx)$/i.test(checkAnchorFile)) {
      const anchors = getAnchors(checkAnchorFile);
      const decodedHashLower = decodedHash.toLowerCase();
      const matches =
        anchors.has(decodedHash) ||
        anchors.has(decodedHashLower);
      if (!matches) {
        const relTarget = path.relative(repoRoot, checkAnchorFile) || path.basename(checkAnchorFile);
        return {
          valid: false,
          reason: `Heading anchor not found: #${decodedHash} in ${relTarget}`,
        };
      }
    }
  }

  return { valid: true };
}

export function checkMarkdownFiles(files, { repoRoot = findRepoRoot() } = {}) {
  const markdownAnchorsCache = new Map();

  function getAnchors(filePath) {
    const normalized = path.resolve(filePath);
    if (markdownAnchorsCache.has(normalized)) {
      return markdownAnchorsCache.get(normalized);
    }
    if (!fs.existsSync(normalized)) {
      return new Set();
    }
    try {
      const content = fs.readFileSync(normalized, "utf8");
      const anchors = extractAnchorsFromMarkdown(content);
      markdownAnchorsCache.set(normalized, anchors);
      return anchors;
    } catch {
      return new Set();
    }
  }

  const failures = [];
  let totalLinks = 0;

  for (const file of files) {
    const absPath = path.resolve(file);
    const displaySource = path.relative(repoRoot, absPath) || path.basename(absPath);

    if (!fs.existsSync(absPath)) {
      failures.push({
        sourceFile: absPath,
        displaySource,
        line: 1,
        type: "file-not-found",
        target: file,
        rawLink: file,
        reason: `Input file does not exist: ${file}`,
      });
      continue;
    }

    const content = fs.readFileSync(absPath, "utf8");
    const links = extractLinks(content);

    for (const link of links) {
      if (isExternal(link.target)) {
        continue;
      }

      totalLinks++;
      const validation = validateLink(link.target, absPath, repoRoot, getAnchors);
      if (!validation.valid) {
        failures.push({
          sourceFile: absPath,
          displaySource,
          line: link.line,
          type: link.type,
          target: link.target,
          rawLink: link.type.startsWith("html-") ? link.text : `[${link.text}](${link.target})`,
          reason: validation.reason,
        });
      }
    }
  }

  const filesWithErrors = new Set(failures.map((f) => f.sourceFile)).size;

  return {
    totalFiles: files.length,
    totalLinks,
    totalErrors: failures.length,
    filesWithErrors,
    failures,
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  let rootDir = null;
  const files = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/docs/check-links.mjs [--root <dir>] [file1.md file2.md ...]

Validates local links and heading anchors in Markdown files.
Defaults to README.md in the repository root if no paths are provided.

Options:
  --root <dir>   Explicit repository root directory (defaults to auto-detected root)
  -h, --help     Show this help message
`);
      process.exit(0);
    } else if (arg === "--root") {
      rootDir = path.resolve(argv[++i]);
    } else if (arg.startsWith("--root=")) {
      rootDir = path.resolve(arg.slice("--root=".length));
    } else if (arg.startsWith("-")) {
      console.error(`check-docs: unrecognized flag: ${arg}`);
      process.exit(1);
    } else {
      files.push(arg);
    }
  }

  const repoRoot = rootDir || findRepoRoot();
  const targetFiles =
    files.length > 0
      ? files.map((f) => path.resolve(process.cwd(), f))
      : [path.join(repoRoot, "README.md")];

  const results = checkMarkdownFiles(targetFiles, { repoRoot });

  if (results.totalErrors > 0) {
    process.exitCode = 1;
    console.error(
      `\ncheck-docs: FAIL — ${results.totalErrors} broken link(s) found in ${results.filesWithErrors} file(s):\n`
    );
    for (const failure of results.failures) {
      console.error(`  ${failure.displaySource}:${failure.line}: ${failure.rawLink} -> ${failure.reason}`);
    }
    console.error("");
    process.exit(1);
  } else {
    process.exitCode = 0;
    console.log(
      `check-docs: PASS — checked ${results.totalFiles} file(s), ${results.totalLinks} link(s) verified.`
    );
  }
}

const isMainModule =
  process.argv[1] &&
  (path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase() ||
    process.argv[1].endsWith("check-links.mjs"));

if (isMainModule) {
  runCli().catch((err) => {
    process.exitCode = 1;
    console.error(`check-docs error: ${err.message}`);
    process.exit(1);
  });
}
