/**
 * `GET /api/public-config` — what the sign-in screen may know before anyone is
 * signed in: the edition, the product's name on this hub and which ways in are
 * switched on. Fetched once at boot (`main.tsx`) and kept; every screen reads
 * the same answer.
 *
 * `null` means «this hub did not answer it» (an older hub, a network blip): the
 * UI then behaves as the internal edition always has. A network failure is NOT
 * remembered, so the next screen asks again.
 */
import { useEffect, useState } from 'react';
import { PublicConfig } from '@cc-remote/shared';

let pending: Promise<PublicConfig | null> | undefined;
let settled: PublicConfig | null | undefined;

export function loadPublicConfig(): Promise<PublicConfig | null> {
  pending ??= fetch('/api/public-config', { credentials: 'same-origin' })
    .then(async (response) => {
      const parsed = response.ok ? PublicConfig.safeParse(await response.json().catch(() => null)) : null;
      settled = parsed?.success ? parsed.data : null;
      return settled;
    })
    .catch(() => {
      pending = undefined;
      return null;
    });
  return pending;
}

/** `undefined` while the first answer is on its way, then the config or `null`. */
export function usePublicConfig(): PublicConfig | null | undefined {
  const [config, setConfig] = useState<PublicConfig | null | undefined>(settled);
  useEffect(() => {
    if (settled !== undefined) {
      setConfig(settled);
      return;
    }
    let live = true;
    void loadPublicConfig().then((value) => {
      if (live) setConfig(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return config;
}

/** Whether to offer the desktop app here: the hub says so (`desktopApps`); an
 *  older hub that does not say counts as ours only when it is the internal
 *  edition. Unknown (config not loaded or failed) is «no»: offering an app the
 *  hub cannot hand out is the worse error. */
export function desktopAppsOffered(config: PublicConfig | null | undefined): boolean {
  return config?.desktopApps ?? config?.edition === 'internal';
}

/** The customer's own hub. Everything edition-specific in the UI keys on this. */
export function isExternal(config: PublicConfig | null | undefined): boolean {
  return config?.edition === 'external';
}
