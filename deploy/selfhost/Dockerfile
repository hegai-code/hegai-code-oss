# syntax=docker/dockerfile:1.7
#
# Hegai Code hub — the external (self-hosted) edition, as one image.
#
#   docker build -f deploy/selfhost/Dockerfile -t hegai-code-hub .     (from the repo root)
#
# Stages: node (shared, EXTERNAL agent bundle, web + light shell) -> rust (the
# hub binary, which embeds installers and the agent bundle) -> debian-slim.
# Base images are pinned by tag AND digest; bump them deliberately.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ARG RUST_IMAGE=rust:1.97-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97
ARG RUNTIME_IMAGE=debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

# ---------------------------------------------------------------- node
FROM ${NODE_IMAGE} AS web
WORKDIR /src
# Manifests first so the dependency layer survives source edits. Scripts are
# off: nothing here needs a native build (esbuild ships its binary, node-pty is
# an external of the agent bundle and is installed on the agents' machines).
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY agent/package.json agent/
COPY server/package.json server/
COPY web/package.json web/
COPY tgbot/package.json tgbot/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY shared shared
COPY agent agent
COPY skills skills
COPY web web
# release-keys.txt: agent/scripts/release-keys.mjs reads it for every external build
# (the keys the bundle trusts); without it the build fails with ENOENT.
COPY deploy/build-agent.sh deploy/package.json deploy/release-keys.txt deploy/
# AGENT_EDITION=external -> deploy/agent-external.mjs: no HegAI host assumed,
# self-updates only from a release signed with a key compiled into it.
RUN npm run build --workspace shared \
 && AGENT_EDITION=external bash deploy/build-agent.sh \
 && npm run build --workspace web

# ---------------------------------------------------------------- rust
FROM ${RUST_IMAGE} AS hub
WORKDIR /src
# include_str!/include_bytes! reach outside server-rs: the installers, the
# embedded agent bundle, the shared limits and the web's privacy page.
COPY server-rs server-rs
COPY shared/src shared/src
COPY web/public/privacy web/public/privacy
COPY deploy deploy
# The hub embeds `deploy/agent.mjs` (the INTERNAL bundle in git). A customer's
# image must carry the external one instead.
COPY --from=web /src/deploy/agent-external.mjs deploy/agent-external.mjs
COPY --from=web /src/deploy/agent-external.mjs deploy/agent.mjs
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/server-rs/target \
    cargo build --release --locked --manifest-path server-rs/Cargo.toml \
 && install -D server-rs/target/release/cc-remote-server /out/cc-remote-server

# ---------------------------------------------------------------- runtime
FROM ${RUNTIME_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin hub \
 && mkdir -p /app/agent-release /data \
 && chown hub:hub /data

COPY --from=hub /out/cc-remote-server /app/cc-remote-server
COPY --from=web /src/web/dist /app/web-dist
# The light shell is for extra host names (CC_REMOTE_LITE_HOSTS); shipped, not enabled:
# set WEB_LITE_DIST=/app/web-lite-dist together with CC_REMOTE_LITE_HOSTS to use it.
COPY --from=web /src/web/lite/dist /app/web-lite-dist

# The agent release the hub offers. A SIGNED release dropped into
# deploy/selfhost/agent-release/ before the build (any *.sig in it) wins; with
# none, the freshly built UNSIGNED external bundle is shipped so the image
# still boots - a hub that verifies releases will refuse to serve it, which is
# the point: only a bundle carrying the vendor signature is ever offered.
COPY --from=web /src/deploy/agent-external.mjs /opt/agent-built/agent-external.mjs
COPY deploy/selfhost/agent-release/ /opt/agent-signed/
RUN if ls /opt/agent-signed/*.sig >/dev/null 2>&1; then cp -a /opt/agent-signed/. /app/agent-release/; \
    else cp /opt/agent-built/agent-external.mjs /app/agent-release/; fi \
 && rm -f /app/agent-release/.gitkeep \
 && rm -rf /opt/agent-signed /opt/agent-built

ENV CC_REMOTE_EDITION=external \
    HOST=0.0.0.0 \
    PORT=4319 \
    WEB_DIST=/app/web-dist \
    CC_REMOTE_DB_PATH=/data/cc-remote.sqlite3 \
    CC_REMOTE_DATA_DIR=/data \
    CC_REMOTE_AGENT_RELEASE_DIR=/app/agent-release

USER hub
WORKDIR /app
VOLUME /data
EXPOSE 4319
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4319/health >/dev/null || exit 1
ENTRYPOINT ["/app/cc-remote-server"]
