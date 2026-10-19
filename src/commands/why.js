// why.js — --why-depends <package>: from a package in a lockfile back to the code and the operation that needs it
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// The printer for whyPackage() (src/core/imports.js). A summary first, then
// three sections, then the caveat, every run:
//   Summary — the package's standing in the lockfile and the heads it comes
//     through; where it reaches the code; the operations above that; the
//     caveat in one line. No paths, so it reads at a glance even when the
//     index names files through a zip.
//   Package to package — every chain from each indexed lockfile's root to the
//     package, from the lockfile's own edges; the direct dependency at the
//     head of each chain; lockfile kinds without edges say so.
//   Package to code — each head's import sites, with the functions that use
//     the imported binding; a head no file imports falls back to the places
//     that NAME it (a grammar table, a build script, a notices file).
//   Code to operation — the callers above each using function to --depth,
//     and the catalogued operations whose handler lies on that path: CLI
//     commands (dispatched at file scope) apart from flags read inside a
//     handler, then routes, GUI actions and commands; or the statement that
//     none is.
// Separate from imports.js (doBom) on purpose: that file carries literal NUL
// bytes inside two template strings and the editing tools refuse it.

import { quotePathIfNeeded } from '../utils.js';
import { whyPackage } from '../core/imports.js';

const SITES_CAP = 20;   // per head, lifted by -v

const hop = (h) => `${h.name}${h.version ? ' ' + h.version : ''}${h.kind ? ' (' + h.kind + ')' : ''}`;
const at = (file, line) => `${quotePathIfNeeded(file)}:${line}`;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const kindWord = (k) => (k === 'runtime' ? 'runtime' : k === 'dev' ? 'dev' : k === 'peer' ? 'peer' : k === 'optional' ? 'optional' : k || 'unknown-kind');

// Operations across every using function of every head, grouped for the
// summary: CLI commands (file-scope dispatch), CLI flags read inside a
// handler, and the other kinds by name.
function gatherOperations(w) {
  const commands = new Set(), flags = new Set(), others = new Map();
  for (const h of w.heads) {
    for (const u of h.users) {
      for (const o of u.operations || []) {
        if (o.kind === 'CLI option') {
          for (const f of String(o.label).split(', ')) (o.dispatch === 'top' ? commands : flags).add(f);
        } else {
          const g = others.get(o.kind) || new Set();
          g.add(o.label);
          others.set(o.kind, g);
        }
      }
    }
  }
  for (const f of commands) flags.delete(f);
  return { commands: [...commands], flags: [...flags], others };
}

function printSummary(w, target) {
  console.log('\nSummary');
  const installedIn = w.lockfiles.filter((l) => l.installed);
  const declaredText = w.declared.map((d) => `${quotePathIfNeeded(d.file)} (${kindWord(d.kind)} dependency)`).join(', ');
  if (!installedIn.length) {
    console.log(`  ${target}: not installed by any indexed lockfile${w.lockfiles.length ? '' : ' (none is indexed)'}${w.declared.length ? `; declared in ${declaredText}` : ''}.`);
  } else {
    for (const l of installedIn) {
      let how;
      if (l.direct) how = `a direct dependency${w.declared.length ? ` (${w.declared.map((d) => kindWord(d.kind)).join('/')})` : ''}`;
      else if (!l.edges) how = 'listed, standing unknown (this lockfile kind carries no edges)';
      else if (!l.chains.length) how = 'a transitive dependency no chain from the root reaches';
      else how = `a transitive dependency reached through ${l.heads.join(', ')} (${plural(l.chains.length, 'chain')}${l.truncated ? '+' : ''})`;
      console.log(`  ${target}${l.version ? ' ' + l.version : ''}: ${how}, per ${quotePathIfNeeded(l.file)}.`);
    }
  }
  for (const h of w.heads) {
    const files = new Set(h.sites.map((s) => s.file)).size;
    const used = !w.callGraph ? ''
      : h.users.length ? `; used by ${plural(h.users.length, 'function')}`
        : h.sites.length ? '; used inside no function' : '; all at file scope';
    if (h.sites.length) console.log(`  ${h.name}: imported in ${plural(files, 'file')} (${plural(h.sites.length, 'site')})${used}.`);
    else if (h.mentionsTotal) console.log(`  ${h.name}: imported by no indexed file; named in ${plural(h.mentionsTotal, 'place')} (a path, a table, a notice)${used}.`);
    else console.log(`  ${h.name}: imported by no indexed file and named nowhere in the index.`);
  }
  if (w.callGraph && w.catalog) {
    const ops = gatherOperations(w);
    const parts = [];
    if (ops.commands.length) parts.push(`CLI commands ${ops.commands.join(', ')}`);
    if (ops.flags.length) parts.push(`flags read on the way ${ops.flags.slice(0, 8).join(', ')}${ops.flags.length > 8 ? ` (+${ops.flags.length - 8})` : ''}`);
    for (const [kind, set] of ops.others) parts.push(`${kind}s ${[...set].slice(0, 6).join(', ')}${set.size > 6 ? ` (+${set.size - 6})` : ''}`);
    console.log(parts.length ? `  Operations above it: ${parts.join('; ')}.` : '  Operations above it: none catalogued with a handler on the chain.');
  } else if (!w.callGraph) {
    console.log('  Operations above it: not walked (no function index on this index).');
  }
  console.log('  Not shown to execute: installed and importable is what the chain proves. Details below.');
}

export function doWhy(index, args) {
  const target = String(args.why_depends || '').trim();
  if (!target) { console.log('--why-depends needs a package name (as the lockfile spells it, e.g. --why-depends y18n or --why-depends @scope/name).'); return; }
  const depth = Number.isInteger(args.depth) && args.depth > 0 ? args.depth : 3;
  const w = whyPackage(index, target, { depth });

  console.log(`\nWhy ${target}: from the lockfile to the code to the operation   [experimental]`);
  printSummary(w, target);

  // ---- Package to package ----------------------------------------------
  console.log('\nPackage to package');
  if (!w.lockfiles.length && !w.manifests) {
    console.log('  No manifest or lockfile is indexed: either the tree has none, or the index was built before manifests were indexed by name (53e12ae, 2026-10-18) and needs a rebuild. Without them this report has import sites and name mentions only.');
  } else if (!w.lockfiles.length) {
    console.log('  No lockfile is indexed, so no resolved tree: --bom lists the manifests and their declared sets.');
  }
  for (const lf of w.lockfiles) {
    const where = `${quotePathIfNeeded(lf.file)} (${lf.kind}${lf.read ? `, ${lf.total} installed` : ', not read'})`;
    if (!lf.read) { console.log(`  ${where}: this lockfile kind is listed but not read yet; nothing to walk.`); continue; }
    if (!lf.edges) {
      const listed = lf.installed ? `${target}${lf.version ? ' ' + lf.version : ''} is listed` : `${target} is not listed`;
      console.log(`  ${where}: ${listed}; this lockfile kind carries no dependency edges, so no chain can be walked from it (the manifest beside it names the direct set only).`);
      continue;
    }
    if (!lf.installed) { console.log(`  ${where}: ${target} is not installed by this lockfile.`); continue; }
    const standing = lf.direct ? 'a direct dependency' : 'a transitive dependency (declared by no manifest at the root)';
    console.log(`  ${where}: ${target}${lf.version ? ' ' + lf.version : ''} is installed as ${standing}.`);
    if (!lf.chains.length) { console.log('    No chain from the root reaches it (an orphan entry, or a kind whose root set is unknown).'); continue; }
    console.log(`    ${lf.chains.length}${lf.truncated ? '+' : ''} chain(s) from the root (edge kinds: prod / dev / optional / peer):`);
    for (const c of lf.chains) console.log(`      ${c.map(hop).join(' -> ')}`);
    if (lf.truncated) console.log('      ... more chains not shown');
    console.log(`    head${lf.heads.length === 1 ? '' : 's'}: ${lf.heads.join(', ')}`);
  }
  if (w.lockfiles.length && w.lockfiles.every((lf) => !lf.installed)) {
    console.log(`  ${target} is not installed by any indexed lockfile; --bom lists what is.`);
  }
  if (w.declared.length) console.log(`  Declared directly by: ${w.declared.map((d) => `${quotePathIfNeeded(d.file)} (${kindWord(d.kind)})`).join(', ')}`);
  else if (!w.lockfiles.some((lf) => lf.installed)) {
    console.log(`  ${target} is not a package this index declares. If it is a program, service or file the code talks to, --referenced-resources (external commands, hosts, paths) and --search ${target} are the surfaces for it; this report shows where the name appears.`);
  }

  // ---- Package to code --------------------------------------------------
  console.log('\nPackage to code');
  if (!w.heads.length) {
    console.log(`  No import site names ${target}, and no chain leads to a direct dependency that the code imports.`);
  }
  for (const h of w.heads) {
    const n = h.sites.length;
    if (n) {
      console.log(`  ${h.name}: ${plural(n, 'import site')}`);
      const shown = args.verbose ? h.sites : h.sites.slice(0, SITES_CAP);
      for (const s of shown) {
        const using = !w.callGraph ? ''
          : s.usersTotal === 0 ? '   (no function uses the binding: top-level use, or a binding this reading cannot follow)'
            : `   used in ${plural(s.usersTotal, 'function')}: ${s.users.map((u) => u.func).join(', ')}${s.usersTotal > s.users.length ? ', ...' : ''}`;
        console.log(`    ${at(s.file, s.line)}  ${s.text}${using}`);
      }
      if (shown.length < n) console.log(`    ... +${n - shown.length} more site(s) (use -v to see all)`);
    } else if (h.mentionsTotal) {
      console.log(`  ${h.name}: 0 import sites; named in ${plural(h.mentionsTotal, 'place')} (the package name in code or text, not an import):`);
      for (const m of h.mentions) {
        const using = !w.callGraph ? '' : m.usersTotal ? `   inside ${m.users.map((u) => u.func).join(', ')}` : '   (file scope)';
        console.log(`    ${at(m.file, m.line)}  ${m.text}${using}`);
      }
      if (h.mentions.length < h.mentionsTotal) console.log(`    ... +${h.mentionsTotal - h.mentions.length} more place(s)`);
    } else {
      console.log(`  ${h.name}: 0 import sites, and the name appears nowhere in the index outside manifests and lockfiles (installed, used by nothing this reading can see; --bom lists the declared-but-unimported set).`);
    }
  }

  // ---- Code to operation ------------------------------------------------
  console.log(`\nCode to operation (callers to --depth ${depth}, then the command catalog)`);
  if (!w.callGraph) {
    console.log('  The call graph is unavailable on this index (no function index); build the index with --build-index to walk callers and the catalog.');
  } else {
    let any = false;
    for (const h of w.heads) {
      for (const u of h.users) {
        any = true;
        const sites = u.sites.map((l) => `${l}`).join(', ');
        const attrs = (a) => (a && a.length ? ' ' + a.join(' ') : '');
        console.log(`  ${u.func}${attrs(u.attrs)}  (${at(u.file, u.line)}; ${h.name} at line${u.sites.length === 1 ? '' : 's'} ${sites}${u.encloses ? ', inside the function' : ''})`);
        for (const p of u.paths) {
          const chain = p.hops.map((x) => `${x.func}${attrs(x.attrs)} (${at(x.file, x.line)})`).join(' <- ');
          const last = p.hops[p.hops.length - 1];
          const lastAttrs = last ? last.attrs : u.attrs;
          const topNote = lastAttrs && lastAttrs.length ? 'no in-tree callers: an entry point by attribute, reached by name' : 'no callers found: top of the chain';
          if (!chain) { console.log(`    <- ${topNote}`); continue; }
          console.log(`    <- ${chain}${p.top ? (last.func === '(top level)' ? '' : ` <- ${topNote}`) : ' ... (depth reached)'}`);
        }
        if (!w.catalog) console.log('    operations: the command catalog is unavailable on this index');
        else if (!u.operations.length) console.log('    operations: no catalogued operation has a handler on this chain');
        else {
          const cmds = [], flags = [], others = new Map();
          for (const o of u.operations) {
            if (o.kind === 'CLI option') for (const f of String(o.label).split(', ')) (o.dispatch === 'top' ? cmds : flags).push(f);
            else { const g = others.get(o.kind) || []; g.push(o.label); others.set(o.kind, g); }
          }
          const uniq = (a) => [...new Set(a)];
          const cap = (a, n = 12) => `${a.slice(0, n).join(', ')}${a.length > n ? `, +${a.length - n} more` : ''}`;
          const cmdSet = uniq(cmds);
          const flagSet = uniq(flags).filter((f) => !cmdSet.includes(f));
          if (cmdSet.length) console.log(`    CLI commands on this chain (dispatched at file scope): ${cap(cmdSet)}`);
          if (flagSet.length) console.log(`    CLI flags read inside a handler on this chain: ${cap(flagSet)}`);
          for (const [kind, labels] of others) console.log(`    ${kind}s handled on this chain: ${cap(uniq(labels))}`);
        }
      }
    }
    if (!any) console.log('  No function uses an imported binding of a head, or encloses a place that names it, so there is no chain to walk.');
  }

  console.log(`\nCaveat: ${w.caveat}`);
}
