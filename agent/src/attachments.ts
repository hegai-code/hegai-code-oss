import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FileInput } from '@cc-remote/shared';

/**
 * Non-image attachments, turned into something a coding agent can actually use.
 *
 * An image has to be inlined as a vision block. A file does not, and inlining
 * one would be the wrong shape anyway: a 200-page PDF or a 40k-line log is not a
 * thing to paste into a prompt. What every CLI in this product already has is a
 * Read tool — so the bytes are written to a scratch directory on this machine
 * and the turn simply says where they are. No new runtime capability, identical
 * for Claude and Codex, and the model reads only the parts it needs.
 *
 * The scratch dir lives for the run, not the turn: a file attached in the third
 * message is still readable in the tenth, which is what a person expects after
 * dropping it into the conversation.
 */

/** Per-run scratch dir, created on first use. */
export class AttachmentStore {
  private dir?: string;

  /** `base`: where the scratch dir goes (a confined run's own bound dir); default the OS tmpdir. */
  constructor(private readonly base?: string) {}

  /**
   * Write these files and return the note to prepend to the turn.
   *
   * Returns an empty string for an empty list, so callers can concatenate
   * unconditionally.
   */
  materialize(files: FileInput[] | undefined): string {
    if (!files?.length) return '';
    if (this.base) mkdirSync(this.base, { recursive: true, mode: 0o700 });
    this.dir ??= mkdtempSync(path.join(this.base ?? tmpdir(), 'ccr-files-'));
    const written: string[] = [];
    const used = new Set<string>();
    for (const file of files) {
      try {
        const target = path.join(this.dir, uniqueName(safeName(file.name), used));
        writeFileSync(target, Buffer.from(file.data, 'base64'));
        written.push(target);
      } catch (err) {
        // One unwritable attachment must not lose the person's message.
        console.error(`[agent] could not write attachment ${file.name}:`, (err as Error).message);
      }
    }
    if (!written.length) return '';
    const lines = written.map((p) => `- ${p}`).join('\n');
    return `[${written.length} file(s) attached to this message, saved on this machine:\n${lines}\nRead them with your file tools.]\n\n`;
  }

  /** Drop the scratch dir. Called when the run ends — not between turns. */
  cleanup(): void {
    if (!this.dir) return;
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // A temp dir we failed to remove is the OS's problem, not a run's.
    }
    this.dir = undefined;
  }
}

/**
 * A filename reduced to something safe to join onto a directory.
 *
 * The name arrives from a browser and is attacker-controlled in a shared
 * workspace: `../../.ssh/authorized_keys` would otherwise be an arbitrary write
 * as whichever unix user the agent runs as. `path.basename` alone is not enough
 * — it keeps a leading dot, and on Windows it does not strip a `C:` prefix — so
 * everything outside a conservative set is replaced.
 *
 * Exported for tests.
 */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9._ \-()Ѐ-ӿ]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'attachment';
}

/**
 * Keep two same-named attachments in one turn from overwriting each other —
 * and ONLY then. Suffixing by position instead would rename files that never
 * collided, so a person who attached `notes.txt` and `report.pdf` would be told
 * to read `report-1.pdf`, a path that matches nothing they sent.
 */
function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  if (used.has(candidate)) {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let n = 1;
    do {
      candidate = `${stem}-${n}${ext}`;
      n += 1;
    } while (used.has(candidate));
  }
  used.add(candidate);
  return candidate;
}
