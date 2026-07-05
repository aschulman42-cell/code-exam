/**
 * version.js - CodeExam server build counter.
 *
 * SERVER_BUILD is a manual restart canary. Node loads `src/` modules once at
 * process start, so edits to backend code take effect only after a full
 * server restart. Bump SERVER_BUILD on every backend (`src/`) change that
 * requires a restart, so the running build can be checked against the
 * expected value -- it is printed in the startup banner and served at
 * /api/version.
 *
 * Deliberately NOT derived from git: a commit SHA does not change for
 * uncommitted edits, which is exactly when the staleness problem bites.
 */
export const SERVER_BUILD = 43;

// #215: the PRODUCT version, read from package.json — distinct from
// SERVER_BUILD above (a dev restart canary; see #264 on the two being
// conflated in the GUI). Used by the provenance header. Falls back
// gracefully when package.json isn't on disk next to src/ (e.g. a compiled
// standalone exe — acceptable for Phase 1; revisit if the exe build should
// embed it).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
export const CE_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    return pkg.version ? `v${pkg.version}` : 'v?';
  } catch { return 'v? (version unavailable in this build)'; }
})();
