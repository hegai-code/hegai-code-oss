import { useEffect, useMemo, useState } from 'react';
import type { CentralState } from '../useCentral.js';
import { claudeOff, runtimeChips, runtimeUsable } from './runtimeChips.js';

/**
 * Which machine is «this one» for the first-run screens, and what the desktop
 * app says about installing its agent. Extracted from the old «Начало» block so
 * the onboarding is the only place that decides it.
 *
 * The desktop app knows its own machine (`window.__HEGAI_AGENT__.machineId`); a
 * browser cannot, so it takes the one online machine of the person's own — the
 * common case — and offers a picker when there are several, preferring one with
 * something to fix.
 */
export type ShellAgent = { phase: 'checking' | 'signed_out' | 'installing' | 'installed' | 'waiting' | 'failed' | 'disconnected' | 'offer' | 'declined'; machineId?: string; reason?: string; hub?: string };

/** The shell's consent bridge (0.1.32+). Absent in older shells, which install
 *  on their own and never report `offer` — feature-detect, never assume. */
type AgentApi = { connect: () => Promise<unknown>; decline: () => Promise<unknown> };
function agentApi(): AgentApi | undefined {
  const a = (window as { __HEGAI_AGENT_API__?: Partial<AgentApi> }).__HEGAI_AGENT_API__;
  return a && typeof a.connect === 'function' && typeof a.decline === 'function' ? (a as AgentApi) : undefined;
}

/** «Подключить»: the person's yes. False when this shell cannot take it. */
export async function connectShellAgent(): Promise<boolean> {
  const api = agentApi();
  if (!api) return false;
  try { await api.connect(); return true; } catch { return false; }
}

/** «Не подключать»: remembered by the shell per hub. Safe to call anywhere —
 *  a no-op outside the shell or in a shell that has no such command. */
export async function declineShellAgent(): Promise<void> {
  try { await agentApi()?.decline(); } catch { /* shell refused: nothing to decline */ }
}

function readShellAgent(): ShellAgent | undefined {
  const a = (window as { __HEGAI_AGENT__?: ShellAgent }).__HEGAI_AGENT__;
  return a && typeof a === 'object' && typeof a.phase === 'string' ? a : undefined;
}

type Machine = CentralState['machines'][number];

/** The person's own (controllable) machines. */
export function ownMachines(central: Pick<CentralState, 'machines'>): Machine[] {
  return central.machines.filter((m) => m.canControl !== false);
}

/** Is at least one of Claude / Codex signed in on this machine? An agent too
 *  old to report counts as signed in — second-guessing it would nag people whose
 *  setup works. */
export function machineHasLogin(central: Pick<CentralState, 'runtimes'>, m: Machine): boolean {
  const r = central.runtimes[m.machine.machineId] ?? m.runtimes;
  if (!r || (!r.claude && !r.codex)) return true;
  const claude = !!r.claude && !claudeOff(r) && r.claude.present && runtimeUsable(r, 'claude');
  const codex = !!r.codex && r.codex.present && runtimeUsable(r, 'codex');
  return claude || codex;
}

/** Should the first-run screens show by themselves: no machine of one's own, or
 *  no coder signed in on any of them. */
export function needsOnboarding(central: Pick<CentralState, 'machines' | 'runtimes'>): boolean {
  const own = ownMachines(central);
  return own.length === 0 || !own.some((m) => machineHasLogin(central, m));
}

/** What the desktop shell says about installing its agent, live. */
export function useShellAgent(): ShellAgent | undefined {
  const [shellAgent, setShellAgent] = useState<ShellAgent | undefined>(() => readShellAgent());
  useEffect(() => {
    const onChange = () => setShellAgent(readShellAgent());
    window.addEventListener('hegai-agent', onChange);
    return () => window.removeEventListener('hegai-agent', onChange);
  }, []);
  return shellAgent;
}

export function useMachinePick(central: CentralState) {
  const own = useMemo(() => ownMachines(central), [central.machines]); // eslint-disable-line react-hooks/exhaustive-deps
  const shellAgent = useShellAgent();
  const shellMachine = shellAgent?.machineId;
  const preferred = useMemo(() => {
    const online = own.filter((m) => m.online);
    const attn = online.find((m) => runtimeChips(central.runtimes[m.machine.machineId] ?? m.runtimes)?.some((c) => c.tone === 'attn'));
    return (
      own.find((m) => m.machine.machineId === shellMachine)?.machine.machineId ??
      attn?.machine.machineId ??
      online[0]?.machine.machineId ??
      own[0]?.machine.machineId
    );
  }, [own, central.runtimes, shellMachine]);
  const [picked, setPicked] = useState<string | undefined>();
  const machineId = picked && own.some((m) => m.machine.machineId === picked) ? picked : preferred;
  const machine = own.find((m) => m.machine.machineId === machineId);
  return { own, machine, machineId, setPicked, shellAgent, shellMachine };
}
