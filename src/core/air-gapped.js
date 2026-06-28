/**
 * air-gapped.js — the single source of truth for `--air-gapped` (#223).
 *
 * `--air-gapped` is a hard, opt-in promise that CodeExam makes NO cloud-AI call
 * for the run. It blocks the one thing CE controls — its own outbound AI calls —
 * and is honest (via a disclaimer + AIR_GAPPED.md) that it cannot police the
 * environment (network drives, cloud-synced folders, a machine that reconnects).
 *
 * Enforcement is two-layer: index.js / server.js set the flag + scrub the key at
 * startup; every outbound AI call site calls assertLocalOnly() immediately before
 * reaching the network. The local-GGUF path needs no key or network, so it stays
 * available as the air-gapped way to still get AI.
 */

import net from 'net';

let _airGapped = false;
let _allowConnected = false;

/** Turn air-gapped mode on/off for the process. `allowConnected` keeps the block
 *  active on a machine that has a network path (deliberate connected-box runs). */
export function setAirGapped(on, { allowConnected = false } = {}) {
  _airGapped = !!on;
  _allowConnected = !!allowConnected;
}

export function isAirGapped() { return _airGapped; }
export function allowConnected() { return _allowConnected; }

/** Throw a uniform, user-safe error before any outbound AI call when air-gapped.
 *  Call this at every cloud-AI call site, just before the network is touched. */
export function assertLocalOnly(feature) {
  if (_airGapped) {
    throw new Error(
      `--air-gapped: "${feature}" needs a cloud AI call, which is blocked. Use a LOCAL model ` +
      `instead — in the GUI, set the engine to Local in the Workspace pane (LLM controls); on the ` +
      `CLI, pass --model <gguf> (or point CLAIM_SEARCH_API_URL at a localhost LLM). Dropping ` +
      `--air-gapped re-enables cloud calls — only do that if you intend your data to leave this machine.`);
  }
}

/** Belt-and-suspenders: delete ANTHROPIC_API_KEY from the env so the Anthropic
 *  SDK can't silently auto-read it even if a call site is ever missed. */
export function scrubApiKey() {
  delete process.env.ANTHROPIC_API_KEY;
}

/** Best-effort connectivity probe: a short TCP connect to the AI endpoint.
 *  Resolves true if reachable (so the box is NOT actually isolated), false if it
 *  times out / is refused. NOT authoritative — a clean result does not prove
 *  isolation (the disclaimer says so). */
export function checkConnectivity({ host = 'api.anthropic.com', port = 443, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reachable) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve(reachable); };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** Startup gate. Returns null if the run may proceed, or a refusal message if
 *  --air-gapped is set, --allow-connected is NOT, and the internet is reachable
 *  (a contradiction the user should resolve). */
export async function airGappedStartupCheck() {
  if (!_airGapped || _allowConnected) return null;
  const reachable = await checkConnectivity();
  if (!reachable) return null;
  return 'The network appears reachable, but --air-gapped was set. An air-gapped run should be on an isolated machine. ' +
    'Disconnect and retry; or, to keep CodeExam\'s cloud calls blocked on a connected machine, re-run with --allow-connected. ' +
    '(This check is not authoritative — a clean result does NOT prove isolation; see AIR_GAPPED.md.)';
}

/** The runtime CYA disclaimer printed to stderr on every air-gapped run. */
export const AIR_GAPPED_DISCLAIMER =
  '[air-gapped] CodeExam will make no cloud AI call this run; ANTHROPIC_API_KEY is ignored. ' +
  'This does NOT isolate your environment: saving to a network drive or a cloud-synced folder ' +
  '(OneDrive/Dropbox), or a machine that later reconnects, can still move data — that is your ' +
  'responsibility. See AIR_GAPPED.md.';
