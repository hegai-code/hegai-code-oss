# Hegai Code — notes for coding agents and contributors

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing protocol or session code and
[CONTRIBUTING.md](CONTRIBUTING.md) for builds and test CLIs. To run your own hub, see
"Deploy the self-hosted hub" below.

## Map

| Area | Responsibility |
|---|---|
| shared | zod wire schemas; build first |
| agent | machine daemon, Claude/Codex adapters, discovery, history, files/git/terminal |
| server-rs | the only hub: axum, routing, access, writer locks, SQLite replicas |
| server | development and smoke CLIs; no Node hub |
| web | React/Vite SPA; one UI socket shared by session views |
| ios / android | native clients of the same hub |
| windows | Tauri shell for Windows and macOS around the hosted SPA |
| tgbot | Telegram client |
| skills | session-category workflows bundled into the agent |
| deploy | installers the hub serves, the self-hosted kit (`deploy/selfhost`), release signing |

## Invariants

1. **One writer per session.** Preserve hub locking, agent liveness checks and mid-run yield.
2. **Agents dial out only.** The hub is the sole listener.
3. **Wire changes start in `shared`.** Rebuild it and update Rust routing and affected consumers together. Optional fields are absent, never `null`. Keep old clients working.
4. **One access gate per transport.** Mutating HTTP endpoints use `require_active`; work-driving UI messages use the hub access gate.
5. **Two editions, one code.** The external edition is selected by `CC_REMOTE_EDITION=external` (hub) / `AGENT_EDITION=external` (agent build); every external-only behaviour is gated on `edition::is_external()` / `isExternal()`. See [docs/EXTERNAL-EDITION.md](docs/EXTERNAL-EDITION.md).
6. **One visual canon per platform.** See [DESIGN.md](DESIGN.md), [ios/DESIGN.md](ios/DESIGN.md), [android/DESIGN.md](android/DESIGN.md).

## Checks

```bash
npm run build --workspace shared
npm run build
npm test
npm run lint
cargo test --manifest-path server-rs/Cargo.toml
cargo clippy --manifest-path server-rs/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path server-rs/Cargo.toml --check
```

`deploy/agent.mjs` is a placeholder here; generated bundles are never hand-edited
(`bash deploy/build-agent.sh`).

## Deploy the self-hosted hub

The user usually wants their own server running, not a source build. Kit: `deploy/selfhost/`
(full guide: [deploy/selfhost/README.md](deploy/selfhost/README.md), in Russian).

**Requirements:** a Linux server with Docker and Compose v2 (`docker compose version`), a domain
whose A/AAAA record points at that server, ports 80 and 443 reachable from the internet, root.
Ask the user for the domain and the owner's e-mail; do not invent them.

**One command, on the server:**

```bash
cd deploy/selfhost && sudo ./install.sh <domain> <owner-email>
```

It (1) writes `deploy/selfhost/.env` with generated secrets (an existing `.env` is kept),
(2) builds and starts the hub and Caddy (automatic HTTPS) with `docker compose up -d --build`
(first run 10-20 minutes), (3) connects this server itself as the owner's first machine,
(4) prints a one-time owner setup link (password + authenticator code; valid 24 h). It is safe to re-run.

**Other machines:** on each, run `curl -fsSL https://<domain>/go | bash` (Windows PowerShell:
`irm https://<domain>/go.ps1 | iex`). The installer shows a connection code; the owner confirms it
in the web UI at `https://<domain>/link`. Sign in to Claude Code / Codex on that machine with the
user's own account. Phones: iOS "Другой хаб / токен" and Android "Другой сервер" in the app.

**Logs and state:** `cd deploy/selfhost && docker compose logs hub` (also `caddy`); all state is
the `hub-data` volume.

**Do not:**

- commit `deploy/selfhost/.env` or print its secrets into chat or logs;
- edit `deploy/agent.mjs` (a stub; the Docker build produces the real bundle);
- run `install.sh` on a machine that already hosts another hub or a fleet agent against another hub;
- open any ports other than 80 and 443, or publish the hub's port 4319 (only Caddy faces the network).

Push notifications and the desktop-app download links need two addresses that the vendor hands out
(`CC_REMOTE_PUSH_RELAY_URL`, `CC_REMOTE_APP_DL`, see `deploy/selfhost/.env.example`); ask info@heg.ai.
Everything else works without them.
