// ============================================================================
// claim-chart.js — --claim-chart: ONE element-per-row chart for a real patent
// claim, merged across explicit targets. The client deliverable (#300 Tier 2).
//
// WHY THIS EXISTS. `--claim-analyze` over N targets produces N isolated
// verdicts. On the live '101 run that meant the same structural absence was
// re-derived three times and ~60% of the output was redundant restatement,
// with nothing merged per element. The value here is the MERGE, not the
// batching.
//
// TWO STRUCTURAL RULES, both load-bearing for the artifact:
//
//   1. CE OWNS THE STRUCTURE, the model owns only the cell contents. Rows come
//      from splitClaimElements, the table/caveats/coverage summary are emitted
//      here, and every engine produces the identical skeleton. That is what
//      makes `--llm claude`, `--llm chatgpt`, `--llm gemini` and `--model
//      <gguf>` charts juxtaposable — which is the whole local-vs-cloud
//      argument. If the model formatted, four charts would not be comparable.
//
//   2. VERDICTS ARE NEVER SOFTENED. ABSENT is a result. This file does not
//      argue toward or away from any label; the scope note states a structural
//      fact once instead of the model re-deriving it per element, and that is
//      the only thing it does.
//
// The output is the deliverable, verbatim. Commentary belongs beside it, never
// inside it.
// ============================================================================

import fs from 'node:fs';
import { resolveModel, makeDrafter, claimsCostGate, actualCostLine, resetCloudUsage } from '../core/llm-runner.js';
import { buildClaimAnalyzePrompt, addLineNumbers } from './analyze.js';
import { splitClaimElements, targetsChecksum, dedupeTargets } from './claim-locate.js';
import { readCeVersion } from '../utils.js';
import { buildSymbolTable, verifySymbol, isFound, navigateFrom } from '../core/symbol-verify.js';
import { parseAnalysisLabels, lexicalGate } from './claims-loop.js';

// Mirrors claims-loop's private LABEL_RANK. Duplicated deliberately rather than
// widening this item's file list to re-export it; if a label is ever added,
// both must change together.
const LABEL_RANK = { ABSENT: 0, ASSUMED: 1, PARTIAL: 2, PRESENT: 3 };

// package.json version, best-effort. A chart that cannot say which build made
// it cannot be reproduced.
export { readCeVersion };

export const CHART_DEFAULTS = {
  calleeDepth: 1,          // depth-1 bodies only; depth 2 blew the local context
  maxCalleeBytes: 6000,    // total appended callee source per target
  maxCallees: 6,
};

// Rows come from the CLAIM, not from the model — one row per element, in claim
// order, so every engine's chart lines up row-for-row.
export function buildChartTable(claimText) {
  const elements = splitClaimElements(claimText);
  const lines = ['| # | Claim element | CE finding | Cited code |', '|---|---|---|---|'];
  elements.forEach((e, i) => {
    lines.push(`| ${i + 1} | ${String(e).replace(/\|/g, '\\|')} |  |  |`);
  });
  return { table: lines.join('\n'), elements };
}

// Parse `--targets "file.java@Class::fn;other.java@fn"` or `@targets.txt`.
export function parseTargets(spec) {
  let raw = String(spec || '');
  let source = 'the --targets argument';
  if (raw.startsWith('@')) {
    const path = raw.slice(1);
    try { raw = fs.readFileSync(path, 'utf8'); }
    catch (e) { throw new Error(`cannot read targets file: ${e.message}`); }
    source = `\`${path}\``;
  }
  // Leading `#` lines are PROVENANCE, carried verbatim into the header. This is
  // what makes a targets file self-documenting — the operator (or a future
  // --claim-locate that stamps its own command line into the file it suggests)
  // records how the list was produced, and the chart can then answer for it.
  const provenance = [];
  const targets = [];
  let claimed = null;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const body = t.replace(/^#+\s*/, '');
      const m = /^Targets-checksum:\s*([0-9a-f]+)$/i.exec(body);
      if (m) { claimed = m[1].toLowerCase(); continue; }
      provenance.push(body);
      continue;
    }
    for (const part of t.split(';')) {
      const p = part.trim();
      if (p) targets.push(p);
    }
  }
  // Curating a target list is a legitimate operator action — CE reports it, it
  // does not forbid it. But without this the provenance block would keep
  // vouching for a run that produced a DIFFERENT list than the one below it,
  // which just relocates the honesty problem the block exists to solve.
  //
  // Checksummed BEFORE dedup, deliberately: a duplicate hand-added to a
  // CE-produced file is an edit, and deduping first would hide it.
  const integrity = claimed == null ? null
    : (targetsChecksum(targets) === claimed ? 'unmodified' : 'modified');
  // Defence in depth — a hand-written targets file gets the same protection as
  // a CE-emitted one. A duplicate here would inflate the per-element agreement
  // count, which is the one number in the chart a reader cannot sanity-check.
  const { targets: unique, duplicates, containers } = dedupeTargets(targets);
  return { targets: unique, provenance, source, integrity, duplicates, containers };
}

// Depth-1 callee BODIES for the analysed function.
//
// This is the #300 Tier-1 fix. On the live run the model wrote "the function
// calls determineIdealSelectedIndex(...) to select a track. However, the
// determination uses bufferedDurationUs…" — it INFERRED what the crux function
// did because the prompt held only the target's own source. A digest would not
// have fixed that: a digest lists callee NAMES. The bodies are what settle it.
export function collectCalleeBodies(index, symbols, seed, opts = {}) {
  const depth = opts.calleeDepth ?? CHART_DEFAULTS.calleeDepth;
  const maxBytes = opts.maxCalleeBytes ?? CHART_DEFAULTS.maxCalleeBytes;
  const maxCallees = opts.maxCallees ?? CHART_DEFAULTS.maxCallees;
  if (depth < 1 || !seed) return { text: '', included: [] };

  const nav = navigateFrom(index, seed, { limit: maxCallees * 2 });
  const out = [];
  const included = [];
  let bytes = 0;
  for (const name of (nav.callees || []).slice(0, maxCallees * 2)) {
    if (included.length >= maxCallees || bytes >= maxBytes) break;
    // Resolve within the seed's own file first — a bare callee name is
    // ambiguous index-wide (eight symbols share `updateSelectedTrack`).
    const bare = String(name).replace(/^.*::/, '');
    const local = symbols.filter((s) => s.filepath === seed.filepath && s.bare === bare);
    const v = local.length ? { status: 'exact', matches: local } : verifySymbol(symbols, name);
    if (!isFound(v)) continue;
    const m = v.matches[0];
    let src = null;
    const _log = console.log; console.log = () => {};
    try { src = index.getFunctionSource?.(m.filepath, m.name); } catch { src = null; } finally { console.log = _log; }
    if (!src) continue;
    const clipped = String(src).slice(0, Math.max(0, maxBytes - bytes));
    bytes += clipped.length;
    included.push(m.name);
    // Number each callee with ITS OWN start line. A callee from another file
    // has its own numbering; sharing the target's offset would be worse than no
    // numbers, because it looks authoritative and is wrong.
    const body = m.start != null ? addLineNumbers(clipped, m.start) : clipped;
    out.push(`\n// ---- callee: ${m.name}  (${m.filepath.split('!').pop()}${m.start != null ? `, L${m.start}-${m.end}` : ''}) ----\n${body}`);
  }
  return { text: out.join('\n'), included };
}

// The chart needs machine-parseable per-element verdicts; `--claim-analyze`
// does not. buildClaimAnalyzePrompt asks for prose plus a single coverage
// summary line ("Claim coverage: 2 PRESENT, 1 ABSENT out of 5 elements") and
// never requests a label per element — so claims-loop's parser recovers COUNTS
// from it but no per-element labels, and counts cannot fill rows. Rather than
// change the output contract of the interactive command for every caller, the
// chart appends its own explicit contract and parses that.
export function buildChartAnalysisPrompt(src, fnName, filepath, claimText, elements) {
  const base = buildClaimAnalyzePrompt(src, fnName, filepath, claimText, false);
  const rows = elements.map((e, i) => `ELEMENT ${i + 1}: ${String(e).slice(0, 150)}`).join('\n');
  return `${base}

The claim has been split into the numbered elements below. AFTER your analysis,
emit one line per element, in this exact form and nothing else on the line:

VERDICT <n>: <PRESENT|PARTIAL|ASSUMED|ABSENT> | <one sentence, and the line
number(s) in this function that justify it, or "no line" if none>

Emit a VERDICT line for EVERY element, including ones this function has nothing
to do with — ABSENT is a correct and expected answer for those. Do not omit an
element, do not merge two elements onto one line, and do not renumber.

The source above carries its OWN file line numbers in the left margin, in the
form "  436 | code". Cite those numbers exactly as shown. Do not count lines
yourself and do not renumber from 1: a citation that does not match the file
cannot be verified, and an unverifiable citation is worse than none.

${rows}`;
}

// Parse the VERDICT contract above. Falls back to claims-loop's parser so a
// model that ignores the contract but produces its usual labelled blocks still
// yields something rather than an empty chart.
export function parseChartVerdicts(text, elements) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*\**VERDICT\s*(\d+)\s*\**\s*[:\-]\s*\**\s*(PRESENT|PARTIAL|ASSUMED|ABSENT)\b\**\s*\|?\s*(.*)$/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (!(n >= 1 && n <= elements.length) || seen.has(n)) continue;
    seen.add(n);
    out.push({
      element: n,
      text: String(elements[n - 1] || ''),
      label: m[2].toUpperCase(),
      note: (m[3] || '').trim(),
    });
  }
  if (out.length) return out;
  // Fallback: labelled blocks in claims-loop's shape, matched to elements by
  // position. Weaker, but better than discarding a usable analysis.
  const parsed = parseAnalysisLabels(text || '');
  return parsed.elements.slice(0, elements.length).map((e, i) => ({
    element: i + 1, text: String(elements[i] || e.text), label: e.label, note: '',
  }));
}

// Merge per-element verdicts across targets: best label wins, carrying the
// citation that produced it. Same rule as claims-loop's anchoredPass.
export function mergeBestPerElement(perTarget) {
  const best = new Map();
  // Tally every label each element received, not just the winner. The merge
  // already visits all of them and was discarding the field: a cell reading
  // "ASSUMED, RtspMessageChannel" could be 1 of 34 targets with 33 dissenting,
  // or 30 agreeing, and the chart rendered those identically. The rule stays
  // strongest-wins — one function implementing an element IS infringement of
  // that element, so requiring agreement would suppress true findings — but the
  // reader has to be able to see how lonely a finding is.
  const tally = new Map();
  for (const { target, elements } of perTarget) {
    for (const e of elements) {
      // Key on the element NUMBER when the VERDICT contract supplied one —
      // exact, and immune to the model paraphrasing the element text. Fall back
      // to normalized text only for the legacy labelled-block path.
      const key = e.element != null
        ? `#${e.element}`
        : String(e.text || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      if (!key) continue;
      const t = tally.get(key) || { PRESENT: 0, PARTIAL: 0, ASSUMED: 0, ABSENT: 0, total: 0 };
      if (t[e.label] != null) t[e.label] += 1;
      t.total += 1;
      tally.set(key, t);
      const prev = best.get(key);
      if (!prev || (LABEL_RANK[e.label] ?? 0) > (LABEL_RANK[prev.label] ?? 0)) {
        best.set(key, { element: e.element, text: e.text, label: e.label, target, note: e.note || '' });
      }
    }
  }
  for (const [key, v] of best) v.agreement = tally.get(key) || null;
  return [...best.values()];
}

// Fill the chart by element NUMBER. claims-loop's fillChartSection is built for
// a 3-column table, fills a single cell, and matches rows by fuzzy keyword
// overlap — all three are wrong here: this table has a separate finding column,
// and the VERDICT contract already carries the element number, so row targeting
// is exact rather than inferred. Its `(loop: X)` marker would also mislabel the
// provenance.
export function fillChartRows(table, fills) {
  const lines = table.split('\n');
  const byNum = new Map(fills.filter((f) => f.element != null).map((f) => [f.element, f]));
  const unplaced = fills.filter((f) => f.element == null);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\| (\d+) \| (.*?) \|\s*\|\s*\|\s*$/);
    if (!m) continue;
    const f = byNum.get(Number(m[1]));
    if (!f) continue;
    const cite = f.target ? `\`${f.target}\`` : '—';
    const note = f.note ? ` ${String(f.note).replace(/\|/g, '\\|').slice(0, 160)}` : '';
    // How lonely is this finding? "(1 of 34; 33 ABSENT)" tells the reader that
    // a lone PRESENT was promoted over 33 dissents — which deserves scrutiny —
    // while "(30 of 34)" does not.
    const a = f.agreement;
    let agree = '';
    if (a && a.total > 1) {
      const mine = a[f.label] || 0;
      const others = Object.entries(a)
        .filter(([k, n]) => k !== 'total' && k !== f.label && n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      agree = ` _(${mine} of ${a.total}${others ? `; ${others}` : ''})_`;
    }
    lines[i] = `| ${m[1]} | ${m[2]} | **${f.label}**${agree}${note} | ${cite} |`;
  }
  let out = lines.join('\n');
  if (unplaced.length) {
    out += `\n\n_Finding(s) not matched to a numbered element: ${
      unplaced.map((f) => `${f.label} (\`${f.target}\`)`).join(', ')}._`;
  }
  return out;
}

export function coverageLine(fills, nElements) {
  const c = { PRESENT: 0, PARTIAL: 0, ABSENT: 0, ASSUMED: 0 };
  for (const f of fills) if (c[f.label] != null) c[f.label] += 1;
  const cited = fills.length;
  return `**Coverage:** ${c.PRESENT} PRESENT · ${c.PARTIAL} PARTIAL · ${c.ASSUMED} ASSUMED · `
    + `${c.ABSENT} ABSENT · ${Math.max(0, nElements - cited)} element(s) with no finding.`;
}

// Provenance the artifact must carry to be defensible. Everything here is
// machine-derived except targetProvenance, which CANNOT be — CE has no way to
// know how a targets file was produced. When it is unknown the header says so
// rather than leaving a silent gap: an honest blank is defensible, an invisible
// one is not. "Where did these targets come from, and why these and not others?"
// is the first question an opposing expert asks.
export function buildProvenanceHeader({
  claimText, claimSource, indexPath, indexFiles, indexSymbols, engineLabel,
  argv, targets, targetSource, targetProvenance, targetIntegrity, ceVersion, generatedAt,
  targetDuplicates, targetContainers, targetUnresolved, targetAmbiguous,
}) {
  const firstLine = String(claimText || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const rows = [];
  rows.push(`- **Claim:** ${firstLine.slice(0, 120)}${firstLine.length > 120 ? '…' : ''}`);
  rows.push(`- **Claim source:** ${claimSource || 'inline text (not from a file)'}`);
  rows.push(`- **Index:** \`${indexPath}\`${indexFiles != null ? ` — ${indexFiles} files` : ''}${indexSymbols != null ? `, ${indexSymbols} symbols` : ''}`);
  rows.push(`- **Engine:** ${engineLabel}`);
  const integrity = targetIntegrity === 'unmodified'
    ? ' — _unmodified since generation_'
    : targetIntegrity === 'modified'
      ? ' — ⚠ **MODIFIED after generation**: the list below is not the one the'
        + ' recorded command produced, so the provenance describes how the'
        + ' original list was made, not this one'
      : '';
  rows.push(`- **Targets:** ${targets} analysed, from ${targetSource || 'the --targets argument'}${integrity}`);
  // The chart must never under-report its own inputs. A target the model never
  // saw — dropped as a duplicate, subsumed by a class, or unresolvable in this
  // index — changes what the verdicts and the agreement counts mean, and a
  // reader who cannot see the drop reads ABSENT as "CE looked and found
  // nothing" when it may mean "CE could not look". (#305 Part A.)
  const drops = [];
  if (targetDuplicates) drops.push(`${targetDuplicates} duplicate(s) collapsed`);
  if (targetContainers && targetContainers.length) {
    drops.push(`${targetContainers.length} class target(s) dropped in favour of their own`
      + ` methods, which were also targeted (${targetContainers.join(', ')})`);
  }
  if (targetUnresolved && targetUnresolved.length) {
    drops.push(`**${targetUnresolved.length} target(s) could not be resolved in this index`
      + ` and were NOT analysed**: ${targetUnresolved.join(', ')}`);
  }
  if (targetAmbiguous && targetAmbiguous.length) {
    // The chart picks the first match. Silently, until now — so a citation
    // could point at a different symbol than the one the target names, with
    // nothing in the artifact to reveal it.
    drops.push(`${targetAmbiguous.length} ambiguous target(s) — first match used:`
      + ` ${targetAmbiguous.join(', ')}`);
  }
  for (const d of drops) rows.push(`  - ${d}`);
  if (targetProvenance && targetProvenance.length) {
    rows.push('- **Target provenance:**');
    for (const l of targetProvenance) rows.push(`  - ${l}`);
  } else {
    rows.push('- **Target provenance:** _not recorded_ — the targets file carried no'
      + ' `#` provenance comments and no `--targets-note` was given, so how these'
      + ' targets were selected (and why these and not others) is not established'
      + ' by this document.');
  }
  rows.push(argv && argv.trim()
    ? `- **Command:** \`${argv}\``
    : '- **Command:** _not captured_');
  rows.push(`- **Generated:** ${generatedAt}`);
  if (ceVersion) rows.push(`- **CodeExam:** ${ceVersion}`);
  return rows.join('\n');
}

export function formatChart({
  claimText, table, fills, targets, engineLabel, elements, scopeNote, provenance,
}) {
  const filled = fillChartRows(table, fills);
  const out = [];
  out.push('# Claim chart');
  out.push('');
  if (provenance) { out.push(provenance); out.push(''); }
  else { out.push(`_Generated by CodeExam. Engine: ${engineLabel}. ${targets.length} analysed target(s)._`); out.push(''); }
  out.push('## Claim');
  out.push('');
  out.push('```');
  out.push(String(claimText).trim());
  out.push('```');
  out.push('');
  if (scopeNote) { out.push('## Scope'); out.push(''); out.push(scopeNote); out.push(''); }
  out.push('## Chart');
  out.push('');
  out.push(filled);
  out.push('');
  out.push(coverageLine(fills, elements.length));
  out.push('');
  out.push('## Analysed targets');
  out.push('');
  for (const t of targets) out.push(`- \`${t}\``);
  out.push('');
  out.push('---');
  out.push('');
  out.push('_This chart is machine-generated from a source index and is illustrative only.');
  out.push('It is not legal advice and is not an infringement opinion. Every citation should');
  out.push('be verified against the source — each is reproducible with_ `ce --index-path <idx>');
  out.push('--extract <file>@<function>`_._');
  return out.join('\n');
}

export async function doClaimChart(index, args, opts = {}) {
  const spec = args.claim_chart;
  let claimText = spec;
  if (typeof spec === 'string' && spec.startsWith('@')) {
    try { claimText = fs.readFileSync(spec.slice(1), 'utf8'); }
    catch (e) { console.error(`Cannot read claim file: ${e.message}`); process.exitCode = 1; return; }
  }
  if (!claimText || !String(claimText).trim()) {
    console.error('--claim-chart needs claim text: --claim-chart @claim.txt'); process.exitCode = 1; return;
  }
  claimText = String(claimText).trim();

  if (!args.targets) {
    console.error('--claim-chart needs --targets "file@fn;file@fn" or --targets @targets.txt');
    process.exitCode = 1; return;
  }
  let targets, targetProvenance, targetSource, targetIntegrity, targetDuplicates, targetContainers;
  try { ({ targets, provenance: targetProvenance, source: targetSource, integrity: targetIntegrity,
    duplicates: targetDuplicates, containers: targetContainers } = parseTargets(args.targets)); }
  catch (e) { console.error(e.message); process.exitCode = 1; return; }
  if (!targets.length) { console.error('No targets parsed.'); process.exitCode = 1; return; }
  if (args.targets_note) targetProvenance = [...targetProvenance, String(args.targets_note)];

  const model = resolveModel(args);
  if (!model) { console.error('--claim-chart needs a model: --llm <provider> or --model <gguf>.'); process.exitCode = 1; return; }
  if (model.kind === 'error') { console.error(`Error: ${model.error}`); process.exitCode = 1; return; }
  let draft;
  try { draft = opts.draft || makeDrafter(model, args.temperature ?? 0); }
  catch (e) { console.error(`--claim-chart: ${e.message}`); process.exitCode = 1; return; }

  const symbols = buildSymbolTable(index);
  const { table, elements } = buildChartTable(claimText);
  const engineLabel = model.kind === 'gguf'
    ? `local ${String(model.modelPath).split(/[\\/]/).pop()}`
    : (model.label || model.provider?.label || 'cloud');

  process.stderr.write(`[claim-chart] ${elements.length} element(s), ${targets.length} target(s), engine ${engineLabel}\n`);

  if (!claimsCostGate(model, targets.map(() => ({ inChars: 9000, outTokens: 900 })), 'claim-chart', args)) return;
  resetCloudUsage();

  const perTarget = [];
  const unresolved = [];
  const ambiguous = [];
  for (const t of targets) {
    // `file.java@Class::method` (what --claim-locate emits) or a bare qualified
    // `Class::method` — verifySymbol resolves either, and requiring the file
    // prefix would reject the form a user most naturally types.
    const at = t.indexOf('@');
    const fnSpec = at >= 0 ? t.slice(at + 1) : t;
    const v = verifySymbol(symbols, fnSpec);
    if (!isFound(v)) { process.stderr.write(`  NOT FOUND in index: ${t}\n`); continue; }
    const m = v.matches[0];
    if (v.ambiguous > 1) {
      process.stderr.write(`  AMBIGUOUS: ${v.ambiguous} symbols match ${fnSpec} — using ${m.filepath.split('!').pop()}; qualify the target to choose\n`);
    }
    let src = null;
    const _log = console.log; console.log = () => {};
    try { src = index.getFunctionSource?.(m.filepath, m.name); } catch { src = null; } finally { console.log = _log; }
    if (!src) { process.stderr.write(`  source not retrievable: ${t}\n`); continue; }

    const { text: calleeText, included } = args.no_callees === true
      ? { text: '', included: [] }
      : collectCalleeBodies(index, symbols, m, args);
    process.stderr.write(`  ${m.name}: ${included.length} callee body(ies)${included.length ? ' — ' + included.join(', ') : ''}\n`);

    // File-ABSOLUTE line numbers. Without this the model counts lines off raw
    // source and emits function-relative offsets: on the smoke run
    // updateSelectedTrack (file L436-485) drew citations like "L27", which
    // resolves to file line 462 and sends a verifier to unrelated code. Every
    // chart citation must survive `ce --extract file@fn`.
    const numbered = m.start != null ? addLineNumbers(String(src), m.start) : String(src);
    const promptSrc = calleeText
      ? `${numbered}\n\n// ===== depth-1 callees, included so the analysis need not infer what they do =====\n${calleeText}`
      : numbered;
    let out;
    try { out = await draft(buildChartAnalysisPrompt(promptSrc, m.name, m.filepath, claimText, elements), '', 1100); }
    catch (e) { process.stderr.write(`  analysis failed for ${m.name}: ${e.message}\n`); continue; }

    const verdicts = parseChartVerdicts(out || '', elements);
    // The same lexical gate the loop applies: a PRESENT whose element
    // vocabulary does not appear in the analysed source is downgraded, so a
    // confident label cannot outrun its evidence.
    const gated = verdicts.map((e) => ({ ...e, label: lexicalGate(e.label, e.text, `${m.name}\n${promptSrc}`) }));
    process.stderr.write(`    ${gated.length}/${elements.length} element verdict(s) parsed\n`);
    perTarget.push({ target: `${m.filepath.split('!').pop().split('/').pop()}@${m.name}`, elements: gated });
  }

  if (!perTarget.length) { console.error('No target produced a parseable analysis.'); process.exitCode = 1; return; }

  const fills = mergeBestPerElement(perTarget);
  const scopeNote = args.scope_note ? String(args.scope_note) : null;
  const provenance = buildProvenanceHeader({
    claimText,
    claimSource: (typeof spec === 'string' && spec.startsWith('@')) ? `\`${spec.slice(1)}\`` : null,
    indexPath: args.index_path || '(unknown)',
    indexFiles: index.files ? (index.files.size ?? index.files.length ?? null) : null,
    indexSymbols: symbols.length,
    engineLabel,
    argv: process.argv.slice(1).join(' '),
    targets: perTarget.length,
    targetSource, targetProvenance, targetIntegrity,
    targetDuplicates, targetContainers,
    targetUnresolved: unresolved, targetAmbiguous: ambiguous,
    ceVersion: readCeVersion(),
    generatedAt: new Date().toISOString(),
  });
  console.log(formatChart({
    claimText, table, fills, elements, engineLabel, scopeNote, provenance,
    targets: perTarget.map((p) => p.target),
  }));
  const cost = actualCostLine(model);
  if (cost) process.stderr.write(cost + '\n');
  return { fills, elements: elements.length, targets: perTarget.length };
}
