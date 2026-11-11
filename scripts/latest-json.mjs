#!/usr/bin/env node
// The manifest the desktop app's updater reads, latest.json, written next to
// the release's desktop assets (scripts/package.sh desktop names them). The
// app asks for it at
// https://github.com/Extransload/TablePeek/releases/latest/download/latest.json,
// so it always describes the newest stable release.
//
//   node scripts/latest-json.mjs <tag> <dir> [--notes <file>] [--base-url <url>] [--platforms <list>]
//
// Each platform's entry holds the signature the build made (<asset>.sig,
// minisign, checked against the public key in tauri.conf.json) and where its
// asset is downloaded from: the release's download URL unless --base-url
// names another place (a local server, to try an update out). Every
// platform is required unless --platforms lists the ones to include.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_URL = "https://github.com/Extransload/TablePeek";
// The updater's platform keys and the asset each one installs.
const PLATFORMS = {
  "darwin-aarch64": (tag) => `TablePeek-${tag}-aarch64-apple-darwin.app.tar.gz`,
  "windows-x86_64": (tag) => `TablePeek-${tag}-x86_64-pc-windows-msvc-setup.exe`,
};

function fail(message) {
  console.error(`latest-json: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = [];
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    if (i + 1 >= args.length) fail(`${args[i]} needs a value`);
    options[args[i].slice(2)] = args[++i];
  } else {
    positional.push(args[i]);
  }
}
const [tag, dir] = positional;
if (!tag || !dir || positional.length > 2) {
  fail("usage: latest-json.mjs <tag> <dir> [--notes <file>] [--base-url <url>] [--platforms <list>]");
}
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) fail(`not a release tag: ${tag}`);
for (const name of Object.keys(options)) {
  if (!["notes", "base-url", "platforms"].includes(name)) fail(`unknown option --${name}`);
}

const keys = options.platforms ? options.platforms.split(",").map((key) => key.trim()) : Object.keys(PLATFORMS);
const baseUrl = (options["base-url"] ?? `${REPO_URL}/releases/download/${tag}`).replace(/\/+$/, "");
const platforms = {};
for (const key of keys) {
  const asset = PLATFORMS[key]?.(tag);
  if (!asset) fail(`unknown platform ${key} (known: ${Object.keys(PLATFORMS).join(", ")})`);
  if (!existsSync(join(dir, asset))) fail(`${asset} is missing from ${dir}`);
  const signature = join(dir, `${asset}.sig`);
  if (!existsSync(signature)) fail(`${asset}.sig is missing from ${dir}`);
  platforms[key] = {
    signature: readFileSync(signature, "utf8").trim(),
    url: `${baseUrl}/${encodeURIComponent(asset)}`,
  };
}

const manifest = {
  version: tag.slice(1),
  notes: options.notes ? readFileSync(options.notes, "utf8").trim() : "",
  // RFC 3339 without the milliseconds.
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms,
};
const text = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(dir, "latest.json"), text);
process.stdout.write(text);
