import type { MachineSnapshot, RuntimeStatus } from '@cc-remote/shared';
import { pickRuntime, runtimeUsable } from '../components/runtimeChips.js';

/**
 * The two choices the light shell makes so the person does not have to: which
 * machine, and which runtime on it.
 *
 * In the full client both are controls — a server chip and a Claude/Codex
 * switch — because the people it was built for run eight machines and care
 * which one. Here the question on screen is «что сделать», and «где» is an
 * answer the product already has for anybody with one computer connected. The
 * choice is still SHOWN (the project sheet names the machine) and still
 * changeable there; it is just never the first thing asked.
 */

export type Engine = 'claude' | 'codex';

/** Has the machine said it can start a session on at least one runtime? */
export function hasUsableRuntime(r: RuntimeStatus | undefined): boolean {
  return runtimeUsable(r, 'claude') || runtimeUsable(r, 'codex');
}

/**
 * A machine a NEW project may be created on: the viewer controls it, it is
 * connected, and its owner has not made it chat-only (the agent refuses
 * `projects.create` there). Narrower than «may start a session», which a
 * control-share member can do in a folder they were given.
 */
export function canCreateOn(m: MachineSnapshot): boolean {
  return m.online && m.canControl === true && m.machine.policy?.chatOnly !== true;
}

export interface MachineChoice {
  viewerId?: string;
  /** The machine picked last time, if it is still a candidate. */
  remembered?: string;
  runtimesOf: (m: MachineSnapshot) => RuntimeStatus | undefined;
}

/**
 * Where a new project goes. A machine that can actually run something beats
 * one that cannot; among those, the person's own beats one they were given
 * control of; among those, the remembered pick, then the one they worked on
 * last. Returns `undefined` only when there is nowhere at all.
 */
export function pickMachine(machines: MachineSnapshot[], choice: MachineChoice): MachineSnapshot | undefined {
  const rank = (m: MachineSnapshot): [number, number, number, number] => [
    hasUsableRuntime(choice.runtimesOf(m)) ? 0 : 1,
    !m.owner || m.owner.userId === choice.viewerId ? 0 : 1,
    m.machine.machineId === choice.remembered ? 0 : 1,
    -m.sessions.reduce((t, s) => Math.max(t, s.lastModified), 0),
  ];
  return machines
    .filter(canCreateOn)
    .map((m) => ({ m, r: rank(m) }))
    .sort((a, b) => {
      for (let i = 0; i < a.r.length; i++) {
        if (a.r[i] !== b.r[i]) return a.r[i]! - b.r[i]!;
      }
      return a.m.machine.machineId < b.m.machine.machineId ? -1 : 1;
    })[0]?.m;
}

/**
 * Is a new session here pinned to the machine's Codex, whatever is asked for?
 *
 * The hub does that to a team member on a machine they do NOT control — a
 * folder shared to them — so they never spend the owner's Claude login. The
 * test is the machine, not the role: a member on their own computer chooses
 * like anybody else. (The full start screen hides its picker by role alone,
 * which is a control it can afford to be coarse about; here the answer also
 * decides which mode list is offered and what the task is drawn as while it
 * starts, so it has to be the hub's own rule.)
 */
export function pinnedToCodex(m: Pick<MachineSnapshot, 'canControl'> | undefined, isMember: boolean): boolean {
  return isMember && m?.canControl !== true;
}

/** The runtime a new task starts on: Codex where the hub pins it, otherwise
 *  the preferred one unless only the other can start. */
export function pickEngine(r: RuntimeStatus | undefined, opts: { preferred: Engine; pinned: boolean }): Engine {
  if (opts.pinned) return 'codex';
  return pickRuntime(r, opts.preferred);
}

/** Why the composer cannot send, in the order a person would have to fix it. */
export type StartBlock = 'no-machine' | 'no-runtime' | null;

/**
 * Whether there is anywhere to start at all. `targets` is how many existing
 * projects the viewer may start in (their own machines' and the folders shared
 * to them); a member with a shared folder and no machine of their own is not
 * blocked.
 */
export function startBlock(
  machines: MachineSnapshot[],
  runtimesOf: (m: MachineSnapshot) => RuntimeStatus | undefined,
): StartBlock {
  const startable = machines.filter((m) => m.online && (m.canControl === true || m.canStart === true));
  if (!startable.length) return 'no-machine';
  // A member's machine does not report its runtimes to them (controllers
  // only), which reads as unknown — usable.
  if (!startable.some((m) => hasUsableRuntime(runtimesOf(m)))) return 'no-runtime';
  return null;
}
