/**
 * Worker thread for building indexes without blocking the main event loop.
 * Receives { sourcePath, indexPath } via workerData.
 * Posts progress messages and final result back to parent.
 */
import { parentPort, workerData } from 'worker_threads';
import { CodeSearchIndex } from './core/CodeSearchIndex.js';

const { sourcePath, indexPath } = workerData;

// Intercept console.log and stdout.write to capture progress
const origLog = console.log;
const origWrite = process.stdout.write;

console.log = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  if (msg) parentPort.postMessage({ type: 'progress', message: msg });
};

const boundOrigWrite = origWrite.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : chunk.toString();
  const trimMsg = s.replace(/\r?\n$/, '').trim();
  if (trimMsg) parentPort.postMessage({ type: 'progress', message: trimMsg });
  return boundOrigWrite(chunk, ...rest);
};

try {
  const idx = new CodeSearchIndex({ indexPath });
  const stats = idx.buildIndex(sourcePath, { showProgress: true, skipSemantic: true });
  console.log = origLog;
  process.stdout.write = origWrite;
  parentPort.postMessage({ type: 'done', stats });
} catch (err) {
  console.log = origLog;
  process.stdout.write = origWrite;
  parentPort.postMessage({ type: 'error', error: err.message });
}
