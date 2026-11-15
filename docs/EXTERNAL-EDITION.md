# External edition — Hegai Code on a customer's own server

Status: in development (from 30.10.2026). Target: a company's own VPS, a team
of employees with a manager who sees their work, source available to the customer.

## What it is

One codebase, two editions:

| | internal (code.example.com) | external (customer's hub) |
|---|---|---|
| Selected by | default | hub: `CC_REMOTE_EDITION=external`; agent: built with `AGENT_EDITION=external` |
| Agent rollout | a hub deploy is the rollout (unchanged) | a new agent bundle is served only after (1) it carries **our release signature** and (2) the customer's **owner approves it with their authenticator code** |
| Sign-in | Google, Telegram, Apple, HegAI SSO | local owner (password + authenticator), generic OIDC (Google Workspace, Keycloak, …) restricted to allowed domains, Google/Telegram only if the customer configures their own keys |
| New accounts | community gate (`CC_REMOTE_ACCESS_DEFAULT`) | `active` only when vouched for (created by the owner/an admin, the bootstrap owner, or a sign-in from a domain listed in `OIDC_ALLOWED_DOMAINS` / `GOOGLE_ALLOWED_DOMAINS`); everyone else (Telegram, Apple, unrestricted OIDC/Google) lands on the waitlist and the owner approves them in the access screen. `CC_REMOTE_ACCESS_DEFAULT` set explicitly still overrides |
| HegAI hosts | llm.example.com, admin.example.com, spare relay ports | none unless configured; an unset feature is off |
| Our access | full (our fleet) | **none by default**; temporary support access only when the owner grants it, every action logged for the owner |

The internal hub must behave exactly as before: every new behaviour is gated on
`edition::is_external()` (hub, `server-rs/src/edition.rs`) or `isExternal()`
(agent, `agent/src/edition.ts`). Do not add a separate env switch per policy.

## Building blocks already in the tree

- `server-rs/src/edition.rs` — `edition::current()`, `is_external()`, `hegai_default(url)`.
- `server-rs/src/totp.rs` — RFC 6238 (Google Authenticator), base32, `otpauth://` URI, recovery codes.
- `server-rs/src/user_totp.rs` — per-user authenticator: `begin`, `confirm` (returns recovery codes once), `verify` (TOTP once per step, or a recovery code, burned), `is_enrolled`, `reset`. **The only place a user's code is checked.**
- `agent/src/edition.ts` — `EDITION` from the build define `__CC_REMOTE_EDITION__`.
- `deploy/build-agent.sh` — `AGENT_EDITION=external` → `deploy/agent-external.mjs`.

## Sign-in

A fresh customer hub has no identity provider, so it starts with the owner and
a link. Which ways in are on is public at `GET /api/public-config`
(`edition`, `brandName`, `auth.{local,google,telegram,apple,oidc,hegaiSso}`),
and the web draws only those buttons.

- **Owner (local).** The owner is the bootstrap user
  (`CC_REMOTE_BOOTSTRAP_USER_ID`, `CC_REMOTE_BOOTSTRAP_EMAIL` — set the real
  address). While the owner has no password and no OIDC is configured, every
  start prints a one-hour link to the log (`docker compose logs hub`):
  `<CC_REMOTE_PUBLIC_URL>/setup#token=…`. Another one at any time:
  `cc-remote-server setup-link --email <owner> [--hours N]`. The `/setup` page
  shows an authenticator QR code, takes a password (12+ characters) and the
  first code, and hands out ten recovery codes once. A token is 32 random
  bytes, stored hashed, single use. Sign-in is then password + authenticator
  code (or a recovery code); every failure says the same sentence, and the
  hub rate-limits per address and per (account, address) pair. Failures from
  many addresses against one account only add a one-second delay (after 100 in
  15 minutes), they never lock the account: a stranger cannot lock the owner out.
- **Employees.** A platform admin `POST /api/admin/local-users {email,
  fullName?}` gets back a 24-hour setup link to send; `POST
  /api/admin/local-users/{userId}/reset` is the lost-phone path (drops the
  password and authenticator, ends the sessions, returns a new link). Both are
  audited. Accounts the owner or an admin creates are `active`.
- **OIDC** (Google Workspace, Keycloak, Entra, …): `OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; register
  `<CC_REMOTE_PUBLIC_URL>/api/auth/oidc/callback` at the provider. Optional:
  `OIDC_DISPLAY_NAME` (default `SSO`), `OIDC_SCOPES`, `OIDC_ALLOWED_DOMAINS`
  (comma list; the address and, when the token has `hd`, that too must match),
  `OIDC_TRUST_UNVERIFIED_EMAIL=1`, `OIDC_REQUIRE_HD=1`. RS256/ES256,
  `iss`/`aud`/`exp`/nonce checked, `email_verified` required. With a domain list
  the `hd` (hosted domain) claim is **required and must be listed** when the
  issuer is `https://accounts.google.com`, with `OIDC_REQUIRE_HD=1` for any other
  issuer, and always for `GOOGLE_ALLOWED_DOMAINS` (a consumer Google account can
  carry a corporate address but has no `hd`). A known `(issuer, sub)` opens its
  account. A new subject whose address is in a listed domain opens an existing
  account **by address** only if that account is an ordinary one: **never** an
  account with a local password, a platform admin or the bootstrap owner — that
  sign-in is refused with a clear message (linking from inside an already
  signed-in session is not built yet). So the owner always signs in locally; the
  setup link is printed at every start until the owner has both a password and
  an authenticator, whatever OIDC is configured.
  `GOOGLE_ALLOWED_DOMAINS` applies the same domain rule to the Google sign-in
  (unset = unchanged). A listed domain also makes new accounts `active`.
- **Authenticator for admins.** An admin who has none (e.g. the owner who came
  in some other way) enrols one from the *Agent updates* block:
  `POST /api/auth/totp/begin` → `{otpauthUri, qrSvg}`,
  `POST /api/auth/totp/confirm {code}` → `{recoveryCodes}` (shown once).
- The internal edition's second factor on sign-in (`mfa.rs`, ARCHITECTURE.md)
  reuses the same `/api/auth/totp/*` endpoints; on the external edition their
  behaviour is unchanged and the pending-session rule is off (`mfa_required` is
  false there — the owner's code is already part of the password sign-in).
- Local sign-in is on in the external edition, or with
  `CC_REMOTE_LOCAL_LOGIN=1` on a dev hub; otherwise its routes answer 404.
- The hub believes `X-Real-IP` **only from loopback and from the proxy ranges
  in `CC_REMOTE_TRUSTED_PROXIES`** (`client_address` in `main.rs`); a request
  from any other peer is keyed by its own socket address, whatever header it
  sends. The sign-in, setup and OIDC/Google hops use that rule. Behind a reverse
  proxy that is not on loopback, list its network there and have it set the
  header (Caddy: `header_up X-Real-IP {remote_host}`), never pass the client's
  own. (Older open endpoints inherited from the internal hub still read
  `X-Real-IP` from any peer for their own rate limits; they are not a
  sign-in path.)

### Mobile apps (iOS, Android)

The apps sign in to a customer's hub through the hub's own page, not through
Google. They read `GET /api/public-config`; for `edition == "external"` (or a hub
with neither Google nor Apple but a password / OIDC login) the sign-in screen
shows «Войти», which opens `<hub>/native-signin` in the system auth browser
(ASWebAuthenticationSession / Custom Tab) with the query they already send to
`/api/auth/google/start`: `native=1` (iOS) or `android=1&code_challenge=…&client_state=…`
(Android, S256 PKCE). The page (`web/src/NativeSignInPage.tsx`) draws the hub's
methods:

- **OIDC / Google buttons** go to `/api/auth/{oidc,google}/start` with the same
  query, so `begin_login` / `finish_login` do the usual redirect to the app
  scheme.
- **Local form** posts to `POST /api/auth/local/native-handoff`
  `{email, password, code, native: true}` or `{…, android: true, code_challenge,
  client_state}`. Same checks, rate limits and single generic error as
  `/api/auth/local/login` (`check_credentials`); the answer is `{redirect}` — the
  address `finish_login` produces: `ccremote://auth?session=…` (iOS) or a one-use
  `hegai-code://auth?code=…&state=…` bound to the PKCE challenge (Android,
  exchanged at `/api/auth/android/exchange`). The parameters are validated
  before the credentials, so a malformed request never spends an authenticator
  code. The page navigates to the redirect (and offers it as a button if the
  browser does not follow it).
- Telegram is not on this page: the apps run its number-matching flow
  in-app and show that button when `auth.telegram` is on.

The apps also derive privacy / support links from the configured hub, and both
bind the stored session to the hub that issued it: Android stores the hub origin
with the session (`SessionBinding`) and refuses/clears a session whose hub is not
the current one; changing the hub signs out of the old one first (iOS drops the
old token when the hub in «Другой хаб / токен» changes).

### Push relay (privacy)

A customer hub has no APNs key / FCM service account for our store apps, so
with both unconfigured and `CC_REMOTE_PUSH_RELAY` explicitly `on` (`1`/`true`/`yes`;
unset = off, with one log line; `deploy/selfhost/init.sh` writes `on` into new `.env`
files) the
notifier gains a `relay` backend (`server-rs/src/push_relay.rs`). It registers
once with the relay (`CC_REMOTE_PUSH_RELAY_URL`, no default — the vendor gives it, unset = off with a log line;
needs `CC_REMOTE_PUBLIC_URL`) via the two-phase `POST /api/push-relay/register/start` / `register/finish` (below), keeps
`{instanceId, secret, relayUrl}` in `push-relay.json` in the data dir (0600), and
posts `POST /api/push-relay/send`, HMAC-SHA256 signed (`X-Relay-Instance`,
`-Timestamp`, `-Signature` over `<ts>.<body>`, 5-minute window).

Domain proof, two phases (registration is not anonymous):

1. `POST /api/push-relay/register/start {publicUrl}` -> `{challengeId, nonce}`.
   The relay keeps the challenge in memory for 2 minutes (at most 1000, oldest
   evicted). `challengeId` is a secret between the hub and the relay; only the
   nonce is ever published.
2. The hub serves the nonce at `GET /.well-known/hegai-push-relay` (public,
   `no-store`, every edition; 404 when no registration is pending), then calls
   `POST /api/push-relay/register/finish {challengeId}`. The relay removes the
   challenge (single use), fetches `https://<host>/.well-known/hegai-push-relay`
   of the stored `publicUrl` host (path ignored), compares the body with the
   nonce, and only then issues `{instanceId, secret}`. Someone who merely reads
   the public nonce cannot finish another hub's registration.

The fetch: `https` on 443 and a DNS name only; every resolved address must be
public (loopback, private, link-local, unique-local, CGNAT, documentation,
multicast, reserved are refused) and the request goes to that checked address,
no redirects, 5 s, 256 bytes. A failed proof (or an unknown/expired challenge)
is `422 domain proof failed` (the hub pauses 1 h); `403 revoked` pauses it 24 h.
Limits: `start` 5/h per address, `finish` 10/h per address; the global 200/day
counts only proven registrations.

What HegAI receives per push: the device push token, platform, state
(`needs_attention` / `error` / `idle`), session id, machine id, workspace id, the hub's user id,
the hub's public URL (once, at registration) and the time. Never: the session
title, assistant text, tool, request id, action token. The request type has no
field for them and the relay rejects unknown fields. The relay builds the text
itself from the state («Агент ждёт ваш ответ» / «Ошибка в сессии» / «Есть ответ в
сессии») with no action buttons. No Live Activity relay. Limits per instance:
120/min, 5000/day; per token and state one per 10 s; registrations as above. Revoke an instance (our side, hub database):
`UPDATE push_relay_instances SET revoked_at=strftime('%s','now')*1000
WHERE instance_id='…'`. A revoked instance gets 403 and its hub stops for 24 h
instead of re-registering; since the host is proven, revocation also refuses new
instances from the same host or registering address (/64); an abuser with
many owned domains is held only by the limits. The endpoints exist only on a non-external hub that has
APNs or FCM configured.

## Host enrollment secret

`CC_REMOTE_HOST_ENROLLMENT_SECRET` (>= 32 characters; `deploy/selfhost/init.sh`
generates it into `.env`) is seeded at start as one ordinary, single-use
enrollment code of the bootstrap owner. `deploy/selfhost/connect-host.sh` uses it
to install the agent for user `hegai` on the hub's own server, so the server
joins as the owner's machine with no `/go` and no code approval. Whoever can read
`.env` can enroll one machine as the owner; once exchanged the secret is dead
(a restart does not re-arm it). Unset or shorter than 32 characters: ignored.

## Release signing (replaces "the key on the MacBook")

Owner's decision 30.10.2026: the second factor for a release is **Google
Authenticator**, not an offline key on a laptop.

- The Ed25519 private key lives in a small **release signer** service
  (`deploy/release-signer/`) on a host **outside the fleet** — no Hegai Code
  agent, no fleet SSH keys, so root on our hub cannot read it.
- **Request / approve.** The build machine can only *ask*: it POSTs
  `{version, sha256, commit?, note?}` with a bearer token and gets a request id.
  The operator opens the signer's own page (from their phone, through TLS),
  sees the version, the **full sha256**, the commit and the note of each pending
  request, and types the authenticator code next to the one they recognise. Only
  that exact manifest is signed. A code that leaks from the build machine signs
  nothing, because it is never typed there. Replay-guarded (a code once), five
  wrong codes lock approvals for 15 minutes, then 30, 60, … up to 24 hours
  (persisted); requests expire after 2 hours, at most 10 pending; every request
  and signature is logged and optionally sent to Telegram.
- What is signed is a release manifest, not the file, and it attests the edition:

  ```
  hegai-code-agent-release/1
  edition=external
  version=<agent version>
  sha256=<hex sha256 of agent-external.mjs>
  ```

  stored as `deploy/agent-external.mjs.release`, signature (base64 Ed25519, 64
  bytes) as `deploy/agent-external.mjs.sig`. `sign-release.mjs` refuses to ask
  for a signature on a bundle that does not carry the external edition marker
  (`HEGAI_AGENT_EDITION=external`, compiled in by `deploy/build-agent.sh`); the
  hub offers, and an external agent installs, only a manifest saying
  `edition=external`; and before installing, the agent runs the candidate's
  `--self-test` once and requires it to report the same marker, so a mis-signed
  internal bundle (which trusts no key and verifies nothing) can never replace an
  external agent.
- Trusted public keys: `deploy/release-keys.txt`, one base64 SPKI DER Ed25519
  key per line, `#` comments. Compiled into the external agent bundle and into
  the hub. Rotation = add the new key, ship, then sign with it.
- Honest limits. TOTP protects the act of signing; whoever has root on the
  signer host can sign without it — hence the host outside the fleet. The
  operator must compare the sha256 on the page with the one printed by the build
  **on a machine they trust**: a page they approve blindly signs whatever a
  compromised build machine asked for. The request-token holder can only ask,
  not sign. The page is open to anyone who can reach it (it shows pending
  requests and takes codes), so a stranger can burn failed attempts and lock
  approvals for a while — never sign. A hub can still re-offer an OLDER validly
  signed bundle; agents do not compare versions (rollback is legitimate; version
  monotonicity is not enforced).

### Releasing (our side)

```bash
# once, on the signer host (outside the fleet): key, authenticator secret, request token
node deploy/release-signer/setup.mjs /etc/release-signer   # prints the release-keys.txt line and a QR
# add the printed line to deploy/release-keys.txt, commit, build the hub image
# copy /etc/release-signer/request-token to the build machine (SIGN_RELEASE_TOKEN_FILE)

# every release
AGENT_EDITION=external bash deploy/build-agent.sh          # -> deploy/agent-external.mjs (untracked); prints its sha256
SIGN_RELEASE_TOKEN_FILE=~/.release-token \
node deploy/release-signer/sign-release.mjs --signer https://<signer> \
     --bundle deploy/agent-external.mjs                    # prints the sha256 + request id, waits up to 15 min
# on your phone: open https://<signer>/ , compare the sha256, type the code next to the request
# sign-release.mjs then writes .release and .sig next to the bundle
# ship the three files in the hub image under /app/agent-release/
```

`sign-release.mjs` verifies what it got back against `deploy/release-keys.txt`
before it writes anything. The external bundle is never tracked in the repo
(`.gitignore`); the internal `deploy/agent.mjs` carries no key and is never signed.
Setup, systemd unit, rotation and the honest limits: `deploy/release-signer/README.md`.

### Customer side

- The hub (external) offers the bundle from `CC_REMOTE_AGENT_RELEASE_DIR`
  (default `/app/agent-release`: `agent-external.mjs`, `.release`, `.sig`),
  verifies the signature and hash itself against `deploy/release-keys.txt`
  (compiled in), and serves **only the approved copy** kept in the data volume
  (`<data>/agent-release/`, `CC_REMOTE_DATA_DIR`, default: next to the database)
  as `/install/agent.mjs`, `.sha256`, `.release`, `.sig`. Nothing approved: 404.
  The approved bundle is verified once (at start and whenever it is written) and
  then served from memory, so the open `/install/agent.mjs*` URLs cost no disk
  read, hash or signature check per request; a key removed from
  `release-keys.txt` makes it unservable from the next start.
- First boot with nothing approved approves a validly signed offered bundle
  (audit `agent_release.auto_approve`; written at the first admin call when the
  fresh install has no workspace yet). «First boot» means **never approved on
  this installation**: the first approval writes an irreversible marker in the
  database (`schema_meta` key `agent_release_initialized`). With the marker
  present, a deleted/corrupted `approved.json` or a database restored without
  the release directory is *not* a first boot: nothing is auto-approved, the
  installs 404, the admin API reports `approvedLost` and the owner approves
  again with the authenticator. A different valid bundle after
  `docker compose pull` is **pending**; an unsigned or wrongly signed one is
  shown as such and never served.
- Admin page «Команда → Доступ → Обновления агента» (platform admin) and
  `GET /api/admin/agent-release`, `POST …/approve {sha, code}`, `POST …/rollback
  {code}`. The code is the admin's own authenticator code (`user_totp::verify`,
  one use per step; 5 wrong codes pause it for 15 minutes); an admin without a
  confirmed authenticator gets 409 and the block offers to enrol one. Audit: `agent_release.approve`,
  `agent_release.rollback`. The previous bundle is kept for rollback.
- There is no push to agents: they pick an approval up on reconnect or within
  their 30-minute check.
- Agents (external build) install a self-update only if the manifest says
  `edition=external`, its sha256 equals the download and a key compiled into the
  bundle verifies the manifest's signature — checked before the file is written
  or run — and the candidate's `--self-test` then reports
  `HEGAI_AGENT_EDITION=external`. No key compiled in:
  the agent never self-updates. Missing release files are retried; a manifest
  that is readable but wrong refuses that bundle until the agent restarts.
- Not covered (known limitation): a hub can still re-offer an OLDER validly
  signed bundle (rollback is legitimate); agents do not compare versions, so
  version monotonicity is not enforced.

## Расходы (per-person AI usage and limits)

Works with **any Bifrost**, and the self-host kit bundles one
(`deploy/selfhost/llm.sh`, `compose.llm.yml`: Bifrost plus one CLIProxyAPI
container per subscription account, each its own `pool-<name>` provider, the
same layout as our gateway; see the selfhost README). Set `LLM_GATEWAY_URL`
(its admin API; `http://user:pass@host:port` when Bifrost's `auth_config` is
on - the credentials are split off at start, sent as Basic auth on admin calls
only and never logged) and `LLM_PUBLIC_URL` (no default here: without it seats stay off,
logged at start). Gateway-only Codex sessions and the journal additionally need
each agent machine to name its gateway: `CC_REMOTE_GATEWAY_URL` in the agent's
service environment (https; http only on loopback; not a file a session could rewrite) - the hub cannot
set or redirect it. Without `LLM_GATEWAY_URL` the feature is simply
absent: no «Расходы» tab in the team, no «Мои расходы» card in Настройки, and
`GET /api/workspaces/{id}/usage` / `GET /api/me/usage` answer
`{"configured": false, "members": []}`. `GET /api/me` carries `llmUsage: true`
only when it is configured; the web keys the UI off that.

- **Gateway side.** One Bifrost virtual key per person named `hegai:<email>`.
  Every 10 minutes the hub folds new `GET /api/logs` rows (ascending, 200 per
  page, 15 minute look-back, exactly once per log id) into `llm_usage_daily`:
  day (UTC), key, model, requests, errors, prompt / completion / cached tokens.
  The first run backfills 30 days, bounded per pass. Bifrost log rows may carry
  `raw_request` / `raw_response` and an embedded copy of the key (secret
  included); the collector's wire types do not name them, so they are skipped
  while parsing and never held, logged or stored. Keys not named
  `hegai:<email>` (service keys, other prefixes) are kept under their own name
  and shown to nobody.
- **Limits.** The seat's budget / rate-limit window comes live from
  `GET /api/governance/virtual-keys` (cached 30 s); the secrets in that list
  are dropped on arrival.
- **Own subscriptions, not pooled.** When an agent reports its Claude / Codex
  limits the hub keeps the latest reading and the day's peak per owner, account
  and window for 90 days (`sub_limit_samples`). A window at 90 % or more on two
  or more days of the period flags the person «часто упирается в лимит».
- **Who sees whom.** The workspace owner sees every member; a manager sees
  themselves and the members assigned to them (`member` assignments; project
  assignments do not expose people); a member sees only themselves. Customer
  installs do not need CLIProxyAPI or any shared consumer subscription; the
  bundled gateway offers it as an option, one account per container, with the
  provider's terms left to the operator.

## Support access on request

The owner opens access for us for N hours (1–72) with a role (`member` or
`manager`); the hub creates a dedicated account `support:<grant_id>` ("Поддержка
Hegai Code", `support+<short>@support.invalid`, no personal workspace) that is a
member of that team only, and a one-time sign-in link the owner sends us. The
session ends with the grant, whichever comes first: expiry or revoke. Every UI
message and HTTP mutation by the account is written to `audit_events` and shown
to the owner as "Что делала поддержка" (Настройки → «Доступ поддержки»).
Code: `server-rs/src/support_access.rs` (rules, store), `support_api.rs`
(endpoints, middleware), `web/src/components/SupportAccess.tsx`.

Endpoints (owner of an organization only, `require_active`; wire types in
`shared/src/web-protocol.ts`):

| | |
|---|---|
| `POST /api/workspaces/{id}/support-grants` `{hours, role, note?}` | creates the grant, returns `{grant, link}`; the link (`<public>/support-login#token=…`, valid min(grant, 2 h), single use) is returned **once** and stored only as a hash. Audit `support.grant`. At most 5 open grants per team. |
| `GET  /api/workspaces/{id}/support-grants` | grants with `status` (`active`/`expired`/`revoked`), `expiresAt`, `linkUsed` |
| `POST /api/workspaces/{id}/support-grants/{grant}/revoke` | removes the membership, deletes all sessions of the account, closes its sockets. Audit `support.revoke`. Idempotent. |
| `GET  /api/workspaces/{id}/support-grants/{grant}/log[?before=ms]` | `{events, total}`: the account's audit rows plus the grant's lifecycle rows, newest first, up to 1000 per call; `before` (a `createdAt`, inclusive) pages back |
| `POST /api/auth/support-login` `{token}` | no session needed; spends the token and sets the usual cookie. The token travels in the URL fragment and the `/support-login` page posts it, so a link preview cannot spend it. Rate-limited per address. Audit `support.login`. |

How the limits hold:

- **The clock is checked at the gate.** `authenticate`, `require_member`,
  `ui_access`, `session_alive` and every UI frame refuse a support account whose
  grant is past `expires_at` or closed, before any sweep. Only the session the
  login link minted counts (a session made any other way for that id is
  refused), its expiry is the grant's and it does not slide
  (`authenticate_row`). A 5 s hub tick (`SweepSupport`, free while no grant is
  open) closes the sockets of a grant that ran out and tidies up: membership,
  sessions, devices and codes of the account removed, `support.expired`
  written, push registrations dropped. A revoke does the same at once.
- **What is logged.** `support.ui`: the frame `type` plus `machineId`,
  `sessionId`, `runId`, `termId`, `cwd`, `path`, `from`, `to`, `name`, `dir`,
  `uploadId`, `branch` and the RPC `method` (each ≤ 500 chars) — never prompts,
  file contents or terminal input. `ping`, `hello`, `stats_interest` and
  `term_resize` are not logged; an identical row from the same socket within 15 s
  is written once (keystrokes, upload chunks). `support.http`: method and path
  (no query) of every non-GET request, written before the handler runs; a refused
  one has `"refused": true`. **Fail closed:** if the row cannot be written the
  frame is not run (error) and the request answers 503. The in-memory registry of
  open grants and their session hashes means a normal user's request never
  touches SQLite for this. `support.ui` / `support.http` are left out of the
  team's general audit page (they have their own log).
- **Nothing is left behind.** A support account cannot create or approve device
  enrollments, link sign-in methods, accept invitations, create teams, request
  erasure of itself (which would erase its log rows) or register for push
  (`support_forbidden`, `account_deletion`, `register_push`); owner-only team
  operations (invite, roles, transfer, delete, grants) already refuse it. It sees
  only the machines and projects the owner has shared with the team, and what it
  does there is the role's ordinary reach. Runs it started keep running after the
  grant ends (they belong to the machine, and are visible in the log).

## Packaging

`deploy/selfhost/` is the whole customer kit (Russian README inside):

- `Dockerfile` — multi-stage: node 22 (shared, the **external** agent bundle,
  web + light shell) → rust (the hub; the external bundle is copied over
  `deploy/agent.mjs` so what the binary embeds is never the internal one) →
  debian-slim runtime (non-root `hub`, `/data` volume, healthcheck on
  `/health`). Bases are pinned by tag and digest. A signed release placed in
  `deploy/selfhost/agent-release/` before the build (any `*.sig`) is shipped in
  `/app/agent-release`; otherwise the unsigned bundle is, so the image boots
  and a verifying hub refuses to offer it.
- `compose.yml` — `hub` (read-only root fs, tmpfs `/tmp`, `cap_drop: ALL`,
  `no-new-privileges`, memory/pid limits, healthcheck) and `caddy` (automatic
  HTTPS; every path including the WebSockets `/ui`, `/mobile/ui`, `/agent` goes
  through as-is). The hub is not published; Caddy sits on a fixed subnet that
  `CC_REMOTE_TRUSTED_PROXIES` names, so rate limits see real client addresses.
- `.env.example`, `init.sh` (generates the fleet token), `README.md`.

What makes the hub itself deployable anywhere (all inert for the internal hub):

- No HegAI host in any default: gateway (`LLM_PUBLIC_URL`, agent
  `CC_REMOTE_GATEWAY_URL`), SSO (`HEGAI_SSO_AUTHORIZE_URL`), relay doors
  (`CC_REMOTE_ALT_PORTS`), git author. Unset = off.
- Installers served by the hub (`/go`, `/install/*`) are rewritten to
  `CC_REMOTE_PUBLIC_URL` at serve time (`server-rs/src/selfhost.rs`).
- `/mobile/ui` is served by the hub (no nginx rewrite needed).
- Legal pages: `CC_REMOTE_LEGAL_DIR` or a neutral page — never HegAI's.
- The external edition refuses a fleet token shorter than 32 characters.

Twelve-factor: config only via env, logs to stdout, state in one volume
(`/data`), `/health` healthcheck (the README maps all twelve factors).
Agents run on the host or on employees' machines
(`curl https://<hub>/go | bash`), employee sandboxes are an optional host-level
module (`deploy/sandbox/`; agents there use the hub's public https URL and its
`/install/agent.mjs`).
