// test_claim_schema.js — claim objects: the schema from the frame tables and shape bands, its strict and loose copies, the validator, the renderer, the post-checks, and the drafter wiring on every engine
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_claim_schema.js -- src/core/claim-schema.js and the --claim-schema path (#322, 2026-10-19).
 *
 * The schema's permitted preamble forms, dependent kinds and count bounds come from the shipped
 * frame tables and the shape profiles, so the first group pins that derivation. The renderer and
 * the post-checks are tested on hand-built objects; the two cloud wires on a stubbed fetch, including
 * the strict-mode downgrade; the local wire by a source scan (a GGUF is not assumed present).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  claimSchema, renderClaim, checkClaim, validateObject, strictSchema, looseSchema, skeletonsFor, skeletonHead,
  reviseLine, SCHEMA_CLASSES, SCHEMA_RESAMPLE_CAP,
} from '../src/core/claim-schema.js';
import { SHAPE_PROFILES, buildPseudoClaimSys, groundAnchors } from '../src/commands/pseudo-claims.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import { draftCloud } from '../src/core/llm-runner.js';
import { splitIdent, overlapOf, scoreSidecar, formatSummary, parseArtifact, frameOf, formatFrame } from '../scripts/claim-frame-overlap.mjs';

const axes = SHAPE_PROFILES.litigated.axes;
const sample = () => ({
  class: 'method',
  preamble: { skeleton: 'a method for ..., the method comprising the steps of', purpose: 'resolving a dependency chain from a lockfile' },
  elements: [
    { text: 'receiving a lockfile naming packages and the edges between them', anchors: ['src/core/imports.js@lockfileDeps'] },
    { text: 'walking the edges from a root package to a target package', anchors: ['src/core/imports.js@lockfileChains'] },
    { text: 'reporting each chain with its head', anchors: [] },
  ],
  dependents: [
    { dependsOn: 1, kind: 'wherein', text: 'the lockfile is a package-lock.json file' },
    { dependsOn: 2, kind: 'further comprising', text: 'pruning a chain that cannot reach the target' },
  ],
});

describe('claim schema: built from the frame tables and the shape bands', () => {
  it('method: the preamble forms are the population’s skeletons; the counts are the bands', () => {
    const s = claimSchema({ claimClass: 'method', axes });
    const forms = s.properties.preamble.properties.skeleton.enum;
    assert.ok(forms.includes('a method comprising') && forms.includes('a method for ... comprising the steps of'), forms.join(' | '));
    assert.ok(forms.length >= 10 && forms.length <= 40, `forms=${forms.length}`);
    assert.equal(s.properties.elements.minItems, Math.round(axes.mechanism.p10));
    assert.equal(s.properties.elements.maxItems, Math.round(axes.fine.p90));
    assert.equal(s.properties.dependents.maxItems, Math.round(axes.dependents.p90));
    assert.deepEqual(s.properties.class.enum, ['method']);
    assert.deepEqual(s.properties.dependents.items.properties.kind.enum, ['wherein', 'further comprising']);
    assert.deepEqual(claimSchema({ claimClass: 'method', axes, fixedClass: false }).properties.class.enum, SCHEMA_CLASSES);
  });
  it('system: apparatus forms, and the further-configured-to dependent kind dep-claims recognises', () => {
    const s = claimSchema({ claimClass: 'system', axes: SHAPE_PROFILES['litigated-system'].axes });
    const forms = s.properties.preamble.properties.skeleton.enum;
    assert.ok(forms.includes('a system for ... comprising') && forms.includes('an apparatus comprising'), forms.join(' | '));
    assert.ok(s.properties.dependents.items.properties.kind.enum.includes('wherein the processor is further configured to'));
  });
  it('crm (a thin class): the measured form plus the class’s own openers in the two generic shapes, marked supplementary', () => {
    const rows = skeletonsFor('crm');
    assert.ok(rows.length >= 3, JSON.stringify(rows));
    assert.ok(rows.some((r) => !r.supplementary) && rows.some((r) => r.supplementary));
    assert.ok(rows.some((r) => r.skeleton === 'a computer-readable medium ... comprising'));
  });
  it('uses only the subset every engine accepts: no const, no pattern', () => {
    const j = JSON.stringify(claimSchema({ claimClass: 'method', axes }));
    assert.ok(!/"const"|"pattern"/.test(j));
  });
  it('strictSchema requires every property and forbids extras at every level; looseSchema drops the bounds', () => {
    const s = claimSchema({ claimClass: 'method', axes });
    const strict = strictSchema(s);
    assert.deepEqual(strict.required, ['class', 'preamble', 'elements', 'dependents']);
    assert.equal(strict.additionalProperties, false);
    assert.deepEqual(strict.properties.elements.items.required, ['text', 'anchors']);
    assert.equal(strict.properties.dependents.items.additionalProperties, false);
    assert.ok(!('required' in s), 'the source schema is untouched');
    const loose = looseSchema(strict);
    assert.ok(!/"(?:minItems|maxItems|minLength|maxLength)"/.test(JSON.stringify(loose)));
    assert.deepEqual(loose.required, strict.required, 'loose keeps the strict-mode keys');
  });
  it('refuses a class it does not draft in', () => {
    assert.throws(() => claimSchema({ claimClass: 'jepson', axes }), /class must be one of/);
  });
});

describe('skeleton heads: the noun a dependent’s subject echoes', () => {
  it('reads the opener, or the closing re-mention when there is one', () => {
    assert.deepEqual(['a method for ... comprising', 'a system for ... comprising', 'an apparatus comprising',
      'a peripheral device connectable to ..., the peripheral device comprising', 'a computer-readable medium having ... comprising'].map(skeletonHead),
    ['method', 'system', 'apparatus', 'device', 'medium']);
  });
});

describe('validateObject: the violations the local grammar cannot produce and a cloud wire can', () => {
  const s = claimSchema({ claimClass: 'method', axes });
  it('a conforming object has none', () => {
    assert.deepEqual(validateObject(sample(), strictSchema(s)), []);
  });
  it('names a missing property, a value off the enum, a short array and an extra key, by path', () => {
    const o = sample();
    delete o.preamble.purpose;
    o.dependents[0].kind = 'whereby';
    o.elements = [o.elements[0]];
    o.extra = 1;
    const v = validateObject(o, s).map((x) => `${x.path}: ${x.message}`);
    assert.ok(v.some((x) => x.startsWith('$.preamble: missing property "purpose"')), v.join('\n'));
    assert.ok(v.some((x) => x.startsWith('$.dependents[0].kind: expected one of')), v.join('\n'));
    assert.ok(v.some((x) => x.startsWith('$.elements: expected at least 2 item(s), got 1')), v.join('\n'));
    assert.ok(v.some((x) => x.includes('unexpected property "extra"')), v.join('\n'));
  });
});

describe('renderClaim: the text CodeExam writes from the object', () => {
  it('fills the form with the purpose, joins elements with semicolons and a final "and", numbers dependents from 2 with the head noun', () => {
    const r = renderClaim(sample(), { claimClass: 'method' });
    assert.equal(r.claim, 'A method for resolving a dependency chain from a lockfile, the method comprising the steps of: '
      + 'receiving a lockfile naming packages and the edges between them; walking the edges from a root package to a target package; and reporting each chain with its head.');
    assert.deepEqual(r.dependents, [
      { n: 2, text: 'The method of claim 1, wherein the lockfile is a package-lock.json file.' },
      { n: 3, text: 'The method of claim 2, further comprising: pruning a chain that cannot reach the target.' },
    ]);
    assert.equal(r.head, 'method');
  });
  it('keeps the anchors out of the text and returns them beside it with the element as the note', () => {
    const r = renderClaim(sample(), { claimClass: 'method' });
    assert.ok(!/@|imports\.js/.test(r.claim));
    assert.deepEqual(r.anchors.map((a) => a.ref), ['src/core/imports.js@lockfileDeps', 'src/core/imports.js@lockfileChains']);
    assert.equal(r.anchors[0].element, 'receiving a lockfile naming packages and the edges between them');
    assert.deepEqual(r.anchors.map((a) => a.n), [1, 2], 'each anchor carries its element’s 1-based position');
  });
  it('round-trips through CE’s own splitter: every element is a row', () => {
    const o = sample();
    const r = renderClaim(o, { claimClass: 'method' });
    const rows = splitClaimElements(r.claim);
    for (const e of o.elements) assert.ok(rows.some((row) => row.includes(e.text.slice(0, 30))), `${e.text} not in ${JSON.stringify(rows)}`);
  });
  it('a form without "..." ignores the purpose; a system dependent uses the apparatus head', () => {
    const o = sample();
    o.preamble = { skeleton: 'a method comprising', purpose: 'ignored words' };
    assert.ok(renderClaim(o).claim.startsWith('A method comprising: receiving'));
    const sys = { class: 'system', preamble: { skeleton: 'an apparatus comprising', purpose: '' },
      elements: [{ text: 'a memory storing an index', anchors: [] }, { text: 'a processor configured to: read the index', anchors: [] }],
      dependents: [{ dependsOn: 1, kind: 'wherein the processor is further configured to', text: 'prune the index' }] };
    const r = renderClaim(sys);
    assert.equal(r.claim, 'An apparatus comprising: a memory storing an index; and a processor configured to: read the index.');
    assert.equal(r.dependents[0].text, 'The apparatus of claim 1, wherein the processor is further configured to prune the index.');
  });
});

describe('checkClaim: what the schema cannot say', () => {
  const s = claimSchema({ claimClass: 'method', axes });
  it('passes a well-formed method object and notes the unanchored element', () => {
    const c = checkClaim(sample(), { claimClass: 'method', axes, schema: s });
    assert.deepEqual(c.failures, []);
    assert.deepEqual(c.notes, ['element(s) 3 carry no anchor']);
  });
  it('flags a non-gerund method step and a parent that is not claim 1 or an earlier dependent, as hard', () => {
    const o = sample();
    o.elements[1].text = 'the edges are walked from a root package';
    o.dependents.push({ dependsOn: 9, kind: 'wherein', text: 'the chain is pruned' });
    const codes = checkClaim(o, { claimClass: 'method', axes, schema: s }).failures.map((f) => `${f.code}:${f.hard}`);
    assert.deepEqual(codes, ['method-step-opener:true', 'dependent-reference:true']);
  });
  it('allows the population’s non-gerund method openers ("in response to", "if", "wherein")', () => {
    const o = sample();
    o.elements[2].text = 'in response to the walk reaching the target, reporting the chain';
    o.elements.push({ text: 'if no chain reaches the target, reporting none', anchors: [] });
    assert.deepEqual(checkClaim(o, { claimClass: 'method', axes, schema: s }).failures, []);
  });
  it('a schema violation is a hard failure; a missing purpose on a form with "..." too', () => {
    const o = sample();
    o.preamble.purpose = '';
    o.dependents[0].kind = 'whereby';
    const codes = checkClaim(o, { claimClass: 'method', axes, schema: s }).failures.map((f) => f.code);
    assert.ok(codes.includes('schema') && codes.includes('purpose-missing'), codes.join(','));
  });
  it('system elements open with an article or "means for"; a gerund there is the failure', () => {
    const o = { class: 'system', preamble: { skeleton: 'a system comprising', purpose: '' },
      elements: [{ text: 'a memory storing an index', anchors: [] }, { text: 'reading the index', anchors: [] }], dependents: [] };
    const f = checkClaim(o, { claimClass: 'system', axes: SHAPE_PROFILES['litigated-system'].axes }).failures;
    assert.deepEqual(f.map((x) => x.code), ['apparatus-element-opener']);
    assert.match(f[0].message, /element\(s\) 2: "reading"/);
  });
  it('a chain deeper than the band and a duplicated element are soft; reviseLine names only the hard ones', () => {
    const o = sample();
    o.elements.push({ text: 'receiving a lockfile naming packages and the edges between them', anchors: [] });
    o.dependents = [1, 2, 3, 4, 5].map((n) => ({ dependsOn: n, kind: 'wherein', text: `fact ${n}` })); // 2<-1, 3<-2, 4<-3, 5<-4, 6<-5: depth 5
    const c = checkClaim(o, { claimClass: 'method', axes, schema: s });
    assert.deepEqual(c.failures.map((f) => `${f.code}:${f.hard}`), ['duplicate-element:false', 'dependent-depth:false']);
    assert.equal(reviseLine(c.failures), '');
    assert.match(reviseLine([{ code: 'x', message: 'fix this', hard: true }]), /REVISE:.*\n- fix this/s);
  });
});

describe('the drafter wiring', () => {
  it('the schema-path system prompt describes the object and carries no format block; the free-text prompt is unchanged', () => {
    const schemaSys = buildPseudoClaimSys('litigated', 'method', { schema: true });
    assert.ok(/FILLING A CLAIM OBJECT/.test(schemaSys) && /preamble\.skeleton/.test(schemaSys) && /dependsOn/.test(schemaSys));
    assert.ok(!/Output EXACTLY/.test(schemaSys) && !/ANCHORS:/.test(schemaSys));
    assert.ok(/GIVEN: METHOD/.test(schemaSys), 'the class line stays');
    const free = buildPseudoClaimSys('litigated', 'method');
    assert.ok(/Output EXACTLY/.test(free) && /ANCHORS:/.test(free));
    assert.ok(/STRUCTURAL element/.test(buildPseudoClaimSys('litigated-system', 'system', { schema: true })));
  });
  it('is registered: argparse default, table and help; the sidecar carries the object; the local wire compiles a grammar', () => {
    const arg = fs.readFileSync('src/argparse.js', 'utf8');
    assert.ok(/claim_schema: false/.test(arg));
    assert.ok(/\['claim_schema',\s+'flag',\s+\['--claim-schema'\]\]/.test(arg));
    assert.ok(/--claim-schema\s+--pseudo-claims \(EXPERIMENTAL\)/.test(arg));
    const pc = fs.readFileSync('src/commands/pseudo-claims.js', 'utf8');
    assert.ok(/d\.schemaDraft \? \{ schema: d\.schemaDraft \}/.test(pc), 'sidecar field');
    assert.ok(/SCHEMA_RESAMPLE_CAP/.test(pc) && SCHEMA_RESAMPLE_CAP >= 1);
    const lr = fs.readFileSync('src/core/llm-runner.js', 'utf8');
    assert.ok(/createGrammarForJsonSchema\(schema\)/.test(lr) && /grammar\.parse\(/.test(lr), 'local grammar');
    assert.ok(/tool_choice: \{ type: 'tool', name: 'draft_claim' \}/.test(lr), 'anthropic forced tool');
    assert.ok(/response_format: \{ type: 'json_schema'/.test(lr) && /type: 'json_object'/.test(lr), 'openai response_format and its last resort');
  });
  it('anthropic wire: the schema goes as a forced tool and the tool_use input comes back as the object', async () => {
    const s = claimSchema({ claimClass: 'method', axes });
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'draft_claim', input: sample() }] }), text: async () => '' };
    };
    try {
      const model = { wire: 'anthropic', model: 'claude-test', key: 'k', apiUrl: 'http://127.0.0.1:9/v1/messages', label: 'Claude API' };
      const out = await draftCloud(model, 'sys', 'user', 100, 0, { schema: s });
      assert.equal(out.preamble.purpose, 'resolving a dependency chain from a lockfile');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].tools[0].name, 'draft_claim');
      assert.deepEqual(calls[0].tool_choice, { type: 'tool', name: 'draft_claim' });
      assert.deepEqual(calls[0].tools[0].input_schema.required, ['class', 'preamble', 'elements', 'dependents']);
      const plain = await draftCloud(model, 'sys', 'user', 100, 0);
      assert.equal(typeof plain, 'string', 'without a schema the wire still returns text');
      assert.ok(!('tools' in calls[1]));
    } finally { globalThis.fetch = realFetch; }
  });
  it('openai wire: strict json_schema first; a 400 naming the bounds is answered without them; the reply is parsed into the object', async () => {
    const s = claimSchema({ claimClass: 'method', axes });
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) return { ok: false, status: 400, json: async () => ({}), text: async () => '{"error":{"message":"Invalid schema: minItems is not supported"}}' };
      return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(sample()) + '\n```' } }] }), text: async () => '' };
    };
    try {
      const model = { wire: 'openai', model: 'gpt-test', key: 'k', apiUrl: 'http://127.0.0.1:9/v1/chat/completions', label: 'OpenAI API' };
      const out = await draftCloud(model, 'sys', 'user', 100, 0, { schema: s });
      assert.equal(out.elements.length, 3);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].response_format.type, 'json_schema');
      assert.equal(calls[0].response_format.json_schema.strict, true);
      assert.ok(JSON.stringify(calls[0].response_format).includes('minItems'));
      assert.ok(!JSON.stringify(calls[1].response_format).includes('minItems'), 'bounds dropped on the retry');
      assert.equal(calls[1].response_format.json_schema.schema.additionalProperties, false, 'strict-mode keys kept');
    } finally { globalThis.fetch = realFetch; }
  });
  it('the fumes number: claim content words that are anchored-identifier pieces', () => {
    assert.deepEqual(splitIdent('VectorStore::similarity_search_by_vector'), ['vector', 'store', 'similarity', 'search', 'vector']);
    const grounded = [{ file: 'langchain_core/vectorstores/base.py', func: 'VectorStore::similarity_search' }, { file: 'x/embeddings.py', func: 'embed_documents' }];
    const o = overlapOf('A method comprising: embedding documents with a model; and searching a vector store by similarity.', grounded);
    assert.ok(o.share > 0 && o.share <= 1, JSON.stringify(o));
    assert.ok(o.shared.some((w) => /^similar|^vector|^search|^embed|^document/.test(w)), o.shared.join(','));
    assert.deepEqual(overlapOf('A method comprising: receiving a request; and storing a reply.', grounded).shared, []);
    const sidecar = { format: 'ce-pseudo-claim-anchors', claims: [
      { n: 1, claim: 'A method comprising: searching a vector store.', grounded, shape: { inBandAll: true, mechanism: 3 }, dependents: [{}, {}], schema: { attempts: 2, failures: [] } },
      { n: 2, claim: 'A method comprising: receiving a request.', grounded: [], shape: { inBandAll: false, mechanism: 1 }, schema: { attempts: 3, failures: [{ hard: true }] } },
    ] };
    const { summary } = scoreSidecar(sidecar);
    assert.equal(summary.claims, 2);
    assert.equal(summary.inBand, 1);
    assert.equal(summary.resampled, 2);
    assert.equal(summary.failing, 1);
    assert.equal(summary.dependentsMedian, 2);
    assert.match(formatSummary('x', summary), /2 claim\(s\); overlap median .*; in band 1\/2; .*schema: 2 resampled, 1 still failing/);
  });
  it('parseArtifact reads the Markdown artifact in both anchor layouts, and its run-level schema line', () => {
    // A run without --claims-only writes no sidecar; the artifact is what there is to score.
    const art = [
      '# PSEUDO-CLAIMS — illustrative drafting exercise, NOT legal analysis', '',
      '_Claim schema (**experimental**): the drafter filled a claim object and CodeExam rendered the text; the preamble forms, dependent kinds and element / dependent counts are the **litigated** population\'s. 1 of 2 draft(s) resampled after a failed check (method-step-opener 1); 0 still failing. Each claim\'s cited anchors are listed by the element that cited them; pass --claims-only <file> to keep the object itself in an .anchors.json sidecar (this run wrote none)._', '',
      '## Contents', '', '1. [file] a.js — "A method…"', '2. [file] b.js — "A method…"', '',
      '## Pseudo-claim 1 — [file] a.js', '',
      '**[PSEUDO-CLAIM — illustrative only; not a legal opinion or admission that any code practices this. `file:line` = orientation pointer, not a finding.]**', '',
      'A method for searching a vector store comprising: embedding documents with a model; and searching the vector store by similarity.', '',
      '**Dependent claims (2)** — same illustrative exercise as claim 1.', '',
      '2. The method of claim 1, wherein the model is local.', '3. The method of claim 2, further comprising: caching.', '',
      '_Shape vs litigated: 20 words (146, band 85-257) · 3 rows (6, band 4-11) · mechanism 2 / generic 0 (4, band 2-7) — inside the band on every axis; distance 0.1._', '',
      '### Cited anchors (3 grounded, by element)', '',
      '- **1.** embedding documents with a model — `x/embeddings.py@embed_documents` L1-9',
      '- **2.** searching the vector store by similarity — `langchain_core/vectorstores/base.py@VectorStore::similarity_search` L10-20 · `docs/guide.md@L5-9` (documentation excerpt)', '',
      '_Dropped (cited but not found in index): `x/none.py@missing`._', '',
      '## Pseudo-claim 2 — [file] b.js', '',
      '**[PSEUDO-CLAIM — illustrative only.]**', '',
      'A method comprising: receiving a request; and storing a reply.', '',
      '_Shape vs litigated: 9 words (146, band 85-257) · 2 rows (6, band 4-11) · mechanism 1 / generic 1 (4, band 2-7) — outside on 2 of 9 axes; distance 0.6._', '',
      '### Cited anchors (1 grounded)', '',
      '- `x/server.py@handle` — L3-30 — receiving a request', '',
      '_Evidence pack: packed 1 of 1 resolved anchor(s)._', '',
    ].join('\n');
    const sc = parseArtifact(art);
    assert.equal(sc.format, 'ce-pseudo-claim-anchors');
    assert.equal(sc.claims.length, 2);
    assert.equal(sc.claims[0].label, '[file] a.js');
    assert.match(sc.claims[0].claim, /^A method for searching a vector store comprising:/);
    assert.equal(sc.claims[0].dependents.length, 2);
    assert.deepEqual(sc.claims[0].shape, { inBandAll: true, mechanism: 2 });
    assert.deepEqual(sc.claims[0].grounded.map((a) => a.func), ['embed_documents', 'VectorStore::similarity_search', '']);
    assert.equal(sc.claims[0].grounded[2].kind, 'lines');
    assert.deepEqual(sc.claims[1].grounded, [{ file: 'x/server.py', func: 'handle', start: 3, end: 30, kind: 'func' }], 'the dropped line is not counted as grounded');
    assert.equal(sc.claims[1].shape.inBandAll, false);
    assert.deepEqual(sc.schemaSummary, { resampled: 1, drafts: 2, failing: 0 });
    const { summary } = scoreSidecar(sc);
    assert.equal(summary.claims, 2);
    assert.equal(summary.grounded, 4);
    assert.equal(summary.inBand, 1);
    assert.ok(summary.schemaRun && summary.resampled === 1 && summary.failing === 0, JSON.stringify(summary));
    assert.equal(parseArtifact('no sections here').claims.length, 0);
  });
  it('frameOf: a run’s frame counts beside the population’s shares, class read from the preamble', () => {
    const sidecar = { format: 'ce-pseudo-claim-anchors', claims: [
      { n: 1, claim: 'A method for searching a store comprising: embedding documents with a model; and searching the store by similarity.',
        dependents: [{ n: 2, text: 'The method of claim 1, wherein the store is local.' }, { n: 3, text: 'The method of claim 1, further comprising: caching a result.' }] },
      { n: 2, claim: 'A system for indexing comprising: a memory storing an index; and a processor configured to read the index.' },
      { n: 3, claim: 'A method of ranking including: the processor scores each row; and sorting the rows.' },
    ] };
    const f = frameOf(sidecar);
    assert.equal(f.claims, 3);
    assert.equal(f.comprising, 2, '"including" is not "comprising"');
    assert.deepEqual(f.classes, { method: 2, system: 1 });
    assert.equal(f.method, 2);
    assert.equal(f.skeletonInEnum, 1, '"a method for ... comprising" is in the enum; "a method of ... including" is not');
    assert.equal(f.methodRows, 4);
    assert.equal(f.gerund, 3, 'the noun-led step is the one that is not gerund-led');
    assert.equal(f.system, 1);
    assert.equal(f.nounPhrase, 2);
    assert.equal(f.configuredTo, 1);
    assert.deepEqual([f.dependents, f.ofClaim, f.wherein, f.further], [2, 2, 1, 1]);
    assert.ok(f.population.gerund > 0.7 && f.population.gerund < 0.9, 'the population’s gerund share comes from the tables');
    assert.ok(f.population.ofClaim > 0.6 && f.population.nounPhrase > 0.6);
    assert.match(formatFrame('x', f), /comprising 67% \(population 9\d%\); class method 2 · system 1; method 2: skeleton in schema enum 50%, rows gerund-led 75% of 4 \(population 81%\); system 1: rows noun-phrase 100% of 2/);
  });
  it('groundAnchors carries elementIndex through to the grounded record', () => {
    const index = {
      findFunctionMatches: (name) => (name === 'spearman' ? [{ filepath: 'src/core/ranker-eval.js', name: 'spearman', start: 43, end: 56 }] : []),
      fileLines: new Map(),
    };
    const { grounded, dropped } = groundAnchors(index, [
      { file: 'src/core/ranker-eval.js', func: 'spearman', element: 'computing a rank correlation', elementIndex: 2 },
      { file: 'src/core/ranker-eval.js', func: 'nope', element: 'x', elementIndex: 3 },
    ]);
    assert.equal(grounded.length, 1);
    assert.equal(grounded[0].elementIndex, 2);
    assert.equal(dropped.length, 1);
  });
  it('the artifact lists schema-path anchors by element, says what a resample answered, and claims no sidecar it did not write', () => {
    const src = fs.readFileSync(new URL('../src/commands/pseudo-claims.js', import.meta.url), 'utf8');
    assert.ok(src.includes("byElement ? ', by element' : ''"), 'cited-anchors heading marks the by-element layout');
    assert.ok(src.includes('resampledFor'), 'the codes each resample answered are kept');
    assert.ok(src.includes('pass --claims-only <file> to keep the object itself'), 'no sidecar is claimed when none is written');
    assert.ok(src.includes('schemaChars'), 'the projected cost counts the schema on every call');
  });
  it('openai wire: a 400 that is not about the schema is an error, not a downgrade', async () => {
    const s = claimSchema({ claimClass: 'method', axes });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => '{"error":{"message":"model not found"}}' });
    try {
      const model = { wire: 'openai', model: 'gpt-test', key: 'k', apiUrl: 'http://127.0.0.1:9/v1/chat/completions', label: 'OpenAI API' };
      await assert.rejects(() => draftCloud(model, 'sys', 'user', 100, 0, { schema: s }), /HTTP 400: .*model not found/);
    } finally { globalThis.fetch = realFetch; }
  });
});
