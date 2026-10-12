#!/usr/bin/env node
// build-first-run-index.mjs — rebuilds samples/FIRST_RUN_INDEX.zip from the tracked samples/ tree: hybrid build, base path sanitized, deflate zip, verified load
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// The shipped demo index is CodeExam's default index (a bare `ce` or a first
// `ce --gui` loads it), so it has to be regenerable in one step whenever the
// parsers change, without re-leaking the build machine's path (#237: the
// July 2026 zip was sanitized by a one-off JSON edit, and a rebuild from a
// file list or a directory stores the absolute path again). This script is
// that step (rebuild-first-run-index, 2026-10-12):
//
//   1. the file list is `git ls-files samples/` minus *.zip / *.lst — exactly
//      what ships, never a stray scratch file;
//   2. `node src/index.js --index-path <tmp> --build-index @<list>
//      --use-tree-sitter`, from the repo root (the demo ships the hybrid
//      build: grammar spans, deduped merge, macro names);
//   3. base_path and index_source in literal_index.json are rewritten to
//      "samples", and every build file is checked for the absolute path;
//   4. the build's JSON files are zipped under a FIRST_RUN_INDEX/ folder
//      (deflate, written here with zlib — the repo has no zip-writing
//      dependency);
//   5. the zip is loaded through CodeExam and --stats must report
//      `Source: samples`; the before/after counts are printed.
//
//   node scripts/build-first-run-index.mjs [--out samples/FIRST_RUN_INDEX.zip] [--keep]
//
//   --out   where to write (default: the shipped path)
//   --keep  leave the temp build directory in place and print its path

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');
const LABEL = 'samples';            // what the shipped zip says for base_path / index_source
const FOLDER = 'FIRST_RUN_INDEX';   // the folder inside the zip (the July layout)

const args = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const OUT = path.resolve(ROOT, argVal('--out', path.join('samples', 'FIRST_RUN_INDEX.zip')));
const KEEP = args.includes('--keep');

function fail(msg) { console.error(`build-first-run-index: ${msg}`); process.exit(1); }
function ce(cliArgs) {
  const r = spawnSync(process.execPath, [ENTRY, ...cliArgs], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`${r.error.message}`);
  return r;
}
function statsOf(indexPath) {
  const r = ce(['--index-path', indexPath, '--stats']);
  const line = (re) => (r.stdout.match(re) || [])[0] || '';
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr,
    files: line(/^.*[Ff]iles.*$/m), functions: line(/^.*[Ff]unctions.*$/m),
    source: line(/^Source:.*$/m), base: line(/^Base path:.*$/m), parse: line(/^.*[Pp]arse.*$/m) };
}

// --- 1. what ships ---------------------------------------------------------
const ls = spawnSync('git', ['ls-files', '-z', 'samples'], { cwd: ROOT, encoding: 'utf8' });
if (ls.status !== 0) fail(`git ls-files failed: ${ls.stderr || ls.error}`);
const files = ls.stdout.split('\0').filter(Boolean).filter((f) => !/\.(zip|lst)$/i.test(f)).sort();
if (!files.length) fail('git ls-files samples/ returned nothing');
console.log(`[first-run] ${files.length} tracked files under samples/ (zips and lists excluded)`);

// --- 2. before, for the record --------------------------------------------
let before = null;
if (fs.existsSync(OUT)) {
  before = statsOf(OUT);
  console.log(`[first-run] before: ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes)`);
  for (const l of [before.files, before.functions, before.parse, before.source, before.base]) if (l) console.log(`    ${l}`);
}

// --- 3. build ---------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codeexam-first-run-'));
const listPath = path.join(work, 'samples.lst');
fs.writeFileSync(listPath, files.join('\n') + '\n');
const idxDir = path.join(work, 'index');
console.log(`[first-run] building ${idxDir} (hybrid: --use-tree-sitter)`);
const b = ce(['--index-path', idxDir, '--build-index', `@${listPath}`, '--use-tree-sitter']);
process.stdout.write(b.stdout.split('\n').filter((l) => /Function index|tree-sitter:|regex fallback|parse errors|Indexing complete|Read \d+ files/.test(l)).map((l) => `    ${l.trim()}`).join('\n') + '\n');
if (b.status !== 0) { process.stderr.write(b.stderr); fail(`build exited ${b.status}`); }

// --- 4. sanitize, then prove nothing leaks -----------------------------------
const litPath = path.join(idxDir, 'literal_index.json');
if (!fs.existsSync(litPath)) fail(`no literal_index.json in ${idxDir}`);
let lit = fs.readFileSync(litPath, 'utf8');
const was = {
  base: (lit.match(/^"base_path":(.*),$/m) || [])[1],
  source: (lit.match(/^"index_source":(.*),$/m) || [])[1],
};
if (was.base === undefined || was.source === undefined) fail('literal_index.json header is not the expected one-field-per-line shape; refusing to sanitize blind');
lit = lit.replace(/^"base_path":.*$/m, `"base_path":${JSON.stringify(LABEL)},`)
  .replace(/^"index_source":.*$/m, `"index_source":${JSON.stringify(LABEL)},`);
fs.writeFileSync(litPath, lit);
console.log(`[first-run] base_path ${was.base} -> ${JSON.stringify(LABEL)}; index_source ${was.source} -> ${JSON.stringify(LABEL)}`);

const buildFiles = fs.readdirSync(idxDir).filter((f) => f.endsWith('.json')).sort();
const leaks = [ROOT, ROOT.replace(/\\/g, '/'), ROOT.replace(/\\/g, '\\\\'), os.homedir(), os.homedir().replace(/\\/g, '/')];
for (const f of buildFiles) {
  const text = fs.readFileSync(path.join(idxDir, f), 'utf8');
  for (const leak of leaks) if (leak && text.includes(leak)) fail(`${f} still contains the build path (${leak}); not shipping it`);
}
console.log(`[first-run] ${buildFiles.length} build files, none contains the build path or the home directory`);

// --- 5. zip (stored under FIRST_RUN_INDEX/, deflate) --------------------------
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c; }
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
const locals = [], centrals = [];
let offset = 0;
for (const f of buildFiles) {
  const data = fs.readFileSync(path.join(idxDir, f));
  const name = Buffer.from(`${FOLDER}/${f}`, 'utf8');
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14); cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
  locals.push(lh, name, comp);
  centrals.push(cd, name);
  offset += lh.length + name.length + comp.length;
}
const cdBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
end.writeUInt16LE(buildFiles.length, 8); end.writeUInt16LE(buildFiles.length, 10);
end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([...locals, cdBuf, end]));
console.log(`[first-run] wrote ${path.relative(ROOT, OUT)}: ${buildFiles.length} entries under ${FOLDER}/, ${fs.statSync(OUT).size} bytes`);

// --- 6. verify by loading it the way a user does ----------------------------
const after = statsOf(OUT);
if (!after.ok) { process.stderr.write(after.stderr); fail('--stats on the new zip failed'); }
if (!/\[zip-index\] extracting/.test(after.stderr)) fail('the new zip was served from an old cache; the cache key should have changed');
if (!new RegExp(`^Source: ${LABEL}$`, 'm').test(after.stdout)) fail(`--stats does not report "Source: ${LABEL}":\n${after.stdout}`);
if (!new RegExp(`^Base path: ${LABEL}$`, 'm').test(after.stdout)) fail(`--stats does not report "Base path: ${LABEL}":\n${after.stdout}`);
console.log('[first-run] after:');
for (const l of [after.files, after.functions, after.parse, after.source, after.base]) if (l) console.log(`    ${l}`);

if (KEEP) console.log(`[first-run] kept ${work}`);
else fs.rmSync(work, { recursive: true, force: true });
console.log('[first-run] done');
