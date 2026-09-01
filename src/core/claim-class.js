/**
 * claim-class.js -- pseudo-claims-statutory-class (#311 track).
 *
 * Every pseudo-claim CE drafted was a method claim (446/446 CE, 160/161
 * sr_gh, measured 2026-08-29) -- not by decision but because the prompt's
 * only example was a method. Andrew: "What I don't want is arbitrarily
 * selecting device vs. method claiming." So the class is chosen by a STATED,
 * DETERMINISTIC rule keyed on the mechanism's shape in the code, its reason
 * recorded per claim. `method` stays the default until the second both-ways
 * measurement is read; `auto` applies this rule; CRM is a mirror class and
 * is never chosen here (explicit request only).
 *
 * The two word lists below are the structure rule's WHOLE vocabulary --
 * stated, not learned, nothing hidden. STRUCTURE_MIN operationalizes
 * "dominated by": structure must strictly beat process AND appear at least
 * twice.
 */
export const STRUCTURE_WORDS = ['index', 'schema', 'format', 'table', 'record', 'layout', 'sidecar', 'serialize', 'deserialize', 'store', 'cache'];
export const PROCESS_WORDS = ['run', 'build', 'scan', 'extract', 'resolve', 'draft', 'pipeline'];
const STRUCTURE_MIN = 2;

/**
 * @param {object} group  a drafting pack: { label, purpose?, docHeader?, resolved|members: [{ name }] }
 * @returns {{ class: 'method'|'system', reason: string, signals: object }}
 */
export function pickClaimClass(group = {}) {
  const label = String(group.label || '');
  const members = group.resolved || group.members || [];
  const names = members.map((m) => String((m && (m.name || m.func)) || '')).filter(Boolean);
  // 1. Component: the group IS a class; its methods are what it is
  //    "configured to" do.
  const prefixes = names.map((n) => (n.includes('::') ? n.split('::')[0] : null)).filter(Boolean);
  let dom = null;
  {
    const c = new Map();
    for (const p of prefixes) c.set(p, (c.get(p) || 0) + 1);
    for (const [k, v] of c) if (!dom || v > dom.v) dom = { k, v };
  }
  if (/^\[class\]/i.test(label)) {
    return { class: 'system', reason: 'component: [class] seed', signals: { domClass: dom ? dom.k : null } };
  }
  if (names.length && dom && dom.v / names.length >= 0.6) {
    return { class: 'system', reason: `component: ${Math.round(100 * dom.v / names.length)}% of members are ${dom.k} methods`, signals: { domClass: dom.k } };
  }
  // 2. Structure vocabulary over process vocabulary.
  const hay = `${label} ${String(group.purpose || '')} ${String(group.docHeader || '')} ${names.join(' ')}`.toLowerCase();
  const count = (ws) => ws.reduce((n, w) => n + (hay.split(w).length - 1), 0);
  const sN = count(STRUCTURE_WORDS);
  const pN = count(PROCESS_WORDS);
  if (sN > pN && sN >= STRUCTURE_MIN) {
    return { class: 'system', reason: `structure vocabulary ${sN} vs process ${pN}`, signals: { structure: sN, process: pN } };
  }
  // 3. Handler / pipeline.
  if (/^\[cmd\]/i.test(label)) return { class: 'method', reason: 'handler: [cmd] seed', signals: { structure: sN, process: pN } };
  if (names.length && !names.some((n) => n.includes('::'))) {
    return { class: 'method', reason: 'free functions, no shared class', signals: { structure: sN, process: pN } };
  }
  return { class: 'method', reason: 'default', signals: { structure: sN, process: pN } };
}
