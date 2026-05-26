/**
 * Bun standalone-executable extractor (#74).
 *
 * Decodes the on-disk format that `bun build --compile` produces. The
 * canonical reference is `oven-sh/bun:src/standalone_graph/StandaloneModuleGraph.zig`
 * — this file mirrors that schema in JavaScript.
 *
 * Layout (from end-of-payload, working backward):
 *
 *   [ module graph bytes (byte_count bytes) ]
 *   [ Offsets struct (32 bytes) ]
 *   [ trailer "\n---- Bun! ----\n" (16 bytes) ]
 *
 * For PE binaries that have been Authenticode-signed (Windows builds of
 * Claude Code, Codex, etc.), the certificate block sits AFTER the trailer.
 * `detectBun` is PE-aware: it reads the PE Certificate Table directory to
 * find the cert offset, then scans backward from that point for the
 * trailer marker. For unsigned binaries (ELF/Mach-O without codesigning,
 * or PE with no cert), the scan starts from the end of file.
 *
 * Offsets struct:
 *   byte_count             usize (u64 on 64-bit, 8 bytes)
 *   modules_ptr            StringPointer (8 bytes: offset u32, length u32)
 *   entry_point_id         u32 (4 bytes)
 *   compile_exec_argv_ptr  StringPointer (8 bytes)
 *   flags                  u32 (4 bytes)
 *
 * CompiledModuleGraphFile (52 bytes, repeated `modules_ptr.length / 52` times):
 *   name                   StringPointer
 *   contents               StringPointer
 *   sourcemap              StringPointer
 *   bytecode               StringPointer
 *   module_info            StringPointer
 *   bytecode_origin_path   StringPointer
 *   encoding               u8 (0=binary, 1=latin1, 2=utf8)
 *   loader                 u8 (1=jsx, 2=js, 3=ts, ...)
 *   module_format          u8 (0=none, 1=esm, 2=cjs)
 *   side                   u8 (0=server, 1=client)
 *
 * All StringPointer offsets are relative to the start of the module graph
 * bytes (NOT the start of the binary).
 */

import fs from 'node:fs';
import path from 'node:path';

const TRAILER = Buffer.from('\n---- Bun! ----\n', 'utf8');
const OFFSETS_SIZE = 32;
const MODULE_RECORD_SIZE = 52;

// Bun's virtual-filesystem prefixes. Strip these so extracted files land
// at sane relative paths rather than e.g. `B:/~BUN/root/app.js`.
const BUN_VFS_PREFIXES = [
  '/$bunfs/root/',
  '/$bunfs/',
  'B:/~BUN/root/',
  'B:/~BUN/',
  'B:\\~BUN\\root\\',
  'B:\\~BUN\\',
];

// Loader values match `oven-sh/bun:src/options_types/schema.zig::Loader`.
// Used to give extracted files informative metadata + (eventually) extensions.
const LOADERS = {
  254: 'none', 1: 'jsx', 2: 'js', 3: 'ts', 4: 'tsx', 5: 'css', 6: 'file',
  7: 'json', 8: 'jsonc', 9: 'toml', 10: 'wasm', 11: 'napi', 12: 'base64',
  13: 'dataurl', 14: 'text', 15: 'bunsh', 16: 'sqlite', 17: 'sqlite_embedded',
  18: 'html', 19: 'yaml', 20: 'json5', 21: 'md',
};

const ENCODINGS = { 0: 'binary', 1: 'latin1', 2: 'utf8' };

const MODULE_FORMATS = { 0: 'none', 1: 'esm', 2: 'cjs' };

/**
 * Detect whether `binaryPath` is a Bun standalone executable.
 *
 * Returns `{ trailerOffset, payloadEnd, fileSize }` on detection, or
 * `null` if no trailer marker is found.
 *
 * `payloadEnd` is the offset where the bun payload ends — either the
 * file size (no codesigning) or the PE Certificate Table offset
 * (Authenticode-signed Windows builds).
 */
export function detectBun(binaryPath) {
  const fd = fs.openSync(binaryPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    let payloadEnd = fileSize;
    const cert = _readPECertOffset(fd);
    if (cert && cert.certOffset > 0) {
      payloadEnd = cert.certOffset;
    }

    // The trailer is 16 bytes. Scan the tail of the payload for it.
    // 64 KB is generous — the trailer is the last thing before the cert.
    const scanBack = Math.min(65536, payloadEnd);
    const scanStart = payloadEnd - scanBack;
    const buf = Buffer.alloc(scanBack);
    fs.readSync(fd, buf, 0, scanBack, scanStart);

    const trailerIdx = buf.lastIndexOf(TRAILER);
    if (trailerIdx < 0) return null;

    return {
      trailerOffset: scanStart + trailerIdx,
      payloadEnd,
      fileSize,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Extract embedded modules from a Bun standalone executable.
 *
 * Writes each module's contents to `outputDir`, preserving the VFS path
 * (with the `/$bunfs/root/` or `B:/~BUN/root/` prefix stripped).
 *
 * Returns `{ format, outputDir, moduleCount, entryPointId, extractedFiles, skipped, totalBytes }`.
 */
export function extractBun(binaryPath, outputDir) {
  const detection = detectBun(binaryPath);
  if (!detection) throw new Error(`Bun trailer not found in ${binaryPath}`);

  const { trailerOffset } = detection;
  const offsetsStart = trailerOffset - OFFSETS_SIZE;
  if (offsetsStart < 0) throw new Error('Trailer too close to start of file — corrupt binary?');

  const fd = fs.openSync(binaryPath, 'r');
  try {
    const offsetsBuf = Buffer.alloc(OFFSETS_SIZE);
    fs.readSync(fd, offsetsBuf, 0, OFFSETS_SIZE, offsetsStart);

    const byteCount = Number(offsetsBuf.readBigUInt64LE(0));
    const modulesOffset = offsetsBuf.readUInt32LE(8);
    const modulesLength = offsetsBuf.readUInt32LE(12);
    const entryPointId = offsetsBuf.readUInt32LE(16);
    const execArgvOffset = offsetsBuf.readUInt32LE(20);
    const execArgvLength = offsetsBuf.readUInt32LE(24);
    const flags = offsetsBuf.readUInt32LE(28);

    if (byteCount <= 0 || byteCount > offsetsStart) {
      throw new Error(`Invalid byte_count from Offsets: ${byteCount}`);
    }

    const graphStart = offsetsStart - byteCount;

    // Read the full module-graph region into memory. This can be hundreds
    // of MB on a large binary (claude.exe v2.1.150 has ~125 MB of graph);
    // a streaming extractor would be more memory-friendly but the simple
    // in-memory approach is fine for an analysis tool, and matches Bun's
    // own runtime which mmap's the whole region.
    const graphBuf = Buffer.alloc(byteCount);
    fs.readSync(fd, graphBuf, 0, byteCount, graphStart);

    if (modulesOffset + modulesLength > byteCount) {
      throw new Error(`Modules list range [${modulesOffset}, ${modulesOffset + modulesLength}) exceeds graph (${byteCount})`);
    }
    const moduleCount = Math.floor(modulesLength / MODULE_RECORD_SIZE);

    const extractedFiles = [];
    const skipped = [];

    for (let i = 0; i < moduleCount; i++) {
      const rec = modulesOffset + i * MODULE_RECORD_SIZE;

      const name = _readStringPointer(graphBuf, rec + 0);
      const contents = _readStringPointer(graphBuf, rec + 8);
      const sourcemap = _readStringPointer(graphBuf, rec + 16);
      // bytecode / module_info / bytecode_origin_path read but not extracted
      // (they're Bun's runtime cache artifacts, not source); only the
      // shape matters here for parsing.
      const encoding = graphBuf.readUInt8(rec + 48);
      const loader = graphBuf.readUInt8(rec + 49);
      const moduleFormat = graphBuf.readUInt8(rec + 50);
      const side = graphBuf.readUInt8(rec + 51);

      const nameStr = _readStringFromGraph(graphBuf, name) || `<unnamed-${i}>`;

      if (contents.length === 0) {
        skipped.push({ index: i, name: nameStr, reason: 'empty contents' });
        continue;
      }
      if (contents.offset + contents.length > byteCount) {
        skipped.push({ index: i, name: nameStr, reason: `contents range out of bounds` });
        continue;
      }

      const relPath = _stripVfsPrefix(nameStr) || `module-${i}.dat`;
      const fullOutputPath = path.join(outputDir, relPath);
      fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true });

      const contentBuf = graphBuf.slice(contents.offset, contents.offset + contents.length);
      fs.writeFileSync(fullOutputPath, contentBuf);

      extractedFiles.push({
        path: relPath,
        sourcePath: nameStr,
        size: contents.length,
        loader: LOADERS[loader] || `loader-${loader}`,
        encoding: ENCODINGS[encoding] || `enc-${encoding}`,
        moduleFormat: MODULE_FORMATS[moduleFormat] || `fmt-${moduleFormat}`,
        side: side === 1 ? 'client' : 'server',
        isEntryPoint: i === entryPointId,
      });

      if (sourcemap.length > 0 && sourcemap.offset + sourcemap.length <= byteCount) {
        const smapPath = fullOutputPath + '.map';
        const smapBuf = graphBuf.slice(sourcemap.offset, sourcemap.offset + sourcemap.length);
        fs.writeFileSync(smapPath, smapBuf);
        extractedFiles.push({
          path: relPath + '.map',
          sourcePath: nameStr + '.map',
          size: sourcemap.length,
          loader: 'sourcemap',
          encoding: 'binary',
          moduleFormat: 'sourcemap',
          side: side === 1 ? 'client' : 'server',
          isEntryPoint: false,
        });
      }
    }

    return {
      format: 'bun',
      outputDir,
      moduleCount,
      entryPointId,
      extractedFiles,
      skipped,
      totalBytes: byteCount,
      flags,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function _readStringPointer(buf, at) {
  return {
    offset: buf.readUInt32LE(at),
    length: buf.readUInt32LE(at + 4),
  };
}

function _readStringFromGraph(graphBuf, ptr) {
  if (ptr.length === 0) return '';
  if (ptr.offset + ptr.length > graphBuf.length) return '';
  return graphBuf.slice(ptr.offset, ptr.offset + ptr.length).toString('utf8');
}

function _stripVfsPrefix(s) {
  // Normalize backslashes for prefix-stripping (Windows VFS uses `B:\~BUN\`
  // but most paths in the index use forward slashes). Then strip any
  // recognized VFS prefix.
  let out = s.replace(/\\/g, '/');
  for (const prefix of BUN_VFS_PREFIXES) {
    const norm = prefix.replace(/\\/g, '/');
    if (out.startsWith(norm)) {
      out = out.slice(norm.length);
      break;
    }
  }
  // Drop any leading slashes so path.join doesn't treat the result as
  // absolute on Unix.
  return out.replace(/^\/+/, '');
}

/**
 * Read the PE Certificate Table offset/size from the optional header.
 * Returns `{ certOffset, certSize }` for signed PE32+ binaries, or null
 * for unsigned binaries / non-PE files / parse errors.
 */
function _readPECertOffset(fd) {
  const buf = Buffer.alloc(8);
  try {
    // MZ signature at offset 0
    fs.readSync(fd, buf, 0, 2, 0);
    if (buf[0] !== 0x4d || buf[1] !== 0x5a) return null;  // not MZ
    // PE offset at 0x3C
    fs.readSync(fd, buf, 0, 4, 0x3C);
    const peOffset = buf.readUInt32LE(0);
    // PE signature
    fs.readSync(fd, buf, 0, 4, peOffset);
    if (buf.toString('ascii', 0, 4) !== 'PE\0\0') return null;
    // Optional header magic (PE32+ = 0x20b, PE32 = 0x10b)
    fs.readSync(fd, buf, 0, 2, peOffset + 24);
    const magic = buf.readUInt16LE(0);
    // Certificate Table is data directory index 4
    // PE32+: data dirs at OptHdr + 112. PE32: at OptHdr + 96.
    const dataDirBase = (magic === 0x20b) ? 112 : 96;
    const certDirOff = peOffset + 24 + dataDirBase + 4 * 8;
    fs.readSync(fd, buf, 0, 8, certDirOff);
    const certOffset = buf.readUInt32LE(0);
    const certSize = buf.readUInt32LE(4);
    return { certOffset, certSize };
  } catch {
    return null;
  }
}
