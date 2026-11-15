// Preloaded by `npm test` (--import): tests must never touch the real
// ~/.cc-remote of the machine they run on — a live agent keeps its run-state
// files there. Always overridden here; individual tests may still point CC_REMOTE_STATE_DIR elsewhere.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

{
  process.env['CC_REMOTE_STATE_DIR'] = mkdtempSync(path.join(os.tmpdir(), 'ccr-test-state-'));
}
