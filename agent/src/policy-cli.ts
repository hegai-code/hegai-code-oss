import {
  addSyncProject,
  loadPolicy,
  policyFile,
  removeSyncProject,
  setSyncMode,
  writeChatOnly,
  writePrivate,
  writeRetentionDays,
} from './policy.js';

/**
 * `node agent.mjs policy …` — the machine owner's own controls (policy.ts),
 * run ON the machine. The hub has no way to call this; that is what makes it
 * the owner's. The running agent reads the file once at start, so a change
 * takes effect when the agent restarts (its supervisor starts it again).
 *
 *   policy                         show what is in force
 *   policy chat-only on|off        terminal, file/git writes, kill, runtime
 *                                  install/login and no-approval modes off/on
 *   policy sync all|selected       every session leaves the machine / only picked folders
 *   policy sync add <folder>       pick a folder (switches to «selected»)
 *   policy sync remove <folder>
 *   policy retention <days>|off    how long the hub may keep a transcript
 *   policy private on|off          end-to-end encrypted sessions (docs/E2EE.md);
 *                                  then `--pair` prints the code for a device
 */
export function runPolicyCli(args: string[]): number {
  const [what, arg, dir] = args;
  try {
    if (what === 'chat-only' && (arg === 'on' || arg === 'off')) {
      writeChatOnly(arg === 'on');
    } else if (what === 'sync' && (arg === 'all' || arg === 'selected')) {
      setSyncMode(arg);
    } else if (what === 'sync' && arg === 'add' && dir) {
      setSyncMode('selected');
      addSyncProject(dir);
    } else if (what === 'sync' && arg === 'remove' && dir) {
      removeSyncProject(dir);
    } else if (what === 'private' && (arg === 'on' || arg === 'off')) {
      writePrivate(arg === 'on');
    } else if (what === 'retention' && arg === 'off') {
      writeRetentionDays(undefined);
    } else if (what === 'retention' && arg !== undefined && /^\d+$/.test(arg) && Number(arg) >= 1) {
      writeRetentionDays(Number(arg));
    } else if (what !== undefined) {
      console.error('usage: policy [chat-only on|off | sync all|selected | sync add <folder> | sync remove <folder> | retention <days>|off | private on|off]');
      return 64;
    }
  } catch (err) {
    console.error(`policy: ${(err as Error).message}`);
    return 1;
  }
  const p = loadPolicy();
  console.log(`file:      ${policyFile()}`);
  console.log(`chat-only: ${p.chatOnly ? 'on' : 'off'}`);
  console.log(`sync:      ${p.sync === 'all' ? 'all sessions' : `only ${p.sync.projects.length ? p.sync.projects.join(', ') : '(no folders yet)'}`}`);
  console.log(
    `retention: ${p.transcriptRetentionDays === undefined ? 'the hub keeps transcripts' : `the hub keeps a transcript ${p.transcriptRetentionDays} day(s) after it was last written`}`,
  );
  console.log(`private:   ${p.private ? 'on - content leaves only as ciphertext (--pair prints the code)' : 'off'}`);
  if (what !== undefined) console.log('Restart the agent to apply.');
  return 0;
}
