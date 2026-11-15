# Third-party notices

Hegai Code bundles or depends on third-party software under its own licenses.
The full list of npm and Cargo dependencies with their licenses is produced by
`npx license-checker --production` and `cargo about` from the lockfiles; the
components that need a specific notice are:

- **noVNC** (`@novnc/novnc`, used by the web client's browser view) — Mozilla
  Public License 2.0. Source: https://github.com/novnc/noVNC. We use it
  unmodified; the MPL applies to its files only.
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — proprietary,
  © Anthropic PBC, governed by Anthropic's terms. It is NOT included in this
  repository or in the agent bundle; the installer fetches it from npm onto the
  user's machine, where the user agrees to Anthropic's terms.
- **OpenAI Codex CLI** — Apache License 2.0, installed separately by the user.
- **Fonts** Onest and IBM Plex Mono — SIL Open Font License 1.1.
