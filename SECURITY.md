# Security policy

## Supported versions

Only the latest minor release gets security fixes. When 0.9.0 comes out, 0.8.x stops getting them. The desktop app updates itself, and the [install guide](docs/INSTALL.md#updating) explains how to update every other way of running TablePeek.

| Version | Security fixes |
|---|---|
| Latest minor release (see [Releases](https://github.com/Extransload/TablePeek/releases/latest)) | Yes |
| Anything older | No |

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue.

1. Open the [Security tab](https://github.com/Extransload/TablePeek/security) of the repository.
2. Click **Report a vulnerability** and fill in the form. Only the maintainers can see it.

Include the TablePeek version (`tablepeek --version`, or Settings > General in the app), how you ran it (desktop app, command line, or a source build), your OS, the database engine involved if any, and the steps to reproduce. A proof of concept helps, but leave out real credentials and real data.

If the **Report a vulnerability** button is missing, open a regular issue that only asks for a private contact, with no details of the problem.

## What to expect

TablePeek is maintained by a small team without a dedicated security staff, so these are aims, not guarantees:

- We try to acknowledge a report within a week.
- We will tell you whether we can reproduce it and whether we consider it a vulnerability.
- A confirmed issue is fixed in a new release as soon as we reasonably can. The fix is listed in [CHANGELOG.md](CHANGELOG.md), and a GitHub Security Advisory is published once the release is out.
- We credit you in the advisory unless you ask us not to.

Please give us a reasonable time to ship a fix before you disclose the issue publicly.

## Scope

TablePeek runs a local server on your machine and shows its UI in your browser or in the desktop app. The [user guide](docs/GUIDE.md#security) describes the security model in full. Reports about any of these are in scope:

- **Local server exposure.** The HTTP and WebSocket server binds to `127.0.0.1` only and checks the `Host` header against DNS rebinding. Anything that lets another machine, or a web page from another origin, reach it is in scope.
- **Access token.** Each server start makes a new token, and every `/api` request must carry it. A way around the token check, or a way for the token to leak to another site, is in scope.
- **Stored credentials.** Database, SSH and AI API key secrets are kept in the OS keychain, not in `~/.tablepeek/store.json`. Exported `.tablepeek` connection files are encrypted with a file password (Argon2id and AES-256-GCM). A secret written in plain text to disk or logs, or sent to the page when it should not be, is in scope.
- **TLS and SSH tunnels.** Certificate or host-key checks that are skipped when the connection settings ask for them, or a `prefer` mode that falls back to plain text in cases other than the documented ones.
- **The desktop app.** The page is given no native API, links to other sites open in the system browser, and downloads go to the Downloads folder. A way for a page to reach native code, or to load a foreign site inside the app window, is in scope.
- **The desktop updater.** Updates are downloaded from GitHub Releases and installed only if their signature matches the public key built into the app. A way to install an unsigned or wrongly signed update is in scope.
- **MCP.** `tablepeek mcp` exposes read-only tools and rejects multi-statement and write SQL. That filter is a guard against accidents, not a privilege boundary, as the guide says; a way to write through it is still worth reporting, but the real protection is a read-only database role.
- **Write SQL with AI.** When turned on, TablePeek sends the connection's schema, your request, and the selected SQL (or the text around the cursor for suggestions) to the provider you chose, and never row data. Anything that sends rows, sends to a provider you did not choose, or leaks the ChatGPT tokens or an API key to the page is in scope.

Out of scope:

- Problems that need someone who can already run code as your user, or read your home folder or keychain.
- The unsigned builds' first-launch prompts (Gatekeeper, SmartScreen); see the [install guide](docs/INSTALL.md).
- Vulnerabilities in a database server itself, or in a third-party library with no TablePeek-specific way to reach them. Please report those upstream. A library vulnerability that TablePeek actually exposes is in scope.
