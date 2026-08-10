// credential-mask.js — #306 F70. A secret reached user-visible prose.
//
// From asus-CC's 51-index sweep, `.as_ml_code`:
//
//   "The codebase leverages several AI/ML models, including `uqDZ…SPdJ`,
//    which appears to be a locally…"
//
// Source: `claude_pto.py:97`, `API_KEY = "pVJt….uqDZ…SPdJ"` — the SECRET HALF of
// the literal, after the `.` separator.
//
// THE PATH, after asus-CC measured it and withdrew their first diagnosis
// ----------------------------------------------------------------------
// No deterministic tool classified it as a model. `models_used`,
// `referenced_resources`, `vocabulary` and `stats` each returned ZERO hits for
// the token; `models_used` returned 22 real models for that index. What returned
// it was `search`, verbatim, as a raw source line. The model then filled the
// mandated AI/ML sentence with the most model-shaped token in its context.
//
// So this masks at the TOOL-OUTPUT seam, which is upstream of every consumer:
// model context, CLI, GUI. Fixing it at the prose layer would leave the value in
// context and still print it from a `search` at the terminal.
//
// MASK, NEVER SUPPRESS — and this is the design decision, not a detail
// --------------------------------------------------------------------
// The instinct is to drop the line. That is wrong for CE's users. For a code
// examiner, "there is a hardcoded credential at claude_pto.py:97" is a FINDING —
// it is the kind of thing an examination exists to surface. So the value goes and
// everything else stays:
//
//   claude_pto.py:97   API_KEY = "<redacted 40-char secret>"
//
// The examiner keeps file, line, identifier and the fact. The model never sees a
// token it can mistake for a model name. A client never receives the value.
//
// NOT A PRECEDENT, THOUGH IT LOOKS LIKE ONE: `scrubApiKey` in air-gapped.js
// deletes cloud keys from `process.env`. That is environment hygiene, not text
// redaction — it shares the subject and none of the mechanism. Named here so the
// next reader does not go looking for reuse that is not there.
//
// NAMES ARE NOT MASKED. `OPENAI_API_KEY` appearing as an env-var NAME is what
// `referenced_resources` exists to report — "this app calls OpenAI" is
// orientation, and hiding it degrades the tool for its purpose. CE has no
// index-origin signal, so a hide-by-default rule would blind every public corpus
// to protect a private one that a pre-ship scrub already covers. Only VALUES go.

// Vendor-issued key shapes: unambiguous on their own, no context needed.
const KNOWN_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,                       // OpenAI / Anthropic
  /\bghp_[A-Za-z0-9]{20,}/g,                        // GitHub PAT (classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,                // GitHub PAT (fine-grained)
  /\bAKIA[0-9A-Z]{12,}/g,                           // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,                // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/g,                      // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

// Assignment context: a literal assigned to a secret-named identifier. This is
// what catches `.as_ml_code` — `pVJt….uqDZ…SPdJ` matches no vendor shape, and
// entropy alone would be far too broad (minified identifiers and hashes are
// high-entropy and legitimate; masking on entropy would gut every bundled file).
// The IDENTIFIER is what makes the detector specific.
const SECRET_NAME = '[A-Za-z0-9_.\\[\\]"\'-]*(?:secret|passwd|password|token|api_?key|apikey|credential|auth)[A-Za-z0-9_.\\[\\]"\'-]*';
const ASSIGNED = new RegExp(
  `(${SECRET_NAME}\\s*(?:=|:|=>|:=)\\s*)(['"\`])([^'"\`\\n]{8,})(\\2)`, 'gi');

const _mask = (n) => `<redacted ${n}-char secret>`;

/**
 * Mask credential VALUES in a block of text, preserving structure.
 * @param {string} text tool output
 * @returns {string}
 */
export function maskCredentials(text) {
  let s = String(text ?? '');
  if (!s) return s;
  // Assignment form first: it keeps the identifier and quotes, so a later
  // vendor-shape pass cannot re-match inside an already-masked span.
  s = s.replace(ASSIGNED, (_m, lhs, q, val) => `${lhs}${q}${_mask(val.length)}${q}`);
  for (const re of KNOWN_SHAPES) s = s.replace(re, (m) => _mask(m.length));
  return s;
}

/** Did masking change anything? For callers that want to log or count. */
export function hasCredential(text) {
  const s = String(text ?? '');
  return !!s && maskCredentials(s) !== s;
}
