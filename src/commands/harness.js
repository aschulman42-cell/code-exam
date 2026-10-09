// harness.js — emits a runnable PyTorch forward-hook activation-capture script from static nn.Module analysis
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * harness.js — CE as static scaffolder, foothold lane (#95).
 *
 * `--emit-harness <Model>` emits a runnable PyTorch forward-hook
 * activation-capture script, pre-wired from static analysis of the model's
 * nn.Module tree. CE NEVER runs the harness — it is a static artifact the
 * user executes separately (the #95 Lane 3 / Lane 4 boundary).
 *
 * Terminology: a "[seam]" here is an INSTRUMENTATION POINT on a model
 * (forward/predict boundary, activation tap) per investigation-to-spec /
 * #95 — completely unrelated to `--bundle-seams` (module boundaries inside
 * a minified JS bundle).
 *
 * Mechanical parts (emitted deterministically, no LLM):
 *   - STATIC_NAMESPACE: the recursive hook-path namespace, read from each
 *     class's `self.x = SubModule(...)` assignments; `{i}` marks ModuleList
 *     repeats; nn.Sequential children become `.0 .1 .2`.
 *   - STATIC_ROLES: heuristic name-pattern labels (qkv/proj/act_fn/...).
 *   - hook registration + shape/dtype capture + static-vs-runtime cross-check.
 * The one non-mechanical step — a model instance + an apt input — is left as
 * an explicit `load_model()` stub for the user (with a pre-wired import hint).
 *
 * Template is a literal below (a src/harness-templates/ dir is premature for
 * one template). Generalizes resources/issue-84-prototype-*.py.
 */

import fs from 'fs';
import { effectiveMaxResults, capNotice } from '../argparse.js';
import path from 'path';
import { eprint } from '../utils.js';

// Harness templates available today. Foothold lane (#95) ships exactly one;
// SHAP / LIME / activation-PCA/UMAP/t-SNE are follow-ups (each needs its own
// investigation-to-spec pass). Adding a template = adding a key here + its
// renderer; the CLI/help/validation read from this set.
const KNOWN_TEMPLATES = new Set(['activation-hook']);

// ---------------------------------------------------------------------------
// Heuristic role labels for leaf submodule attribute names. Disclosed as
// heuristic in the emitted file; misses are blank, never guessed wildly.
// ---------------------------------------------------------------------------
// Labels are deliberately pure ASCII: they are printed by the emitted
// harness, and Windows `> file` redirection uses cp1252 — a u2192 arrow
// in a role label is a UnicodeEncodeError at the user's prompt.
const ROLE_TABLE = [
  [/^qkv$/i,                       'FUSED Q,K,V -- split functionally in forward()'],
  [/^(q_proj|query(_dense)?)$/i,   'attention Q (QK circuit)'],
  [/^(k_proj|key(_dense)?)$/i,     'attention K (QK circuit)'],
  [/^(v_proj|value(_dense)?)$/i,   'attention V (OV circuit: V)'],
  // bare `proj` is attention-output ONLY in an attention parent -- a Conv
  // patch projector is also called `proj` (gated on path in roleFor).
  [/^(o_proj|out_proj|output_dense)$/i, 'attention output (OV circuit: O)'],
  [/^(act|act_fn|activation)$/i,   'activation (SAE-candidate)'],
  [/^down_proj$/i,                 'MLP output -> residual add'],
  [/^(gate_proj|up_proj)$/i,       'MLP in-projection (gated/SwiGLU pair)'],
  [/^gate$/i,                      'router / gating'],
  [/norm|^ln_|_ln$|layernorm/i,    'normalization (pre/post-LN)'],
  [/embed/i,                       'embedding'],
];

function roleFor(attrName, fullPath = '') {
  if (/^proj$/i.test(attrName)) {
    return /attn|attention/i.test(fullPath) ? 'attention output (OV circuit: O)' : null;
  }
  for (const [re, label] of ROLE_TABLE) if (re.test(attrName)) return label;
  return null;
}

// Emitted .py must be pure ASCII end to end (header, comments, roles) so its
// own stdout survives `> file` under cp1252.
function toAscii(s) {
  return String(s).replace(/→/g, '->').replace(/[–—]/g, '--').replace(/[^\x00-\x7F]/g, '?');
}

// ---------------------------------------------------------------------------
// Namespace extraction.
// ---------------------------------------------------------------------------

// Global map: bare class name -> [{ filepath, start, end }] from the function
// index (type === 'class').
function buildClassMap(index) {
  index._ensureFunctionIndex();
  const map = new Map();
  for (const [fp, functions] of Object.entries(index.functionIndex)) {
    for (const [name, info] of Object.entries(functions)) {
      if (!info || info.type !== 'class') continue;
      const bare = name.includes('::') ? name.split('::').pop() : name;
      if (!map.has(bare)) map.set(bare, []);
      map.get(bare).push({ filepath: fp, start: info.start, end: info.end });
    }
  }
  return map;
}

// Parse one `self.attr = EXPR` head (EXPR may continue on later lines — the
// caller hands us a small joined window). Returns a descriptor or null.
function classifyAssignment(attr, expr) {
  // nn.Parameter / buffers are not modules — correctly absent from the
  // hookable namespace.
  if (/^nn\.Parameter\b|^torch\.nn\.Parameter\b/.test(expr)) return null;

  // nn.ModuleList(...) — repeated child when a comprehension is present.
  if (/^(?:torch\.)?nn\.ModuleList\s*\(/.test(expr)) {
    const inner = expr.replace(/^(?:torch\.)?nn\.ModuleList\s*\(/, '');
    const innerCls = /\b([A-Z]\w+)\s*\(/.exec(inner);
    const repeated = /\bfor\b/.test(inner);
    return { kind: repeated ? 'module-list' : 'container', attr, cls: innerCls ? innerCls[1] : null };
  }
  // nn.ModuleDict — container; children unpredictable statically.
  if (/^(?:torch\.)?nn\.ModuleDict\s*\(/.test(expr)) {
    return { kind: 'container', attr, cls: null };
  }
  // nn.Sequential(a, b, c) — positional children .0 .1 .2
  if (/^(?:torch\.)?nn\.Sequential\s*\(/.test(expr)) {
    const argsSrc = expr.replace(/^(?:torch\.)?nn\.Sequential\s*\(/, '');
    const children = [];
    let depth = 0, cur = '';
    for (const ch of argsSrc) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') { if (depth === 0) break; depth--; }
      if (ch === ',' && depth === 0) { children.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) children.push(cur.trim());
    const labels = children.map(c => (/^([\w.]+)\s*\(/.exec(c) || [, '?'])[1]);
    return { kind: 'sequential', attr, children: labels };
  }
  // ACT2FN[...] / getattr-style activation lookup — a leaf module.
  if (/^ACT2FN\b|^get_activation\b/.test(expr)) {
    return { kind: 'leaf', attr, cls: '(activation module)' };
  }
  // nn.X(...) builtin leaf.
  const nnLeaf = /^((?:torch\.)?nn\.\w+)\s*\(/.exec(expr);
  if (nnLeaf) return { kind: 'leaf', attr, cls: nnLeaf[1] };
  // SomeClass(...) — index-local class (recurse) or external leaf.
  const userCls = /^([A-Z]\w*)\s*\(/.exec(expr);
  if (userCls) return { kind: 'class', attr, cls: userCls[1] };
  return null;
}

// Gather the full assignment expression by balancing brackets from the head
// line — NOT a fixed line window (#158: a long `nn.ModuleList([... for i in
// range(...)])` put the `for`/child past the old 6-line window, so the list
// read as a non-repeated container and its `blocks.{i}` taps were dropped).
// Reads until ( [ { all close, bounded so a pathological literal can't run
// away. Strips line comments so inline `#` notes don't skew the balance.
// Returns { expr, endIdx } — endIdx lets the caller skip consumed lines.
function balancedExpr(lines, startIdx, tail, hardEnd) {
  const strip = (s) => (s || '').replace(/#.*$/, '');
  let depth = 0;
  const count = (s) => { for (const ch of s) { if (ch === '(' || ch === '[' || ch === '{') depth++; else if (ch === ')' || ch === ']' || ch === '}') depth--; } };
  let buf = strip(tail);
  count(buf);
  let j = startIdx;
  const limit = Math.min(hardEnd, startIdx + 200);
  while (depth > 0 && j + 1 < limit) {
    j++;
    const s = strip(lines[j]);
    buf += ' ' + s.trim();
    count(s);
  }
  return { expr: buf.trim(), endIdx: j };
}

// Extract `self.x = ...` module assignments from a class body, in source
// order, deduped by attribute (first assignment wins).
function extractAssignments(lines, start, end) {
  const out = [];
  const seen = new Set();
  const reAssign = /^\s*self\.(\w+)\s*=\s*(.+)$/;
  const hardEnd = Math.min(end, lines.length);
  for (let i = start - 1; i < hardEnd; i++) {
    const m = reAssign.exec(lines[i] || '');
    if (!m) continue;
    const attr = m[1];
    const { expr, endIdx } = balancedExpr(lines, i, m[2], hardEnd);
    i = endIdx;                          // skip the consumed continuation lines
    if (seen.has(attr)) continue;
    const desc = classifyAssignment(attr, expr);
    if (!desc) continue;
    seen.add(attr);
    out.push(desc);
  }
  return out;
}

// Resolve a class name to its (filepath, range): prefer the current file,
// else a unique index-wide match; ambiguous or missing -> null (leaf).
function resolveClass(classMap, name, preferFile) {
  const entries = classMap.get(name);
  if (!entries || !entries.length) return null;
  const same = entries.filter(e => e.filepath === preferFile);
  if (same.length) return same[0];
  if (entries.length === 1) return entries[0];
  return entries[0];  // first by index order; collision disclosed in header
}

// Recursive namespace walk. Returns [{ path, label, role }] rows.
function buildNamespace(index, classMap, filepath, start, end, prefix, visited, depth) {
  if (depth > 8) return [];
  const lines = index.fileLines.get(filepath);
  if (!lines) return [];
  const rows = [];
  for (const a of extractAssignments(lines, start, end)) {
    const p = prefix + a.attr;
    if (a.kind === 'leaf') {
      rows.push({ path: p, label: a.cls, role: roleFor(a.attr, p) });
    } else if (a.kind === 'sequential') {
      rows.push({ path: p, label: 'nn.Sequential', role: roleFor(a.attr, p) });
      a.children.forEach((c, ci) => rows.push({ path: `${p}.${ci}`, label: c, role: null }));
    } else if (a.kind === 'container') {
      rows.push({ path: p, label: (a.cls ? `container of ${a.cls}` : 'container') + ' (non-hookable: no forward)', role: null });
    } else if (a.kind === 'module-list') {
      rows.push({ path: p, label: 'nn.ModuleList container (non-hookable: no forward)', role: null });
      const resolved = a.cls && resolveClass(classMap, a.cls, filepath);
      const childPrefix = `${p}.{i}`;
      rows.push({ path: childPrefix, label: a.cls || '?', role: null });
      // Cycle guard tracks the recursion BRANCH (ancestors), not all visited
      // classes — the same class legitimately recurs at multiple paths
      // (DeepSeek: experts.{i} AND shared_experts are both DeepseekV3MLP).
      const klist = resolved && `${resolved.filepath}|${a.cls}`;
      if (resolved && !visited.has(klist)) {
        rows.push(...buildNamespace(index, classMap, resolved.filepath, resolved.start, resolved.end, `${childPrefix}.`, new Set([...visited, klist]), depth + 1));
      }
    } else if (a.kind === 'class') {
      const resolved = resolveClass(classMap, a.cls, filepath);
      rows.push({ path: p, label: a.cls, role: roleFor(a.attr, p) });
      const kcls = resolved && `${resolved.filepath}|${a.cls}`;
      if (resolved && !visited.has(kcls)) {
        rows.push(...buildNamespace(index, classMap, resolved.filepath, resolved.start, resolved.end, `${p}.`, new Set([...visited, kcls]), depth + 1));
      }
    }
  }
  return rows;
}

// Best-effort python import path from an indexed filepath (zip!-prefixes and
// repo dirs stripped at well-known seams). Emitted as a COMMENT hint only.
function moduleHint(filepath) {
  let p = filepath.replace(/\\/g, '/');
  const bang = p.lastIndexOf('!');
  if (bang >= 0) p = p.slice(bang + 1);
  p = p.replace(/\.py$/i, '');
  const segs = p.split('/');
  for (const marker of ['site-packages', 'src']) {
    const at = segs.lastIndexOf(marker);
    if (at >= 0) return segs.slice(at + 1).join('.');
  }
  return segs.slice(Math.max(0, segs.length - 4)).join('.');
}

// A derived module path is only usable as a live `import` if every dot-segment
// is a valid Python identifier (zip stems like `d2l-en-master` are not). When
// valid, emit a live (best-effort, maybe prefix-short) import; when not, emit a
// FIXME comment so the harness still PY-COMPILES (it NameErrors at runtime,
// which the user fixes by writing the real import).
function importLine(modPath, name) {
  const ok = modPath && modPath.split('.').every(s => /^[A-Za-z_]\w*$/.test(s));
  return ok
    ? `    from ${modPath} import ${name}`
    : `    # FIXME: write the import for ${name} (auto-derived path "${modPath}" is not a valid module)`;
}

// Recover the top-level package name from the corpus's OWN absolute
// self-imports — `from <TOP>.<rest> import` where <rest> (as a path) matches an
// indexed file. The dominant <TOP> is the package. This is principled and
// dogfood-able: independent of the (arbitrary) index label and of the build
// root. Crucially it recovers the IMPORT name, not the label — e.g. the
// `.scikit-learn` index yields `sklearn`, not the hyphenated label. Returns
// null when no package dominates (relative-import-only code) → FIXME fallback.
function derivePackageName(index) {
  const stems = new Set([...index.fileLines.keys()].map(p => p.replace(/\\/g, '/').replace(/\.py$/, '')));
  const counts = new Map();
  const re = /^\s*(?:from|import)\s+([A-Za-z_]\w*)\.([\w.]+)/;
  for (const [, lines] of index.fileLines) {
    for (const ln of lines) {
      const m = re.exec(ln);
      if (!m) continue;
      const rest = m[2].replace(/\./g, '/');
      if (stems.has(rest)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
  }
  let best = null, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return bestN >= 3 ? best : null;   // threshold drops 1-off cross-package noise
}

// Prepend the derived package when it's valid and not already present; a wrong
// or absent guess just becomes a FIXME via importLine's validity check.
function withPkg(modPath, pkg) {
  if (!pkg || !/^[A-Za-z_]\w*$/.test(pkg)) return modPath;
  return modPath.split('.')[0] === pkg ? modPath : `${pkg}.${modPath}`;
}

// ---------------------------------------------------------------------------
// Template rendering.
// ---------------------------------------------------------------------------
// Build a short, CONCRETE "reading the output" guide that cites actual rows
// the extractor found in THIS model — so the explanation is grounded in lines
// the user will literally see, not generic boilerplate.
function readingGuide(namespaceRows, className) {
  const find = (re) => (namespaceRows.find(r => r.role && re.test(r.role)) || {}).path;
  const repeat = (namespaceRows.find(r => r.path.includes('{i}')) || {}).path;
  const attn = find(/FUSED|attention/);
  const act = find(/activation/);
  const norm = find(/normaliz/);
  const lines = [];
  lines.push('READING THE OUTPUT');
  lines.push('------------------');
  lines.push('Two sections print when you run this:');
  lines.push('');
  lines.push('1. CAPTURED ACTIVATIONS — one row per forward hook = one submodule\'s');
  lines.push('   output tensor, as data flows through. Columns: path, class, output');
  lines.push('   shape, dtype, and (where labeled) a role. For example, a row like');
  if (act) lines.push(`     ${act}  -> the activation tensor (a natural "what features fire" tap)`);
  if (attn) lines.push(`     ${attn}  -> the attention projection (the QK/OV circuit boundary)`);
  if (!act && !attn && namespaceRows[0]) lines.push(`     ${namespaceRows[0].path}  -> that submodule's output tensor`);
  lines.push('   tells you the tensor SHAPE at that point (real even with random');
  lines.push('   weights) -- though the VALUES are only meaningful with real weights');
  lines.push('   and an apt input.');
  lines.push('');
  lines.push('2. STATIC-VS-RUNTIME CROSS-CHECK — did CodeExam\'s statically-read');
  lines.push('   namespace match the model\'s real module tree? "none / none" means the');
  lines.push('   static map was exact. Mismatches point at modules created dynamically');
  lines.push('   (static miss) or that the extractor did not predict.');
  lines.push('');
  lines.push('WHY THESE ARE "SEAMS" (instrumentation points)');
  lines.push('----------------------------------------------');
  lines.push('Every named submodule is a clean tensor boundary: a forward hook reads');
  lines.push('(or, if you extend it, intervenes on) the tensor crossing it -- no model');
  lines.push('edits needed. That makes each a ready probe point for dynamic analysis:');
  if (act) lines.push(`  - activation taps (e.g. ${act}) -> feed an SAE / collect features;`);
  if (attn) lines.push(`  - attention projections (e.g. ${attn}) -> QK/OV circuit analysis;`);
  if (repeat) lines.push(`  - repeated blocks (${repeat}) -> per-layer probes across depth.`);
  lines.push('The role labels flag the circuit-relevant taps; this harness captures');
  lines.push('shapes + the namespace so the dynamic step (SHAP/PCA/UMAP/activation');
  lines.push('patching, run by you) starts from correct wiring, not a guess.');
  return lines.join('\n');
}

function renderHarness({ className, filepath, startLine, namespaceRows, indexPath, loaderBody }) {
  const nsLines = namespaceRows.map(r => {
    const comment = [r.label, r.role].filter(Boolean).join(' -- ');
    return `    ${JSON.stringify(r.path) + ','}${comment ? `  # ${comment}` : ''}`;
  }).join('\n');
  const roleEntries = namespaceRows.filter(r => r.role).map(r =>
    `    ${JSON.stringify(r.path)}: ${JSON.stringify(r.role)},`).join('\n');

  return `#!/usr/bin/env python3
"""
AUTO-GENERATED instrumentation harness — emitted by CodeExam (--emit-harness)
==============================================================================
Target class : ${className}
Source       : ${filepath.replace(/\\/g, '/')}:${startLine}
Index        : ${indexPath}
Template     : activation-hook (#95 foothold)

CodeExam emitted this file MECHANICALLY from static analysis of the model's
nn.Module tree. CodeExam never runs it — you do. REVIEW BEFORE RUNNING.

Mechanical (static, no LLM):
  - STATIC_NAMESPACE : recursive hook-path namespace read from each class's
                       \`self.x = SubModule(...)\` assignments. \`{i}\` marks an
                       nn.ModuleList repeat (count known only at runtime).
  - STATIC_ROLES     : heuristic name-pattern labels — verify before relying.
  - hook registration + shape/dtype capture + static-vs-runtime cross-check.

You supply (the one non-mechanical step): a model instance and an apt sample
input, in load_model() below. CodeExam cannot know your checkpoint or a
meaningful input — that seam is intentionally left to you.

${'$'}{READING_GUIDE}
"""

import os
import re
import torch

# Provenance — where this harness came from (printed at the top of its output).
TARGET_CLASS = "${className}"
SOURCE       = "${filepath.replace(/\\/g, '/')}:${startLine}"
INDEX        = "${indexPath}"


# ---------------------------------------------------------------------------
# MECHANICAL PART 1 — statically extracted namespace + heuristic role labels.
# ---------------------------------------------------------------------------
STATIC_NAMESPACE = [
${nsLines}
]

STATIC_ROLES = {
${roleEntries}
}


def role_for(name):
    """Map a concrete runtime path back to its templated role label, if any."""
    templ = re.sub(r"\\.\\d+(?=\\.|$)", ".{i}", name)
    return STATIC_ROLES.get(templ, "")


# ---------------------------------------------------------------------------
# MECHANICAL PART 2 — hook registration + capture + cross-check.
# ---------------------------------------------------------------------------
def _shape(t):
    return tuple(t.shape) if isinstance(t, torch.Tensor) else type(t).__name__


def instrument(model):
    """Register a forward hook on every named submodule. Returns the records
    list (filled during the forward pass) and the runtime name set."""
    records = []

    def make_hook(path):
        def hook(module, inputs, output):
            out = output[0] if isinstance(output, tuple) else output
            records.append({
                "path": path,
                "class": type(module).__name__,
                "out_shape": _shape(out),
                "dtype": str(getattr(out, "dtype", None)),
                "role": role_for(path),
            })
        return hook

    runtime_names = set()
    for name, module in model.named_modules():
        if name:
            module.register_forward_hook(make_hook(name))
            runtime_names.add(name)
    return records, runtime_names


def cross_check(runtime_names):
    """Compare CE's static namespace to the model's real runtime tree.
    {i} templates match any numeric index — repeat counts are runtime facts.
    A static path with no runtime match = a static-analysis miss; a runtime
    module matching no static path = something the extractor didn't predict
    (e.g. a module created dynamically). Either is worth surfacing."""
    def to_regex(p):
        return re.compile("^" + re.escape(p).replace(r"\\{i\\}", r"\\d+") + "$")
    static_res = [(p, to_regex(p)) for p in STATIC_NAMESPACE]
    missing = [p for p, rx in static_res if not any(rx.match(n) for n in runtime_names)]
    unpredicted = sorted(n for n in runtime_names
                         if not any(rx.match(n) for _, rx in static_res))
    print("\\n=== static-vs-runtime namespace cross-check ===")
    print(f"  static paths   : {len(STATIC_NAMESPACE)}")
    print(f"  runtime modules: {len(runtime_names)}")
    print(f"  static paths with no runtime match : {missing or 'none'}")
    print(f"  runtime modules CE did not predict : {unpredicted or 'none'}")


def report(records):
    print("\\n=== captured activations (path -> class, out shape, dtype | role) ===")
    for r in records:
        role = f"  | {r['role']}" if r["role"] else ""
        print(f"  {r['path']:32s} {r['class']:24s} {str(r['out_shape']):20s} "
              f"{r['dtype']}{role}")


def provenance():
    """Print where this harness came from -- so redirected output is self-identifying."""
    here = os.path.basename(__file__)
    print("Output from CodeExam --emit-harness (activation-hook template)")
    print(f"  Target: {TARGET_CLASS}")
    print(f"  Source: {SOURCE}")
    print(f"  Index : {INDEX}")
    print(f"  Guide : see the docstring at the top of {here} for how to read this")
    print(f"          output and why these submodule boundaries are useful 'seams'.")


def dynamic_coverage(records, runtime_names):
    """For each REPEATED block (a '{i}' template), how many instances actually
    FIRED (their forward ran) vs how many are REGISTERED. fired < registered
    means dynamic / conditional execution -- e.g. a Mixture-of-Experts enlists
    only the top-k experts the router picks for THIS input, so you see e.g.
    '4 of 32 experts fired'. This is the static-structure vs dynamic-behavior
    gap made concrete -- the thing static analysis alone cannot tell you."""
    fired = {r["path"] for r in records}
    blocks = [p for p in STATIC_NAMESPACE if p.endswith(".{i}") or p == "{i}"]
    if not blocks:
        return
    print("\\n=== dynamic coverage (instances fired vs registered, per repeated block) ===")
    for tmpl in blocks:
        rx = re.compile("^" + re.escape(tmpl).replace(r"\\{i\\}", r"\\d+") + "$")
        reg = sum(1 for n in runtime_names if rx.match(n))
        fir = sum(1 for n in fired if rx.match(n))
        flag = "   <- dynamic: only some ran for this input (e.g. MoE routing)" if fir < reg else ""
        print(f"  {tmpl:28s} {fir:4d} of {reg:4d} fired{flag}")


# ---------------------------------------------------------------------------
# YOU SUPPLY: model instance + sample input.
# ---------------------------------------------------------------------------
def load_model():
    """Return (model, args_tuple, kwargs_dict) for one forward pass.

    Import hint (verify against your environment):
        # from ${'$'}{MODULE_HINT} import ${className}

    Typical shapes:
      - real checkpoint:   model = ${className}.from_pretrained(...)  (HF-style)
      - config-only/tiny:  build a small config and instantiate ${className}(cfg)
        with random weights — structure/namespace validation without downloads.
    """
${'$'}{LOADER_BODY}


def main():
    provenance()
    model, fwd_args, fwd_kwargs = load_model()
    model = model.eval()
    records, runtime_names = instrument(model)
    # The forward pass can fail on a wrong synthetic INPUT SHAPE (a # FIXME),
    # but the static-vs-runtime cross-check below does NOT need it -- module
    # registration (named_modules) happened at instrument() time, before this.
    # So a shape error still leaves the STRUCTURE validation intact.
    forward_ok = True
    try:
        with torch.no_grad():
            model(*fwd_args, **fwd_kwargs)
    except Exception as e:
        forward_ok = False
        print(f"\\n[forward did not complete: {type(e).__name__}: {e}]")
        print("  Activation capture is partial. If you used --synthetic-loader this is")
        print("  almost certainly the input SHAPE (a # FIXME in load_model). The static-")
        print("  vs-runtime cross-check below is STILL VALID (it uses module registration,")
        print("  which happens before the forward pass).")
    report(records)
    cross_check(runtime_names)
    if forward_ok:
        dynamic_coverage(records, runtime_names)


if __name__ == "__main__":
    main()
`.replace('${MODULE_HINT}', moduleHint(filepath))
   .replace('${READING_GUIDE}', readingGuide(namespaceRows, className))
   .replace('${LOADER_BODY}', loaderBody || `    raise NotImplementedError(\n        "Supply a ${className} instance and a sample input here, then rerun."\n    )`);
}

// (renderHarness output passes through toAscii at the write site.)

// ---------------------------------------------------------------------------
// Synthetic loader (#157) — opt-in mechanical load_model() body. Best-effort:
// removes the config/instantiation burden; input shapes are a guess / # FIXME.
// Reframed as a STRUCTURE VALIDATOR (values are noise) in a loud banner.
// ---------------------------------------------------------------------------

// Size-like __init__/config params get shrunk so the model is tiny on CPU.
const SIZE_PARAM = /(?:_size$|_dim$|^dim|hidden|embed|ffn|intermediate|channels?|vocab|^d_)/i;
const COUNT_PARAM = /(?:depth|num_layers?|n_layers?|layers?|num_heads?|n_heads?|heads?|num_.*experts?|n_.*experts?|experts?|blocks?|n_group)/i;
// Forward args that are NOT the main tensor input — skip when synthesizing randn.
const NON_INPUT_ARG = /^(?:self|config|cfg|mask|attention_mask|.*_mask|past.*|cache.*|use_cache|position_ids|.*_ids|labels?|return_dict|output_.*|kwargs|inputs_embeds)$/i;

// Scan a class body [start,end] for `def <name>(` and return the joined
// parameter string + the line index just after the signature's closing `):`.
function methodSig(lines, start, end, name) {
  const open = new RegExp(`^\\s*def\\s+${name}\\s*\\(`);
  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
    if (!open.test(lines[i] || '')) continue;
    let buf = '', depth = 0, started = false, endIdx = i;
    for (let j = i; j < Math.min(end, lines.length); j++) {
      // Strip trailing line comments — multiline signatures often carry inline
      // `# ...` notes that would otherwise parse as bogus params.
      const ln = (lines[j] || '').replace(/#.*$/, '');
      for (const ch of ln) {
        if (ch === '(') { depth++; started = true; }
        else if (ch === ')') depth--;
      }
      buf += (buf ? ' ' : '') + ln.trim();
      if (started && depth <= 0) { endIdx = j; break; }
    }
    const m = /\(([\s\S]*)\)/.exec(buf);
    return { params: m ? m[1] : '', sigEndIdx: endIdx };
  }
  return null;
}

// Split a parameter string into [{name, type, default}], paren/bracket-aware.
function parseParams(raw) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of raw) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => p.trim()).filter(p => p && p !== 'self' && !p.startsWith('*')).map(p => {
    let name = p, type = null, def = null;
    const eq = p.indexOf('=');
    if (eq >= 0) { def = p.slice(eq + 1).trim(); name = p.slice(0, eq); }
    const colon = name.indexOf(':');
    if (colon >= 0) { type = name.slice(colon + 1).trim(); name = name.slice(0, colon); }
    return { name: name.trim(), type, default: def };
  }).filter(p => /^[A-Za-z_]\w*$/.test(p.name));   // drop any non-identifier noise
}

// Shrunk value for a size/count param, else null (keep its default).
function shrink(name) {
  if (COUNT_PARAM.test(name)) return name.match(/experts?/i) ? 8 : 2;
  if (SIZE_PARAM.test(name)) return 16;
  return null;
}

// Find a Config class for a config-based model by stripping role suffixes off
// the class name and trying `<stem>Config`. Unreliable for nested HF configs
// (disclosed) — null falls back to the stub.
function findConfigClass(classMap, className) {
  let stem = className;
  const strip = /(?:PreTrainedModel|Model|ForCausalLM|ForConditionalGeneration|ForSequenceClassification|ForMaskedLM|MoE|Block|Layer|Attention|Encoder|Decoder|Transformer|Head|Embeddings?)$/;
  const tries = [];
  for (let i = 0; i < 6 && stem; i++) {
    tries.push(stem + 'Config');
    const next = stem.replace(strip, '');
    if (next === stem) break;
    stem = next;
  }
  for (const cand of tries) if (classMap.has(cand)) return cand;
  return null;
}

// Build the python load_model() body. Returns { body, notes }.
function buildSyntheticLoader(index, classMap, model, className, info, pkg) {
  const lines = index.fileLines.get(model.filepath) || [];
  const initSig = methodSig(lines, info.start, info.end, '__init__');
  const fwdSig = methodSig(lines, info.start, info.end, 'forward');
  if (!fwdSig) return null;  // no forward -> can't drive it; keep stub
  const initParams = initSig ? parseParams(initSig.params) : [];
  const fwdParams = parseParams(fwdSig.params);
  const notes = [];
  let hiddenVal = null;   // shrunk hidden size, for a 3D input-shape guess
  // Real (best-effort) imports — the index path may omit the top-level package
  // (e.g. a transformers index rooted at src/transformers/ yields
  // `models.deepseek_v3...`, dropping `transformers.`). FIXME-marked so the
  // user prepends the package if the import fails.
  const imports = [importLine(withPkg(moduleHint(model.filepath), pkg), className)];
  // transformers quirk: `modular_*` files are build-time source, not
  // runtime-importable; the shipped module is `modeling_*`.
  if (/(?:^|[\\/])modular_[^\\/]*$/.test(model.filepath)) {
    imports.push(`    # NOTE: source is a 'modular_*' file (build-time only); import from the 'modeling_*' module instead.`);
  }

  // --- instantiation ---
  // A param is FILLABLE if it's size-like (shrink), has a default (omit), or is
  // a config (built below). A required param that's none of these means we
  // can't honestly synthesize -> stub-fallback (never emit broken syntax).
  const cfgParam = initParams.find(p => /^(config|cfg|configuration)$/i.test(p.name));
  // Numeric default of a param, else null.
  const numDefault = (p) => (p.default != null && /^-?\d+(?:\.\d+)?$/.test(p.default.trim())) ? Number(p.default) : null;
  // Shrink an __init__ EXTRA arg to a kwarg, or null to omit (defaults), or
  // false when it's a required arg we can't fill. NEVER increase a param past
  // its default — shrinking is for big dims (hidden_size 4096->16), not for
  // small structural ones (kernel_size 3 must stay 3, not jump to 16).
  const extraKw = (p) => {
    const s = shrink(p.name), d = numDefault(p);
    if (s != null && (d == null || d > s)) return `${p.name}=${s}`;
    if (p.default != null) return null;     // has a default -> omit (keep it)
    return false;                            // required, unfillable
  };
  let instantiate;
  if (cfgParam) {
    const cfgClass = findConfigClass(classMap, className);
    if (!cfgClass) return { stubFallback: `config-based __init__ but no <stem>Config class found in this index` };
    // Extra args beyond config (e.g. layer_idx) — bail if any is required+unfillable.
    const extras = [];
    for (const p of initParams) {
      if (p === cfgParam) continue;
      const kw = extraKw(p);
      if (kw === false) return { stubFallback: `__init__ requires '${p.name}' (no default, not size-like) alongside config` };
      if (kw) extras.push(kw);
    }
    const cfgInfo = classMap.get(cfgClass)[0];
    imports.push(importLine(withPkg(moduleHint(cfgInfo.filepath), pkg), cfgClass));
    const cfgLines = index.fileLines.get(cfgInfo.filepath) || [];
    const cfgInit = methodSig(cfgLines, cfgInfo.start, cfgInfo.end, '__init__');
    const cfgParams = cfgInit ? parseParams(cfgInit.params) : [];
    // Only shrink params whose DEFAULT is numeric (or absent) — name-matching
    // alone wrongly shrinks string/bool params (hidden_act="silu").
    // Shrink only numeric-default params, and only when it REDUCES (never bump
    // kernel_size 3 -> 16; only shrink big dims like hidden_size 4096 -> 16).
    const isNumericDefault = (d) => d == null || /^-?\d+(?:\.\d+)?$/.test(d.trim());
    const numOf = (d) => (d != null && /^-?\d+(?:\.\d+)?$/.test(d.trim())) ? Number(d) : null;
    const overrides = cfgParams.map(p => [p.name, shrink(p.name), p.default])
      .filter(([, v, d]) => v != null && isNumericDefault(d) && (numOf(d) == null || numOf(d) > v));
    const kw = overrides.map(([n, v]) => `${n}=${v}`).join(', ');
    const hid = overrides.find(([n]) => /^(?:hidden_size|hidden|d_model|embed_dim)$/i.test(n));
    if (hid) hiddenVal = hid[1];
    const ctorArgs = [`${cfgParam.name}=cfg`, ...extras].join(', ');
    instantiate = [
      `    # Config '${cfgClass}' found by name convention; numeric size params shrunk`,
      `    # (heuristic). FIXME: shrunk dims may violate inter-param constraints`,
      `    # (e.g. hidden_size == num_heads * head_dim); adjust if construction fails.`,
      `    cfg = ${cfgClass}(${kw})`,
      `    model = ${className}(${ctorArgs})`,
    ].join('\n');
    notes.push(`config=${cfgClass}`);
  } else {
    // Direct-arg __init__: shrink size args, omit defaulted ones. A required
    // non-size arg means we can't synthesize -> stub-fallback.
    const kws = [];
    for (const p of initParams) {
      const kw = extraKw(p);
      if (kw === false) return { stubFallback: `__init__ requires '${p.name}' (no default, not size-like)` };
      if (kw) kws.push(kw);
    }
    instantiate = `    model = ${className}(${kws.join(', ')})`;
    notes.push('direct-arg init');
  }

  // --- forward inputs ---
  // Parse docstring shapes: `name (... of shape (d1, d2))`.
  const docShapes = {};
  for (let j = fwdSig.sigEndIdx + 1; j < Math.min(info.end, lines.length); j++) {
    const sm = /(\w+)\s*\(`?[^)]*shape[`\s]*\(?([^)]+)\)/i.exec(lines[j] || '');
    if (sm) docShapes[sm[1]] = sm[2].replace(/`/g, '').trim();
    if (/^\s*(def |return |[a-z_]+\s*=)/.test(lines[j] || '') && j > fwdSig.sigEndIdx + 1) break;
  }
  const inputs = fwdParams.filter(p => !NON_INPUT_ARG.test(p.name)
    && (!p.type || /tensor/i.test(p.type)));
  if (!inputs.length) return { stubFallback: `forward has no synthesizable tensor input` };
  // Guess shape: numeric docstring dims if available, else a 3D
  // (batch, seq, hidden) shape (the common transformer input) using the shrunk
  // hidden size when known, else a generic 2D — always FIXME-marked. Seq is 16
  // (not 4) so conv/pooling stacks don't underflow their kernel/padding.
  const guess = hiddenVal != null ? `1, 16, ${hiddenVal}` : '2, 16';
  const argLines = [];
  for (const p of inputs) {
    const shape = docShapes[p.name];
    const numeric = shape && /^[\d,\s]+$/.test(shape);
    if (numeric) argLines.push(`    ${p.name} = torch.randn(${shape.replace(/\s+/g, '')})`);
    else if (shape) argLines.push(`    ${p.name} = torch.randn(${guess})   # FIXME: real shape "(${shape})" -- symbolic, set concrete dims`);
    else argLines.push(`    ${p.name} = torch.randn(${guess})   # FIXME: shape is a guess -- set real dims`);
  }
  const kwargsDict = inputs.map(p => `"${p.name}": ${p.name}`).join(', ');

  const body = [
    '    # SYNTHETIC (--synthetic-loader): random weights + shape-inferred input.',
    '    # Validates STRUCTURE (namespace, shapes, cross-check) ONLY -- activation',
    '    # VALUES are meaningless noise. For real behavior, supply real weights +',
    '    # an apt input. Best-effort: the import path below uses the package name',
    "    # derived from the corpus's own imports -- if ModuleNotFoundError,",
    '    # `pip install` the package and/or fix the path. Also fix any # FIXME shape.',
    ...imports,
    instantiate,
    '    model = model.eval()',
    ...argLines,
    `    return model, (), {${kwargsDict}}`,
  ].join('\n');
  return { body, notes };
}

// Locate a model class's body range (function index entry) — shared by emit
// and the harnessability sweep.
function classInfoFor(index, model) {
  const fileFuncs = index.functionIndex[model.filepath] || {};
  const entry = Object.entries(fileFuncs).find(([n, i]) => i && i.type === 'class'
    && (n === model.name || n.split('::').pop() === model.name));
  return entry ? entry[1] : null;
}

// ---------------------------------------------------------------------------
// --list-harnessable: CE-native sweep — for each model, would --emit-harness
// (and its --synthetic-loader) succeed? Dogfoods the "which models can I test"
// question instead of a throwaway script. Pure analysis, writes nothing.
// ---------------------------------------------------------------------------
export function doListHarnessable(index, args) {
  index._ensureFunctionIndex();
  const pkg = derivePackageName(index);
  const classMap = buildClassMap(index);
  const models = index.listModels(args.filter).filter(m => m.framework === 'PyTorch'
    && !/(?:^|[\\/])modular_[^\\/]*$/.test(m.filepath));   // modular_* aren't importable
  const ready = [], manual = [], skip = {};
  for (const m of models) {
    const info = classInfoFor(index, m);
    if (!info) continue;
    const visited = new Set([`${m.filepath}|${m.name}`]);
    const rows = buildNamespace(index, classMap, m.filepath, info.start, info.end, '', visited, 0);
    if (!rows.some(r => !/non-hookable/.test(r.label || ''))) { skip['no instrumentable submodules'] = (skip['no instrumentable submodules'] || 0) + 1; continue; }
    const syn = buildSyntheticLoader(index, classMap, m, m.name, info, pkg);
    if (syn && syn.body) ready.push(m);
    else { manual.push(m); const r = (syn && syn.stubFallback) || 'no forward'; skip[`needs manual loader: ${r}`] = (skip[`needs manual loader: ${r}`] || 0) + 1; }
  }
  const pkgNote = pkg ? `package '${pkg}' (from corpus self-imports)` : 'package NOT derivable (relative-import code) — imports will be FIXME';
  console.log(`\n${models.length} PyTorch model classes; ${pkg ? pkgNote : pkgNote}.`);
  console.log(`  ${ready.length} synthetic-ready (--synthetic-loader auto-fills load_model)`);
  console.log(`  ${manual.length} instrumentable but need a hand-written loader`);
  const max = effectiveMaxResults(args, 25);
  console.log(`\nSynthetic-ready (file@Class)${ready.length > max ? `, first ${max}` : ''}:`);
  for (const m of ready.slice(0, max)) console.log(`  ${m.filepath.replace(/\\/g, '/')}@${m.name}`);
  { const note = capNotice(ready.length, Math.min(max, ready.length), 'models'); if (note) console.log('\n' + note); }
  const reasons = Object.entries(skip).sort((a, b) => b[1] - a[1]);
  if (reasons.length) {
    console.log(`\nWhy the rest aren't synthetic-ready:`);
    for (const [r, n] of reasons.slice(0, 8)) console.log(`  ${String(n).padStart(5)}  ${r}`);
  }
  console.log(`\n  (Run: --emit-harness <file@Class> --synthetic-loader. Synthetic = random`);
  console.log(`   weights, STRUCTURE validation only; review the import + any # FIXME.)`);
}

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------
export function doEmitHarness(index, args) {
  const spec = args.emit_harness;
  if (!spec || spec === true) {
    console.log('Usage: --emit-harness <Class>   (or file@Class to disambiguate)');
    console.log('  Target = a model class from --models. Template defaults to activation-hook');
    console.log('  (the only one today); override with --harness-template <name>.');
    return;
  }
  // The VALUE of --emit-harness is the model class, not the template. A user
  // who typed `--emit-harness activation-hook` (template-first, per the #95
  // sketch) lands here — redirect instead of "class not found".
  if (KNOWN_TEMPLATES.has(spec)) {
    console.log(`'${spec}' is a harness TEMPLATE, not a model class.`);
    console.log(`Usage: --emit-harness <Class> [--harness-template ${spec}]`);
    console.log(`  activation-hook is the default (and currently only) template, so`);
    console.log(`  --harness-template is optional. Pass the model class as the value.`);
    return;
  }
  const template = args.harness_template || 'activation-hook';
  if (!KNOWN_TEMPLATES.has(template)) {
    console.log(`Unknown harness template '${template}'. Available: ${[...KNOWN_TEMPLATES].join(', ')}`);
    return;
  }

  // Resolve the target model file-qualified (#85): file@Class form, else the
  // listModels rows (already per-(file, class)).
  let fileHint = null, className = spec;
  if (spec.includes('@')) {
    const at = spec.indexOf('@');
    fileHint = spec.slice(0, at);
    className = spec.slice(at + 1);
  }
  const models = index.listModels().filter(m => m.name === className
    && (!fileHint || m.filepath.replace(/\\/g, '/').includes(fileHint.replace(/\\/g, '/'))));
  if (!models.length) {
    console.log(`Model class not found: '${className}'${fileHint ? ` (file hint: ${fileHint})` : ''}.`);
    console.log('Targets come from --models (classes whose inheritance reaches an ML base).');
    return;
  }
  if (models.length > 1) {
    console.log(`Ambiguous: ${models.length} model classes named '${className}'. Use file@Class:`);
    for (const m of models.slice(0, 10)) console.log(`  ${m.filepath.replace(/\\/g, '/')}@${m.name}`);
    return;
  }
  const model = models[0];
  if (model.framework !== 'PyTorch') {
    eprint(`Note: '${className}' detected as ${model.framework}; the activation-hook template targets PyTorch nn.Module trees. Emitting anyway — review carefully.`);
  }
  // `modular_*` files are build-time source: importing them is fragile and
  // spews transformers' own auto_docstring warnings. If the same class lives in
  // the `modeling_*` twin (the shipped, importable module), steer there.
  const fp = model.filepath.replace(/\\/g, '/');
  if (/(?:^|\/)modular_[^/]*\.py$/.test(fp)) {
    const twin = fp.replace(/(^|\/)modular_/, '$1modeling_');
    const hasTwin = index.listModels().some(m => m.name === className
      && m.filepath.replace(/\\/g, '/') === twin);
    if (hasTwin) {
      eprint(`WARNING: '${fp}' is a 'modular_*' file (build-time source — fragile to import,`);
      eprint(`         emits transformers' own auto_docstring warnings at runtime). The same`);
      eprint(`         class exists in the importable 'modeling_*' module. Re-run with:`);
      eprint(`           --emit-harness ${twin}@${className} --synthetic-loader`);
    }
  }

  // Class range from the function index.
  index._ensureFunctionIndex();
  const info = classInfoFor(index, model);
  if (!info) {
    console.log(`Could not locate the class body for '${className}' in ${model.filepath}.`);
    return;
  }

  const classMap = buildClassMap(index);
  const visited = new Set([`${model.filepath}|${className}`]);
  const namespaceRows = buildNamespace(index, classMap, model.filepath, info.start, info.end, '', visited, 0);
  if (!namespaceRows.length) {
    console.log(`No \`self.x = Module(...)\` assignments found in ${className} — nothing to instrument.`);
    return;
  }

  // #157: opt-in synthetic load_model() body. Best-effort; honest fallback to
  // the stub (with a note) when instantiation/inputs can't be synthesized.
  let loaderBody = null;
  if (args.synthetic_loader) {
    const syn = buildSyntheticLoader(index, classMap, model, className, info, derivePackageName(index));
    if (syn && syn.body) {
      loaderBody = syn.body;
    } else {
      const why = (syn && syn.stubFallback) || 'forward signature not found';
      eprint(`Note: --synthetic-loader could not synthesize a loader (${why}); emitting the stub for you to fill.`);
    }
  }

  const text = toAscii(renderHarness({
    className,
    filepath: model.filepath,
    startLine: info.start,
    namespaceRows,
    indexPath: index.indexPath || args.index_path || '',
    loaderBody,
  }));

  // Never overwrite an existing harness — the user may have filled in
  // load_model() (or otherwise edited it). Bump _2, _3, … instead.
  let outPath = (typeof args.harness_out === 'string' && args.harness_out) || `${className}_harness.py`;
  if (fs.existsSync(outPath)) {
    const ext = path.extname(outPath);
    const stem = outPath.slice(0, outPath.length - ext.length);
    let n = 2;
    while (fs.existsSync(`${stem}_${n}${ext}`)) n++;
    eprint(`Note: ${outPath} exists (may contain your edits) — writing ${stem}_${n}${ext} instead.`);
    outPath = `${stem}_${n}${ext}`;
  }
  fs.writeFileSync(outPath, text, 'utf8');

  const taps = namespaceRows.filter(r => !/non-hookable/.test(r.label || ''));
  console.log(`\nEmitted ${path.resolve(outPath)}`);
  console.log(`  Target : ${className}  (${model.filepath.replace(/\\/g, '/')}:${info.start})`);
  console.log(`  Paths  : ${namespaceRows.length} static (${taps.length} hookable); ${namespaceRows.filter(r => r.role).length} role-labeled`);
  if (loaderBody) {
    console.log(`  Loader : --synthetic-loader filled load_model() (random weights, structure-only).`);
    console.log(`           Review/fix any # FIXME shape, then run it yourself. Values are noise.`);
  } else {
    console.log(`  Next   : fill in load_model() (model + sample input), review, then run it yourself.`);
  }
  console.log(`           CodeExam does not execute harnesses.`);
}
