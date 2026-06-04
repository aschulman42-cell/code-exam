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
export const SERVER_BUILD = 36;
