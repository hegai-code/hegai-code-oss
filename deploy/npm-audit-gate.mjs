#!/usr/bin/env node
// CI gate: `npm audit` at high and above, with a short, dated list of advisories
// that have NO fixed release yet and only reach build tooling. `npm audit` has no
// ignore flag, and failing every push on an advisory nobody can fix blocks every
// deploy (18.11.2026: picomatch, every version flagged, via vite).
//
// An entry here is temporary: each one says why it is tolerable and when to look
// again. Anything else at high/critical still fails the build.
//
// Usage: npm audit --json > audit.json; node deploy/npm-audit-gate.mjs < audit.json
import { readFileSync } from 'node:fs';

const ALLOW = new Map([
  // picomatch ReDoS via extglobs. No patched release exists (4.0.7 is the latest
  // and flagged); reached only through vite / tinyglobby / fdir at BUILD time,
  // matching our own globs, never request input. Re-check by 2026-12-18.
  ['GHSA-fc5q-39xc-vjpf', { reason: 'picomatch: no fixed release, build tooling only', expires: '2026-12-18' }],
]);
const HIGH = new Set(['high', 'critical']);

const report = JSON.parse(readFileSync(0, 'utf8'));
// No report (registry unreachable, npm error) is not «clean».
if (report.error || !report.vulnerabilities) {
  console.error('npm audit: no report', JSON.stringify(report.error ?? report).slice(0, 500));
  process.exit(1);
}
const vulns = report.vulnerabilities;
const blocking = [];
const allowed = new Set();
for (const [name, v] of Object.entries(vulns)) {
  for (const via of v.via ?? []) {
    // A string `via` names another package; its own advisories are judged there.
    if (typeof via === 'string' || !HIGH.has(via.severity)) continue;
    const id = String(via.url ?? '').split('/').pop();
    const entry = ALLOW.get(id);
    // The expiry is enforced, not just written down: past it the advisory blocks
    // again and someone has to look (a fix, or a new dated entry).
    if (entry && Date.now() <= Date.parse(`${entry.expires}T23:59:59Z`)) {
      allowed.add(`${id} (${name}): ${entry.reason}, until ${entry.expires}`);
    } else {
      const late = entry ? ` (exception expired ${entry.expires})` : '';
      blocking.push(`${name}: ${via.title ?? id} [${via.severity}] ${via.url ?? ''}${late}`);
    }
  }
}
for (const line of allowed) console.log(`allowed: ${line}`);
if (blocking.length) {
  console.error(`npm audit: ${blocking.length} high/critical advisor${blocking.length === 1 ? 'y' : 'ies'}:`);
  for (const line of blocking) console.error(`  ${line}`);
  process.exit(1);
}
console.log('npm audit: no blocking high/critical advisories');
