// claim-frame-overlap.mjs — the fumes number: how much of a pseudo-claim's vocabulary is the identifiers of the code it is anchored to
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// claim-frame-overlap.mjs -- scores one or more --pseudo-claims sidecars (<claims>.txt.anchors.json)
// on the number #322 tracks: the share of a claim's content words that are word-pieces of the
// identifiers it is grounded to (VectorStore::similarity_search -> vector, store, similarity,
// search). Our fumes: a claim drafted from code tends to speak the code's names; the frame tables,
// the claim schema, the exemplars and the synonymizer are each meant to lower this share without
// losing anchors. Alongside it: the shape report's in-band share, the mechanism and dependent
// counts, grounded anchors, and (schema runs) attempts and still-failing checks.
//
//   node scripts/claim-frame-overlap.mjs <a.txt.anchors.json | a.md> [<b.txt.anchors.json | b.md> ...] [-v] [--frame]
//
// Each input is a `--claims-only` sidecar (JSON) or the Markdown ARTIFACT `--pseudo-claims`
// prints (a run without --claims-only writes no sidecar; the artifact carries the same claims
// and grounded anchors). One summary line per input; -v adds a per-claim table; --frame adds
// the run's FRAME shares beside the litigated population's (transition, preamble skeleton in
// the schema's enum, gerund-led method rows, noun-phrase apparatus rows, dependent references
// and openers) -- the dimension `--claim-schema` acts on, which overlap and shape do not see.
// Compare runs on the SAME candidate groups (the before/after arms of a prompt or schema
// change); a different group set is a different population and the number does not transfer.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { contentWords, stem } from '../src/core/claim-terms.js';
import { frameTables } from '../src/core/claim-schema.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import { preambleClass, preambleOf, preambleSkeleton, elementOpeners, dependentFrame } from './build-claim-frame-tables.mjs';

/** Word-pieces of an identifier: camelCase, snake_case, `::` and `.` boundaries; pieces of three letters or more. */
export function splitIdent(s) {
  return String(s || '').replace(/::|\./g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ').toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
}

/** The stemmed word-pieces of every grounded anchor's function name and file basename. */
export function identifierWords(grounded) {
  const out = new Set();
  for (const a of grounded || []) {
    const base = String(a.file || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    for (const w of [...splitIdent(a.func), ...splitIdent(base)]) out.add(stem(w));
  }
  return out;
}

/** `{share, shared, words}`: distinct content words of the claim that are anchored-identifier pieces, as a share of all distinct content words. */
export function overlapOf(claim, grounded) {
  const words = [...new Set(contentWords(String(claim || '')).map((w) => stem(w)))];
  if (!words.length) return { share: 0, shared: [], words: 0 };
  const ids = identifierWords(grounded);
  const shared = words.filter((w) => ids.has(w));
  return { share: +(shared.length / words.length).toFixed(3), shared, words: words.length };
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/**
 * The Markdown artifact `--pseudo-claims` prints, read into the sidecar shape: per claim the
 * label, the claim-1 paragraph after the caveat line, the numbered dependents, the shape line
 * (`inside the band on every axis`, `mechanism N`) and the `### Cited anchors` bullets. Per-claim
 * schema attempts are not in the artifact; its run-level "N of M draft(s) resampled ...; K still
 * failing" line is read as `schemaSummary` instead.
 */
export function parseArtifact(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const parts = src.split(/^## Pseudo-claim (\d+) — /m);
  const claims = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const body = parts[i + 1];
    const lines = body.split('\n');
    const paras = body.split(/\n[ \t]*\n/).map((p) => p.trim());
    const caveat = paras.findIndex((p) => p.startsWith('**[PSEUDO-CLAIM'));
    const claim = caveat >= 0 ? (paras[caveat + 1] || '').replace(/\s+/g, ' ') : '';
    const dependents = [];
    for (const m of body.matchAll(/^(\d+)\. (.+)$/gm)) if (Number(m[1]) >= 2) dependents.push({ n: Number(m[1]), text: m[2].trim() });
    const shapeLine = lines.find((l) => l.startsWith('_Shape vs '));
    const mech = shapeLine && /mechanism (\d+)/.exec(shapeLine);
    const shape = shapeLine ? { inBandAll: /inside the band on every axis/.test(shapeLine), mechanism: mech ? Number(mech[1]) : null } : null;
    // The anchors block ends at the next `_..._` note (dropped anchors, evidence-pack
    // disclosure) or section. Both layouts are read: the flat list (one `- \`file@func\`
    // — L1-2 — note` per anchor) and the by-element list of the schema path (one line per
    // element with its anchors after it).
    const grounded = [];
    const at = body.indexOf('### Cited anchors');
    if (at >= 0) {
      const rest = body.slice(at);
      const stop = rest.search(/\n_|\n## /);
      const block = stop >= 0 ? rest.slice(0, stop) : rest;
      for (const m of block.matchAll(/`([^`\s@]+)@([^`\s]+)`(?:\s(?:—\s)?L(\d+)-(\d+))?/g)) {
        const lm = /^L(\d+)-(\d+)$/.exec(m[2]);
        grounded.push(lm ? { file: m[1], func: '', start: Number(lm[1]), end: Number(lm[2]), kind: 'lines' }
          : { file: m[1], func: m[2], start: m[3] ? Number(m[3]) : null, end: m[4] ? Number(m[4]) : null, kind: 'func' });
      }
    }
    claims.push({ n: Number(parts[i]), label: (lines[0] || '').trim(), claim, dependents, ...(shape ? { shape } : {}), grounded });
  }
  const sm = /_Claim schema \(\*\*experimental\*\*\):.*? (\d+) of (\d+) draft\(s\) resampled after a failed check(?: \([^)]*\))?; (\d+) still failing/.exec(src);
  return {
    format: 'ce-pseudo-claim-anchors', source: 'artifact', claims,
    ...(sm ? { schemaSummary: { resampled: Number(sm[1]), drafts: Number(sm[2]), failing: Number(sm[3]) } } : {}),
  };
}

/** Per-claim rows and a summary for one sidecar (format ce-pseudo-claim-anchors) or parsed artifact. */
export function scoreSidecar(sidecar) {
  const rows = (sidecar.claims || []).map((c) => {
    const o = overlapOf(c.claim, c.grounded);
    return {
      n: c.n, label: c.label || '', overlap: o.share, words: o.words, shared: o.shared, grounded: (c.grounded || []).length,
      inBand: c.shape ? !!c.shape.inBandAll : null, mechanism: c.shape ? c.shape.mechanism : null,
      dependents: (c.dependents || []).length,
      attempts: c.schema ? c.schema.attempts : null, failing: c.schema ? (c.schema.failures || []).some((f) => f.hard) : null,
    };
  });
  const n = rows.length;
  const ss = sidecar.schemaSummary || null; // an artifact's run-level line stands in for per-claim attempts
  const summary = {
    claims: n,
    overlapMedian: median(rows.map((r) => r.overlap)),
    overlapMean: n ? +(rows.reduce((s, r) => s + r.overlap, 0) / n).toFixed(3) : null,
    inBand: rows.filter((r) => r.inBand === true).length, shaped: rows.filter((r) => r.inBand != null).length,
    mechanismMedian: median(rows.map((r) => r.mechanism)),
    dependentsMedian: median(rows.map((r) => r.dependents)),
    grounded: rows.reduce((s, r) => s + r.grounded, 0),
    resampled: ss ? ss.resampled : rows.filter((r) => r.attempts != null && r.attempts > 1).length,
    failing: ss ? ss.failing : rows.filter((r) => r.failing === true).length,
    schemaRun: !!ss || rows.some((r) => r.attempts != null),
  };
  return { rows, summary };
}

const shareOf = (table, value) => { const r = ((table && table.rows) || []).find((x) => x.value === value); return r ? r.share : null; };

/**
 * A run's frame counts beside the population's shares. Rows come from CE's own splitter (the
 * tables' rows are the attorney's), `wherein` rows are set aside as the tables do, and a claim's
 * class is read from its preamble -- so a run asked for method claims shows its class drift here.
 */
export function frameOf(sidecar, tables = frameTables()) {
  const t1 = tables.claim1 || {}, td = tables.dependents || {};
  const skel = new Set((((((t1.preambles || {}).skeletons || {}).method) || {}).rows || []).map((r) => r.value));
  const c = {
    claims: 0, comprising: 0, classes: {},
    method: 0, skeletonInEnum: 0, methodRows: 0, gerund: 0,
    system: 0, systemRows: 0, nounPhrase: 0, meansFor: 0, configuredTo: 0,
    dependents: 0, ofClaim: 0, wherein: 0, further: 0,
  };
  for (const cl of sidecar.claims || []) {
    const text = String(cl.claim || '').trim();
    if (!text) continue;
    c.claims++;
    const cls = preambleClass(text);
    c.classes[cls] = (c.classes[cls] || 0) + 1;
    const res = splitClaimElements(text);
    const list = Array.isArray(res) ? res : ((res && res.elements) || []);
    const lines = list.map((x) => (typeof x === 'string' ? x : String((x && x.text) || '')));
    const { preamble, transition, tail } = preambleOf(lines[0] || text);
    if ((transition || '').toLowerCase() === 'comprising') c.comprising++;
    const rows = elementOpeners(lines).filter((o) => o.kind !== 'wherein');
    if (cls === 'method') {
      c.method++;
      if (skel.has(preambleSkeleton(preamble, transition, tail))) c.skeletonInEnum++;
      c.methodRows += rows.length;
      c.gerund += rows.filter((o) => o.kind === 'gerund').length;
    } else if (cls === 'system') {
      c.system++;
      c.systemRows += rows.length;
      c.nounPhrase += rows.filter((o) => o.kind === 'noun-phrase').length;
      c.meansFor += rows.filter((o) => o.kind === 'means' || o.forms.includes('means for')).length;
      c.configuredTo += rows.filter((o) => o.forms.includes('configured to')).length;
    }
    for (const d of cl.dependents || []) {
      c.dependents++;
      const f = dependentFrame(d.text);
      if (f.reference === 'of claim') c.ofClaim++;
      if (f.opener === 'wherein') c.wherein++;
      if (/^(?:and )?further comprising/.test(f.opener || '')) c.further++;
    }
  }
  c.population = {
    comprising: shareOf((t1.transitions || {}).all, 'comprising'),
    gerund: shareOf(((t1.elements || {}).openerKinds || {}).method, 'gerund'),
    nounPhrase: shareOf(((t1.elements || {}).openerKinds || {}).system, 'noun-phrase'),
    ofClaim: shareOf((td.referencePhrases || {}).all, 'of claim'),
    wherein: shareOf((td.openers || {}).all, 'wherein'),
    further: shareOf((td.openers || {}).all, 'further comprising'),
  };
  return c;
}

export function formatFrame(path, f) {
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  const pop = (x) => (x == null ? '?' : `${Math.round(100 * x)}%`);
  const p = f.population || {};
  const classes = Object.entries(f.classes).map(([k, n]) => `${k} ${n}`).join(' · ');
  return `${path}: frame — comprising ${pct(f.comprising, f.claims)} (population ${pop(p.comprising)}); class ${classes || '-'}; `
    + `method ${f.method}: skeleton in schema enum ${pct(f.skeletonInEnum, f.method)}, rows gerund-led ${pct(f.gerund, f.methodRows)} of ${f.methodRows} (population ${pop(p.gerund)}); `
    + `system ${f.system}: rows noun-phrase ${pct(f.nounPhrase, f.systemRows)} of ${f.systemRows} (population ${pop(p.nounPhrase)}), means for ${f.meansFor}, configured to ${f.configuredTo}; `
    + `dependents ${f.dependents}: of claim ${pct(f.ofClaim, f.dependents)} (population ${pop(p.ofClaim)}), wherein ${pct(f.wherein, f.dependents)} (${pop(p.wherein)}), further comprising ${pct(f.further, f.dependents)} (${pop(p.further)})`;
}

export function formatSummary(path, s) {
  return `${path}: ${s.claims} claim(s); overlap median ${s.overlapMedian} mean ${s.overlapMean}; in band ${s.inBand}/${s.shaped}; `
    + `mechanism median ${s.mechanismMedian}; dependents median ${s.dependentsMedian}; grounded ${s.grounded}`
    + (s.schemaRun ? `; schema: ${s.resampled} resampled, ${s.failing} still failing` : '');
}

export function main(argv = process.argv.slice(2)) {
  const verbose = argv.includes('-v');
  const frame = argv.includes('--frame');
  const paths = argv.filter((a) => a !== '-v' && a !== '--frame');
  if (!paths.length) { console.error('usage: node scripts/claim-frame-overlap.mjs <claims.txt.anchors.json | artifact.md> [...] [-v] [--frame]'); process.exit(2); }
  for (const p of paths) {
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { console.error(`${p}: ${e.message}`); process.exitCode = 1; continue; }
    let sidecar;
    if (/^\s*\{/.test(raw)) {
      try { sidecar = JSON.parse(raw); } catch (e) { console.error(`${p}: ${e.message}`); process.exitCode = 1; continue; }
      if (sidecar.format !== 'ce-pseudo-claim-anchors') { console.error(`${p}: not a pseudo-claims sidecar (format ${sidecar.format || 'missing'})`); process.exitCode = 1; continue; }
    } else {
      sidecar = parseArtifact(raw);
      if (!sidecar.claims.length) { console.error(`${p}: neither a pseudo-claims sidecar (JSON) nor a --pseudo-claims artifact (no "## Pseudo-claim N" sections)`); process.exitCode = 1; continue; }
    }
    const { rows, summary } = scoreSidecar(sidecar);
    console.log(formatSummary(p, summary));
    if (frame) console.log(formatFrame(p, frameOf(sidecar)));
    if (verbose) {
      console.log('  n  overlap words grounded band mech deps attempts  shared');
      for (const r of rows) {
        console.log(`  ${String(r.n).padStart(2)}  ${r.overlap.toFixed(3)}   ${String(r.words).padStart(3)}    ${String(r.grounded).padStart(3)}   ${r.inBand == null ? '-' : r.inBand ? 'in ' : 'out'}  ${r.mechanism ?? '-'}    ${r.dependents}    ${r.attempts ?? '-'}${r.failing ? '!' : ' '}     ${r.shared.slice(0, 8).join(' ')}`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
