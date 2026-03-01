/**
 * graph.js - Call graph visualization: call-tree, file-map, file-tree.
 * Includes Mermaid diagram output.
 * Port of ce_graph.py
 */

import path from 'path';
import crypto from 'crypto';
import { displayName, eprint } from '../utils.js';


// ========================================================================
// Call Tree
// ========================================================================

export function doCallTree(index, args) {
  const callTreeArg = args.call_tree;
  const depth = args.depth != null ? args.depth : 3;
  const mermaid = args.mermaid || false;
  const verbose = args.verbose || false;

  let pathHint = null, functionName;
  if (callTreeArg.includes('@')) {
    const atPos = callTreeArg.indexOf('@');
    pathHint = callTreeArg.slice(0, atPos);
    functionName = callTreeArg.slice(atPos + 1);
  } else {
    functionName = callTreeArg;
  }

  const matches = index.findFunctionMatches(functionName, pathHint);
  if (matches.length === 0) {
    console.log(`Function '${functionName}' not found in index.`);
    if (pathHint) console.log(`  (searched paths matching '${pathHint}')`);
    console.log(`  Tip: use --list-functions "${functionName}" to check`);
    return;
  }

  const root = matches[0];
  const rootDn = displayName(root.name, root.filepath);
  const rootLines = root.end - root.start + 1;
  let rootBare = functionName.includes('::') ? functionName.split('::').pop() : functionName;
  rootBare = rootBare.includes('.') ? rootBare.split('.').pop() : rootBare;

  eprint('  Loading call counts for sorting...');
  const callCounts = index.getCallCounts(false);

  function hotspotScore(name, lines) {
    let bare = name.includes('::') ? name.split('::').pop() : name;
    bare = bare.includes('.') ? bare.split('.').pop() : bare;
    if (bare.includes('@')) bare = bare.split('@')[0];
    const calls = callCounts[bare] || 0;
    return calls * Math.log2(Math.max(lines, 2));
  }

  function getFuncInfo(fname) {
    const fm = index.findFunctionMatches(fname);
    if (fm.length > 0) {
      const fl = fm[0].end - fm[0].start + 1;
      return [fl, hotspotScore(fname, fl), fm[0]];
    }
    return [0, 0, null];
  }

  // --- Build caller chains (walk UP) ---
  const upDepth = 2;
  eprint('  Finding callers (context)...');

  function buildCallerChains(targetName, maxUp) {
    if (maxUp <= 0) return [];
    const callers = index.findCallers(targetName, 200);
    if (callers.length === 0) return [];

    const callerFuncs = {};
    for (const c of callers) {
      const cf = c.caller_function || '(unknown)';
      if (cf === '(unknown)') continue;
      callerFuncs[cf] = (callerFuncs[cf] || 0) + 1;
    }

    const scored = [];
    for (const [cf, callSites] of Object.entries(callerFuncs)) {
      const [cfLines, cfScore] = getFuncInfo(cf);
      scored.push([cfScore, cf, cfLines, callSites]);
    }
    scored.sort((a, b) => b[0] - a[0]);

    const chains = [];
    for (const [, cf, cfLines, callSites] of scored) {
      const thisLink = [cf, cfLines, hotspotScore(cf, cfLines), callSites];
      if (maxUp > 1) {
        const parentChains = buildCallerChains(cf, maxUp - 1);
        if (parentChains.length > 0) {
          for (const pc of parentChains) chains.push([...pc, thisLink]);
        } else {
          chains.push([thisLink]);
        }
      } else {
        chains.push([thisLink]);
      }
    }
    return chains;
  }

  const callerChains = buildCallerChains(rootBare, upDepth);

  // --- Textual output ---
  if (!mermaid) {
    const rootCalls = callCounts[rootBare] || 0;
    const rootScore = rootCalls * Math.log2(Math.max(rootLines, 2));
    console.log(`\nCall tree for ${rootDn}  (${rootLines} lines, ${rootCalls} calls, score ${rootScore.toFixed(0)})`);
    console.log(`  Depth: ${depth} down, ${upDepth} up   Sorted by: hotspot score (calls x log2(lines))`);

    if (callerChains.length > 0) {
      const shownImmediate = new Set();
      const chainsToShow = [];
      for (const chain of callerChains) {
        const immediate = chain[chain.length - 1][0];
        if (!shownImmediate.has(immediate)) {
          shownImmediate.add(immediate);
          chainsToShow.push(chain);
        }
        if (chainsToShow.length >= 5) break;
      }

      const allImmediate = new Set(callerChains.map(c => c[c.length - 1][0]));
      console.log(`\n  Callers (${allImmediate.size} direct):`);

      for (const chain of chainsToShow) {
        for (let i = 0; i < chain.length; i++) {
          const [name, flines, fscore, callSites] = chain[i];
          const indent = '    ' + '  '.repeat(chain.length - 1 - i);
          const scoreStr = (verbose || fscore > 0) ? `  (${flines}L, score ${fscore.toFixed(0)})` : (flines > 0 ? `  (${flines}L)` : '');
          const callsStr = callSites > 1 ? ` (${callSites}x)` : '';
          console.log(`${indent}${name}${callsStr}${scoreStr}`);
        }
      }
      if (allImmediate.size > 5) console.log(`    ... and ${allImmediate.size - 5} more callers`);
    } else {
      console.log('\n  (no callers found - may be an entry point)');
    }

    // Target
    const rootScoreVal = (callCounts[rootBare] || 0) * Math.log2(Math.max(rootLines, 2));
    console.log(`\n  >>> ${rootDn} <<<  (${rootLines}L, score ${rootScoreVal.toFixed(0)})`);

    // Callees (downward)
    const visitedStack = new Set();
    const expanded = new Set();
    let totalNodes = 0;

    function expandedKey(ce) {
      const d = ce.resolved_def || (ce.definitions && ce.definitions[0]);
      if (d) {
        return `${d.filepath}|${d.full_name || ce.name}`;
      }
      return `|${ce.name}`;
    }

    function printTree(funcName, fileHint, indent, rem) {
      if (rem <= 0) return;
      const callees = index.findCallees(funcName, fileHint);
      if (callees.length === 0) return;

      const scored = [];
      for (const ce of callees) {
        if (ce.call_type === 'recursive') continue;
        if (ce.ambiguous && !ce.resolved_def) continue;  // skip unresolved dot-calls
        const fd = ce.resolved_def || (ce.definitions && ce.definitions[0]);
        const cl = fd ? (fd.end - fd.start + 1) : 0;
        scored.push([hotspotScore(ce.name, cl), cl, ce]);
      }
      scored.sort((a, b) => b[0] - a[0]);

      for (const [score, ceLines, ce] of scored) {
        totalNodes++;
        const name = ce.display_name;
        const ct = ce.call_type || 'direct';
        const tag = ['indirect', 'reference', 'recursive'].includes(ct) ? ` [${ct}]` : '';

        const ekey = expandedKey(ce);
        if (visitedStack.has(ekey)) { console.log(`${indent}${name}${tag}  [cycle]`); continue; }

        const ss = (verbose || score > 0) ? `  (${ceLines}L, score ${score.toFixed(0)})` : (ceLines > 0 ? `  (${ceLines}L)` : '');
        if (expanded.has(ekey)) { console.log(`${indent}${name}${tag}${ss}  [see above]`); continue; }

        console.log(`${indent}${name}${tag}${ss}`);
        expanded.add(ekey);

        if (rem > 1) {
          const fd = ce.resolved_def || (ce.definitions && ce.definitions[0]);
          if (fd) {
            visitedStack.add(ekey);
            printTree(fd.full_name || ce.name, fd.filepath, indent + '  ', rem - 1);
            visitedStack.delete(ekey);
          }
        }
      }
    }

    const rootEkey = `${root.filepath}|${root.name}`;
    visitedStack.add(rootEkey);
    expanded.add(rootEkey);
    printTree(functionName, pathHint || root.filepath, '    ', depth);

    if (totalNodes === 0) console.log('    (no callees - leaf function)');
    console.log(`\n  ${totalNodes} callees shown across ${depth} level(s)`);
    return;
  }

  // --- Mermaid output ---
  console.log('```mermaid');
  console.log('flowchart TD');
  const mid = (n) => n.replace(/[^a-zA-Z0-9_]/g, '_');
  const edges = [], nodesSeen = new Set(), mVis = new Set();

  const rootId = mid(rootBare);
  console.log(`    ${rootId}[["${rootDn} (${rootLines}L)"]]`);
  nodesSeen.add(rootId);

  if (callerChains.length > 0) {
    for (const chain of callerChains.slice(0, 5)) {
      let prev = null;
      for (const [name, flines] of chain) {
        const nid = mid(name);
        if (!nodesSeen.has(nid)) { nodesSeen.add(nid); console.log(`    ${nid}["${name} (${flines}L)"]`); }
        if (prev) { const e = `    ${prev} --> ${nid}`; if (!edges.includes(e)) edges.push(e); }
        prev = nid;
      }
      if (prev) { const e = `    ${prev} --> ${rootId}`; if (!edges.includes(e)) edges.push(e); }
    }
  }

  function collectMermaid(fn, fh, rem) {
    if (rem <= 0) return;
    const callees = index.findCallees(fn, fh);
    if (!callees.length) return;
    let bareSrc = fn.includes('::') ? fn.split('::').pop() : fn;
    const srcId = mid(bareSrc);
    for (const ce of callees) {
      if (ce.call_type === 'recursive') continue;
      if (ce.ambiguous && !ce.resolved_def) continue;  // skip unresolved dot-calls
      const fd = ce.resolved_def || (ce.definitions && ce.definitions[0]);
      const tgtId = mid(ce.name);
      const e = `    ${srcId} --> ${tgtId}`;
      if (!edges.includes(e)) edges.push(e);
      if (!nodesSeen.has(tgtId)) {
        nodesSeen.add(tgtId);
        if (fd) { const cl = fd.end - fd.start + 1; console.log(`    ${tgtId}["${ce.display_name} (${cl}L)"]`); }
      }
      if (!mVis.has(ce.name) && rem > 1 && fd) {
        mVis.add(ce.name);
        collectMermaid(fd.full_name || ce.name, fd.filepath, rem - 1);
        mVis.delete(ce.name);
      }
    }
  }
  mVis.add(rootBare);
  collectMermaid(functionName, pathHint || root.filepath, depth);
  for (const e of edges) console.log(e);
  console.log(`    style ${rootId} fill:#ff9,stroke:#333,stroke-width:3px`);
  console.log('```');
}


// ========================================================================
// File Map
// ========================================================================

export function doFileMap(index, args) {
  let pathFilter = args.file_map;
  if (pathFilter === true || pathFilter === '') pathFilter = null;
  const mermaid = args.mermaid || false;
  const verbose = args.verbose || false;
  const n = args.max_results || 30;

  eprint('  Scanning cross-file function calls...');
  let fileDeps = index.getAllFileDeps(pathFilter, true);

  if (!fileDeps || Object.keys(fileDeps).length === 0) {
    console.log('No cross-file dependencies found.');
    if (pathFilter) console.log(`  (filtered to paths matching '${pathFilter}')`);
    return;
  }

  if (args.include_path) {
    const f = {};
    for (const [fp, d] of Object.entries(fileDeps))
      if (args.include_path.some(p => fp.toLowerCase().includes(p.toLowerCase()))) f[fp] = d;
    fileDeps = f;
  }
  if (args.exclude_path) {
    const f = {};
    for (const [fp, d] of Object.entries(fileDeps))
      if (!args.exclude_path.some(p => fp.toLowerCase().includes(p.toLowerCase()))) f[fp] = d;
    fileDeps = f;
  }

  if (!mermaid) {
    const pairs = [];
    for (const [src, deps] of Object.entries(fileDeps))
      for (const [tgt, count] of Object.entries(deps))
        pairs.push([count, src, tgt]);
    pairs.sort((a, b) => b[0] - a[0]);

    const fileOut = {}, fileOutTargets = {};
    for (const [src, deps] of Object.entries(fileDeps)) {
      fileOut[src] = Object.values(deps).reduce((a, b) => a + b, 0);
      fileOutTargets[src] = Object.keys(deps).length;
    }
    const fileSummary = Object.entries(fileOut).sort((a, b) => b[1] - a[1]);

    const sp = (fp, ml = 60) => fp.length <= ml ? fp : '...' + fp.slice(-(ml - 3));

    console.log(`\nFile dependency map (${Object.keys(fileDeps).length} files with cross-file calls, ${pairs.length} edges)`);
    if (pathFilter) console.log(`  Filtered to: ${pathFilter}`);
    console.log('\n  --- Files by outgoing coupling (calls to other files) ---\n');

    let shown = 0;
    for (const [src, totalCalls] of fileSummary.slice(0, n)) {
      const nTargets = fileOutTargets[src];
      const nFns = Object.keys(index.functionIndex[src] || {}).length;
      console.log(`  ${sp(src)}`);
      console.log(`    ${totalCalls} calls to ${nTargets} other file(s)  (${nFns} functions defined)`);
      const targets = Object.entries(fileDeps[src]).sort((a, b) => b[1] - a[1]);
      for (const [tgt, cnt] of targets.slice(0, 5))
        console.log(`      -> ${sp(tgt, 55)}  (${cnt} calls)`);
      if (targets.length > 5) console.log(`      ... and ${targets.length - 5} more targets`);
      console.log();
      shown++;
    }
    if (shown < fileSummary.length)
      console.log(`  ... ${fileSummary.length - shown} more files (use --max-results to see more)`);

    console.log('\n  --- Strongest file-to-file couplings ---\n');
    console.log(`  ${'Calls'.padStart(6)}  ${'Source'.padStart(40)}  ->  Target`);
    for (const [count, src, tgt] of pairs.slice(0, 20))
      console.log(`  ${String(count).padStart(6)}  ${sp(src, 40).padStart(40)}  ->  ${sp(tgt, 40)}`);
    if (pairs.length > 20) console.log(`\n  ... ${pairs.length - 20} more pairs`);
    console.log('\n  Note: Dependencies inferred from bare function-name matching.');
    console.log('  Use --call-tree FUNC for verified per-function call chains.');
    return;
  }

  // --- Mermaid ---
  console.log('```mermaid');
  console.log('flowchart LR');
  const mfid = (fp) => {
    const b = path.basename(fp).replace(/\./g, '_').replace(/-/g, '_');
    const h = crypto.createHash('md5').update(fp).digest('hex').slice(0, 4);
    return `f_${b}_${h}`;
  };
  const nids = {};
  for (const [src, deps] of Object.entries(fileDeps)) {
    const sid = mfid(src);
    if (!(sid in nids)) { nids[sid] = src; console.log(`    ${sid}["${path.basename(src)}"]`); }
    for (const [tgt, count] of Object.entries(deps)) {
      const tid = mfid(tgt);
      if (!(tid in nids)) { nids[tid] = tgt; console.log(`    ${tid}["${path.basename(tgt)}"]`); }
      const label = count > 1 ? `|${count}|` : '';
      console.log(`    ${sid} -->${label} ${tid}`);
    }
  }
  console.log('```');
}


// ========================================================================
// File Tree
// ========================================================================

function _getFileOutgoingDeps(index, filepath) {
  const deps = {};
  index._ensureFunctionIndex();
  if (!index.functionIndex[filepath]) return deps;
  for (const [fname] of Object.entries(index.functionIndex[filepath])) {
    const callees = index.findCallees(fname, filepath);
    for (const ce of callees) {
      if (ce.ambiguous && !ce.resolved_def) continue;  // skip unresolved
      // Use resolved definition for accuracy
      const bestDef = ce.resolved_def || (ce.definitions && ce.definitions[0]);
      if (bestDef && bestDef.filepath !== filepath) {
        deps[bestDef.filepath] = (deps[bestDef.filepath] || 0) + 1;
      }
    }
  }
  return deps;
}

function _getFileIncomingDeps(index, filepath) {
  const incoming = {};
  index._ensureFunctionIndex();
  if (!index.functionIndex[filepath]) return incoming;
  for (const fname of Object.keys(index.functionIndex[filepath])) {
    let bare = fname.includes('::') ? fname.split('::').pop() : fname;
    bare = bare.includes('.') ? bare.split('.').pop() : bare;
    const callers = index.findCallers(bare, 200);
    for (const c of callers) {
      if (c.filepath !== filepath) incoming[c.filepath] = (incoming[c.filepath] || 0) + 1;
    }
  }
  return incoming;
}

export function doFileTree(index, args) {
  const fileTreeArg = args.file_tree;
  const depth = args.depth || 2;
  const mermaid = args.mermaid || false;
  const verbose = args.verbose || false;

  const filePattern = fileTreeArg.replace(/\\/g, '/').toLowerCase();
  let fmatches = [...index.files.keys()].filter(fp => fp.replace(/\\/g, '/').toLowerCase().includes(filePattern));

  if (fmatches.length === 0) {
    console.log(`No files matching '${fileTreeArg}' in index.`);
    return;
  }
  if (fmatches.length > 1) {
    const bm = fmatches.filter(fp => path.basename(fp).toLowerCase() === path.basename(fileTreeArg).toLowerCase());
    if (bm.length === 1) { fmatches = bm; }
    else if (fmatches.length <= 10) {
      console.log(`Multiple files match '${fileTreeArg}':`);
      for (const [i, m] of fmatches.sort().entries()) console.log(`  [${i + 1}] ${m}`);
      console.log('\nNarrow your search.');
      return;
    } else {
      console.log(`${fmatches.length} files match '${fileTreeArg}'. Narrow your search.`);
      for (const m of fmatches.sort().slice(0, 10)) console.log(`  ${m}`);
      if (fmatches.length > 10) console.log(`  ... and ${fmatches.length - 10} more`);
      return;
    }
  }

  const targetFile = fmatches[0];
  const targetBase = path.basename(targetFile);
  index._ensureFunctionIndex();
  const nFuncs = Object.keys(index.functionIndex[targetFile] || {}).length;
  const nLines = (index.fileLines.get(targetFile) || []).length;
  const sp = (fp, ml = 55) => fp.length <= ml ? fp : '...' + fp.slice(-(ml - 3));

  eprint('  Finding incoming dependencies (callers)...');
  const incoming = _getFileIncomingDeps(index, targetFile);

  if (!mermaid) {
    console.log(`\nFile tree for ${targetBase}  (${nLines} lines, ${nFuncs} functions)`);
    console.log(`  Full path: ${targetFile}`);
    console.log(`  Depth: ${depth}   Sorted by: coupling strength (cross-file call count)`);

    if (Object.keys(incoming).length > 0) {
      const si = Object.entries(incoming).sort((a, b) => b[1] - a[1]);
      const ti = Object.values(incoming).reduce((a, b) => a + b, 0);
      console.log(`\n  Incoming (${ti} calls from ${Object.keys(incoming).length} files):`);
      for (const [src, count] of si.slice(0, 8)) console.log(`      ${sp(src)}  (${count} calls)`);
      if (si.length > 8) console.log(`      ... and ${si.length - 8} more`);
    } else {
      console.log('\n  (no incoming calls found)');
    }

    console.log(`\n  >>> ${targetBase} <<<  (${nLines} lines, ${nFuncs} functions)`);

    const visited = new Set([targetFile]);
    let totalFiles = 0;

    function printFileTree(fp, indent, rem) {
      if (rem <= 0) return;
      const deps = _getFileOutgoingDeps(index, fp);
      if (!Object.keys(deps).length) return;
      for (const [tgt, count] of Object.entries(deps).sort((a, b) => b[1] - a[1])) {
        totalFiles++;
        const tb = path.basename(tgt);
        const tl = (index.fileLines.get(tgt) || []).length;
        const tf = Object.keys(index.functionIndex[tgt] || {}).length;
        if (visited.has(tgt)) { console.log(`${indent}${tb}  (${count} calls, ${tl}L)  [see above]`); continue; }
        const info = verbose ? `  (${count} calls, ${tl}L, ${tf} fns)` : `  (${count} calls, ${tl}L)`;
        console.log(`${indent}${sp(tgt)}${info}`);
        visited.add(tgt);
        if (rem > 1) printFileTree(tgt, indent + '  ', rem - 1);
      }
    }

    printFileTree(targetFile, '    ', depth);
    if (totalFiles === 0) console.log('    (no outgoing file dependencies)');
    console.log(`\n  ${totalFiles} file dependencies shown across ${depth} level(s)`);
    return;
  }

  // --- Mermaid ---
  console.log('```mermaid');
  console.log('flowchart LR');
  const mfid = (fp) => {
    const b = path.basename(fp).replace(/\./g, '_').replace(/-/g, '_');
    const h = crypto.createHash('md5').update(fp).digest('hex').slice(0, 4);
    return `f_${b}_${h}`;
  };
  const tid = mfid(targetFile);
  console.log(`    ${tid}[["${targetBase} (${nLines}L)"]]`);
  const ns = new Set([tid]), me = [];

  for (const [src, count] of Object.entries(incoming).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    const sid = mfid(src);
    if (!ns.has(sid)) { ns.add(sid); console.log(`    ${sid}["${path.basename(src)}"]`); }
    me.push(`    ${sid} -->${count > 1 ? `|${count}|` : ''} ${tid}`);
  }

  const mv = new Set([targetFile]);
  function collectMF(fp, rem) {
    if (rem <= 0) return;
    const deps = _getFileOutgoingDeps(index, fp);
    const sid = mfid(fp);
    for (const [tgt, count] of Object.entries(deps).sort((a, b) => b[1] - a[1])) {
      const tgid = mfid(tgt);
      if (!ns.has(tgid)) { ns.add(tgid); const tl = (index.fileLines.get(tgt) || []).length; console.log(`    ${tgid}["${path.basename(tgt)} (${tl}L)"]`); }
      me.push(`    ${sid} -->${count > 1 ? `|${count}|` : ''} ${tgid}`);
      if (!mv.has(tgt) && rem > 1) { mv.add(tgt); collectMF(tgt, rem - 1); }
    }
  }
  collectMF(targetFile, depth);
  for (const e of me) console.log(e);
  console.log(`    style ${tid} fill:#ff9,stroke:#333,stroke-width:3px`);
  console.log('```');
}
