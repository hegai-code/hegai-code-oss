import { lazy, Suspense } from 'react';
import { closeBrowser, useBrowserInfo, useBrowserSheet } from './browserApi.js';

// noVNC is ~200 KB nobody needs until the sheet opens.
const BrowserSheet = lazy(() => import('./BrowserSheet.js').then((m) => ({ default: m.BrowserSheet })));

/**
 * Mounted once, at the shell: the sheet is the shell's, so it stays open while
 * the person moves between sessions under it.
 */
export function BrowserSheetHost() {
  const sheet = useBrowserSheet();
  const info = useBrowserInfo();
  if (!sheet || !info) return null;
  return (
    <Suspense fallback={null}>
      <BrowserSheet requested={sheet.profileId} onClose={closeBrowser} />
    </Suspense>
  );
}
