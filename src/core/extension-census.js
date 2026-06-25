/**
 * extension-census.js — "present in source but not indexed" extension census (#191).
 *
 * Single source of truth for the skipped-extension report shown by three surfaces:
 *   - the `--build-index` tip (src/index.js),
 *   - the GUI Extensions accordion (`/api/index-extensions` in src/server.js),
 *   - the CLI `--index-extensions` command (src/commands/browse.js).
 *
 * It UNIONS the two ways a file can be "present but unindexed", because for a
 * source directory that CONTAINS archives BOTH apply and the previous `if/else-if`
 * picked only one:
 *
 *   1. `index.skippedExtensions` — archive-INTERNAL skips recorded during zip
 *      expansion at build (e.g. 78 `.jinja2` inside `*-main.zip`), persisted on
 *      the index.
 *   2. a live scan of the source directory — loose on-disk files not indexed.
 *
 * A directory-of-zips has its real skips in (1), while a plain directory scan (2)
 * sees only the `.zip` files; the old code took (2) and dropped (1), so the
 * archive-internal skips (the interesting ones) never surfaced.
 */
import fs from 'fs';
import { MEDIA_BINARY_EXTENSIONS, ARCHIVE_EXTENSIONS, EXECUTABLE_EXTENSIONS } from '../utils.js';
import { BINSTRING_EXTENSIONS } from '../binstrings.js';
import { CodeSearchIndex } from './CodeSearchIndex.js';

const _isNonText = (ext) => MEDIA_BINARY_EXTENSIONS.has(ext) || ARCHIVE_EXTENSIONS.has(ext)
  || EXECUTABLE_EXTENSIONS.has(ext) || BINSTRING_EXTENSIONS.has(ext);

// A real, suggestable extension: starts with a letter, alphanumeric, <= 8 chars.
// Rejects junk pseudo-extensions that filename-splitting produces from dotted
// non-extension suffixes — e.g. `.0`, `.0001_bs32_schlinear_grpo_` off ML
// checkpoint files named `global_step.0001_bs32_...`. Never an --add-extensions
// target, and pure noise in the report.
const _isPlausibleExt = (ext) => /^[a-z][a-z0-9]{0,7}$/i.test(String(ext).replace(/^\./, ''));

/**
 * Compute the skipped-extension census for a loaded index.
 * @param {object} index loaded CodeSearchIndex (uses .skippedExtensions, .indexSource, .extensions)
 * @param {object} [opts]
 * @param {number} [opts.limit=12]    max entries per (text / media) list
 * @param {number} [opts.minCount=3]  minimum file count for an extension to report
 * @returns {{text:Array<{ext:string,count:number}>, media:Array<{ext:string,count:number}>, addList:string}|null}
 */
export function skippedExtensionCensus(index, { limit = 12, minCount = 3 } = {}) {
  const census = {}; // { ext: count } of files present in source but NOT indexed

  // (1) archive-internal skips, recorded at build and persisted on the index.
  for (const [ext, n] of Object.entries(index.skippedExtensions || {})) {
    if (ext) census[ext] = (census[ext] || 0) + n;
  }

  // (2) loose on-disk files not indexed — live scan when the source is a directory.
  //     For a directory-of-archives this only adds the .zip files (filtered out
  //     below as non-text); the real skips come from (1).
  try {
    const src = index.indexSource;
    if (src && fs.existsSync(src) && fs.statSync(src).isDirectory()) {
      const counts = CodeSearchIndex.scanExtensions(src);
      for (const [ext, n] of Object.entries(counts)) {
        if (ext && ext !== '(no extension)') census[ext] = (census[ext] || 0) + n;
      }
    }
  } catch { /* source moved / unreadable: persisted census only */ }

  // (3) drop extensions that ARE indexed. A partially-skipped-but-indexed
  //     extension (e.g. .yaml: 71 indexed + 5 stray skips) must not read as
  //     "skipped". The directory branch already filtered this way; the persisted
  //     branch did not — this closes that second blind spot.
  const eff = index.extensions;
  if (eff && typeof eff.has === 'function') {
    for (const ext of Object.keys(census)) if (eff.has(ext)) delete census[ext];
  }

  const entries = Object.entries(census)
    .filter(([ext, n]) => ext && n >= minCount && _isPlausibleExt(ext))
    .sort((a, b) => b[1] - a[1]);
  // Only text extensions are suggested for --add-extensions; media/binary are
  // listed for awareness (indexing them as text yields garbage), never recommended.
  const text = entries.filter(([ext]) => !_isNonText(ext)).slice(0, limit).map(([ext, count]) => ({ ext, count }));
  const media = entries.filter(([ext]) => MEDIA_BINARY_EXTENSIONS.has(ext)).slice(0, limit).map(([ext, count]) => ({ ext, count }));
  if (!text.length && !media.length) return null;
  return { text, media, addList: text.map(t => t.ext).join(',') };
}
