// mechanisms-build-worker.js — worker thread that runs the mechanisms build (the grouper and the purpose harvester) off the main loop for the GUI's Build button
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// gui-mechanisms-describe-button (Andrew's feedback, 2026-11-04): the
// Mechanisms pane's Build button runs --build-mechanisms's own build
// (buildMechanismsFile, src/commands/mechanisms.js) here, on the
// build-worker.js pattern, so the server keeps answering while a large index
// groups. The worker loads its own copy of the index from the path the server
// resolved (a second copy in memory for the duration, as a CLI build beside
// the GUI is), posts the phase as it goes (loading, grouping, then records
// every two hundred), and ends with the outcome line or the error. Receives
// { indexPath, indexName } via workerData.
import { parentPort, workerData } from 'worker_threads';
import { CodeSearchIndex } from './core/CodeSearchIndex.js';
import { buildMechanismsFile, coverSummary } from './commands/mechanisms.js';

const { indexPath, indexName } = workerData;
const nf = (x) => Number(x || 0).toLocaleString('en-US');

try {
  parentPort.postMessage({ type: 'progress', phase: 'loading' });
  const index = new CodeSearchIndex({ indexPath });
  if (index.files.size === 0) throw new Error(`No files loaded from index at ${indexPath}`);
  parentPort.postMessage({ type: 'progress', phase: 'grouping' });
  const r = buildMechanismsFile(index, {
    indexName,
    onProgress: (done, total) => parentPort.postMessage({ type: 'progress', phase: 'records', done, total }),
  });
  const notes = [
    r.blank ? `${nf(r.blank)} record${r.blank === 1 ? '' : 's'} with no purpose text` : '',
    r.prevDescribed ? `${nf(r.carried)} of the previous file's ${nf(r.prevDescribed)} description(s) carried over` : '',
  ].filter(Boolean);
  parentPort.postMessage({
    type: 'done',
    records: r.data.records.length,
    outcome: `Built ${coverSummary(r.data)} in ${r.seconds.toFixed(1)} s${notes.length ? `; ${notes.join('; ')}` : ''}.`,
  });
} catch (err) {
  parentPort.postMessage({ type: 'error', error: (err && err.message) ? err.message : String(err) });
}
