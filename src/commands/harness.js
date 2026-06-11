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

// Extract `self.x = ...` module assignments from a class body, in source
// order, deduped by attribute (first assignment wins).
function extractAssignments(lines, start, end) {
  const out = [];
  const seen = new Set();
  const reAssign = /^\s*self\.(\w+)\s*=\s*(.+)$/;
  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
    const m = reAssign.exec(lines[i] || '');
    if (!m) continue;
    const attr = m[1];
    if (seen.has(attr)) continue;
    // Join a small window so multiline heads (`nn.Sequential(\n nn.Linear...`,
    // `nn.ModuleList([\n Cls(...) for ...`) still classify with all their
    // children; bounded so giant literals don't blow up.
    const expr = [m[2], ...lines.slice(i + 1, i + 7)].join(' ').trim();
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

function renderHarness({ className, filepath, startLine, namespaceRows, indexPath }) {
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
    raise NotImplementedError(
        "Supply a ${className} instance and a sample input here, then rerun."
    )


def main():
    provenance()
    model, fwd_args, fwd_kwargs = load_model()
    model = model.eval()
    records, runtime_names = instrument(model)
    with torch.no_grad():
        model(*fwd_args, **fwd_kwargs)
    report(records)
    cross_check(runtime_names)
    dynamic_coverage(records, runtime_names)


if __name__ == "__main__":
    main()
`.replace('${MODULE_HINT}', moduleHint(filepath))
   .replace('${READING_GUIDE}', readingGuide(namespaceRows, className));
}

// (renderHarness output passes through toAscii at the write site.)

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

  // Class range from the function index.
  index._ensureFunctionIndex();
  const fileFuncs = index.functionIndex[model.filepath] || {};
  const entry = Object.entries(fileFuncs).find(([n, i]) => i && i.type === 'class'
    && (n === className || n.split('::').pop() === className));
  if (!entry) {
    console.log(`Could not locate the class body for '${className}' in ${model.filepath}.`);
    return;
  }
  const [, info] = entry;

  const classMap = buildClassMap(index);
  const visited = new Set([`${model.filepath}|${className}`]);
  const namespaceRows = buildNamespace(index, classMap, model.filepath, info.start, info.end, '', visited, 0);
  if (!namespaceRows.length) {
    console.log(`No \`self.x = Module(...)\` assignments found in ${className} — nothing to instrument.`);
    return;
  }

  const text = toAscii(renderHarness({
    className,
    filepath: model.filepath,
    startLine: info.start,
    namespaceRows,
    indexPath: index.indexPath || args.index_path || '',
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
  console.log(`  Next   : fill in load_model() (model + sample input), review, then run it yourself.`);
  console.log(`           CodeExam does not execute harnesses.`);
}
