/**
 * glob.js - Minimal glob implementation using only Node.js built-ins.
 * Supports *, **, and ? wildcards for file discovery.
 */

import fs from 'fs';
import path from 'path';

/**
 * Expand a glob pattern into matching file paths.
 * Supports: *, **, ? wildcards.
 * @param {string} pattern - Glob pattern (forward slashes)
 * @returns {string[]} - Matching absolute file paths
 */
export function _globSync(pattern) {
  // Normalize to forward slashes
  pattern = pattern.replace(/\\/g, '/');

  // Split into directory prefix (non-glob part) and glob suffix
  const parts = pattern.split('/');
  let baseIdx = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].includes('*') || parts[i].includes('?')) break;
    baseIdx = i + 1;
  }

  const baseParts = parts.slice(0, baseIdx);
  const globParts = parts.slice(baseIdx);

  let baseDir = baseParts.length > 0 ? baseParts.join('/') : '.';
  // Handle Windows drive letters
  if (baseDir.match(/^[a-zA-Z]:$/)) baseDir += '/';

  baseDir = path.resolve(baseDir);

  if (globParts.length === 0) {
    // No glob - just check if path exists
    if (fs.existsSync(pattern)) return [path.resolve(pattern)];
    return [];
  }

  // Convert glob pattern to a regex-like matcher
  const results = [];
  _matchGlob(baseDir, globParts, 0, results);
  return results.sort();
}


function _matchGlob(currentDir, globParts, partIdx, results) {
  if (partIdx >= globParts.length) return;

  const part = globParts[partIdx];
  const isLast = partIdx === globParts.length - 1;

  if (part === '**') {
    // ** matches zero or more directory levels
    // Try matching remaining parts at current level
    if (partIdx + 1 < globParts.length) {
      _matchGlob(currentDir, globParts, partIdx + 1, results);
    }

    // Recurse into subdirectories
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(currentDir, entry.name);
        _matchGlob(subDir, globParts, partIdx, results); // ** can match more levels
      }
    }
  } else {
    // Normal glob part (may contain * or ?)
    const regex = _globPartToRegex(part);
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (!regex.test(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);
      if (isLast) {
        if (entry.isFile()) {
          results.push(fullPath);
        }
      } else {
        if (entry.isDirectory()) {
          _matchGlob(fullPath, globParts, partIdx + 1, results);
        }
      }
    }
  }
}


function _globPartToRegex(part) {
  let regexStr = '^';
  for (const ch of part) {
    switch (ch) {
      case '*': regexStr += '.*'; break;
      case '?': regexStr += '.'; break;
      // #252: escape ALL regex metacharacters, not just '.'. Unescaped '+'
      // made the default '.c++'/'.h++' extension patterns throw ("Nothing to
      // repeat") and crash the build.
      default:  regexStr += ch.replace(/[.+^${}()|[\]\\]/, '\\$&'); break;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr, 'i'); // case-insensitive for Windows
}
