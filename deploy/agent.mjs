// PLACEHOLDER - this is not the Hegai Code agent.
//
// The hub embeds this path at compile time (server-rs/src/main.rs, include_bytes!), so
// a fresh checkout needs a file here to compile. The real agent bundle is generated,
// and the internal bundle is deliberately NOT shipped in this repository:
//
//   bash deploy/build-agent.sh                         # -> deploy/agent.mjs (internal edition)
//   AGENT_EDITION=external bash deploy/build-agent.sh  # -> deploy/agent-external.mjs
//
// The self-hosted image (deploy/selfhost/Dockerfile) builds the external bundle and
// copies it over this file before compiling the hub.
console.error("deploy/agent.mjs is a placeholder: run `bash deploy/build-agent.sh` (see the comment in this file).");
process.exit(1);
