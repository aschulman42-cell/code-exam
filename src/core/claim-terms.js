/**
 * claim-terms.js -- one definition of "content word" for everything that scores claim text against
 * a corpus: the ballpark screen (scripts/claim-ballpark.mjs), the element genericity score
 * (claim-genericity.js), the index selectivity profile, and the ballpark command when it lands.
 *
 * Moved verbatim from scripts/claim-ballpark.mjs (claim-chart-element-classes, 2026-08-28); the
 * STOP list, the 3-letter acronym rule, the stemmer and the TF x IDF term picker carry their own
 * measurements in the comments below. `contentWords(text)` is the tokenizer the others share.
 */

// Claim boilerplate: words that carry no subject matter. Kept deliberately long -- every one of
// these ranked into a claim's top 8 on the 2026-08-27 litigated set before it was listed.
export const STOP = new Set((
  'a an the of to in on for and or by with as at is are be from that this each when least one any all into than then its it ' +
  'wherein further comprising claim method system said plurality configured device devices first second third information data ' +
  'receiving received receive response based associated including includes include having processor memory computer computing ' +
  'user users apparatus means step steps thereof whether such being between within during through about after before via more ' +
  'other another where which while comprises comprise operable adapted coupled connected corresponding respective determined ' +
  'determining providing provided provide generating generated generate storing stored store using used use selected selecting ' +
  'selection performing performed perform transmitting transmitted transmit sending sent send signal signals value values set ' +
  'portion portions element elements unit units module modules medium program programs instructions executed executable ' +
  'operation operations process processing content items item object objects number amount type types display displaying ' +
  'displayed request requests application applications software hardware interface input output message messages least ' +
  'non-transitory readable storage causing cause caused least also further whereby thereby therein wherein ' +
  // Code-ubiquitous words. The IDF background is CLAIMS, so a word rare in claims but everywhere in code
  // (`file` is in 88% of ExoPlayer3's files) earns a slot it cannot use; the first 385-claim run spent
  // slots on file / make / source / target / directory / string / list.
  'file files make source sources target targets directory directories string strings list lists name names time ' +
  'default defaults option options config configuration mode modes state states server servers client clients ' +
  'error errors return returns object method function class code path paths index key keys node nodes entry entries ' +
  'field fields record records table tables event events format formats size sizes count counts update updates updated ' +
  'check checks read reads write writes load loads call calls start starts stop stops create creates created delete ' +
  'deletes remove removes removed add adds added get gets put puts open opens close closes enable enables enabled ' +
  'disable disables disabled given make makes text line lines block blocks flag flags result results ' +
  // Function words of 4+ letters. Claims are written in the present tense, so `were` / `been` / `have`
  // are RARE in a claim background and scored as distinctive -- `were` took a slot on US claim 347
  // (a DMA controller) before this was listed.
  'were been have having will would shall should could does done there these those their them they what only some same ' +
  'both either neither ever never once upon over under above below along among across against toward towards without ' +
  'whose whom until unless whereas wherever whenever whether although though because since thus hence therefore'
).split(/\s+/));

// A 3-letter token survives only when the claim writes it in capitals -- `DMA`, `LAN`, `API`, `CRC` --
// i.e. it is an acronym, and for a hardware or network claim usually the most distinctive word in it.
// Two-letter ones (`IO`, `IP`, `OS`) stay out: multisect substring-matches, and `ip` is inside `zip`,
// `chip` and `description`.
const ACRONYM_SKIP = new Set(['AND', 'THE', 'NOT', 'FOR']);
const isAcronym = (raw) => raw.length === 3 && raw === raw.toUpperCase() && /^[A-Z][A-Z0-9]{2}$/.test(raw) && !ACRONYM_SKIP.has(raw);

export const contentWords = (text) => String(text || '').replace(/[^A-Za-z0-9-]+/g, ' ').split(' ')
  .filter((raw) => raw.length >= 4 || isAcronym(raw))
  .map((raw) => raw.toLowerCase())
  .filter((w) => !STOP.has(w) && !/^[0-9-]+$/.test(w));

// Crude stem so `player`/`players`, `detect`/`detected`/`detecting` do not take two slots --
// multisect already substring-matches, so the shorter form finds the longer.
export const stem = (w) => w.replace(/(ings?|ations?|ation|ed|es|s|ly)$/, '').slice(0, 6);

/** Document frequency over a background corpus of claim texts. */
export function buildDf(texts) {
  const df = new Map();
  for (const t of texts) for (const w of new Set(contentWords(t))) df.set(w, (df.get(w) || 0) + 1);
  return { df, n: texts.length };
}

/** The claim's n most distinctive words: TF x IDF, stem-deduplicated, shortest surface form kept. */
export function claimTerms(text, bg, n = 8) {
  const tf = new Map();
  for (const w of contentWords(text)) tf.set(w, (tf.get(w) || 0) + 1);
  const scored = [...tf.entries()]
    .map(([w, f]) => [w, f * Math.log((bg.n + 1) / ((bg.df.get(w) || 0) + 1))])
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  const out = [], seen = new Set();
  for (const [w] of scored) { const s = stem(w); if (seen.has(s)) continue; seen.add(s); out.push(w); if (out.length >= n) break; }
  return out;
}
