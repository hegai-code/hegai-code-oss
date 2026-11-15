#!/usr/bin/env python3
"""Fail over the hub's three public names; read-only unless --apply is given."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

PRIMARY = "203.0.113.133"
BACKUP = "198.51.100.233"
RECORDS = {"code.acme.test": 10505414, "claude.acme.test": 10505415,
           "remote.acme.test": 10621565}
API = "https://api.gcore.com/dns/v2/zones/acme.test/"
MAX_GAP = 90


def probe(ip, name="code.acme.test"):
    # Pin the address while retaining Host, SNI and normal certificate validation.
    # A redirect, proxy or a healthy relay nginx with a dead hub is not success.
    try:
        result = subprocess.run(
            ["curl", "--noproxy", "*", "--silent", "--show-error", "--fail",
             "--connect-timeout", "3", "--max-time", "6", "--max-filesize", "4096",
             "--resolve", f"{name}:443:{ip}", "--write-out", "\n%{http_code}",
             f"https://{name}/health"],
            capture_output=True, text=True, timeout=8, check=False)
        body, status = result.stdout.rsplit("\n", 1)
        return result.returncode == 0 and status == "200" and json.loads(body) == {"ok": True}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def advance(previous, primary_ok, backup_ok, now):
    """Only consecutive, recent observations contribute to a switch."""
    fresh = 0 <= now - previous.get("observed_at", 0) <= MAX_GAP
    old = previous if fresh else {}
    state = {"observed_at": now}
    for name, healthy in (("primary", primary_ok), ("backup", backup_ok)):
        state[name + "_ok"] = min(old.get(name + "_ok", 0) + 1, 20) if healthy else 0
    state["primary_down"] = min(old.get("primary_down", 0) + 1, 3) if not primary_ok else 0
    target = None
    if state["primary_down"] >= 3 and state["backup_ok"] >= 3:
        target = BACKUP
    elif state["primary_ok"] >= 20:
        target = PRIMARY
    return state, target


def observe(previous, health, now):
    states, targets = {}, {}
    for name in RECORDS:
        old = previous.get(name, {})
        if not isinstance(old, dict) or any(
                not isinstance(old.get(field, 0), (int, float))
                or not 0 <= old.get(field, 0) < float("inf")
                for field in ("observed_at", "primary_ok", "backup_ok", "primary_down")):
            old = {}
        states[name], targets[name] = advance(old, health[name][PRIMARY], health[name][BACKUP], now)
    return states, targets


def validate(rrset, name):
    """Refuse to replace GeoDNS, extra addresses or a manual third destination."""
    if (rrset.get("id") != RECORDS[name] or rrset.get("name") != name
            or rrset.get("type") != "A" or rrset.get("ttl") != 120
            or rrset.get("meta") or rrset.get("pickers")
            or rrset.get("filter_set_id") or rrset.get("filters")):
        raise ValueError(f"unmanaged RRset configuration: {name}")
    records = rrset.get("resource_records", [])
    if (len(records) != 1 or records[0].get("enabled") is not True
            or records[0].get("meta") or records[0].get("content") not in ([PRIMARY], [BACKUP])):
        raise ValueError(f"unmanaged address configuration: {name}")
    return records[0]["content"][0]


class Gcore:
    def __init__(self, key):
        self.key = key
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, name, payload=None):
        request = urllib.request.Request(
            API + name + "/A", method="GET" if payload is None else "PUT",
            data=None if payload is None else json.dumps(payload).encode(),
            headers={"Authorization": "APIKey " + self.key, "Content-Type": "application/json"})
        with self.opener.open(request, timeout=10) as response:
            return json.load(response)


def reconcile(api, targets, apply):
    before = {name: api.request(name) for name in RECORDS}
    addresses = {name: validate(rrset, name) for name, rrset in before.items()}
    print(json.dumps({"addresses": addresses, "targets": targets, "apply": apply}), flush=True)
    if not apply:
        return
    for name in RECORDS:
        target = targets[name]
        if target is None or addresses[name] == target:
            continue
        if not probe(target, name):
            raise ValueError("destination stopped responding before DNS update")
        # Gcore has no documented conditional PUT. Re-read immediately before
        # writing and refuse drift rather than reverting an operator's edit.
        if api.request(name) != before[name]:
            raise ValueError(f"RRset changed during observation: {name}")
        payload = {"ttl": 120, "meta": {}, "pickers": [], "resource_records": [
            {"content": [target], "enabled": True, "meta": {}}]}
        api.request(name, payload)
        if validate(api.request(name), name) != target:
            raise ValueError(f"DNS readback mismatch: {name}")
        print(f"switched {name} to {target}", flush=True)


def save_state(path, state):
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(state, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    import fcntl  # Linux-only service; pure decision logic is also tested on Windows.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    args = parser.parse_args()
    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (args.state_dir / "lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state_path = args.state_dir / "state.json"
        try:
            old = json.loads(state_path.read_text())
            if not isinstance(old, dict):
                raise ValueError("state must be an object")
        except (FileNotFoundError, ValueError):
            old = {}
        health = {name: {} for name in RECORDS}
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            jobs = {(name, ip): pool.submit(probe, ip, name)
                    for name in RECORDS for ip in (PRIMARY, BACKUP)}
            for (name, ip), future in jobs.items():
                health[name][ip] = future.result()
        state, targets = observe(old, health, time.time())
        print(json.dumps({"health": health, "state": state}), flush=True)
        if args.apply:
            save_state(state_path, state)
        reconcile(Gcore(args.key_file.read_text().strip()), targets, args.apply)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # HTTP exception bodies/headers may contain account details. Log no key,
        # payload or arbitrary server error; systemd records the failed run.
        print(f"dns-failover failed: {type(error).__name__}", flush=True)
        raise SystemExit(1)
