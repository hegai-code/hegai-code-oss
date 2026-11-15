import { storageGet, storageSet } from '../storage.js';

/** Whether a person has finished or skipped the first-run screens. Kept out of
 *  `Onboarding.tsx` so the app shell can ask without loading that chunk. */
const KEY = 'cc-onboarding';

/** Per person, not per browser: a shared laptop greets the next account. */
export function onboardingDone(userId: string): boolean {
  return storageGet(KEY)?.split(',').includes(userId) ?? false;
}

export function markOnboardingDone(userId: string): void {
  const prev = (storageGet(KEY) ?? '').split(',').filter(Boolean);
  if (!prev.includes(userId)) storageSet(KEY, [...prev, userId].join(','));
}

