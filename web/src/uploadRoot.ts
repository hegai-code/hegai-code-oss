import { useContext } from 'react';
import { ShareRootsContext } from './appHooks.js';
import { shareRootFor } from './components/NewFolderPanel.js';
import type { CentralState } from './useCentral.js';

/** Where a session's big attachments go: its folder on your own machine, the
 *  shared root above it on somebody else's — the only place the hub lets a
 *  member write. */
export function useUploadRoot(central: CentralState, machineId: string, cwd: string | undefined): string | undefined {
  const roots = useContext(ShareRootsContext);
  if (!cwd) return undefined;
  const machine = central.machines.find((m) => m.machine.machineId === machineId);
  if (!machine || machine.canControl === true) return cwd;
  return shareRootFor(cwd, roots.filter((r) => r.machineId === machineId).map((r) => r.cwd)) ?? cwd;
}
