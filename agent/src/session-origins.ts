import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './atomic-write.js';

/** Undelivered creation outcomes, containing IDs only. Persist before any user
 * input can reach the runtime; replay until the hub durably acknowledges them. */
export class SessionOrigins {
  private readonly pending = new Map<string, string | null>();
  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    const rows: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(rows) || rows.length > 1024) throw new Error('Invalid session-origin journal');
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string'
          || (row[1] !== null && typeof row[1] !== 'string')) throw new Error('Invalid session-origin journal');
      this.pending.set(row[0], row[1]);
    }
  }
  entries(): Array<[string, string | null]> { return [...this.pending]; }
  record(runId: string, sessionId: string | null): void {
    if (this.pending.size >= 1024 && !this.pending.has(runId)) throw new Error('Hub has not acknowledged session origins; reconnect before starting more sessions');
    const next = new Map(this.pending); next.set(runId, sessionId);
    this.save(next); this.pending.set(runId, sessionId);
  }
  acknowledge(runId: string): void {
    if (!this.pending.has(runId)) return;
    const next = new Map(this.pending); next.delete(runId);
    this.save(next); this.pending.delete(runId);
  }
  private save(rows: Map<string, string | null>): void {
    writeFileAtomicSync(this.file, JSON.stringify([...rows]), { mode: 0o600, mkdir: 0o700 });
  }
}
