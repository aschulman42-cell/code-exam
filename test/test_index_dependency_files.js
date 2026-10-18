// test_index_dependency_files.js — dependency and build files are indexed by name, whatever the extension
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// bom-lockfiles-resolved-tree: a build admitted files by extension alone, so
// a Makefile or Dockerfile (no extension) could never be indexed and go.mod,
// go.sum, Cargo.toml and every *.lock needed --add-extensions. The by-name
// rule (DEPENDENCY_FILE_RE) admits them in the directory walk and inside
// archives; an explicit --extensions list turns it off.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { expandArchive } from '../src/archive.js';
import { isDependencyFileName, DEPENDENCY_FILE_RE } from '../src/utils.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-depfiles-'));
const write = (rel, text) => {
  const p = path.join(root, 'src', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
write('Makefile', 'all:\n\tcc main.c\n');
write('Dockerfile', 'FROM node:20\n');
write('go.mod', 'module example.com/x\n\ngo 1.22\n');
write('Cargo.lock', '[[package]]\nname = "serde"\nversion = "1.0.0"\n');
write('BUILD', 'cc_library(name = "x")\n');
write('app/main.py', 'import os\n');
write('notes.lock', 'not a dependency file\n');
write('data.sum', 'not go.sum either\n');

const names = (idx) => [...idx.fileLines.keys()].map((p) => p.replace(/\\/g, '/')).sort();

describe('dependency and build files are indexed by name', () => {
  it('the name rule knows the manifests, lockfiles and build files, and nothing else', () => {
    for (const n of ['Makefile', 'GNUmakefile', 'rules.mk', 'CMakeLists.txt', 'Dockerfile', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
      'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Pipfile', 'Pipfile.lock', 'pyproject.toml', 'poetry.lock',
      'composer.lock', 'Gemfile', 'Gemfile.lock', 'pom.xml', 'build.gradle', 'App.csproj', 'Native.vcxproj', 'packages.config',
      'BUILD', 'WORKSPACE', 'BUILD.bazel', 'defs.bzl', 'Podfile', 'pubspec.lock', 'mix.exs', 'some/dir/Makefile']) {
      assert.ok(isDependencyFileName(n), `${n} should be a dependency/build file`);
    }
    for (const n of ['notes.lock', 'data.sum', 'main.py', 'README.md', 'Makefile.bak', 'build.log', 'config.json', 'lockfile.txt']) {
      assert.ok(!isDependencyFileName(n), `${n} should not be`);
    }
    assert.ok(DEPENDENCY_FILE_RE.flags.includes('i'), 'case-insensitive: BUILD, Makefile, makefile');
  });

  it('a default build admits them beside the source files; look-alikes stay out', async () => {
    const idx = new CodeSearchIndex({ indexPath: path.join(root, '.idx-default') });
    await idx.buildIndex(path.join(root, 'src'), { showProgress: false });
    assert.deepEqual(names(idx), ['BUILD', 'Cargo.lock', 'Dockerfile', 'Makefile', 'app/main.py', 'go.mod']);
  });

  it('an explicit --extensions list means exactly that list', async () => {
    const idx = new CodeSearchIndex({ indexPath: path.join(root, '.idx-explicit'), extensions: new Set(['.py']), dependencyFilesByName: false });
    await idx.buildIndex(path.join(root, 'src'), { showProgress: false });
    assert.deepEqual(names(idx), ['app/main.py']);
  });

  it('inside an archive the same rule applies, and the flag turns it off', () => {
    const zip = makeZip([
      { name: 'proj/Makefile', data: Buffer.from('all:\n') },
      { name: 'proj/go.sum', data: Buffer.from('example.com/y v1.0.0 h1:abc=\n') },
      { name: 'proj/main.py', data: Buffer.from('import os\n') },
      { name: 'proj/notes.lock', data: Buffer.from('x\n') },
    ]);
    const got = (opts) => expandArchive(zip, { archiveName: 'proj.zip', showProgress: false, ...opts }).map((e) => e.virtualPath.replace(/\\/g, '/').replace(/^.*?proj\.zip[/!]*/, '')).sort();
    assert.deepEqual(got({ extensions: new Set(['.py']) }), ['proj/Makefile', 'proj/go.sum', 'proj/main.py']);
    assert.deepEqual(got({ extensions: new Set(['.py']), dependencyFilesByName: false }), ['proj/main.py']);
  });
});

// A stored-only ZIP from [{name, data}], enough for the real central-directory
// parser (the reader keys off sizes and offsets, not CRC).
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const data = f.data;
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    locals.push(local, data); centrals.push(central);
    offset += local.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}
