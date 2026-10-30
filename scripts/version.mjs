#!/usr/bin/env node
// TablePeek's version lives in the root Cargo.toml ([workspace.package]) and
// is repeated in web/package.json and web/package-lock.json. This script
// keeps them together and reads CHANGELOG.md for the release notes.
//
//   node scripts/version.mjs check          the three agree (exit 1 if not)
//   node scripts/version.mjs set 0.2.0      bump them, open a CHANGELOG section
//   node scripts/version.mjs tag v0.2.0     the tag names the current version
//   node scripts/version.mjs notes 0.2.0    print that version's CHANGELOG section
//
// No git commands are run; committing and tagging stay with the maintainer.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  cargo: join(root, "Cargo.toml"),
  pkg: join(root, "web", "package.json"),
  lock: join(root, "web", "package-lock.json"),
  changelog: join(root, "CHANGELOG.md"),
};
const REPO_URL = "https://github.com/Extransload/TablePeek";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(`version: ${message}`);
  process.exit(1);
}

// The `version = "..."` line inside [workspace.package], with its index.
function cargoVersionLine(lines) {
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inSection = header[1].trim() === "workspace.package";
      continue;
    }
    const m = inSection && lines[i].match(/^\s*version\s*=\s*"([^"]+)"/);
    if (m) return { index: i, version: m[1] };
  }
  fail("Cargo.toml has no version in [workspace.package]");
}

function readVersions() {
  const cargo = cargoVersionLine(readFileSync(paths.cargo, "utf8").split("\n")).version;
  const pkg = JSON.parse(readFileSync(paths.pkg, "utf8")).version;
  const lockJson = JSON.parse(readFileSync(paths.lock, "utf8"));
  const lock = lockJson.version;
  const lockRoot = lockJson.packages?.[""]?.version;
  return { cargo, pkg, lock, lockRoot };
}

function check() {
  const v = readVersions();
  const mismatched =
    v.pkg !== v.cargo || v.lock !== v.cargo || (v.lockRoot !== undefined && v.lockRoot !== v.cargo);
  if (mismatched) {
    fail(
      `versions differ: Cargo.toml ${v.cargo}, web/package.json ${v.pkg}, ` +
        `web/package-lock.json ${v.lock}/${v.lockRoot} (run make version V=${v.cargo})`,
    );
  }
  console.log(`version ${v.cargo} (Cargo.toml, web/package.json, web/package-lock.json agree)`);
}

// Replaces the first `"version": "..."` after `anchor` without reformatting
// the file, so the diff stays one line.
function replaceJsonVersion(text, anchor, version) {
  const start = anchor ? text.indexOf(anchor) : 0;
  if (start < 0) fail(`anchor ${anchor} not found`);
  const re = /"version":\s*"[^"]*"/g;
  re.lastIndex = start;
  const m = re.exec(text);
  if (!m) fail("no version field found");
  return text.slice(0, m.index) + `"version": "${version}"` + text.slice(m.index + m[0].length);
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function openChangelogSection(version) {
  const lines = readFileSync(paths.changelog, "utf8").split("\n");
  const heading = (line) => line.match(/^## \[([^\]]+)\]/);
  if (lines.some((l) => heading(l)?.[1] === version)) {
    fail(`CHANGELOG.md already has a section for ${version}`);
  }
  // The new section goes above the latest released one, leaving
  // [Unreleased] on top for the entries to be moved down by hand.
  const at = lines.findIndex((l) => heading(l) && heading(l)[1] !== "Unreleased");
  const previous = at >= 0 ? heading(lines[at])[1] : null;
  const section = [`## [${version}] - ${today()}`, ""];
  if (at >= 0) {
    lines.splice(at, 0, ...section);
  } else {
    lines.push("", ...section);
  }
  // Link references at the bottom: [Unreleased] compares from the new tag,
  // and the new version compares against the previous one.
  const unreleased = lines.findIndex((l) => l.startsWith("[Unreleased]: "));
  if (unreleased >= 0) {
    lines[unreleased] = `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD`;
    const link = previous
      ? `[${version}]: ${REPO_URL}/compare/v${previous}...v${version}`
      : `[${version}]: ${REPO_URL}/releases/tag/v${version}`;
    lines.splice(unreleased + 1, 0, link);
  }
  writeFileSync(paths.changelog, lines.join("\n"));
}

function set(version) {
  if (!SEMVER.test(version ?? "")) fail(`not a version: ${version ?? "(none)"} (expected x.y.z or x.y.z-rc.n)`);
  const cargoLines = readFileSync(paths.cargo, "utf8").split("\n");
  const { index, version: old } = cargoVersionLine(cargoLines);
  if (old === version) fail(`already at ${version}`);
  openChangelogSection(version);
  cargoLines[index] = cargoLines[index].replace(/"[^"]+"/, `"${version}"`);
  writeFileSync(paths.cargo, cargoLines.join("\n"));
  writeFileSync(paths.pkg, replaceJsonVersion(readFileSync(paths.pkg, "utf8"), null, version));
  let lock = readFileSync(paths.lock, "utf8");
  lock = replaceJsonVersion(lock, null, version);
  lock = replaceJsonVersion(lock, '"": {', version);
  writeFileSync(paths.lock, lock);
  console.log(`version ${old} -> ${version}; CHANGELOG.md has an empty [${version}] section to fill`);
}

function tag(name) {
  const version = (name ?? "").replace(/^refs\/tags\//, "");
  if (!/^v/.test(version) || !SEMVER.test(version.slice(1))) fail(`not a release tag: ${name ?? "(none)"} (expected vX.Y.Z)`);
  check();
  const { cargo } = readVersions();
  if (version.slice(1) !== cargo) fail(`tag ${version} does not match the workspace version ${cargo}`);
  console.log(`tag ${version} matches`);
}

function notes(version) {
  if (!version) fail("notes needs a version");
  const lines = readFileSync(paths.changelog, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) fail(`CHANGELOG.md has no section for ${version}`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line) || /^\[[^\]]+\]: /.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  if (!text) fail(`the CHANGELOG.md section for ${version} is empty`);
  process.stdout.write(text + "\n");
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case "check":
    check();
    break;
  case "set":
    set(arg);
    break;
  case "tag":
    tag(arg);
    break;
  case "notes":
    notes(arg);
    break;
  default:
    fail("usage: version.mjs check | set <x.y.z> | tag <vX.Y.Z> | notes <x.y.z>");
}
