// mechanisms.js — --build-mechanisms writes <index>/mechanisms.json (the grouper in cover mode, optional --describe sentences); --mechanisms lists it one row per function set, --toc is its table of contents
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// mechanisms-index-prebuild-cli-gui, Parts B and E. The build is an explicit
// post-build step like --build-rename-map (it joins _MUTATING_COMMAND_KEYS in
// src/index.js, so a no-index run errors instead of touching the demo); the
// listing reads the file through the same loader the GUI route and the MCP
// list_mechanisms tool use, so the three surfaces cannot disagree.

import { buildMechanismsIndex, saveMechanismsIndex, loadMechanismsIndex, mechanismsPath, filterRecords, foldRecords, formatMechanismsList, formatMechanismsToc, notBuiltLine, candidateCount, estimateBuildMinutes, carryDescriptions } from '../core/mechanisms-index.js';
import { harvestPurpose } from './pseudo-claims.js';
import { describeMechanisms } from '../core/mechanisms-describe.js';
import { effectiveMaxResults } from '../argparse.js';
import { filteredEmptyNotice } from '../core/filter-match.js';

const nf = (x) => Number(x || 0).toLocaleString('en-US');
const indexNameOf = (args) => String(args.index_path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '?';

/**
 * The build itself, shared by `--build-mechanisms` and the GUI's Build button
 * (src/mechanisms-build-worker.js): the grouper in cover mode with the
 * pseudo-claims harvester for purposes, the previous file's descriptions
 * carried over, the file written. Returns what the two callers report:
 * { data, file, seconds, blank, carried, prevDescribed }.
 */
export function buildMechanismsFile(index, { indexName = '?', onProgress = null } = {}) {
  const t0 = Date.now();
  // A previous file's paid descriptions survive the rebuild where the
  // record did not change (same label, same members).
  let prev = null;
  try { prev = loadMechanismsIndex(index, { cache: false }); } catch { prev = null; }
  const data = buildMechanismsIndex(index, {
    indexName,
    purposeFor: (label, members, g, calls) => harvestPurpose(index, label, members, g && g.residue, { calls: false, first: !!(g && g.splitFirst), hasCalls: !!(calls && calls.length) }),
    onProgress,
  });
  const carried = prev ? carryDescriptions(prev, data) : 0;
  const file = saveMechanismsIndex(index, data);
  return {
    data, file, seconds: (Date.now() - t0) / 1000,
    blank: data.records.filter((r) => !r.purpose).length,
    carried, prevDescribed: prev ? prev.records.filter((r) => r.description).length : 0,
  };
}

/** "N record(s) covering A of B functions (P%), C of D files": the cover line both surfaces print. */
export function coverSummary(data) {
  const c = data.coverage;
  const pct = c.functions ? Math.round(100 * c.inGroups / c.functions) : 0;
  return `${nf(data.records.length)} record(s) covering ${nf(c.inGroups)} of ${nf(c.functions)} functions (${pct}%), ${nf(c.filesRepresented)} of ${nf(c.files)} files`;
}

/**
 * `--build-mechanisms [--describe]`, or `--describe` alone on an existing
 * mechanisms.json. `exe` is how the CLI names itself in hints; `drafter` is
 * the test seam for --describe (an async (sys, user, maxTokens) => text).
 */
export async function doBuildMechanisms(index, args, { exe = 'ce', drafter = null } = {}) {
  const indexName = indexNameOf(args);
  let data = null;
  if (args.build_mechanisms) {
    const n = candidateCount(index);
    const est = estimateBuildMinutes(n);
    console.log(`Building mechanisms index from ${nf(index.files.size)} loaded files, ${nf(n)} functions (every function in at least one record; about ${est} minute${est === 1 ? '' : 's'} on an index this size)...`);
    const r = buildMechanismsFile(index, {
      indexName,
      onProgress: args.verbose ? (done, total) => console.error(`# mechanisms: ${nf(done)}/${nf(total)} records`) : null,
    });
    data = r.data;
    console.log(`Done: ${coverSummary(data)}, written to ${r.file} in ${r.seconds.toFixed(1)} s`);
    if (r.blank) console.log(`  ${nf(r.blank)} record(s) have no purpose text: no header, doc comment, docstring or outbound call to read.`);
    if (r.prevDescribed) {
      console.log(`  ${nf(r.carried)} of the previous file's ${nf(r.prevDescribed)} description(s) carried over (same label and members); ${nf(r.prevDescribed - r.carried)} belonged to records the rebuild changed.`);
    }
  } else {
    // --describe alone: the records of the existing file.
    try { data = loadMechanismsIndex(index, { cache: false }); } catch (e) { console.error(`--describe: ${e.message}`); process.exitCode = 1; return; }
    if (!data) { console.log(notBuiltLine(index, { exe, indexPath: args.index_path })); process.exitCode = 1; return; }
  }
  // Returned so a `--mechanisms` listing in the same command can repeat the
  // outcome at its bottom (mechanisms-description-leads, Andrew's Bram run:
  // the refusal line at the top had scrolled off under a hundred records).
  let describe = null;
  if (args.describe) {
    // `--mechanisms <filter> --describe` (or `--filter`) describes the matching
    // records only, so a reader pays for the dozen rows of interest rather than
    // the whole file (Andrew, 2026-11-04: `--mechanisms concepts --describe
    // --llm claude` on CodeExam's 1,010 records met the $2 cost guard instead).
    const filter = describeFilter(args);
    const subset = filter ? filterRecords(data.records, filter) : data.records;
    if (filter && !subset.length) {
      describe = { ok: false, done: 0, failed: 0, outcome: `No descriptions written: ${filteredEmptyNotice('mechanisms', data.records.length, filter)}` };
    } else {
      const r = await describeMechanisms(index, data, args, { drafter, records: subset, filter, redo: !!args.redescribe });
      if (r.ok) {
        saveMechanismsIndex(index, data);
        const scope = filter ? ` matching '${filter}'` : '';
        const skipped = r.skipped ? ` (${nf(r.skipped)} already described, skipped; --redescribe rewrites them)` : '';
        // mechanisms-toc-one-row-per-mechanism: a pair that is the same
        // functions under two labels is one call, and a pair described twice
        // before the fold takes one sentence at no cost.
        const unified = r.unified ? `; ${nf(r.unified)} record(s) took the sentence of the record with the same functions` : '';
        // A run the model calls cut short (the network dropped, a key expired)
        // keeps what it got and says how to resume: the same command again,
        // which skips the described records.
        const failed = r.failed
          ? `; ${nf(r.failed)} got no description${r.lastError ? ` (${r.lastError})` : ''}${r.stopped ? `, and the run stopped after ${nf(r.stopped)} failures in a row` : ''}; rerun the same command to resume (described records are skipped)`
          : '';
        const carrying = `${nf((data.described && data.described.records) || 0)} of ${nf(data.records.length)} records now carry a description`;
        describe = { ...r, outcome: r.done
          ? `Described ${nf(r.done)} of ${nf(r.wanted)} mechanism(s)${scope}${skipped} via ${data.described.engine}; ${carrying}${unified}; written to ${mechanismsPath(index)}${failed}`
          : `Unified ${nf(r.unified)} record(s) to the sentence of the record with the same functions, no model call needed; all ${nf(r.wanted)} mechanism(s)${scope} already carry one; ${carrying}; written to ${mechanismsPath(index)}` };
      } else {
        // Say so where a reader looks: the refusal itself went to stderr.
        describe = { ...r, outcome: `No descriptions written: ${r.reason}` };
      }
    }
    console.log(describe.outcome);
    if (!describe.ok) return { describe };
  }
  if (!(args._explicit && (args._explicit.has('mechanisms') || args._explicit.has('toc')))) {
    console.log(`  ${exe} --index-path ${args.index_path} --mechanisms [filter]   lists them, --toc [filter] is the one-line contents; the GUI's Mechanisms list and the list_mechanisms tool read the same file.`);
  }
  return { describe };
}

/** The filter a `--describe` run narrows to: the `--mechanisms` value, else the `--toc` value, else `--filter`, else null. */
export function describeFilter(args) {
  if (typeof args.mechanisms === 'string' && args.mechanisms) return args.mechanisms;
  if (typeof args.toc === 'string' && args.toc) return args.toc;
  return args.filter || null;
}

/**
 * The entries a listing shows (mechanisms-toc-one-row-per-mechanism): the
 * file's records folded by identical member set, then the filter. Returns
 * { data, entries, kept, filter }, or null after printing the not-built
 * line, an error, or the empty-filter notice.
 */
function listedEntries(index, args, flag, exe) {
  let data;
  try { data = loadMechanismsIndex(index); } catch (e) { console.error(`--${flag}: ${e.message}`); process.exitCode = 1; return null; }
  if (!data) { console.log(notBuiltLine(index, { exe, indexPath: args.index_path })); return null; }
  const own = args[flag];
  const filter = typeof own === 'string' && own ? own : (args.filter || null);
  const entries = foldRecords(data.records);
  const kept = filter ? filterRecords(entries, filter) : entries;
  if (!kept.length) {
    console.log(filter && entries.length ? filteredEmptyNotice('mechanisms', entries.length, filter) : 'No mechanisms recorded.');
    return null;
  }
  return { data, entries, kept, filter };
}

/**
 * `--mechanisms [filter]`: the entries of the file, or the one not-built line.
 * `describe` is the outcome a `--describe` in the same command returned; it is
 * repeated after the listing, where a reader of a long list looks, in place
 * of the formatter's own how-to-describe line.
 */
export function doMechanisms(index, args, { exe = 'ce', describe = null } = {}) {
  const l = listedEntries(index, args, 'mechanisms', exe);
  if (!l) return;
  // The shared cap contract: 100 by default, --max-results N, and
  // --all-results or --max-results 0 for every record.
  const max = effectiveMaxResults(args, 100);
  const { lines } = formatMechanismsList(l.data, l.kept, {
    filter: l.filter, max, verbose: !!args.verbose, exe,
    displayName: typeof index.getDisplayName === 'function' ? (n) => index.getDisplayName(n) : null,
    describeHint: !describe,
  });
  console.log(lines.join('\n'));
  if (describe && describe.outcome) console.log(`\n${describe.outcome}`);
}

/**
 * `--toc [filter]` (#296): the table of contents, one line per entry, the
 * same entries in the same order as --mechanisms; -v adds each entry's
 * block. The outcome of a --describe in the same command follows it.
 */
export function doToc(index, args, { exe = 'ce', describe = null } = {}) {
  const l = listedEntries(index, args, 'toc', exe);
  if (!l) return;
  const max = effectiveMaxResults(args, 100);
  const { lines } = formatMechanismsToc(l.data, l.kept, {
    filter: l.filter, max, verbose: !!args.verbose, exe,
    displayName: typeof index.getDisplayName === 'function' ? (n) => index.getDisplayName(n) : null,
    describeHint: !describe,
  });
  console.log(lines.join('\n'));
  if (describe && describe.outcome) console.log(`\n${describe.outcome}`);
}

// ---------------------------------------------------------------------------
// Part E: --describe lives in src/core/mechanisms-describe.js since
// gui-mechanisms-describe-button (the GUI's Describe button runs the same
// pass through src/server.js, which imports core, not a command).
// Re-exported so the CLI's callers and tests keep their import.
// ---------------------------------------------------------------------------
export { DESCRIBE_MAX_TOKENS, DESCRIBE_MAX_STREAK, DESCRIBE_SYS, describePack, cleanDescription, describeMechanisms, describeProjection } from '../core/mechanisms-describe.js';
