# Contributing

How to build, run and test Hegai Code from source. For the structure, read
[ARCHITECTURE.md](ARCHITECTURE.md); for agents, [AGENTS.md](AGENTS.md). To run your own
server instead, see [deploy/selfhost/README.md](deploy/selfhost/README.md).

## Prerequisites

- **Node 20.19-24** (Vite needs 20.19+; the native `node-pty` dependency does not yet support Node 25).
- **Rust stable** (`cargo`, with `clippy` and `rustfmt`): the hub, `server-rs/`, is Rust.
- Claude Code and/or Codex with working authentication, only if you want to run real sessions.
  Unit tests use fixtures and need neither.

## First run (one machine, local)

```bash
npm ci
npm run build --workspace shared && npm run build   # shared first: everything imports @cc-remote/shared

# terminal 1: the hub (serves the built UI on :4319)
PORT=4319 CC_REMOTE_TOKEN=dev-token WEB_DIST=web/dist \
  cargo run --manifest-path server-rs/Cargo.toml

# terminal 2: the agent daemon
CENTRAL_URL=ws://127.0.0.1:4319 CC_REMOTE_TOKEN=dev-token npm run start --workspace agent
```

Open <http://localhost:4319>; on `localhost` the SPA fills in `dev-token` by itself.

**Do not start a dev agent on a machine that already runs a production agent.** It would discover
the same `~/.claude` transcripts, and the single-writer lock only coordinates writers within one hub.
There, run the hub and the UI freely and keep the agent read-only (`npm run scan --workspace agent`),
or point it at scratch `CLAUDE_CONFIG_DIR` and `CODEX_HOME` directories.

## UI with hot reload

```bash
VITE_CENTRAL_URL=ws://127.0.0.1:4319 npm run dev --workspace web   # Vite on :5173
```

Hub and agent from the first-run recipe must be running. `VITE_CENTRAL_URL` is required in dev. REST
calls go to the page origin, so team/admin screens need a Vite `/api` proxy to the hub.

## Watch modes

| Workspace | Command |
|-----------|---------|
| shared | `npm run dev --workspace shared` (tsc --watch) |
| agent | `npm run dev --workspace agent` (tsx watch) |
| hub | `cargo run --manifest-path server-rs/Cargo.toml` (`cargo watch -x run` for reload) |
| web | `npm run dev --workspace web` (Vite) |

## Checks (what CI runs)

```bash
npm run build --workspace shared
npm run build                                        # TypeScript + production SPA
for w in web server tgbot; do npx tsc --noEmit -p "$w"; done
npm test                                             # shared, agent, web, tgbot
npm run lint                                         # biome
cargo test   --manifest-path server-rs/Cargo.toml
cargo clippy --manifest-path server-rs/Cargo.toml --all-targets -- -D warnings
cargo fmt    --manifest-path server-rs/Cargo.toml --check
```

There is no root `Cargo.toml`: run `cargo` with `--manifest-path`.

## Test CLIs (no browser needed)

With a hub running (see above), these exercise the loop headlessly; start here when debugging the core
resume path before touching the UI. `tsx` is a local devDependency, so prefix with `npx`.

```bash
npm run scan --workspace agent                       # list this machine's sessions
npx tsx server/src/cli/ui-smoke.ts                   # full headless loop
npx tsx server/src/cli/rpc-smoke.ts                  # the RPC surface
npx tsx server/src/cli/protocol-smoke.ts             # wire-conformance sweep
npx tsx server/src/cli/snapshot.ts                   # dump the hub snapshot
```

`ls server/src/cli` lists them all, one file per smoke. They take `[ws-url] [token]` arguments or the
`CC_SMOKE_URL` / `CC_REMOTE_TOKEN` environment variables.

## Native clients

- iOS: [ios/README.md](ios/README.md). `project.yml` is authoritative; generate the Xcode project with
  `(cd ios && xcodegen generate)`.
- Android: open `android/` in Android Studio (JDK 17, SDK 34) or
  `(cd android && ./gradlew :core:test :app:assembleDebug)`; see [android/README.md](android/README.md).
- Desktop shell (Tauri): `windows/`.

## Environment variables

- Hub in the self-hosted kit: every variable is documented in
  [deploy/selfhost/.env.example](deploy/selfhost/.env.example).
- Hub, development: `PORT`, `HOST`, `CC_REMOTE_TOKEN` (default `dev-token`), `WEB_DIST` (default
  `web/dist`), `CC_REMOTE_DB_PATH` (SQLite file), `CC_REMOTE_EDITION=external` (the self-hosted edition,
  see [docs/EXTERNAL-EDITION.md](docs/EXTERNAL-EDITION.md)), `CC_REMOTE_PUBLIC_URL`.
- Agent: `CENTRAL_URL` (default `ws://127.0.0.1:4319`), `MACHINE_NAME`, `CC_REMOTE_STATE_DIR`
  (default `~/.cc-remote`), `CC_REMOTE_CHAT_ONLY`, `CC_REMOTE_DISABLE_CLAUDE`, `CC_REMOTE_AUTO_UPDATE`.

## Changing the wire protocol

Start in `shared/` (zod schemas), rebuild it, then update the Rust routing in `server-rs/` and every
affected client together. Optional fields are absent, never `null`; old clients must keep working.

`deploy/agent.mjs` is a placeholder in this repository; build the real bundle with
`bash deploy/build-agent.sh` (never edit generated bundles by hand).
