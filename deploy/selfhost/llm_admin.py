#!/usr/bin/env python3
"""Bifrost admin calls for ./llm.sh. Not meant to be run by hand.

Secrets never travel in argv (it is world-readable in /proc): the admin
password and a provider's API key come in the environment.

  BF_URL        http://<bifrost container address>:8080
  BF_USER / BF_PASS   admin credentials (auth_config)
  TEMPLATE_SEAT       the seat new people's keys are cloned from
                      (CC_REMOTE_LLM_COMMUNITY_TEMPLATE_KEY, default hegai:template-community)
  PROVIDER_KEY        add-pool / add-provider: the upstream key (a local server
                      that ignores keys still gets one: Bifrost routes a
                      person's key only to providers that have a key)

Commands:
  wait                                  until Bifrost answers (2 min)
  add-pool NAME BASE_URL KEYNAME        a CLIProxyAPI account as provider pool-NAME
  add-provider NAME BASE_URL RESPONSES  an OpenAI-compatible API (RESPONSES: 1 if it
                                        speaks the Responses API, else 0)
  remove-provider NAME
  sync                                  route the template and people's keys to every
                                        provider that has a key (after edits in the UI)
  seat EMAIL...                         a key per person, cloned from the template
  status                                providers, people's keys, models the template reaches
  models PROVIDER                       model ids PROVIDER answers through the template
"""
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

URL = os.environ["BF_URL"].rstrip("/")
AUTH = "Basic " + base64.b64encode(
    f"{os.environ['BF_USER']}:{os.environ['BF_PASS']}".encode()
).decode()
TEMPLATE = os.environ.get("TEMPLATE_SEAT") or "hegai:template-community"
SEAT_PREFIX = "hegai:"

# What Codex and other OpenAI-compatible clients send; everything else stays
# off (a subscription proxy has no embeddings, images or files). An upstream
# without RESPONSES still serves Codex: Bifrost turns a Responses request into
# Chat Completions for it.
CHAT = {"list_models": True, "chat_completion": True, "chat_completion_stream": True}
RESPONSES = {"responses": True, "responses_stream": True}


def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(6):
        req = urllib.request.Request(URL + path, data=data, method=method, headers={
            "Authorization": AUTH, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            # Bifrost's SQLite is busy for a while after a start (catalog and
            # pricing sync): a write answers 500 "database is locked".
            if exc.code == 500 and "database is locked" in detail and attempt < 5:
                time.sleep(2 ** attempt)
                continue
            raise SystemExit(f"{method} {path} -> HTTP {exc.code}: {detail}") from None
        except urllib.error.URLError as exc:
            raise SystemExit(f"{method} {path}: Bifrost unreachable ({exc.reason})") from None
    raise SystemExit(f"{method} {path}: Bifrost database stayed locked")


def inference(path, secret):
    req = urllib.request.Request(URL + path, headers={"Authorization": f"Bearer {secret}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read() or b"{}")
    except Exception:
        return {}


def providers():
    """name -> provider body. Bifrost answers a list or {providers: [...]}."""
    body = api("GET", "/api/providers")
    items = body.get("providers") if isinstance(body, dict) else body
    return {p["name"]: p for p in items or [] if isinstance(p, dict) and p.get("name")}


def key_ids(provider):
    """Key ids of PROVIDER. Bifrost 2.x keeps keys behind their own endpoint:
    `keys` in a provider body is accepted on create and silently dropped."""
    body = api("GET", f"/api/providers/{provider}/keys")
    return [k["id"] for k in body.get("keys") or [] if k.get("id") and k.get("enabled", True)]


def seats():
    return {s["name"]: s for s in api("GET", "/api/governance/virtual-keys").get("virtual_keys") or []}


def routed_configs():
    """One provider config per provider that has a key: every pool and API
    the gateway has, equal weight. Writes take `key_ids`; sending `keys` is
    accepted and ignored, which leaves a key that routes nowhere."""
    out = []
    for name in sorted(providers()):
        ids = key_ids(name)
        if ids:
            out.append({"provider": name, "weight": 1, "allowed_models": ["*"], "key_ids": ids})
    return out


def writable_configs(seat):
    """A seat as read (resolved `keys`) turned back into what a write takes.
    Everything else is carried as read - above all `id`: Bifrost matches a
    provider config by id on update, and one without it is recreated, losing
    what the owner set on it (blacklisted models, limits, usage)."""
    out = []
    for p in seat.get("provider_configs") or []:
        c = {k: v for k, v in p.items() if k not in ("keys", "virtual_key_id")}
        c["key_ids"] = [k.get("key_id") or k.get("id") for k in p.get("keys") or [] if k.get("key_id") or k.get("id")]
        out.append(c)
    return out


def put_seat(seat, configs):
    api("PUT", f"/api/governance/virtual-keys/{seat['id']}", {
        "description": seat.get("description") or "",
        "is_active": seat.get("is_active", True),
        "provider_configs": configs,
    })


def sync_routing():
    """The template and people's keys GAIN providers they lack and keep
    everything else as the owner left it (weights, models, limits). A
    provider removed from one key by hand in the Bifrost UI comes back on the
    next add/sync - remove it from the gateway (remove-provider) instead."""
    wanted = routed_configs()
    if not wanted:
        return
    all_seats = seats()
    if TEMPLATE not in all_seats:
        api("POST", "/api/governance/virtual-keys", {
            "name": TEMPLATE,
            "description": "Template for people's keys (llm.sh). Not handed to anyone.",
            "is_active": True,
            "provider_configs": wanted,
        })
        print(f"[llm] template key {TEMPLATE} created")
    # The template and people's keys alike: gain missing providers, refresh
    # key ids, keep weights / models / limits the owner set.
    for name, seat in all_seats.items():
        if not name.startswith(SEAT_PREFIX) and name != TEMPLATE:
            continue
        have = writable_configs(seat)
        known = {c["provider"] for c in have}
        added = [c for c in wanted if c["provider"] not in known]
        # Existing providers get their current key ids (a re-added account
        # has a new key id; the stale one would route nowhere).
        fresh = {c["provider"]: c["key_ids"] for c in wanted}
        changed = bool(added)
        for c in have:
            if c["provider"] in fresh and sorted(c["key_ids"]) != sorted(fresh[c["provider"]]):
                c["key_ids"] = fresh[c["provider"]]
                changed = True
        if changed:
            put_seat(seat, have + added)


def ensure_provider(name, base_url, allowed, key_name, key_value):
    if not key_value:
        raise SystemExit("an API key is required (any word for a local server that ignores it)")
    existing = providers()
    if name not in existing:
        api_new_provider(name, {
            "provider": name,
            "network_config": {
                "base_url": base_url,
                "default_request_timeout_in_seconds": 900,
                "max_retries": 0,
                # The upstream is a container on the compose network or a
                # local model server: Bifrost's SSRF guard would refuse it.
                # Must travel in the same request as base_url.
                "allow_private_network": True,
            },
            "custom_provider_config": {
                "base_provider_type": "openai",
                "is_key_less": False,
                "allowed_requests": allowed,
            },
        })
        print(f"[llm] provider {name} -> {base_url}")
    else:
        print(f"[llm] provider {name} already exists")
    have = api("GET", f"/api/providers/{name}/keys").get("keys") or []
    if not any(k.get("name") == key_name for k in have):
        api("POST", f"/api/providers/{name}/keys", {
            "name": key_name, "value": key_value, "models": ["*"], "weight": 1.0})
    sync_routing()


def api_new_provider(name, body):
    try:
        api("POST", "/api/providers", body)
    except SystemExit as exc:
        if "same as a standard provider" in str(exc):
            raise SystemExit(
                f"«{name}» - встроенный провайдер Bifrost. Назовите иначе (например {name}-api) "
                "или добавьте его в админке (sudo ./llm.sh ui), затем sudo ./llm.sh sync") from None
        raise


def cmd_wait():
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(URL + "/health", timeout=3):
                return
        except Exception:
            time.sleep(2)
    raise SystemExit("Bifrost did not answer within 2 minutes: docker compose logs bifrost")


def check_name(name):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", name):
        raise SystemExit(f"bad name {name!r}: lowercase letters, digits, dashes")


def cmd_seat(emails):
    all_seats = seats()
    tpl = all_seats.get(TEMPLATE)
    if tpl is None or not writable_configs(tpl):
        raise SystemExit("no template key yet: add an account or a provider first")
    # A NEW key: routing and policy from the template, never its config ids
    # (Bifrost matches configs by id - reusing them would touch the template's).
    configs = [{k: c[k] for k in ("provider", "weight", "allowed_models", "blacklisted_models", "key_ids") if k in c}
               for c in writable_configs(tpl)]
    for email in emails:
        email = email.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise SystemExit(f"not an e-mail: {email!r}")
        name = SEAT_PREFIX + email
        if name in all_seats:
            print(f"[llm] {email}: key exists")
            continue
        body = {"name": name, "description": f"llm.sh seat <{email}>", "is_active": True,
                "provider_configs": configs}
        if tpl.get("budget") and tpl["budget"].get("max_limit") is not None:
            body["budget"] = {k: tpl["budget"].get(k) for k in ("max_limit", "reset_duration")}
        if tpl.get("rate_limit"):
            rl = tpl["rate_limit"]
            body["rate_limit"] = {k: rl.get(k) for k in (
                "token_max_limit", "token_reset_duration", "request_max_limit", "request_reset_duration")}
        api("POST", "/api/governance/virtual-keys", body)
        print(f"[llm] {email}: key created")


def template_secret():
    tpl = seats().get(TEMPLATE)
    return (tpl or {}).get("value") or ""


def cmd_models(provider):
    secret = template_secret()
    ids = [m.get("id", "") for m in inference("/v1/models", secret).get("data") or []] if secret else []
    for i in ids:
        if i.startswith(provider + "/"):
            print(i)


def cmd_status():
    provs = providers()
    print("Providers:")
    if not provs:
        print("  (none yet: ./llm.sh add-account NAME  or  ./llm.sh add-provider ...)")
    for name in sorted(provs):
        base = (provs[name].get("network_config") or {}).get("base_url") or "(built-in)"
        print(f"  {name:<16} keys: {len(key_ids(name))}  {base}")
    all_seats = seats()
    people = sorted(n[len(SEAT_PREFIX):] for n in all_seats if n.startswith(SEAT_PREFIX) and n != TEMPLATE)
    print(f"People's keys: {len(people)}" + (f"  ({', '.join(people[:10])}{' ...' if len(people) > 10 else ''})" if people else ""))
    secret = (all_seats.get(TEMPLATE) or {}).get("value") or ""
    if not secret:
        print(f"Template key {TEMPLATE}: missing")
        return
    models = [m.get("id") for m in inference("/v1/models", secret).get("data") or []]
    print(f"Models through the template key: {len(models)}")
    for m in models[:40]:
        print(f"  {m}")


def main(argv):
    if not argv:
        raise SystemExit(__doc__)
    cmd, args = argv[0], argv[1:]
    # Every command waits for /health first: right after a (re)start the
    # container runs but Bifrost is still loading its catalog.
    cmd_wait()
    if cmd == "wait":
        pass
    elif cmd == "add-pool" and len(args) == 3:
        check_name(args[0])
        secret = os.environ.get("PROVIDER_KEY", "")
        if not secret:
            raise SystemExit("PROVIDER_KEY (the CLIProxyAPI api key) is required")
        ensure_provider(f"pool-{args[0]}", args[1], {**CHAT, **RESPONSES}, args[2], secret)
    elif cmd == "add-provider" and len(args) == 3:
        check_name(args[0])
        allowed = {**CHAT, **(RESPONSES if args[2] == "1" else {})}
        # Bifrost appends /v1/... itself: https://api.example.com/v1 -> https://api.example.com
        base = args[1].rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        ensure_provider(args[0], base, allowed, f"{args[0]}-key", os.environ.get("PROVIDER_KEY", "").strip())
    elif cmd == "remove-provider" and len(args) == 1:
        name = args[0]
        if name in providers():
            for seat in seats().values():
                if not seat["name"].startswith(SEAT_PREFIX) and seat["name"] != TEMPLATE:
                    continue
                have = writable_configs(seat)
                if any(c["provider"] == name for c in have):
                    put_seat(seat, [c for c in have if c["provider"] != name])
            api("DELETE", f"/api/providers/{name}")
            print(f"[llm] provider {name} removed")
    elif cmd == "sync" and not args:
        sync_routing()
        print("[llm] шаблон и ключи людей ведут во все провайдеры с ключом")
    elif cmd == "seat" and args:
        cmd_seat(args)
    elif cmd == "status":
        cmd_status()
    elif cmd == "models" and len(args) == 1:
        cmd_models(args[0])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
