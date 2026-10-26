// claim-schema.js — a pseudo-claim as an OBJECT the drafter fills and CodeExam renders: frame fixed by the litigated population, substance free
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// WHY AN OBJECT, NOT A GRAMMAR (#322, 2026-10-19). A GBNF grammar that enumerates claim English is
// brittle and exists only for the local engine; a JSON schema is what every engine accepts.
// node-llama-cpp compiles it into a grammar for a GGUF (createGrammarForJsonSchema), Claude takes it
// as a tool-use input_schema, the OpenAI-style endpoints as a response_format. So the drafter fills
// this object and renderClaim() writes the claim text, deterministically, the same on every engine.
//
// WHAT THE SCHEMA FIXES AND WHAT IT LEAVES FREE. The frame words come from src/core/claim-frame-
// tables.json (scripts/build-claim-frame-tables.mjs): the preamble is one of the population's
// measured skeletons ("a method for ... comprising the steps of"), a dependent is "wherein" or
// "further comprising" with the parent named by number, and the element and dependent counts are
// bounded by the shape profile's bands. The substance of each element is a free string: the schema
// grammar supports enum, const, item counts and string lengths but no regular expression, so "a
// method step opens with a gerund" is a post-check (checkClaim) that the caller resamples on, not a
// constraint. Enums that reach past the frame make a model write stilted claims; the frame is tight
// and the body is free.
//
// THE PAIR AT BIRTH. Each element carries its anchors (file@function). The renderer keeps them out of
// the claim text and returns them beside it, which is the (claim element, anchored code) pair the HOF
// embedder trains on, produced by the same schema with no second pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLES_PATH = path.join(HERE, 'claim-frame-tables.json');
let _tables = null;

/** The shipped frame tables (built by scripts/build-claim-frame-tables.mjs), read once. */
export function frameTables() {
  if (!_tables) _tables = JSON.parse(fs.readFileSync(TABLES_PATH, 'utf8'));
  return _tables;
}

/** The classes the schema drafts in. pseudo-claim-class-apparatus (2026-10-25): `apparatus` is a
 * claim to a thing by its parts ("an apparatus comprising: a receiving unit configured to ..."),
 * distinct from `system` ("a system comprising: a memory ...; a processor configured to ...");
 * the population files both under one class, so apparatus draws its skeletons from the system
 * rows whose head is apparatus or device. `crm` is the computer-readable-medium claim. */
export const SCHEMA_CLASSES = ['method', 'system', 'apparatus', 'crm'];
const APPARATUS_HEADS = new Set(['apparatus', 'device']);
/** Resamples after a failed post-check, per claim: cheap, and a third attempt rarely differs. */
export const SCHEMA_RESAMPLE_CAP = 2;

// The dependent kinds a drafter may choose per class: the population's "wherein" (76.6%) and
// "further comprising" (17.2%), plus the apparatus ADDITION form dep-claims.js recognises.
const DEP_KINDS = {
  method: ['wherein', 'further comprising'],
  system: ['wherein', 'further comprising', 'wherein the processor is further configured to'],
  apparatus: ['wherein', 'further comprising'],
  crm: ['wherein', 'further comprising', 'wherein the instructions further cause the processor to'],
};
const CLASS_HEAD = { method: 'method', system: 'system', apparatus: 'apparatus', crm: 'computer-readable medium' };

// The words that end a preamble's opener (the noun phrase a dependent's subject echoes): the first
// purpose or body word. "a peripheral device connectable to ..., the peripheral device comprising"
// takes its head from the re-mention; "a system for ... comprising" from the opener.
const HEAD_STOP = /\b(?:for|of|in|to|on|with|by|that|which|when|configured|operable|adapted|arranged|programmed|having|storing|stored|containing|comprising|comprises|including|includes|wherein|embodying|encoded|being|used|usable|connectable|coupled|capable|operative)\b|\.\.\.|[,(:;]/;

/** The head noun a skeleton implies ("method", "system", "device"); null when none can be read. */
export function skeletonHead(skeleton) {
  const s = String(skeleton || '').toLowerCase();
  const mention = /,\s*(?:the|said)\s+((?:[\w-]+\s+){0,2}[\w-]+)\s+(?:comprising|comprises|including|includes|having|wherein|consisting)/.exec(s);
  const span = mention ? mention[1] : (HEAD_STOP.exec(s) ? s.slice(0, HEAD_STOP.exec(s).index) : s);
  const words = span.replace(/[^\w\s-]/g, ' ').trim().split(/\s+/).filter((w) => w && !['a', 'an', 'the', 'said', 'in'].includes(w));
  return words.length ? words[words.length - 1] : null;
}

/**
 * The preamble skeletons a class may use: the population's forms with at least `minCount`
 * occurrences. A thin class (crm: 15 claims, one form above a single count) is filled from the
 * class's own measured OPENERS ("a computer-readable medium", "a computer program product") in the
 * population's two generic shapes, opener + transition and opener + purpose + transition, marked
 * `supplementary` so a reader can tell a measured form from a composed one. Nothing is typed in by
 * hand. Each row carries the head noun it implies.
 */
export function skeletonsFor(claimClass, { tables = frameTables(), minCount = 2 } = {}) {
  // The population's class rule files apparatus and device heads under `system`; the apparatus
  // class is that subset, derived at run time rather than by rebuilding a dated table.
  const srcClass = claimClass === 'apparatus' ? 'system' : claimClass;
  const keep = claimClass === 'apparatus' ? (form) => APPARATUS_HEADS.has(skeletonHead(form)) : () => true;
  const t = tables?.claim1?.preambles?.skeletons?.[srcClass];
  const rows = ((t && t.rows) || []).filter((r) => r.count >= minCount && keep(r.value))
    .map((r) => ({ skeleton: r.value, count: r.count, head: skeletonHead(r.value) || CLASS_HEAD[claimClass] }));
  if (rows.length < 5) {
    const seen = new Set(rows.map((r) => r.skeleton));
    for (const o of (tables?.claim1?.preambles?.openers?.[srcClass]?.rows || [])) {
      for (const form of [`${o.value} comprising`, `${o.value} ... comprising`]) {
        if (seen.has(form) || !keep(form)) continue;
        seen.add(form);
        rows.push({ skeleton: form, count: 0, head: skeletonHead(form) || CLASS_HEAD[claimClass], supplementary: true });
      }
    }
  }
  return rows;
}

/** The litigated population's claim-1 class mix, for the run footer: { method: 0.49, system: 0.18, ... }. */
export function populationClassMix(tables = frameTables()) {
  const out = {};
  for (const r of (tables?.claim1?.classes?.rows || [])) out[r.value] = r.share;
  return out;
}

/**
 * The claim object schema for a class and a shape profile's axes. JSON-schema subset every engine
 * accepts: object/properties, enum, string min/maxLength, array min/maxItems, integer. For
 * node-llama-cpp every property is required and additionalProperties is false by default; the cloud
 * copies get that spelled out by strictSchema().
 */
export function claimSchema({ claimClass = 'method', axes = {}, tables = frameTables(), fixedClass = true } = {}) {
  if (!SCHEMA_CLASSES.includes(claimClass)) throw new Error(`claimSchema: class must be one of ${SCHEMA_CLASSES.join(', ')} (got ${claimClass})`);
  const skeletons = skeletonsFor(claimClass, { tables });
  if (!skeletons.length) throw new Error(`claimSchema: no preamble skeletons for class ${claimClass} in ${TABLES_PATH}`);
  const mech = axes.mechanism, fine = axes.fine, deps = axes.dependents;
  // Lower bound from the MECHANISM band (a claim 1 carries at least that many limitations that do
  // something specific), upper bound from the row band; never from words (a length target trims
  // specifics -- the 2026-08-28 measurement in pseudo-claims.js).
  const minElements = Math.max(2, Math.round(mech ? mech.p10 : 2));
  const maxElements = Math.max(minElements + 2, Math.round(fine ? fine.p90 : 11));
  // Dependents are NOT capped below: "as many as the material supports" (PSEUDO_SYS_DEPENDENTS),
  // and none is allowed. The upper bound is the population's p90.
  const maxDependents = Math.max(4, Math.round(deps ? deps.p90 : 17));
  return {
    type: 'object',
    properties: {
      class: { enum: fixedClass ? [claimClass] : SCHEMA_CLASSES },
      preamble: {
        type: 'object',
        properties: {
          skeleton: { enum: skeletons.map((s) => s.skeleton) },
          purpose: { type: 'string', maxLength: 240 },
        },
      },
      elements: {
        type: 'array', minItems: minElements, maxItems: maxElements,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 12, maxLength: 600 },
            anchors: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 200 } },
          },
        },
      },
      dependents: {
        type: 'array', maxItems: maxDependents,
        items: {
          type: 'object',
          properties: {
            dependsOn: { type: 'integer' },
            kind: { enum: DEP_KINDS[claimClass] },
            text: { type: 'string', minLength: 6, maxLength: 400 },
          },
        },
      },
    },
  };
}

/** A deep copy with `required` (every property) and `additionalProperties: false` on every object: what strict cloud modes demand. */
export function strictSchema(schema) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = (k === 'properties' && v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv)])) : walk(v);
    if (out.type === 'object' && out.properties) { out.required = Object.keys(out.properties); out.additionalProperties = false; }
    return out;
  };
  return walk(schema);
}

/** A deep copy without the bounding keywords an engine may reject (minItems/maxItems/minLength/maxLength); the post-checks still enforce them. */
export function looseSchema(schema) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (['minItems', 'maxItems', 'minLength', 'maxLength'].includes(k)) continue;
      out[k] = walk(v);
    }
    return out;
  };
  return walk(schema);
}

/**
 * Violations of the schema subset above, as `{path, message}` rows; empty when the object conforms.
 * The local grammar cannot produce a violation; the cloud wires can (a strict mode that was
 * downgraded, or a model that ignored a bound), and this is what makes that visible.
 */
export function validateObject(obj, schema, pathStr = '$') {
  const out = [];
  const bad = (m) => out.push({ path: pathStr, message: m });
  if (!schema || typeof schema !== 'object') return out;
  if (schema.enum) { if (!schema.enum.includes(obj)) bad(`expected one of ${schema.enum.slice(0, 6).map((e) => JSON.stringify(e)).join(', ')}${schema.enum.length > 6 ? ', ...' : ''}, got ${JSON.stringify(obj)}`); return out; }
  if (schema.const !== undefined) { if (obj !== schema.const) bad(`expected ${JSON.stringify(schema.const)}`); return out; }
  switch (schema.type) {
    case 'object':
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { bad('expected an object'); return out; }
      for (const [k, sub] of Object.entries(schema.properties || {})) {
        if (!(k in obj)) bad(`missing property "${k}"`);
        else out.push(...validateObject(obj[k], sub, `${pathStr}.${k}`));
      }
      for (const k of Object.keys(obj)) if (schema.properties && !(k in schema.properties)) bad(`unexpected property "${k}"`);
      return out;
    case 'array':
      if (!Array.isArray(obj)) { bad('expected an array'); return out; }
      if (schema.minItems != null && obj.length < schema.minItems) bad(`expected at least ${schema.minItems} item(s), got ${obj.length}`);
      if (schema.maxItems != null && obj.length > schema.maxItems) bad(`expected at most ${schema.maxItems} item(s), got ${obj.length}`);
      obj.forEach((it, i) => out.push(...validateObject(it, schema.items, `${pathStr}[${i}]`)));
      return out;
    case 'string':
      if (typeof obj !== 'string') { bad('expected a string'); return out; }
      if (schema.minLength != null && obj.length < schema.minLength) bad(`expected at least ${schema.minLength} characters`);
      if (schema.maxLength != null && obj.length > schema.maxLength) bad(`expected at most ${schema.maxLength} characters`);
      return out;
    case 'integer':
      if (!Number.isInteger(obj)) bad('expected an integer');
      return out;
    case 'number':
      if (typeof obj !== 'number') bad('expected a number');
      return out;
    case 'boolean':
      if (typeof obj !== 'boolean') bad('expected a boolean');
      return out;
    default:
      return out;
  }
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/^(?:and|or)\s+/i, '').replace(/[\s.;:,]+$/, '');

/**
 * Claim text from the object. Returns `{ claim, dependents: [{n, text}], anchors: [{ref, element}], head }`:
 * the shapes parseGeneratedClaim() produces from a free-text draft, so the caller's grounding,
 * shape report and sidecar run unchanged. Anchors never enter the text.
 */
export function renderClaim(obj, { claimClass = null } = {}) {
  const cls = (obj && obj.class) || claimClass || 'method';
  const skeleton = String((obj && obj.preamble && obj.preamble.skeleton) || '').trim();
  const purpose = clean(obj && obj.preamble && obj.preamble.purpose);
  let pre = skeleton.includes('...') ? skeleton.replace('...', purpose || '[purpose]') : skeleton;
  pre = pre.replace(/\s+/g, ' ').trim();
  pre = pre.charAt(0).toUpperCase() + pre.slice(1);
  const els = ((obj && obj.elements) || []).map((e) => clean(e && e.text)).filter(Boolean);
  const body = els.length <= 1 ? els.join('') : `${els.slice(0, -1).join('; ')}; and ${els[els.length - 1]}`;
  const claim = `${pre}: ${body}.`;
  const head = skeletonHead(skeleton) || CLASS_HEAD[cls] || 'method';
  const dependents = ((obj && obj.dependents) || []).map((d, i) => {
    const n = i + 2;
    const parent = Number(d && d.dependsOn) || 1;
    const t = clean(d && d.text);
    const kind = String((d && d.kind) || 'wherein');
    const text = kind === 'further comprising'
      ? `The ${head} of claim ${parent}, further comprising: ${t}.`
      : `The ${head} of claim ${parent}, ${kind} ${t}.`;
    return { n, text };
  });
  // One record per (element, anchor) pair, `n` = the element's 1-based position: the artifact
  // groups the cited anchors by element from it, and the sidecar keeps the flat pairs.
  const anchors = [];
  ((obj && obj.elements) || []).forEach((e, i) => {
    for (const ref of (e && e.anchors) || []) {
      const r = String(ref || '').trim().replace(/[`'"]/g, '');
      if (r) anchors.push({ ref: r, element: clean(e.text).slice(0, 100), n: i + 1 });
    }
  });
  return { claim, dependents, anchors, head };
}

const GERUND = /^[a-z]+ing$/;
const NOUN_OPENER = /^(?:a|an|the|said|one|at|each|plurality|means|wherein|instructions|logic|circuitry)$/;

/**
 * Post-checks the schema cannot express. `hard` failures are what the caller resamples on; soft ones
 * and notes ride into the sidecar. The allowed method-step openers are the population's own first
 * words (any gerund, plus the non-gerund openers real method claims use: "in response to",
 * "if", "wherein") -- read from the frame tables, not typed in.
 */
export function checkClaim(obj, { claimClass = 'method', axes = {}, tables = frameTables(), schema = null } = {}) {
  const failures = [];
  const notes = [];
  const fail = (code, message, hard = true) => failures.push({ code, message, hard });
  if (!obj || typeof obj !== 'object') { fail('no-object', 'the drafter returned no claim object'); return { failures, notes }; }
  if (schema) for (const v of validateObject(obj, schema)) fail('schema', `${v.path}: ${v.message}`);
  const cls = obj.class || claimClass;
  const skeleton = String((obj.preamble && obj.preamble.skeleton) || '');
  if (skeleton.includes('...') && !clean(obj.preamble && obj.preamble.purpose)) fail('purpose-missing', 'the preamble form has a "..." and no purpose was given');
  const els = Array.isArray(obj.elements) ? obj.elements : [];
  const firstWords = (t) => clean(t).toLowerCase().replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const methodOpeners = new Set((tables?.claim1?.elements?.firstWord?.method?.rows || []).filter((r) => r.count >= 10).map((r) => r.value));
  const offenders = [];
  els.forEach((e, i) => {
    const w = firstWords(e && e.text);
    const first = w[0] || '';
    if (cls === 'method') {
      if (!(GERUND.test(first) || methodOpeners.has(first))) offenders.push(`${i + 1}: "${first}"`);
    } else if (cls === 'system' || cls === 'apparatus') {
      if (!NOUN_OPENER.test(first)) offenders.push(`${i + 1}: "${first}"`);
    } else if (!(GERUND.test(first) || NOUN_OPENER.test(first) || methodOpeners.has(first))) offenders.push(`${i + 1}: "${first}"`);
  });
  if (offenders.length) {
    fail(cls === 'method' ? 'method-step-opener' : 'apparatus-element-opener',
      cls === 'method'
        ? `method steps open with a gerund ("receiving ...", "determining ..."); element(s) ${offenders.join(', ')} do not`
        : `apparatus elements open with an article or "means for" ("a processor configured to ..."); element(s) ${offenders.join(', ')} do not`);
  }
  const texts = els.map((e) => clean(e && e.text).toLowerCase()).filter(Boolean);
  if (new Set(texts).size !== texts.length) fail('duplicate-element', 'two elements have the same text', false);
  const unanchored = els.map((e, i) => ((e && e.anchors) || []).length ? null : i + 1).filter(Boolean);
  if (unanchored.length) notes.push(`element(s) ${unanchored.join(', ')} carry no anchor`);
  const deps = Array.isArray(obj.dependents) ? obj.dependents : [];
  const badRef = [];
  const depth = new Map();
  deps.forEach((d, i) => {
    const n = i + 2;
    const p = Number(d && d.dependsOn);
    if (!Number.isInteger(p) || p < 1 || p >= n) { badRef.push(`${n} -> ${d && d.dependsOn}`); depth.set(n, 1); return; }
    depth.set(n, p === 1 ? 1 : (depth.get(p) || 1) + 1);
  });
  if (badRef.length) fail('dependent-reference', `a dependent names claim 1 or an EARLIER dependent by number; claim(s) ${badRef.join(', ')} do not`);
  const cap = axes.depth ? Math.round(axes.depth.p90) : 4;
  const deep = [...depth.entries()].filter(([, dd]) => dd > cap).map(([n]) => n);
  if (deep.length) fail('dependent-depth', `dependent chain deeper than the population's p90 (${cap}) at claim(s) ${deep.join(', ')}`, false);
  return { failures, notes };
}

/** One line a caller appends to the user prompt on a resample, naming what failed. */
export function reviseLine(failures) {
  const hard = failures.filter((f) => f.hard);
  if (!hard.length) return '';
  return `\n\nREVISE: the previous claim object failed these checks; fix them and keep everything else:\n${hard.map((f) => `- ${f.message}`).join('\n')}`;
}
