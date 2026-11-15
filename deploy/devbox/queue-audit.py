#!/usr/bin/env python3
"""hegai-queue-audit: read-only audit of git worktrees, branches and live sessions.

Usage: hegai-queue-audit [path...] [--json] [--stale-days N] [--fetch]

Scans every git repo directly under /srv (and /srv/*/ one level down) plus
linked worktrees, or the given paths. Prints per worktree: branch, HEAD,
age, dirty files, ahead/behind the default branch, merged flag, live
claude/codex/node/npm processes whose cwd is inside it. Never modifies a
repo: git runs with GIT_OPTIONAL_LOCKS=0; only --fetch touches remote refs.
There is deliberately no prune mode.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = "/srv"
PROCS = {"claude", "codex", "node", "npm"}
ENV = dict(os.environ, GIT_OPTIONAL_LOCKS="0", LC_ALL="C", GIT_TERMINAL_PROMPT="0")


def git(cwd, *args, timeout=20):
    try:
        r = subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", cwd, *args],
                           capture_output=True, text=True, timeout=timeout, env=ENV)
    except (subprocess.TimeoutExpired, OSError):
        return None
    return r.stdout if r.returncode == 0 else None


def has_git(p):
    return os.path.exists(os.path.join(p, ".git"))


def discover(roots):
    out = []
    for root in roots:
        root = os.path.realpath(root)
        top = git(root, "rev-parse", "--show-toplevel") if os.path.isdir(root) else None
        if top:
            out.append(top.strip())
            continue
        try:
            kids = sorted(os.scandir(root), key=lambda e: e.name)
        except OSError:
            continue
        for k in kids:
            if not k.is_dir(follow_symlinks=False):
                continue
            if has_git(k.path):
                out.append(k.path)
                continue
            try:
                for g in os.scandir(k.path):
                    if g.is_dir(follow_symlinks=False) and has_git(g.path):
                        out.append(g.path)
            except OSError:
                pass
    return out


def common_dir(path):
    """Common git dir without spawning git: .git dir, or .git file of a linked worktree."""
    g = os.path.join(path, ".git")
    try:
        if os.path.isdir(g):
            return os.path.realpath(g)
        with open(g) as f:
            gd = f.read().strip().removeprefix("gitdir:").strip()
    except OSError:
        return None
    gd = os.path.realpath(os.path.join(path, gd))
    parent = os.path.dirname(gd)
    return os.path.dirname(parent) if os.path.basename(parent) == "worktrees" else gd


def group_repos(candidates):
    """common-git-dir -> one candidate path (dedupe worktrees and nested repos)."""
    groups = {}
    for c in candidates:
        cd = common_dir(c)
        if cd:
            groups.setdefault(cd, c)
    return groups


def own_chain():
    """This process and its ancestors: the session running the audit is not 'someone else'."""
    chain, pid = set(), os.getpid()
    while pid > 1 and pid not in chain:
        chain.add(pid)
        try:
            with open(f"/proc/{pid}/stat") as f:
                pid = int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return chain


def live_processes():
    res = []
    skip = own_chain()
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) in skip:
            continue
        try:
            with open(f"/proc/{pid}/comm") as f:
                comm = f.read().strip()
            if comm not in PROCS:
                continue
            cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            continue
        res.append((int(pid), comm, cwd))
    return res


def default_branch(repo):
    ref = git(repo, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD")
    if ref and ref.strip():
        return ref.strip()
    for cand in ("origin/main", "origin/master", "main", "master"):
        if git(repo, "rev-parse", "--verify", "-q", cand + "^{commit}"):
            return cand
    return None


def parse_worktrees(common_cand):
    txt = git(common_cand, "worktree", "list", "--porcelain") or ""
    wts, cur = [], {}
    for line in txt.splitlines() + [""]:
        if not line:
            if cur:
                wts.append(cur)
            cur = {}
            continue
        k, _, v = line.partition(" ")
        cur[k] = v
    return wts


def audit_repo(cand, procs, stale_days, do_fetch, wex):
    wts = parse_worktrees(cand)
    if not wts:
        return None
    main_path = wts[0]["worktree"]
    fetch_ok = True
    if do_fetch:
        fetch_ok = git(main_path, "fetch", "--quiet", "--no-tags", timeout=60) is not None
    dflt = default_branch(main_path)
    dflt_local = dflt.split("/", 1)[1] if dflt and dflt.startswith("origin/") else dflt
    now = time.time()
    all_paths = [w["worktree"] for w in wts]
    info = {}
    if dflt:
        fe = git(main_path, "for-each-ref", "refs/heads",
                 f"--format=%(refname:short)\t%(committerdate:unix)\t%(objectname:short)\t%(ahead-behind:{dflt})") or ""
        for line in fe.splitlines():
            n, ts, sha, ab = line.split("\t")
            ahd, bhd = ab.split()
            info[n] = (int(ts), sha, int(ahd), int(bhd))
    out = {"repo": main_path, "default": dflt, "worktrees": [], "orphan_branches": [],
           "fetch": "ok" if do_fetch and fetch_ok else "failed" if do_fetch else "no"}
    checked_out = set()
    for w in wts:
        if w.get("branch"):
            checked_out.add(w["branch"].replace("refs/heads/", ""))

    def one(iw):
        i, w = iw
        path = w["worktree"]
        branch = w.get("branch", "").replace("refs/heads/", "") or None
        e = {"path": path, "main": i == 0, "branch": branch or "(detached)",
             "head": w.get("HEAD", "")[:7], "flags": []}
        if w.get("bare") is not None:
            return None
        if not os.path.isdir(path):
            e["flags"].append("каталога нет (prunable)")
            return e
        if branch in info:
            e["last_commit_ts"] = info[branch][0]
        else:
            ct = git(path, "log", "-1", "--format=%ct")
            e["last_commit_ts"] = int(ct) if ct and ct.strip().isdigit() else None
        e["age_days"] = round((now - e["last_commit_ts"]) / 86400, 2) if e["last_commit_ts"] else None
        st = git(path, "status", "--porcelain")
        e["dirty"] = len(st.splitlines()) if st is not None else None
        if dflt:
            if branch in info:
                e["ahead"], e["behind"] = info[branch][2], info[branch][3]
            else:
                lr = git(path, "rev-list", "--left-right", "--count", f"{dflt}...HEAD")
                if lr:
                    b, a = lr.split()
                    e["behind"], e["ahead"] = int(b), int(a)
            e["merged"] = e.get("ahead") == 0  # HEAD is an ancestor of the default branch
        else:
            e["merged"] = None
        up = git(path, "rev-list", "--count", "HEAD", "--not", "--remotes")
        e["unpushed"] = int(up) if up and up.strip().isdigit() else None
        # deepest worktree owning the cwd
        mine = []
        for pid, comm, cwd in procs:
            owners = [p for p in all_paths if cwd == p or cwd.startswith(p.rstrip("/") + "/")]
            if owners and max(owners, key=len) == path:
                mine.append({"pid": pid, "comm": comm})
        e["procs"] = mine
        is_default = branch is not None and branch == dflt_local
        old = e["age_days"] is not None and e["age_days"] >= stale_days
        if (not e["main"] and not is_default and e.get("merged") and e["dirty"] == 0
                and not mine and old and fetch_ok):  # refs are stale after a failed --fetch
            e["flags"].append("можно убрать")
        if mine and e["dirty"]:
            e["flags"].append("чужая работа идёт")
        if e["unpushed"]:
            e["flags"].append("расходится с origin")
        return e

    out["worktrees"] = [e for e in wex.map(one, enumerate(wts)) if e]
    def orphan(item):
        name, (ts, sha, ahd, _) = item
        unp = git(main_path, "rev-list", "--count", f"refs/heads/{name}", "--not", "--remotes")
        return {"branch": name, "head": sha, "age_days": round((now - ts) / 86400, 2), "ahead": ahd,
                "unpushed": int(unp) if unp and unp.strip().isdigit() else None}

    todo = [(n, v) for n, v in info.items() if v[2] > 0 and n not in checked_out and n != dflt_local]
    out["orphan_branches"] = list(wex.map(orphan, todo))
    return out


def fmt_age(d):
    if d is None:
        return "?"
    if d < 1 / 24:
        return f"{int(d * 1440)}м"
    if d < 1:
        return f"{int(d * 24)}ч"
    return f"{int(d)}д"


def render(repos):
    lines = []
    for r in repos:
        lines.append(f"== {r['repo']}  (база: {r['default'] or 'не найдена'})"
                     + ("  [fetch не удался: «можно убрать» отключено]" if r.get("fetch") == "failed" else ""))
        for w in r["worktrees"]:
            if "age_days" not in w:
                lines.append(f"  {w['path']}  {'; '.join(w['flags'])}")
                continue
            ab = f"+{w.get('ahead', '?')}/-{w.get('behind', '?')}"
            merged = "слита" if w.get("merged") else "не слита"
            procs = ",".join(f"{p['comm']}:{p['pid']}" for p in w["procs"]) or "-"
            mark = "*" if w["main"] else " "
            lines.append(f" {mark}{w['path']}")
            lines.append(f"     {w['branch']} @{w['head']}  коммит {fmt_age(w['age_days'])} назад  "
                         f"грязных {w['dirty']}  {ab}  {merged}  процессы {procs}")
            if w["flags"]:
                lines.append("     >> " + "; ".join(w["flags"]))
        for b in r["orphan_branches"]:
            push = "не запушена" if b["unpushed"] else "запушена"
            lines.append(f"   ветка без worktree: {b['branch']} @{b['head']}  "
                         f"+{b['ahead']}  {fmt_age(b['age_days'])}  {push}")
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(prog="hegai-queue-audit", description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--stale-days", type=float, default=1.0)
    ap.add_argument("--fetch", action="store_true", help="git fetch each repo first (touches remote refs only)")
    a = ap.parse_args()
    t0 = time.time()
    procs = live_processes()
    with ThreadPoolExecutor(16) as ex, ThreadPoolExecutor(16) as wex:
        groups = group_repos(discover(a.paths or [ROOT]))
        res = list(ex.map(lambda c: audit_repo(c, procs, a.stale_days, a.fetch, wex), groups.values()))
    repos = sorted((r for r in res if r), key=lambda r: r["repo"])
    if a.json:
        json.dump({"generated": int(t0), "stale_days": a.stale_days, "repos": repos},
                  sys.stdout, ensure_ascii=False, indent=1)
        print()
    else:
        print(render(repos))
        n = sum(len(r["worktrees"]) for r in repos)
        flagged = {f: sum(1 for r in repos for w in r["worktrees"] if f in w["flags"])
                   for f in ("можно убрать", "чужая работа идёт", "расходится с origin")}
        print(f"репо {len(repos)}, worktree {n}, "
              + ", ".join(f"{k}: {v}" for k, v in flagged.items())
              + f"  ({time.time() - t0:.1f} с)")


if __name__ == "__main__":
    main()
