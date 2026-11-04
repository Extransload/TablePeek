# Installing TablePeek

TablePeek comes as a **desktop app** (macOS, Windows) and as a **command-line binary** (macOS, Linux, Windows) that serves the same UI to your browser. Both are on [GitHub Releases](https://github.com/Extransload/TablePeek/releases), or you can [build from source](DEVELOPMENT.md#build-from-source). SQLite is bundled and TLS uses rustls, so there is no OpenSSL or database client library to install.

The app and the command line keep everything in the same places: connections, history and UI state in `~/.tablepeek`, passwords in the OS keychain. You can switch between them freely.

- [Desktop app](#desktop-app-macos-windows)
- [Command-line binary](#command-line-binary)
- [Updating](#updating)
- [Update check](#update-check)

## Desktop app (macOS, Windows)

The desktop app is TablePeek in its own window instead of a browser tab. It starts the server inside the app (on a free `127.0.0.1` port, with a fresh token each launch) and stops it when you quit. It ships from v0.2.0.

### macOS with Homebrew

```sh
brew install --cask extransload/tap/tablepeek
```

The cask picks the disk image for your Mac and clears the download quarantine, so the app opens without a Gatekeeper prompt. Each stable release updates the cask. The app also updates itself, so `brew upgrade` leaves it alone unless you pass `--greedy`. `brew uninstall --zap --cask tablepeek` also removes the app's web view caches. `~/.tablepeek` stays, because the command line shares it.

### Download

| Platform | File |
| --- | --- |
| macOS, Apple Silicon | `TablePeek-vX.Y.Z-aarch64-apple-darwin.dmg` |
| macOS, Intel | `TablePeek-vX.Y.Z-x86_64-apple-darwin.dmg` |
| Windows, x86_64 | `TablePeek-vX.Y.Z-x86_64-pc-windows-msvc-setup.exe` (installs for the current user, no admin rights) |

The builds are not signed with a paid Apple or Microsoft certificate, so the first launch of a downloaded file needs one extra step:

- **macOS.** Drag TablePeek to Applications and open it. Gatekeeper refuses ("cannot be opened" / "could not verify"). Open System Settings > Privacy & Security, scroll to the message about TablePeek, click **Open Anyway**, and confirm. Or clear the download quarantine once from Terminal: `xattr -dr com.apple.quarantine /Applications/TablePeek.app`. The app carries an ad-hoc signature only.
- **Windows.** SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.

Linux has no desktop app; use the [command-line binary](#command-line-binary).

### MCP and the desktop app

The app picks a new port and token at each launch and shows neither, so an MCP client cannot be pointed at it. For [MCP](GUIDE.md#mcp-for-ai-clients), run `tablepeek serve` (it prints its URL and token) alongside or instead of the app; both share `~/.tablepeek`.

## Command-line binary

Each release has one archive per platform, plus a `SHA256SUMS` file:

| Platform | Archive |
|---|---|
| macOS, Apple silicon | `tablepeek-vX.Y.Z-aarch64-apple-darwin.tar.gz` |
| macOS, Intel | `tablepeek-vX.Y.Z-x86_64-apple-darwin.tar.gz` |
| Linux, x86_64 | `tablepeek-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz` |
| Linux, arm64 | `tablepeek-vX.Y.Z-aarch64-unknown-linux-gnu.tar.gz` |
| Windows, x86_64 | `tablepeek-vX.Y.Z-x86_64-pc-windows-msvc.zip` |

Each archive holds a `tablepeek-vX.Y.Z-<platform>` folder with the `tablepeek` binary (`tablepeek.exe` on Windows) and the README. The binary carries the web UI inside it. It is not signed or notarized, and there is no installer: you unpack the archive and run the binary.

### macOS and Linux

```sh
VERSION=v0.1.0                    # the latest release
TARGET=aarch64-apple-darwin       # or x86_64-apple-darwin, x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu
curl -LO "https://github.com/Extransload/TablePeek/releases/download/$VERSION/tablepeek-$VERSION-$TARGET.tar.gz"
tar -xzf "tablepeek-$VERSION-$TARGET.tar.gz"
cd "tablepeek-$VERSION-$TARGET"
./tablepeek serve
```

> **macOS: "cannot be opened because Apple cannot check it for malicious software".** The binary is not notarized. Gatekeeper stops it when the archive came through a web browser, which marks the download as quarantined. Clear the mark once with `xattr -d com.apple.quarantine tablepeek` in the unpacked folder. Or try to run it, then pick **Open Anyway** under System Settings > Privacy & Security. Archives fetched with `curl` as above are not quarantined; `xattr` then answers "No such xattr", which is harmless.

The Linux binaries need glibc 2.39 or later (Ubuntu 24.04, Debian 13, Fedora 40, or newer). To save passwords they also need a Secret Service keyring such as GNOME Keyring or KWallet over D-Bus (`libdbus-1-3`, present on desktop installs). On an older distribution, [build from source](DEVELOPMENT.md#build-from-source).

To run `tablepeek` from anywhere, move it onto your `PATH`, for example `mv tablepeek ~/.local/bin/` or `sudo mv tablepeek /usr/local/bin/`.

### Windows

1. Download `tablepeek-vX.Y.Z-x86_64-pc-windows-msvc.zip` from the [latest release](https://github.com/Extransload/TablePeek/releases/latest) and extract it (right-click > Extract All).
2. Open PowerShell in the extracted folder and run:

   ```powershell
   .\tablepeek.exe serve
   ```

   If SmartScreen or PowerShell blocks the unsigned binary, run `Unblock-File .\tablepeek.exe` once, or choose **More info > Run anyway** in the SmartScreen dialog.

### Options

`tablepeek serve` starts the server on a free port, prints a tokenized loopback URL (keep it private), and opens your browser on the connection home.

| Option | Effect |
|---|---|
| `--port 7870` | A fixed port (the one [`tablepeek mcp`](GUIDE.md#mcp-for-ai-clients) expects by default) |
| `--demo` | An in-memory demo database (`--demo-rows <n>` for more rows) |
| `--db <file>` | Open a SQLite file |
| `--no-open` | Don't open the browser |

`tablepeek --version` prints the version, the commit it was built from, and whether it is a release or a source build.

### Verify the download (optional)

Download `SHA256SUMS` from the same release into the folder with the archive, then:

```sh
shasum -a 256 --check --ignore-missing SHA256SUMS      # macOS
sha256sum --check --ignore-missing SHA256SUMS          # Linux
```

```powershell
Get-FileHash .\tablepeek-vX.Y.Z-x86_64-pc-windows-msvc.zip -Algorithm SHA256   # compare with its line in SHA256SUMS
```

## Updating

TablePeek tells you when a newer release is out. A notice at the top of the app names the new version, links to its changes, and opens the update steps for the way your copy was installed. It checks GitHub Releases at most once a day and says nothing when offline. Turn it off under Settings > General > **Check for new versions**; [Update check](#update-check) describes exactly what it sends. Versions follow [Semantic Versioning](https://semver.org), and every change is listed in [CHANGELOG.md](../CHANGELOG.md).

**The desktop app.** The notice offers **Install and restart**. The app downloads the new version from the release, checks its update signature against the key built into the app, installs it over the current app, and starts again (on Windows the installer reopens the app). The same button is under Settings > General. If installing fails, for example because the app sits in a folder you cannot write to, the notice says so and offers to try again. Downloading the new `.dmg` or setup `.exe` by hand always works.

**Homebrew.** The app's own updates keep it current. `brew upgrade --cask --greedy tablepeek` moves it to the cask's version as well.

**A downloaded binary.** Quit TablePeek, download the archive for the new version as in [Command-line binary](#command-line-binary), and replace the old `tablepeek` binary with the new one (on macOS, clear the quarantine mark again). Your connections and settings live in `~/.tablepeek` and the OS keychain, not next to the binary, so they carry over.

**A source build.** Pull and rebuild, then restart the server:

```sh
git pull
make build           # or make run; Windows: cd web; npm install; npm run build; cd ..; cargo build -p tablepeek
```

To build a particular release rather than the latest commit, check out its tag, for example `git checkout v0.1.0`. `tablepeek --version` shows which version and commit you are running.

## Update check

The server, not the page, asks GitHub whether a newer release is out. When the app opens, it asks the server for the update status. The server checks only if checks are on and the last check is at least 24 hours old (Settings > General > **Check now** checks right away).

- **What is sent.** One unauthenticated `GET https://api.github.com/repos/Extransload/TablePeek/releases/latest` with `User-Agent: TablePeek/<version>` and `Accept: application/vnd.github+json`, with a 5-second timeout. Nothing else: no identifier, no connection or usage data, no cookies. GitHub sees your IP address, as with any request.
- **What is kept.** `~/.tablepeek/update.json` holds the setting, the release you chose to skip, the time of the last check, and what it found (tag, release page, publish date, the start of the release notes, the archive names). Delete it to start over.
- **What counts as newer.** Tags are compared as [Semantic Versioning](https://semver.org); drafts and prereleases (`v0.2.0-rc.1`) are never offered. **Skip this version** hides the notice for that release only; closing it hides it until the next launch.
- **Failures are quiet.** Offline, a timeout, an HTTP error, or GitHub's rate limit leaves the app silent; Settings > General shows why the last check failed.
- **Turning it off.** Clear Settings > General > **Check for new versions** (kept in `update.json`), or start the server with `TABLEPEEK_NO_UPDATE_CHECK=1` (any value but empty or `0`), which wins over the setting; CI and packagers can use it. Either way no request is made at all.
- **Mirrors.** `TABLEPEEK_UPDATE_URL` replaces the GitHub URL with any endpoint answering in the shape of GitHub's latest-release API (`tag_name`, `html_url`, `published_at`, `body`, `draft`, `prerelease`, `assets[].name`, `assets[].browser_download_url`). The tests use it to point the check at a local server.

`tablepeek --version` and `GET /api/version` report the version, the commit it was built from (`-dirty` with uncommitted changes), and whether it is a `release` binary, the `desktop` app, or a `source` build.
