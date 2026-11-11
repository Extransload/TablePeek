#!/usr/bin/env node
// The Homebrew cask for the desktop app, Casks/tablepeek.rb in the
// Extransload/homebrew-tap repository, written from a release's Apple
// silicon disk image (scripts/package.sh desktop names it); TablePeek has no
// Intel Mac build. The release workflow pushes it to the tap after each
// stable release:
//
//   brew install --cask extransload/tap/tablepeek
//
//   node scripts/homebrew-cask.mjs <tag> <dir> [--base-url <url>]
//
// The cask downloads the disk image from the release unless --base-url
// names another place (a local folder as file:///…, to try the cask out).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_URL = "https://github.com/Extransload/TablePeek";
// The disk image the cask installs.
const IMAGE = (tag) => `TablePeek-${tag}-aarch64-apple-darwin.dmg`;

function fail(message) {
  console.error(`homebrew-cask: ${message}`);
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
  fail("usage: homebrew-cask.mjs <tag> <dir> [--base-url <url>]");
}
// Prereleases stay out of the tap: it follows the latest stable release.
if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`not a stable release tag: ${tag}`);
for (const name of Object.keys(options)) {
  if (name !== "base-url") fail(`unknown option --${name}`);
}

const version = tag.slice(1);
const image = join(dir, IMAGE(tag));
if (!existsSync(image)) fail(`${image} is missing`);
const sha256 = createHash("sha256").update(readFileSync(image)).digest("hex");
// The cask's own interpolation, so `brew bump-cask-pr`-style edits of the
// version alone would still point at the right files.
const baseUrl = (options["base-url"] ?? `${REPO_URL}/releases/download/v#{version}`).replace(/\/+$/, "");

process.stdout.write(`# Written by scripts/homebrew-cask.mjs in ${REPO_URL} on each
# stable release; edits here are replaced by the next one.
cask "tablepeek" do
  version "${version}"
  sha256 "${sha256}"

  url "${baseUrl}/${IMAGE("v#{version}")}"
  name "TablePeek"
  desc "Local-first database client"
  homepage "${REPO_URL}"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app installs its own updates (Settings > General).
  auto_updates true
  depends_on arch: :arm64
  depends_on :macos

  app "TablePeek.app"

  # The app carries an ad-hoc signature only, no Developer ID: without the
  # download quarantine Gatekeeper lets it open.
  postflight_steps do
    run "/usr/bin/xattr",
        args:         ["-dr", "com.apple.quarantine", "{{appdir}}/TablePeek.app"],
        must_succeed: false
  end

  uninstall quit: "io.github.extransload.tablepeek"

  # ~/.tablepeek stays: the command-line tablepeek shares its connections
  # and history.
  zap trash: [
    "~/Library/Caches/io.github.extransload.tablepeek",
    "~/Library/WebKit/io.github.extransload.tablepeek",
  ]
end
`);
