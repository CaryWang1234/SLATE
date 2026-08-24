#!/usr/bin/env node
/**
 * Frontend integrity guard for SLATE.
 *
 * This is intentionally build-free: it does not bundle or transform sources.
 * It only scans the native HTML/CSS/ES module frontend for the failure modes
 * that previously broke interaction: malformed HTML fragments, mojibake, stale
 * cache versions, and JavaScript parse errors.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const errors = [];
const warnings = [];

function fail(file, line, message, sample = "") {
  const loc = line ? `${file}:${line}` : file;
  errors.push(`${loc} ${message}${sample ? `\n  ${sample}` : ""}`);
}

function warn(file, line, message, sample = "") {
  const loc = line ? `${file}:${line}` : file;
  warnings.push(`${loc} ${message}${sample ? `\n  ${sample}` : ""}`);
}

function readUtf8(file) {
  return readFileSync(path.join(root, file), "utf8");
}

function rgFiles(args) {
  const rg = spawnSync("rg", args, { cwd: root, encoding: "utf8" });
  if (rg.status !== 0 && !rg.stdout) return [];
  return rg.stdout.split(/\r?\n/).filter(Boolean);
}

const frontendFiles = rgFiles(["--files", "frontend"]);
const jsFiles = frontendFiles.filter(f => f.endsWith(".js"));
const htmlFiles = frontendFiles.filter(f => f.endsWith(".html"));
const cssFiles = frontendFiles.filter(f => f.endsWith(".css"));
const textFrontendFiles = frontendFiles.filter(f => /\.(html|js|css)$/i.test(f));

if (!frontendFiles.length) fail("frontend", 0, "no frontend files found; run from repo root");

function lineColFromOffset(text, offset) {
  const before = text.slice(0, offset).split(/\r?\n/);
  return { line: before.length, col: before[before.length - 1].length + 1 };
}

function checkBrokenHtmlFragments(file, text) {
  const tags = ["button", "span", "option", "div", "p", "h1", "h2", "h3", "label", "section", "aside", "small", "select", "textarea"];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const tag of tags) {
      const needle = `/${tag}>`;
      let pos = line.indexOf(needle);
      while (pos !== -1) {
        if (pos === 0 || line[pos - 1] !== "<") {
          fail(file, idx + 1, `probable naked closing tag fragment "${needle}"`, line.trim());
          break;
        }
        pos = line.indexOf(needle, pos + needle.length);
      }
    }
    if (/title="[^"]*\btype="button/.test(line)) {
      fail(file, idx + 1, "button attribute appears swallowed by an unterminated title", line.trim());
    }
  });
}

function checkMojibake(file, text) {
  const patterns = [
    /[\uFFFD]/,
    /[锛绛涓鍚棣閫鈥]{2,}/,
    /首(?:\/|const |function |if |for |return |JSON|HTML|Agent|API|MCP|max_tokens|diff)/,
  ];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (patterns.some(re => re.test(line))) {
      warn(file, idx + 1, "possible mojibake or corrupted text", line.trim());
    }
  });
}

function checkHtmlBalance(file, text) {
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const stack = [];
  const stripped = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  const tagRe = /<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*)?>/g;
  let m;
  while ((m = tagRe.exec(stripped))) {
    const raw = m[0];
    const tag = m[1].toLowerCase();
    if (raw.startsWith("<!") || raw.endsWith("/>") || voidTags.has(tag)) continue;
    const pos = lineColFromOffset(stripped, m.index);
    if (!raw.startsWith("</")) {
      stack.push({ tag, line: pos.line, raw });
      continue;
    }
    const last = stack.pop();
    if (!last || last.tag !== tag) {
      fail(file, pos.line, `unbalanced HTML tag, expected </${last?.tag || "none"}> but found </${tag}>`, raw);
      return;
    }
  }
  for (const item of stack.slice(-5)) {
    fail(file, item.line, `unclosed HTML tag <${item.tag}>`, item.raw);
  }
}

function checkCacheVersions() {
  const versionRe = /\?v=(\d{8}-\d+)/g;
  const versions = new Map();
  for (const file of [...htmlFiles, ...jsFiles, ...cssFiles]) {
    const text = readUtf8(file);
    let m;
    while ((m = versionRe.exec(text))) {
      const list = versions.get(m[1]) || [];
      list.push(file);
      versions.set(m[1], list);
    }
  }
  if (versions.size > 1) {
    const detail = [...versions.entries()]
      .map(([v, files]) => `${v}: ${[...new Set(files)].slice(0, 6).join(", ")}`)
      .join("\n  ");
    fail("frontend", 0, "mixed cache-buster versions found; bump frontend versions consistently", detail);
  }
}

function bin(cmd) {
  return process.platform === "win32" ? `${cmd}.cmd` : cmd;
}

function commandExists(cmd, args = ["--version"]) {
  const res = process.platform === "win32"
    ? spawnSync([cmd, ...args].map(quoteShellArg).join(" "), { cwd: root, encoding: "utf8", shell: true, timeout: 5000 })
    : spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell: false, timeout: 5000 });
  return !res.error && res.status === 0;
}

function quoteShellArg(value) {
  const s = String(value);
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function checkJsSyntax() {
  if (!jsFiles.length) return;

  const npx = bin("npx");
  const node = process.execPath;

  const checkWithNode = () => {
    if (!existsSync(node)) return false;
    for (const file of jsFiles) {
      try {
        execFileSync(node, ["--check", file], { cwd: root, encoding: "utf8", stdio: "pipe", timeout: 5000 });
      } catch (err) {
        fail(file, 0, "JavaScript syntax check failed via node --check", String(err.stderr || err.message).trim());
      }
    }
    return true;
  };

  if (commandExists(npx, ["--version"])) {
    const acornArgs = ["--yes", "acorn", "--silent", "--module", "--ecma2022", ...jsFiles];
    const res = process.platform === "win32"
      ? spawnSync([npx, ...acornArgs].map(quoteShellArg).join(" "), {
        cwd: root,
        encoding: "utf8",
        shell: true,
        maxBuffer: 1024 * 1024 * 20,
        timeout: 15000,
      })
      : spawnSync(npx, acornArgs, {
        cwd: root,
        encoding: "utf8",
        shell: false,
        maxBuffer: 1024 * 1024 * 20,
        timeout: 15000,
      });
    if (res.error?.code === "ETIMEDOUT") {
      warn("frontend/js", 0, "acorn syntax check timed out; fell back to node --check");
      if (checkWithNode()) return;
    }
    if (res.status !== 0) {
      fail("frontend/js", 0, "ES module syntax check failed via acorn", (res.stderr || res.stdout || "").trim());
    }
    return;
  }

  if (checkWithNode()) {
    warn("frontend/js", 0, "npx was not available; fell back to node --check, which is weaker for ES modules");
    return;
  }

  warn("frontend/js", 0, "Node.js/npx not available; skipped JavaScript parse check");
}

for (const file of textFrontendFiles) {
  const text = readUtf8(file);
  checkBrokenHtmlFragments(file, text);
  checkMojibake(file, text);
}

for (const file of htmlFiles) {
  checkHtmlBalance(file, readUtf8(file));
}

checkCacheVersions();
checkJsSyntax();

if (warnings.length) {
  console.log("Frontend integrity warnings:");
  for (const item of warnings) console.log(`- ${item}`);
  console.log("");
}

if (errors.length) {
  console.error("Frontend integrity check failed:");
  for (const item of errors) console.error(`- ${item}`);
  process.exit(1);
}

console.log(`Frontend integrity check passed (${htmlFiles.length} HTML, ${jsFiles.length} JS, ${cssFiles.length} CSS files).`);
process.exit(0);
