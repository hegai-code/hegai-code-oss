#!/usr/bin/env bash
# hegai-pdca: weekly failure review of Claude sessions. Proposals only.
#   hegai-pdca            run now (also what hegai-pdca.service executes)
#   DAYS=7                window; PDCA_CPU_BUDGET caps digest CPU seconds
# Logs to /var/log/hegai-pdca.log. Never edits CLAUDE.md, skills, memory or repos:
# the model gets Read/Grep/Glob, Write only under /root/.claude/pdca and /tmp, and
# Bash only for `hegai-fleet report publish|list`.
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
STATE=/root/.claude/pdca
LOG=/var/log/hegai-pdca.log
DAYS="${DAYS:-7}"
DATE="$(date +%F)"
umask 077
OUT="$(mktemp -d "/tmp/pdca-$DATE.XXXXXX")" || exit 1  # private, unpredictable: root writes here
DIGEST="$OUT/digest.json"
export IS_SANDBOX=1 PATH="/usr/local/bin:/usr/bin:/bin:$PATH" HOME=/root

mkdir -p "$STATE/proposals"; chmod 700 "$STATE"
exec >>"$LOG" 2>&1
echo "=== $(date -Is) hegai-pdca start (days=$DAYS)"

# serialize: a second run must not interleave
exec 9>"$STATE/.lock"
flock -n 9 || { echo "another run holds the lock; exit"; exit 0; }

# 1. digest (signals only, redacted, <=150 KB)
nice -n 10 python3 "$HERE/digest.py" --days "$DAYS" --out "$DIGEST" --cpu-budget "${PDCA_CPU_BUDGET:-50}" || {
  echo "digest failed"; exit 1; }

FROM="$(date -d "-$DAYS days" +%d.%m)"; TO="$(date +%d.%m)"
PARAMS="## Параметры запуска
- Дайджест: $DIGEST
- Дата запуска: $DATE; окно: ${FROM}–${TO} ($DAYS дн.)
- Название отчёта: PDCA за неделю ${FROM}–${TO}
- <OUT> = $OUT — рабочий каталог для записи (report.html, log-entry.md, state.json, proposals.patch)
- Дата для журнала и патча: $DATE; публикуй именно $OUT/report.html
- Читать можно: $STATE/log.md (журнал), $STATE/state.json (id опубликованного отчёта)"

# 2. headless Claude. dontAsk = anything not allowed below is denied, nobody is asked.
# The model has no Bash at all: reads are scoped (rules, memory, journal, the work dir) and it
# only writes into $OUT. Publishing is done below by this script, with fixed arguments, so a
# prompt planted in a transcript cannot read credentials or touch other reports.
# Writes use Edit(...) rules: Claude Code matches path rules for the Write tool through Edit.
cd "$STATE" || exit 1
timeout --kill-after=30 1800 claude -p "$(cat "$HERE/PROMPT.md"; printf '\n\n%s\n' "$PARAMS")" \
  --model opus --effort high \
  --permission-mode dontAsk \
  --tools "Read,Grep,Glob,Write" \
  --allowedTools "Read(/$OUT/**)" "Grep(/$OUT/**)" "Glob(/$OUT/**)" \
      "Read(//root/.claude/CLAUDE.md)" "Read(//root/.claude/pdca/**)" "Read(//root/.claude/projects/*/memory/**)" \
      "Read(//srv/**/CLAUDE.md)" "Read(//srv/**/AGENTS.md)" "Read(//srv/main-source/.agents/skills/**)" \
      "Grep(//root/.claude/projects/*/memory/**)" "Grep(//root/.claude/pdca/**)" "Glob(//root/.claude/projects/*/memory/**)" \
      "Edit(/$OUT/**)" \
  --setting-sources "" \
  --no-session-persistence \
  --max-budget-usd 20 \
  --output-format text
rc=$?
echo "claude exit=$rc"

if [ "$rc" -ne 0 ]; then
  echo "model failed or timed out; staged output NOT promoted"; rm -f "$DIGEST"; exit "$rc"
fi

# 3. publish the report (fixed arguments; --id only from our own state.json) and verify it
if [ -s "$OUT/report.html" ]; then
  rid="$(python3 -c "import json,re;d=json.load(open('$STATE/state.json'));print(d['report_id'] if re.fullmatch(r'[0-9a-f]{32}',d['report_id']) else '')" 2>/dev/null || true)"
  desc="$(head -c 300 "$OUT/description.txt" 2>/dev/null | tr '\n' ' ')"
  pub="$(hegai-fleet report publish "$OUT/report.html" --title "PDCA за неделю ${FROM}–${TO}" \
         --description "${desc:-Недельный разбор сбоев агентной разработки}" ${rid:+--id "$rid"} 2>&1)"
  echo "publish: $pub" | head -c 400; echo
  newid="$(grep -oE '[0-9a-f]{32}' <<<"$pub" | head -1)"
  if [ -n "$newid" ] && hegai-fleet report list | grep -q "^$newid"; then
    URL="https://code.acme.test/w/reports/$newid"
    printf '{"report_id": "%s", "url": "%s", "updated": "%s"}\n' "$newid" "$URL" "$DATE" >"$STATE/state.json"
    echo "report published: $URL"
  else echo "report publish NOT verified"; rc=1; fi
else echo "report.html missing"; rc=1; fi

# 4. promote the model's staged journal entry and patch into the state dir
if [ -s "$OUT/log-entry.md" ] && grep -q "^## $DATE" "$OUT/log-entry.md"; then
  entry="$(sed "s|{{REPORT_URL}}|${URL:-не опубликован}|g" "$OUT/log-entry.md")"
  grep -q "^## $DATE" "$STATE/log.md" 2>/dev/null || { printf '\n%s\n' "$entry" >>"$STATE/log.md"; }
  echo "log.md: entry for $DATE appended"
else echo "log.md: NO entry staged for $DATE"; fi
P="$STATE/proposals/$DATE.patch"
if [ -s "$OUT/proposals.patch" ]; then
  cp "$OUT/proposals.patch" "$P"
  # dry-run only; the patch is never applied by this script. Model-authored headers must stay inside
  # the allowed trees before patch(1) is pointed at the root filesystem.
  if ! python3 - "$P" <<'PY'
import re, sys
hdr = [l.split("\t")[0].split(None, 1)[1].strip() for l in open(sys.argv[1], errors="replace")
       if re.match(r"(---|\+\+\+) ", l)]
bad = [h for h in hdr if h != "/dev/null" and (".." in h or not re.fullmatch(r"[ab]/(root/\.claude|srv)/\S*", h))]
sys.exit(1 if bad else 0)
PY
  then echo "patch $P: header paths outside /root/.claude and /srv, or '..': not validated"
  elif out="$(patch -p1 -d / --dry-run <"$P" 2>&1)"; then
    echo "patch $P: applies (dry-run ok$(grep -q fuzz <<<"$out" && echo ', but with fuzz: context lines are inexact'))"
  else echo "patch $P: does NOT apply cleanly (dry-run failed): $(head -c 300 <<<"$out" | tr '\n' ' ')"; fi
else echo "patch: none staged"; fi
rm -f "$DIGEST"  # keep report.html and the rest of $OUT for inspection
echo "=== $(date -Is) hegai-pdca end rc=$rc"
exit "$rc"
