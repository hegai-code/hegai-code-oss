#!/usr/bin/env python3
"""Weekly failure digest of Claude session transcripts (signals only, secrets redacted).

Usage: digest.py [--days 7] [--out FILE] [--max-bytes 150000] [--cpu-budget 50]

Reads /root/.claude/projects/*/*.jsonl and the subagent transcripts stored as
<project>/<session>/subagents/agent-*.jsonl, modified in the last N days.
Streams line by line; never emits whole files. Output is JSON: per-session
corrections by the user, tool errors, risky git operations, CI failures and
files edited more than 3 times, plus cross-session error clusters.
Secrets (sk-..., gho_..., password=, URLs with credentials, long hex/base64)
are redacted before anything is stored.
"""
import argparse
import glob
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

PROJECTS = "/root/.claude/projects"
MAX_FILE = 200 * 1024 * 1024
MAX_LINE = 1024 * 1024
SKIP_TYPES = re.compile(rb'\{"type":"(?:api-request|queue-operation|session-owner|atis-latch|last-prompt|mode"|'
                        rb'tools-used|cost-state|custom|file-history|permission-mode)')

# ---------------------------------------------------------------- redaction
_SECRET_RES = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", re.S),
    re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{6,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,}|\bglpat-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_\-]{30,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{8,}"),
    re.compile(r"(?i)[a-z0-9+.\-]+://[^/\s:@'\"]+:[^@\s/'\"]+@"),
    re.compile(r"(?i)[\"']?\b[\w\-]*(?:password|passwd|pwd|secret|token|api[_\-]?key|apikey|authorization|credential)[\w\-]*[\"']?"
               r"\s*[=:]\s*(?:\\?\"[^\"]*\\?\"|'[^']*'|[^\s,;&\"']+)"),
]
_LONG_RE = re.compile(r"(?<![\w/.\-])[A-Za-z0-9+/=_\-]{33,}(?![\w/.\-])")


def _long_cb(m):
    s = m.group(0)
    if s.startswith("/") or not re.search(r"[A-Za-z]", s) or re.fullmatch(r"[A-Za-z]+(?:[-_][A-Za-z]+)+", s):
        return s  # a path, digits only, or a kebab/snake_case name: not a key
    return "[REDACTED]"


def redact(s):
    if not s:
        return s
    for r in _SECRET_RES:
        s = r.sub(lambda m: "[REDACTED]", s)
    return _LONG_RE.sub(_long_cb, s)


def clip(s, n):
    # redact before clipping so the cut cannot leave half a secret; the generous window keeps big inputs cheap
    s = redact(" ".join((s or "")[: n * 4 + 200].split()))
    return s[:n] + ("…" if len(s) > n else "")


# ------------------------------------------------------------------ signals
COMPLAINT = re.compile(
    r"не так|всрато|почему|не работает|не работают|сломал|ты вообще|что за\b|опять\b|ебать|\bеб[а-я]*|хуйн|хуев|хуйня|"
    r"верни|зачем|блять|\bбля\b|нахуй|нахер|я же (?:просил|говорил|сказал|писал)|я просил|как так|не то\b|не туда|"
    r"снова\b|стоп\b|хватит|откати|откат\b|не вижу|не вышло|не получилось|не помогло|так и не|до сих пор|"
    r"опять не|всё ещё|все еще|всё равно|а где\b|ничего не", re.I)
REPORT = re.compile(r"готово|задеплоил|выкатил|проверил|сделано|запушил|✅|раскатал|починил|исправил|завершил|done\b", re.I)
RISKY = re.compile(
    r"git\s+(?:revert|reset\s+--hard|restore\b|checkout\s+(?:--|\.)|clean\s+-\w*f|stash\s+(?:drop|clear)|branch\s+-D|"
    r"push\b[^|;&]*(?:--force|-f\b|--force-with-lease)|rebase\b|commit\b[^|;&]*--no-verify|worktree\s+remove)|"
    r"\brm\s+-\w*r\w*f|\brm\s+-\w*f\w*r|--no-verify|--force\b", re.I)
CI_FAIL = re.compile(
    r"llm-review:?\s*FAIL|ci-ok[^\n]{0,40}(?:fail|красн|упал|нет)|(?:\bCI\b|пайплайн|pipeline|workflow|forgejo|actions?|llm-review)"
    r"[^\n]{0,50}(?:fail(?:ed|ure)?|красн\w*|упал\w*|провал\w*)|(?:fail(?:ed|ure)?|красн\w*|упал\w*)[^\n]{0,30}"
    r"(?:\bCI\b|пайплайн|pipeline|workflow|llm-review)|status:\s*failure|conclusion[\"']?:\s*[\"']?failure", re.I)
EXIT_RE = re.compile(r"^Exit code (\d+)")
SYSTEM_PREFIX = ("<system-reminder", "<command-", "<local-command", "<task-notification", "<user-prompt-submit",
                 "Caveat:", "This session is being continued", "<bash-", "<ide_", "[Image")


def _ci_hint(s):
    s = s[:2500].lower()
    return "fail" in s or "красн" in s or "упал" in s or "провал" in s


def blocks(content):
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content if isinstance(content, list) else []


def text_of(content):
    return "\n".join(b.get("text", "") for b in blocks(content) if b.get("type") == "text")


def result_text(b):
    c = b.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    return ""


def norm_sig(s):
    s = re.sub(r"\d+", "N", s.lower())
    s = re.sub(r"[0-9a-f]{7,}", "H", s)
    s = re.sub(r"/[\w.\-/]+", "/P", s)
    return " ".join(s.split())[:90]


class Session:
    def __init__(self, sid, project):
        self.sid, self.project = sid, project
        self.title = None
        self.first_user = None
        self.first_ts = None
        self.last_ts = None
        self.n_user = 0
        self.entrypoint = None
        self.corrections = []
        self.errors = []
        self.risky = []
        self.ci = []
        self.edits = Counter()
        self.tool_names = Counter()
        self.last_assistant = ""
        self.pending = None
        self.tool_use = {}
        self.n_interrupts = 0
        self.n_err_total = 0
        self.n_corr = self.n_risky = self.n_ci = 0
        self.trig = Counter()

    def score(self):
        rep = sum(1 for c in self.edits.values() if c > 3)
        return (len(self.corrections) * 3 + self.n_interrupts * 2 + min(self.n_err_total, 30) * 0.3
                + len(self.risky) * 2 + len(self.ci) * 2 + rep * 2)


def handle(d, ses, sub, cutoff, clusters):
    t = d.get("type")
    if t == "ai-title":
        ses.title = d.get("aiTitle") or ses.title
        return
    if t not in ("user", "assistant"):
        return
    ts = d.get("timestamp") or ""
    if ts and ts < cutoff:
        return
    if ts:
        ses.first_ts = ses.first_ts or ts
        ses.last_ts = ts
    msg = d.get("message") or {}
    content = msg.get("content")
    if t == "assistant":
        txt = "" if sub else text_of(content)
        if txt.strip():
            ses.last_assistant = txt
            if ses.pending is not None and not ses.pending.get("after"):
                ses.pending["after"] = clip(txt, 220)
            if _ci_hint(txt) and CI_FAIL.search(txt[:3000]):
                m = CI_FAIL.search(txt[:3000])
                ses.n_ci += 1
                if len(ses.ci) < 5:
                    ses.ci.append({"ts": ts, "src": "assistant", "text": clip(txt[max(0, m.start() - 80):m.end() + 160], 260)})
        for b in blocks(content):
            if b.get("type") != "tool_use":
                continue
            name, inp = b.get("name", "?"), b.get("input") or {}
            ses.tool_names[name] += 1
            if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                fp = inp.get("file_path") or inp.get("notebook_path")
                if fp:
                    ses.edits[fp] += 1
            cmd = inp.get("command") if name == "Bash" else None
            if cmd:
                m = RISKY.search(cmd)
                if m:
                    ses.n_risky += 1
                if m and len(ses.risky) < 10:
                    ses.risky.append({"ts": ts, "cmd": clip(cmd, 180)})
            ses.tool_use[b.get("id")] = (name, " ".join(str(cmd or inp.get("file_path") or inp.get("pattern") or "")[:160].split()))
            if len(ses.tool_use) > 300:
                ses.tool_use.pop(next(iter(ses.tool_use)))
        return
    # ---- user line
    bl = blocks(content)
    human_txt = []
    for b in bl:
        bt = b.get("type")
        if bt == "tool_result":
            rt = result_text(b)
            is_err = bool(b.get("is_error"))
            m = EXIT_RE.match(rt)
            if is_err or m:
                ses.n_err_total += 1
                name, cmd = ses.tool_use.get(b.get("tool_use_id"), ("?", ""))
                if "doesn't want to proceed" in rt[:200] or "was rejected" in rt[:200]:
                    kind = "rejected"
                elif m:
                    kind = f"exit {m.group(1)}"
                else:
                    kind = "error"
                body = rt.split("\n", 1)[1] if m and "\n" in rt else rt
                sig = norm_sig(f"{name} {kind} {body[:120]}")
                c = clusters[sig]
                c["n"] += 1
                c["sessions"].add(ses.sid)
                c.setdefault("example", {"tool": name, "kind": kind, "cmd": redact(cmd), "err": clip(body, 200)})
                if len(ses.errors) < 12:
                    ses.errors.append({"ts": ts, "tool": name, "kind": kind, "cmd": redact(cmd), "err": clip(body, 200)})
            elif ses.tool_use.get(b.get("tool_use_id"), ("",))[0] == "Bash" and _ci_hint(rt) \
                    and "digest.py" not in ses.tool_use[b.get("tool_use_id")][1] and CI_FAIL.search(rt[:2500]):
                mm = CI_FAIL.search(rt[:2500])
                ses.n_ci += 1
                if len(ses.ci) < 5:
                    ses.ci.append({"ts": ts, "src": "tool_result", "text": clip(rt[max(0, mm.start() - 80):mm.end() + 160], 260)})
        elif bt == "text":
            human_txt.append(b.get("text", ""))
    if sub or any(b.get("type") == "tool_result" for b in bl) or d.get("isMeta") or d.get("isCompactSummary"):
        return
    txt = "\n".join(human_txt).strip()
    if not txt or txt.startswith(SYSTEM_PREFIX):
        return
    first = ses.n_user == 0
    ses.n_user += 1
    if first:
        ses.first_user = clip(txt, 200)
        ses.entrypoint = d.get("entrypoint")
        if len(txt) > 800:
            return  # generated/pipeline prompt, not a correction
    if txt.startswith("[Request interrupted"):
        ses.n_interrupts += 1
        trig = ["interrupt"]
    else:
        if len(txt) > 1500:
            return
        trig = list({m.group(0).lower() for m in COMPLAINT.finditer(txt)})
        if "?" in txt and len(txt) < 250 and REPORT.search(ses.last_assistant[-800:] or ""):
            trig.append("?после-отчёта")
    if trig:
        ses.n_corr += 1
        ses.trig.update(trig)
    if trig and len(ses.corrections) < 25:
        ses.pending = {"ts": ts, "user": clip(txt, 350), "triggers": trig[:4],
                       "before": clip(ses.last_assistant[-300:], 220)}
        ses.corrections.append(ses.pending)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--out")
    ap.add_argument("--max-bytes", type=int, default=150_000)
    ap.add_argument("--cpu-budget", type=float, default=50.0)
    a = ap.parse_args()
    now = time.time()
    cutoff_dt = datetime.fromtimestamp(now - a.days * 86400, timezone.utc)
    cutoff = cutoff_dt.strftime("%Y-%m-%dT%H:%M:%S")
    cpu0 = time.process_time()

    files = []
    for pat, sub in ((f"{PROJECTS}/*/*.jsonl", False), (f"{PROJECTS}/*/*/subagents/*.jsonl", True)):
        for f in glob.glob(pat):
            try:
                st = os.stat(f)
            except OSError:
                continue
            if st.st_mtime >= now - a.days * 86400:
                files.append((st.st_mtime, f, sub, st.st_size))
    files.sort(reverse=True)

    sessions, clusters = {}, defaultdict(lambda: {"n": 0, "sessions": set()})
    skipped, truncated, scanned = [], 0, 0
    for _, f, sub, size in files:
        if size > MAX_FILE:
            skipped.append(f"{f.replace(PROJECTS + '/', '')} ({size // 1_000_000} MB > 200 MB)")
            continue
        if time.process_time() - cpu0 > a.cpu_budget:
            truncated += 1
            continue
        rel = f[len(PROJECTS) + 1:].split("/")
        project = rel[0]
        sid = rel[1] if sub else rel[1][:-6]
        ses = sessions.setdefault((project, sid), Session(sid, project))
        scanned += 1
        try:
            fh = open(f, "rb")
        except OSError:
            continue
        with fh:
            for line in fh:
                if line.startswith(b'{"type":"'):
                    if SKIP_TYPES.match(line):
                        continue  # api-request*, queue-operation, session-owner, ... carry no signals
                else:
                    head = line[:200]
                    if b'"attachment":' in head or b'"type":"system"' in head:
                        continue
                if len(line) > MAX_LINE and b'"is_error":true' not in line and b'"is_error": true' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                handle(d, ses, sub, cutoff, clusters)

    out_sessions = []
    for ses in sessions.values():
        rep = [{"file": redact(p), "edits": n} for p, n in ses.edits.most_common(8) if n > 3]
        if not (ses.n_corr or ses.errors or ses.n_risky or ses.n_ci or rep):
            continue
        out_sessions.append({
            "session": ses.sid[:8], "project": ses.project.lstrip("-"),
            "date": (ses.first_ts or "")[:10], "title": clip(ses.title or ses.first_user or "", 100),
            "entrypoint": ses.entrypoint, "user_msgs": ses.n_user, "interrupts": ses.n_interrupts, "n_corrections": ses.n_corr,
            "n_risky": ses.n_risky, "n_ci": ses.n_ci,
            "tool_errors_total": ses.n_err_total, "score": round(ses.score(), 1),
            "corrections": ses.corrections[:8], "tool_errors": ses.errors[:4],
            "risky_ops": ses.risky[:4], "ci_failures": ses.ci[:2], "repeated_edits": rep[:4]})
    out_sessions.sort(key=lambda s: -s["score"])

    cl = sorted(clusters.items(), key=lambda kv: -kv[1]["n"])
    error_clusters = [{"signature": redact(k), "count": v["n"], "sessions": len(v["sessions"]), "example": v["example"]}
                      for k, v in cl if v["n"] >= 3][:25]
    trig = Counter()
    for ses in sessions.values():
        trig.update(ses.trig)
    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window_days": a.days, "since": cutoff + "Z",
        "files_scanned": scanned, "files_candidates": len(files), "skipped": skipped[:20],
        "files_not_scanned_cpu_budget": truncated,
        "totals": {"sessions_with_signals": len(out_sessions), "corrections": sum(s["n_corrections"] for s in out_sessions),
                   "tool_errors": sum(s["tool_errors_total"] for s in out_sessions),
                   "risky_ops": sum(s["n_risky"] for s in out_sessions),
                   "ci_failures": sum(s["n_ci"] for s in out_sessions),
                   "interrupts": sum(s["interrupts"] for s in out_sessions)},
        "trigger_counts": dict(trig.most_common(20)),
        "error_clusters": error_clusters,
        "sessions": [],
        "cpu_seconds": 0,
    }
    # keep the JSON under the cap: strongest sessions first; the rest become one-line stubs
    doc["sessions"] = []
    stubs = []
    used = len(json.dumps(doc, ensure_ascii=False).encode()) + len(json.dumps(error_clusters, ensure_ascii=False).encode()) + 20_000
    for s_ in out_sessions:
        n = len(json.dumps(s_, ensure_ascii=False).encode())
        if used + n <= a.max_bytes:
            doc["sessions"].append(s_)
            used += n
        else:
            stubs.append(f"{s_['session']} {s_['project']} {s_['date']} score={s_['score']} corr={len(s_['corrections'])} "
                         f"err={s_['tool_errors_total']} :: {s_['title'][:60]}")
    doc["other_sessions_one_line"] = stubs[:120]
    doc["sessions_not_detailed"] = len(stubs)
    doc["cpu_seconds"] = round(time.process_time() - cpu0, 1)
    s = json.dumps(doc, ensure_ascii=False, indent=None)
    while len(s.encode()) > a.max_bytes and (doc["other_sessions_one_line"] or len(doc["sessions"]) > 1):
        if doc["other_sessions_one_line"]:
            doc["other_sessions_one_line"] = doc["other_sessions_one_line"][: len(doc["other_sessions_one_line"]) // 2]
        else:
            doc["sessions"].pop()
        s = json.dumps(doc, ensure_ascii=False, indent=None)
    if a.out:
        with open(a.out, "w") as fh:
            fh.write(s)
        os.chmod(a.out, 0o600)
        print(f"digest: {len(s)} bytes, {scanned}/{len(files)} files, {len(out_sessions)} sessions, "
              f"{doc['cpu_seconds']} cpu-s -> {a.out}", file=sys.stderr)
    else:
        print(s)


if __name__ == "__main__":
    main()
