# Release process

How TablePeek maintainers ship a new version. Versions follow [SemVer](https://semver.org), starting at v0.1.0. During 0.x, feature additions bump minor (0.1.0 → 0.2.0), and bug-fix-only releases bump patch (0.1.0 → 0.1.1).

## Where the version lives

| File | Contents |
|---|---|
| `Cargo.toml` `[workspace.package] version` | The single source. Every crate follows it with `version.workspace = true` |
| `web/package.json`, `web/package-lock.json` | Same number. `make check` (and CI) fails if they differ |
| `Cargo.lock` | Versions of the four workspace crates. `make version` updates them too |
| `CHANGELOG.md` | [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The `## [x.y.z] - YYYY-MM-DD` section becomes the release notes as is |

At build time the binary records the commit (`TABLEPEEK_COMMIT`) and the build kind (`TABLEPEEK_DIST`: `release` in the release workflow, `source` otherwise). `tablepeek --version` shows it like `tablepeek 0.1.0 (abc1234, release)`, and `GET /api/version` as `{version, commit, dist}`.

## 1. Bump the version

With `main` clean and CI passing:

```sh
make version V=0.2.0
```

This command does not touch git. It only does the following:

- Changes the version in `Cargo.toml`, `web/package.json`, and `web/package-lock.json`.
- Inserts an empty `## [0.2.0] - YYYY-MM-DD` section with today's date into `CHANGELOG.md` right below `[Unreleased]` (above the previous version's section), and fixes the comparison links at the bottom (`[Unreleased]`, `[0.2.0]`).
- Runs `cargo update --workspace --offline` to bring the workspace crate versions in `Cargo.lock` in line.

For a prerelease, append a suffix, as in `make version V=0.2.0-rc.1`. The tag becomes `v0.2.0-rc.1`, it is published on GitHub as a prerelease, and the app's new-version notice ignores it.

## 2. Fill in the CHANGELOG

Move the entries collected under `[Unreleased]` into the new section and sort them under the `Added` / `Changed` / `Fixed` / `Removed` / `Security` headings. Write only user-visible changes. If the section is empty, the release workflow fails at the first step. To check in advance:

```sh
node scripts/version.mjs notes 0.2.0     # contents that go into the release notes
make check                               # version match, format, build, type check
```

The date is the day you ran `make version`. If you tag on a different day, change the date in the heading to that day.

## 3. Commit and tag

```sh
git add Cargo.toml Cargo.lock web/package.json web/package-lock.json CHANGELOG.md
git commit -m "Release 0.2.0"
git push origin main
git tag -a v0.2.0 -m "TablePeek 0.2.0"
git push origin v0.2.0
```

Tag the release commit that is on `main`. If the version in the tag name differs from the one in `Cargo.toml`, the workflow stops immediately.

## 4. Check the workflow

Pushing the tag runs `.github/workflows/release.yml` (**Release** in the repository's Actions tab).

1. **Tag matches the version**: `node scripts/version.mjs tag v0.2.0` compares the tag with the version in the three files and checks that the CHANGELOG section exists.
2. **Web bundle**: builds `web/dist` once and passes it on as an artifact.
3. **Build <target>**: builds each of four platforms on its own runner with `TABLEPEEK_DIST=release cargo build --release --locked`, checks that `--version` is `tablepeek 0.2.0 (…, release)`, then packs it with `scripts/package.sh archive`. Intel Macs are not supported.

   | target | Runner | Archive |
   |---|---|---|
   | `aarch64-apple-darwin` | `macos-15` | `.tar.gz` |
   | `x86_64-unknown-linux-gnu` | `ubuntu-24.04` | `.tar.gz` |
   | `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` | `.tar.gz` |
   | `x86_64-pc-windows-msvc` | `windows-latest` | `.zip` |

   The file name is `tablepeek-v0.2.0-<target>.tar.gz` (`.zip` on Windows), and it contains a `tablepeek-v0.2.0-<target>/` folder with the binary, `README.md`, and `LICENSE` (AGPL-3.0). There is no signing or notarization.
4. **Desktop <target>**: bundles the desktop app (`crates/tablepeek-desktop`) on two runners with `TABLEPEEK_DIST=desktop` via `npx --yes @tauri-apps/cli@2.12.4 build --ci --target <target> --bundles …`, and `scripts/package.sh desktop` moves the results to release names. The version is taken as is from the workspace version in `Cargo.toml` (`tauri.conf.json` has no version).

   | target | Runner | Files |
   |---|---|---|
   | `aarch64-apple-darwin` | `macos-15` | `TablePeek-v0.2.0-<target>.dmg`, `TablePeek-v0.2.0-<target>.app.tar.gz` (+`.sig`) |
   | `x86_64-pc-windows-msvc` | `windows-latest` | `TablePeek-v0.2.0-<target>-setup.exe` (NSIS, +`.sig`) |

   There is no paid code signing. macOS gets only an ad-hoc signature (`signingIdentity: "-"`), and Windows is unsigned (first-run instructions for users are in the README). The updater bundles (`.app.tar.gz`, `-setup.exe`) are instead signed with the Tauri updater key (minisign) to produce `.sig` files. This step needs two repository secrets.

   | Secret | Value |
   |---|---|
   | `TAURI_SIGNING_PRIVATE_KEY` | The **contents** of the private key file (paste `~/.tauri/tablepeek-updater.key` as is) |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key password. The current key has an empty password, so you can leave it empty or not create it |

   The public key is in `plugins.updater.pubkey` of `crates/tablepeek-desktop/tauri.conf.json`. If the key is lost, already installed apps cannot receive new updates (the signature will not match), so back up the private key outside the repository. If the key changes, users have to download and install by hand once for releases from then on.
5. **Publish the release**: collects the archives and desktop files, creates `SHA256SUMS` (archives, `.dmg`, `.app.tar.gz`, `-setup.exe`), writes the updater manifest `latest.json` with `node scripts/latest-json.mjs v0.2.0 dist --notes notes.md` (version, notes, `pub_date`, and for each of `darwin-aarch64` and `windows-x86_64` the `.sig` contents and download URL), then runs `gh release create` with the CHANGELOG section as notes. Tags containing `-` are published as prereleases. The app reads `https://github.com/Extransload/TablePeek/releases/latest/download/latest.json`, so prereleases do not go out as app updates.
6. **Update the Homebrew cask**: runs only for stable tags (no `-`). From the Apple silicon `.dmg`, `node scripts/homebrew-cask.mjs v0.2.0 dist` writes the cask (version, `sha256`, `depends_on arch: :arm64`, and `postflight_steps` that clear quarantine after install), then commits and pushes it to `Casks/tablepeek.rb` in [Extransload/homebrew-tap](https://github.com/Extransload/homebrew-tap). It gets into the tap repository with this repository's secret `HOMEBREW_TAP_DEPLOY_KEY` (the private key of a deploy key with write access to the tap only). To change the key, create a new one with `ssh-keygen -t ed25519`, add the public key with `gh repo deploy-key add … -R Extransload/homebrew-tap --allow-write` and the private key with `gh secret set HOMEBREW_TAP_DEPLOY_KEY`, and delete the old deploy key. Users install with `brew install --cask extransload/tap/tablepeek`. The tap's `Check casks` workflow runs `brew style` and `brew audit --online` on the pushed cask.

When it finishes, check [Releases](https://github.com/Extransload/TablePeek/releases) for the four archives, one `.dmg`, `.app.tar.gz` and `-setup.exe` (each with `.sig`), `latest.json`, `SHA256SUMS`, and the notes; then download one archive and run `./tablepeek --version` and `./tablepeek serve`. Apps running an earlier version show a new-version notice within a day (Settings > General > **Check now** shows it right away). The desktop app downloads the new version by itself and shows **Restart to update** in the top bar; click it and check that the new version installs and reopens.

To run the same packaging steps locally in advance (current platform only):

```sh
make web
TABLEPEEK_DIST=release cargo build --release --locked -p tablepeek --target aarch64-apple-darwin
scripts/package.sh archive v0.2.0 aarch64-apple-darwin target/aarch64-apple-darwin/release/tablepeek /tmp/tp-dist
scripts/package.sh sums /tmp/tp-dist
node scripts/version.mjs notes 0.2.0
```

## 5. When it fails

**Failure before the build (tag mismatch, missing CHANGELOG).** No release has been created yet. Delete the tag and put it on the fixed commit.

```sh
git push origin :refs/tags/v0.2.0     # delete the remote tag
git tag -d v0.2.0                     # delete the local tag
# after committing the fix to main and pushing
git tag -a v0.2.0 -m "TablePeek 0.2.0"
git push origin v0.2.0
```

**One platform fails temporarily (runner problem, network).** Click **Re-run failed jobs** for that run in Actions. Once the failed build succeeds, the release step runs next.

**Build fails because of a code problem.** Delete the tag as above, land the fix on `main`, and put the same tag on the new commit. Nobody has downloaded the version yet, so reusing the number is fine.

**A problem is found after the release is published.** Someone may have downloaded it, so do not reuse the number. Fix it and ship a new patch version (0.2.1). Delete the bad release or add a warning to its notes.

**Only the release step failed and the release is half-created.** `gh release create` fails if a release for the same tag exists. Delete the leftover release (`gh release delete v0.2.0 --yes`, keeping the tag) and click **Re-run failed jobs** for that run.

## What only a pushed tag can verify

Locally you can only verify the current platform's build, packaging, checksums, notes extraction, and `actionlint`. The desktop app can be bundled on this Mac with `make desktop-bundle` (or `cd crates/tablepeek-desktop && npx --yes @tauri-apps/cli@2.12.4 build --debug --bundles app`), and updates can be tested by serving, from a local server, a build whose endpoint alone is changed with `--config '{"plugins":{"updater":{"endpoints":["http://127.0.0.1:<port>/latest.json"],"dangerousInsecureTransportProtocol":true}}}'` and a manifest made with `scripts/latest-json.mjs … --base-url http://127.0.0.1:<port> --platforms darwin-aarch64` (the app must run from a path that is not a symlink: `/private/tmp` instead of macOS's `/tmp`). The following can only be verified with a real tag: builds on the four runners (especially `ubuntu-24.04-arm`, and bash and `7z` packaging on Windows), Tauri builds on the two desktop runners (Windows NSIS, `.dmg` creation in CI), updater signing with Secrets, passing artifacts between jobs, `gh release create` permission (`contents: write`), whether a real update downloads from the `releases/latest/download/latest.json` path (including whether the Windows installer reopens the app), and the prerelease flag. For the first release (v0.1.0), watch the workflow to the end, and if it fails, delete and re-add the tag as described above. Later, for large changes, you can ship a prerelease first with `make version V=0.3.0-rc.1`.
