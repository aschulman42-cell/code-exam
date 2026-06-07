/**
 * ai-ml-detectors.js - AI/ML detection extracted from CodeSearchIndex.js (#133).
 *
 * The 13 AI/ML "list" detectors plus their two shared helpers, moved verbatim
 * out of the ~7k-line CodeSearchIndex ("CSI") class. They are mixed onto
 * CodeSearchIndex.prototype via Object.assign(prototype, aimlMethods) in
 * CodeSearchIndex.js, so inside each method `this` resolves to the CSI
 * instance: this.fileLines, this.functionIndex, this._ensureFunctionIndex(),
 * and the cross-cell this.listModels()/... calls in listPipelines all work
 * unchanged. External callers (metrics.js, server.js) still call index.listX().
 *
 * MODEL_BASE_* + classifyModelBase travel here because listModels uses them;
 * classifyModelBase is re-exported because CSI's class digest (its one other
 * caller) still needs it - a one-directional CSI -> this-module import, no cycle.
 *
 * Pure move, no logic change. Worklist item: aiml-detectors-mixin-extract.
 */

// ---------------------------------------------------------------------------
// AI/ML model-base classification (#84) — SINGLE source for listModels() and
// the class digest's `Model:` line. Qualified bases are confident; bare
// ambiguous names (Model) are flagged. Bare `Module` is intentionally absent
// (DSPy's dspy.Module etc. are not PyTorch — real PyTorch uses nn.Module).
// ---------------------------------------------------------------------------
const MODEL_BASE_CONFIDENT = {
  'nn.Module': 'PyTorch', 'torch.nn.Module': 'PyTorch',
  'tf.Module': 'TensorFlow', 'tf.keras.Model': 'TensorFlow',
  'keras.layers.Layer': 'Keras', 'keras.Layer': 'Keras', 'keras.Model': 'Keras',
  'BackendLayer': 'Keras', 'Layer': 'Keras',
  'BaseEstimator': 'scikit-learn', 'ClassifierMixin': 'scikit-learn',
  'RegressorMixin': 'scikit-learn', 'TransformerMixin': 'scikit-learn',
  'ClusterMixin': 'scikit-learn', 'OutlierMixin': 'scikit-learn',
};
const MODEL_BASE_AMBIG = { 'Model': 'Keras' };

// Given an ordered list of (qualified-where-known) ancestor names, return
// { framework, base, ambiguous } for the first confident hit, else the first
// ambiguous hit, else null.
function classifyModelBase(ancestorNames) {
  let amb = null;
  for (const p of (ancestorNames || [])) {
    if (MODEL_BASE_CONFIDENT[p]) return { framework: MODEL_BASE_CONFIDENT[p], base: p, ambiguous: false };
    if (!amb && MODEL_BASE_AMBIG[p]) amb = { framework: MODEL_BASE_AMBIG[p], base: p, ambiguous: true };
  }
  return amb;
}

export { classifyModelBase };

// Carrier class: the detector methods are class-body syntax (no inter-method
// commas), so they move here verbatim inside a throwaway class; the mixin
// object below is lifted from its prototype.
class _AIMLMethods {
  /**
   * AI/ML "Models" accordion (#84). Returns classes whose inheritance chain
   * reaches a known ML model base, as
   *   [{ name, filepath, framework, base, ambiguous, method_count }].
   *
   * Pure surfacing of inheritance data already computed by
   * _getInheritanceMap() — no new analysis. Detection honesty:
   *   - qualified bases (nn.Module, tf.Module, keras.layers.Layer,
   *     BaseEstimator, ...) are unambiguous;
   *   - bare ambiguous names (Module / Model / Layer) are matched but flagged
   *     `ambiguous:true`, and the matched `base` is returned so the row can
   *     show it (detect-and-report, never silently assume).
   */
  listModels(filter = null) {
    this._ensureFunctionIndex();

    // Model-base sets are module-level (shared with the digest's Model: line).
    const CONFIDENT = MODEL_BASE_CONFIDENT;
    const AMBIG = MODEL_BASE_AMBIG;

    // Lightweight {filepath, methodCount} per class + the set of class files.
    const classInfo = {};
    const classFiles = new Set();
    for (const [fpath, functions] of Object.entries(this.functionIndex)) {
      let hasClass = false;
      for (const [name, info] of Object.entries(functions)) {
        if (info && info.type === 'class') {
          hasClass = true;
          const bare = name.includes('::') ? name.split('::').pop() : name;
          if (!classInfo[bare]) classInfo[bare] = { name: bare, filepath: fpath, methodCount: 0 };
        }
      }
      if (hasClass) classFiles.add(fpath);
    }
    for (const [, functions] of Object.entries(this.functionIndex)) {
      for (const [name, info] of Object.entries(functions)) {
        if (info && (info.type === 'method' || info.type === 'function')
            && (name.includes('::') || name.includes('.'))) {
          const sep = name.includes('::') ? '::' : '.';
          const prefix = name.slice(0, name.indexOf(sep));
          if (classInfo[prefix]) classInfo[prefix].methodCount++;
        }
      }
    }

    // QUALIFIED inheritance map. Unlike _getInheritanceMap() (which reduces a
    // parent to its last word, turning `nn.Module` into bare `Module`), keep the
    // `nn.`/`tf.`/`keras.` qualifier so PyTorch's nn.Module is unambiguous.
    // child(bare) -> [qualified parent strings].
    const qmap = new Map();
    const decl = [
      /^\s*class\s+(\w+)\s*\(\s*([^)]+)\s*\)\s*:/,             // Python
      /^\s*(?:export\s+)?class\s+(\w+)\s+extends\s+([\w.]+)/,  // JS/TS
    ];
    for (const [filepath, lines] of this.fileLines) {
      if (classFiles.size && !classFiles.has(filepath)) continue;
      for (const line of lines) {
        for (const pat of decl) {
          const mm = pat.exec(line);
          if (!mm) continue;
          const child = mm[1];
          const parents = mm[2].split(',')
            .map(s => s.replace(/<[^>]*>/g, '').replace(/=.*/, '').replace(/\s+/g, ''))
            .filter(p => p && p !== 'object' && p !== 'metaclass');
          if (parents.length) {
            const ex = qmap.get(child) || [];
            for (const p of parents) if (!ex.includes(p)) ex.push(p);
            qmap.set(child, ex);
          }
          break;
        }
      }
    }

    // For each class, walk its qualified ancestor chain to a model base.
    // `chain` records the ancestor path from the class to the base (exclusive of
    // the class itself), e.g. ["Qwen2_5_VLPreTrainedModel","PreTrainedModel",
    // "nn.Module"]. Each stack entry carries the path taken to reach it.
    const out = [];
    for (const cname of Object.keys(classInfo)) {
      const seen = new Set([cname]);
      const stack = [[cname, []]];   // [node, chainFromClassToNode]
      let best = null;               // { base, framework, ambiguous, chain }
      while (stack.length) {
        const [cur, pathToCur] = stack.pop();
        for (const p of (qmap.get(cur) || [])) {
          const chainToP = [...pathToCur, p];
          if (CONFIDENT[p]) { best = { base: p, framework: CONFIDENT[p], ambiguous: false, chain: chainToP }; break; }
          if (!best && AMBIG[p]) best = { base: p, framework: AMBIG[p], ambiguous: true, chain: chainToP };
          if (!seen.has(p)) { seen.add(p); stack.push([p, chainToP]); }
        }
        if (best && !best.ambiguous) break;  // confident hit — stop early
      }
      if (best) {
        const info = classInfo[cname];
        out.push({ name: cname, filepath: info.filepath, framework: best.framework, base: best.base, ambiguous: best.ambiguous, chain: best.chain, method_count: info.methodCount });
      }
    }

    if (filter) {
      const pat = filter.toLowerCase();
      return out.filter(m =>
        m.name.toLowerCase().includes(pat)
        || (m.filepath || '').toLowerCase().includes(pat)
        || (m.framework || '').toLowerCase().includes(pat));
    }
    return out;
  }

  /**
   * listArtifacts(filter) — AI/ML model-artifact load/save sites (#96).
   *
   * Unlike listModels() (which walks a class-inheritance map to find a defined
   * UNIT), artifacts are usage SITES: where model weights enter/leave the
   * program. So this is a line-level marker scan over fileLines with family
   * classification + context-gating. One record per site:
   *   { name, filepath, line, direction, family, familyLabel, format, tag, path, snippet }
   *
   * Three families (grounded in #96):
   *   A `[mechanical]` HF / PyTorch  — from_pretrained / save_pretrained /
   *      AutoModel* / .state_dict() / load_state_dict( / torch.save|load /
   *      safe_open / load_file / hf_hub_download / cached_file
   *   B `[mechanical]` node-llama-cpp — getLlama( / loadModel( / createContext( /
   *      readGgufFileInfo( / GgufFileReader
   *   C `[heuristic]` format-by-extension — bare .gguf/.safetensors/.onnx/.ckpt/
   *      .pt/.bin/.pth/.h5 inside a quoted string
   *
   * Context-gating (the #96 caveat): `state_dict` over-counts because every
   * nn.Module *defines* a state_dict method. We require a CALL site (a leading
   * `.` for `.state_dict(`, and exclude `def load_state_dict`), never the
   * declaration. Family C only fires inside a quoted path string and never on a
   * line already claimed by a mechanical marker, so it doesn't double-count.
   */
  listArtifacts(filter = null) {
    // Ordered detectors — first match on a line wins, so a mechanical marker
    // (A/B) always beats the heuristic extension (C) on the same line.
    const L = 'load', S = 'save';
    const A = 'HF/PyTorch', B = 'node-llama-cpp', C = 'format-ref';
    const detectors = [
      // ── Family A: HF / PyTorch ──────────────────────────────────────────
      { re: /\bsave_pretrained\s*\(/,                fam: A, dir: S, fmt: 'hf',          tag: 'mechanical' },
      { re: /\bfrom_pretrained\s*\(/,                fam: A, dir: L, fmt: 'hf',          tag: 'mechanical' },
      { re: /\bAuto(?:Model|Tokenizer|Config|Processor|FeatureExtractor)\w*\s*\./, fam: A, dir: L, fmt: 'hf', tag: 'mechanical' },
      { re: /\bhf_hub_download\s*\(/,                fam: A, dir: L, fmt: 'hf-hub',      tag: 'mechanical' },
      { re: /\bcached_file\s*\(/,                    fam: A, dir: L, fmt: 'hf-hub',      tag: 'mechanical' },
      { re: /\btorch\.save\s*\(/,                    fam: A, dir: S, fmt: 'torch',       tag: 'mechanical' },
      { re: /\btorch\.load\s*\(/,                    fam: A, dir: L, fmt: 'torch',       tag: 'mechanical' },
      // state_dict: CALL sites only — `.state_dict(` (save side) and
      // `load_state_dict(` (load side); never a `def …state_dict` declaration.
      { re: /\bload_state_dict\s*\(/, not: /\bdef\s+load_state_dict/, fam: A, dir: L, fmt: 'state-dict', tag: 'mechanical' },
      { re: /\.state_dict\s*\(/,                     fam: A, dir: S, fmt: 'state-dict',  tag: 'mechanical' },
      { re: /\bsafe_open\s*\(/,                      fam: A, dir: L, fmt: 'safetensors', tag: 'mechanical' },
      { re: /\bload_file\s*\(/,                      fam: A, dir: L, fmt: 'safetensors', tag: 'mechanical' },
      // ── Family B: node-llama-cpp ────────────────────────────────────────
      // Specific-enough markers fire unconditionally.
      { re: /\bgetLlama\s*\(/,                       fam: B, dir: L, fmt: 'gguf',        tag: 'mechanical' },
      { re: /\breadGgufFileInfo\s*\(/,               fam: B, dir: L, fmt: 'gguf',        tag: 'mechanical' },
      { re: /\bGgufFileReader\b/,                    fam: B, dir: L, fmt: 'gguf',        tag: 'mechanical' },
      // `.loadModel(` and `.createContext(` are GENERIC method names — most
      // notably `.createContext(` is React Context (cli.js / any Ink-based TUI
      // has dozens: `X.createContext({...})` + `.Provider` / `.displayName`).
      // Gate them on same-file node-llama-cpp evidence so React contexts don't
      // masquerade as model loads. (Verified false positives on a cli.js index.)
      { re: /\.loadModel\s*\(/,     gated: true,     fam: B, dir: L, fmt: 'gguf',        tag: 'mechanical' },
      { re: /\.createContext\s*\(/, gated: true,     fam: B, dir: L, fmt: 'gguf',        tag: 'mechanical' },
    ];
    // Family C: a model-artifact extension inside a quoted string.
    const extRe = /["'`]([^"'`\n]*\.(gguf|safetensors|onnx|ckpt|pth|pt|bin|h5))["'`]/i;
    // Best-effort artifact path/id extraction for A/B records.
    const pathRe = /["'`]([^"'`\n]{1,120})["'`]/;
    const isComment = (t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');

    // When the artifact arg is a variable (no quoted literal), pull the
    // identifier so _resolveLiteral can resolve it. `fromIdx` is just past the
    // marker match (after its `(` for call markers). Covers keyword forms
    // (repo_id=, model_path=, …) and the positional first arg.
    const artifactArgIdent = (line, fromIdx) => {
      const seg = line.slice(fromIdx, fromIdx + 160);
      const kw = seg.match(/\b(?:repo_id|model_id|model_path|pretrained_model_name_or_path|path|filename|model|ckpt_path|checkpoint)\s*=\s*([A-Za-z_$][\w.$]*)/);
      const pos = kw ? null : seg.match(/^\s*\(?\s*([A-Za-z_$][\w.$]*)\s*[,)]/);
      const id = kw ? kw[1] : (pos ? pos[1] : null);
      // `cls`/`self` is a method-signature param (def from_pretrained(cls, …)),
      // not an artifact identity — don't surface it.
      return (id === 'cls' || id === 'self') ? null : id;
    };

    // .md/.rst docs aren't code — skip them (#102). pathRe treats markdown
    // inline-code backticks as string quotes, so without this a doc line like
    // `AutoModelForCausalLM.from_pretrained()` becomes a bogus artifact id.
    const reDocFile = /\.(?:md|markdown|mdx|rst)$/i;
    const out = [];
    for (const [filepath, lines] of this.fileLines) {
      if (reDocFile.test(filepath)) continue;
      // Gate for generic Family-B markers: does this file actually use
      // node-llama-cpp? If not, `.createContext(`/`.loadModel(` are something
      // else (React Context, an unrelated loader, etc.) and must not count.
      const fileHasLlama = lines.some(l =>
        /\bgetLlama\s*\(|node-llama-cpp|loadLlamaModelFromFile|\bLlamaModel\b/.test(l));
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();
        let rec = null;
        for (const d of detectors) {
          if (d.gated && !fileHasLlama) continue;
          const m = d.re.exec(line);
          if (m && !(d.not && d.not.test(line))) {
            const pm = line.match(pathRe);
            let path = pm ? pm[1] : null;
            let pathResolved = !!pm;            // a quoted literal is already resolved
            if (!path) {
              const ident = artifactArgIdent(line, m.index + m[0].length);
              if (ident) {
                const lit = this._resolveLiteral(lines, ident, i);
                if (lit != null) { path = lit; pathResolved = true; }
                else { path = '<' + ident + '>'; pathResolved = false; }
              }
            }
            rec = { family: d.fam, direction: d.dir, format: d.fmt, tag: d.tag,
                    marker: d.re.source.replace(/\\b|\\s\*|\\\(|\(\?:|[()\\]/g, '').slice(0, 24),
                    path, pathResolved };
            break;
          }
        }
        if (!rec && !isComment(trimmed)) {
          const em = line.match(extRe);
          if (em) rec = { family: C, direction: 'ref', format: em[2].toLowerCase(),
                          tag: 'heuristic', marker: '.' + em[2].toLowerCase(), path: em[1], pathResolved: true };
        }
        if (rec) {
          out.push({
            name: rec.path || rec.format,
            filepath, line: i + 1,
            direction: rec.direction, family: rec.family, familyLabel: rec.family,
            format: rec.format, tag: rec.tag, marker: rec.marker,
            path: rec.path, pathResolved: rec.pathResolved,
            snippet: trimmed.slice(0, 200),
          });
        }
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(a =>
        (a.filepath || '').toLowerCase().includes(pat)
        || (a.format || '').toLowerCase().includes(pat)
        || (a.family || '').toLowerCase().includes(pat)
        || (a.path || '').toLowerCase().includes(pat)
        || (a.snippet || '').toLowerCase().includes(pat));
    }
    // Stable order: family, then format, then file, then line.
    result.sort((a, b) =>
      a.family.localeCompare(b.family) || a.format.localeCompare(b.format)
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * listKernels(filter) — GPU kernels (#93). Unlike Artifacts (pure sites) and
   * Models (pure inheritance units), kernels are BOTH definitions and launches:
   *
   *   kernel-def : the unit
   *     - CUDA  `__global__` function (the ONE true CUDA kernel marker)
   *     - Triton `@triton.jit` (+ @triton.autotune/@triton.heuristics) decorated def
   *     - numba  `@cuda.jit` decorated def
   *   launch     : callers → kernels
   *     - CUDA  `name<<<grid,block>>>` and `cudaLaunchKernel(`  [mechanical]
   *     - Triton/numba `name[grid](…)`  [heuristic] — generic subscript-call, so
   *       GATED on (a) the file importing triton/numba AND (b) `name` being a
   *       known kernel def in this index (the #96 `createContext` lesson).
   *   device-fn  : `__device__` (incl. `__host__ __device__`) — device helper,
   *                NOT a kernel; surfaced as a distinct secondary category.
   *
   * `__host__` ALONE is an ordinary CPU function (default space) → dropped.
   *
   * Why the CUDA `__`-qualifiers are safe markers: they're reserved,
   * double-underscore-prefixed execution-space qualifiers in a fixed slot before
   * a function decl — user code can't collide (unlike a plain method name like
   * `createContext`), so no same-file gating is needed for them.
   */
  listKernels(filter = null) {
    const CUDA = 'CUDA', TRITON = 'Triton', NUMBA = 'numba';
    const reGlobal = /\b__global__\b/;
    const reDevice = /\b__device__\b/;
    const reCudaName = /__global__\b[^(){};]*?\b(\w+)\s*\(/;
    const reDevName  = /__device__\b[^(){};]*?\b(\w+)\s*\(/;
    const reTritonDec = /^@(?:triton\.jit|triton\.autotune|triton\.heuristics)\b/;
    const reNumbaDec  = /^@(?:cuda\.jit|numba\.cuda\.jit)\b/;
    const reDef = /^\s*def\s+(\w+)\s*\(/;
    const reLaunchCuda = /\b(\w+)\s*<<<[^>]*>>>/;
    const reCudaLaunchKernel = /\bcudaLaunchKernel\s*\(/;
    const reGridLaunch = /\b(\w+)\s*\[\s*[\w()*+\-,.\s]+\]\s*\(/;

    const out = [];
    const kernelNames = new Set();   // for grid-launch gating
    const gridCandidates = [];       // [{filepath, line, name, snippet}]

    // CUDA launch/qualifier syntax (`__global__`, `<<<…>>>`, `cudaLaunchKernel`)
    // exists ONLY in C/C++ — gating CUDA markers to C/C++ files stops them
    // matching e.g. a `'<<<%s>>>'` string in a Python simulator.
    const reCppExt = /\.(cu|cuh|c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp)$/i;
    for (const [filepath, lines] of this.fileLines) {
      const isCpp = reCppExt.test(filepath);
      const fileHasTritonNumba = lines.some(l =>
        /\bimport\s+triton\b|triton\.language|from\s+numba|import\s+numba|@cuda\.jit/.test(l));
      const handledDefLines = new Set();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();

        // CUDA kernel def — __global__ (takes priority over __device__).
        if (isCpp && reGlobal.test(line)) {
          const m = line.match(reCudaName);
          let name = m ? m[1] : null;
          // Signature frequently wraps: `__global__ void` then `VectorAdd(...)`
          // on the next line — look ahead for the first `ident(` if not found.
          if (!name) {
            for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
              const nm = (lines[j] || '').match(/\b(\w+)\s*\(/);
              if (nm) { name = nm[1]; break; }
            }
          }
          name = name || '(kernel)';
          kernelNames.add(name);
          out.push({ name, filepath, line: i + 1, kind: 'kernel-def', family: CUDA, marker: '__global__', tag: 'mechanical', snippet: trimmed.slice(0, 200) });
          continue;
        }
        // CUDA device fn — __device__ / __host__ __device__ (secondary).
        // __host__ alone matches neither → dropped (CPU default space).
        if (isCpp && reDevice.test(line)) {
          const m = line.match(reDevName);
          const name = m ? m[1] : '(device fn)';
          out.push({ name, filepath, line: i + 1, kind: 'device-fn', family: CUDA, marker: '__device__', tag: 'mechanical', snippet: trimmed.slice(0, 200) });
          continue;
        }
        // Triton / numba decorated kernel def — decorator is on the line(s)
        // BEFORE `def`, so associate it with the following function.
        if (reTritonDec.test(trimmed) || reNumbaDec.test(trimmed)) {
          const fam = reNumbaDec.test(trimmed) ? NUMBA : TRITON;
          const marker = (trimmed.match(/^@[\w.]+/) || ['@?'])[0];
          let defName = null, defLine = i;
          for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
            const dm = (lines[j] || '').match(reDef);
            if (dm) { defName = dm[1]; defLine = j; break; }
          }
          if (defName && !handledDefLines.has(defLine)) {
            handledDefLines.add(defLine);
            kernelNames.add(defName);
            out.push({ name: defName, filepath, line: defLine + 1, kind: 'kernel-def', family: fam, marker, tag: 'mechanical', snippet: (lines[defLine] || '').trimStart().slice(0, 200) });
          }
          continue;
        }
        // CUDA launch — name<<<...>>> (｢<<<｣ is CUDA-only syntax IN C/C++; in a
        // Python/other file the same chars can appear inside a string, so gate).
        const lm = isCpp ? line.match(reLaunchCuda) : null;
        if (lm) {
          out.push({ name: lm[1], filepath, line: i + 1, kind: 'launch', family: CUDA, marker: '<<<>>>', tag: 'mechanical', snippet: trimmed.slice(0, 200) });
          continue;
        }
        if (isCpp && reCudaLaunchKernel.test(line)) {
          out.push({ name: 'cudaLaunchKernel', filepath, line: i + 1, kind: 'launch', family: CUDA, marker: 'cudaLaunchKernel', tag: 'mechanical', snippet: trimmed.slice(0, 200) });
          continue;
        }
        // Triton/numba grid launch — name[grid](...). Generic subscript-call, so
        // defer; only kept if the file uses triton/numba AND name is a known
        // kernel def (resolved after the full scan).
        if (fileHasTritonNumba) {
          const gm = line.match(reGridLaunch);
          if (gm) gridCandidates.push({ filepath, line: i + 1, name: gm[1], snippet: trimmed.slice(0, 200) });
        }
      }
    }

    // Resolve grid-launch candidates against the known-kernel set.
    for (const c of gridCandidates) {
      if (kernelNames.has(c.name)) {
        out.push({ name: c.name, filepath: c.filepath, line: c.line, kind: 'launch', family: 'Triton/numba', marker: '[grid]', tag: 'heuristic', snippet: c.snippet });
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(k =>
        (k.name || '').toLowerCase().includes(pat)
        || (k.filepath || '').toLowerCase().includes(pat)
        || (k.family || '').toLowerCase().includes(pat)
        || (k.kind || '').toLowerCase().includes(pat)
        || (k.snippet || '').toLowerCase().includes(pat));
    }
    const kindRank = { 'kernel-def': 0, 'launch': 1, 'device-fn': 2 };
    result.sort((a, b) =>
      a.family.localeCompare(b.family)
      || (kindRank[a.kind] - kindRank[b.kind])
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * listMultimodal(filter) — vision / multimodal / generative-vision proxies
   * (#140). Keyword-table detector (mirrors listEmbeddings' tierA structure),
   * NOT the elaborate CUDA-syntax logic of listKernels: these are NLP-ish
   * keyword matches over source, so every record is `tag: 'heuristic'`.
   *
   * Five kinds, each a representative `family` + the matched `marker` token:
   *   encoder       — vision encoders / VLM image stacks (CLIP, ViT,
   *                   vision_tower, pixel_values, image_processor, …)
   *   cnn-arch      — classic CNN architectures (ResNet, VGG, Inception,
   *                   EfficientNet, ImageNet, Conv2d / convolutional)
   *   detection-seg — object detection + segmentation families & indicia
   *                   (SSD, YOLO, *R-CNN, RetinaNet, DETR, U-Net, bbox,
   *                   anchor box, IoU, NMS, mAP, semantic/instance seg)
   *   generative    — image generative stacks (diffusion, UNet/VAE, latent,
   *                   scheduler, denoise, text-to-image)
   *   marker        — explicit multimodal flags (multimodal, vision-language,
   *                   VLM)
   *
   * FP avoidance is cheap-only: word boundaries + capitalized/underscored
   * forms (`\bCLIP\b`, not `clip` inside `clipboard`; `\bViT\b`, not the `vit`
   * in `invite`). No co-occurrence gating — keep it simple and readable.
   */
  listMultimodal(filter = null) {
    // [regex, family, kind, marker-label]. First match on a line wins (the
    // table is ordered most-specific → most-generic within each theme).
    const table = [
      // ---- encoder (vision encoders / VLM image stacks) ----
      { re: /\bCLIP\b/,                          fam: 'CLIP',         kind: 'encoder',       m: 'CLIP' },
      { re: /\bViT\b/,                           fam: 'ViT',          kind: 'encoder',       m: 'ViT' },
      { re: /\bvision_tower\b/,                  fam: 'VLM',          kind: 'encoder',       m: 'vision_tower' },
      { re: /\bvision_model\b/,                  fam: 'VLM',          kind: 'encoder',       m: 'vision_model' },
      { re: /\bpixel_values\b/,                  fam: 'VLM',          kind: 'encoder',       m: 'pixel_values' },
      { re: /\bimage_processor\b/,               fam: 'VLM',          kind: 'encoder',       m: 'image_processor' },
      { re: /\bimage_embeds\b/,                  fam: 'VLM',          kind: 'encoder',       m: 'image_embeds' },
      { re: /\bfeature_extractor\b/,             fam: 'vision',       kind: 'encoder',       m: 'feature_extractor' },
      // ---- cnn-arch (classic CNN architectures) ----
      { re: /\bResNet\b|\bresnet\d+\b/,          fam: 'ResNet',       kind: 'cnn-arch',      m: 'ResNet' },
      { re: /\bVGG\b|\bvgg\d+\b/,                fam: 'VGG',          kind: 'cnn-arch',      m: 'VGG' },
      { re: /\bInception(?:V\d)?\b/,             fam: 'Inception',    kind: 'cnn-arch',      m: 'Inception' },
      { re: /\bEfficientNet\b/,                  fam: 'EfficientNet', kind: 'cnn-arch',      m: 'EfficientNet' },
      { re: /\bImageNet\b/,                      fam: 'ImageNet',     kind: 'cnn-arch',      m: 'ImageNet' },
      { re: /\bConv2[dD]\b|\bConv2D\b/,          fam: 'CNN',          kind: 'cnn-arch',      m: 'Conv2d' },
      { re: /\bconvolutional\b/i,                fam: 'CNN',          kind: 'cnn-arch',      m: 'convolutional' },
      // ---- detection-seg (object detection + segmentation) ----
      { re: /\bSSD\b/,                           fam: 'SSD',          kind: 'detection-seg', m: 'SSD' },
      { re: /\bYOLO\b|\byolo\w*\b/,              fam: 'YOLO',         kind: 'detection-seg', m: 'YOLO' },
      { re: /\b(?:Faster|Mask)\s*R-?CNN\b/i,     fam: 'R-CNN',        kind: 'detection-seg', m: 'R-CNN' },
      { re: /\bRetinaNet\b/,                     fam: 'RetinaNet',    kind: 'detection-seg', m: 'RetinaNet' },
      { re: /\bDETR\b/,                          fam: 'DETR',         kind: 'detection-seg', m: 'DETR' },
      { re: /\bU-?Net\b/,                        fam: 'U-Net',        kind: 'detection-seg', m: 'U-Net' },
      { re: /\b(?:semantic|instance)\s+segmentation\b/i, fam: 'segmentation', kind: 'detection-seg', m: 'segmentation' },
      { re: /\bbounding\s*box\b|\bbbox\b/i,      fam: 'detection',    kind: 'detection-seg', m: 'bbox' },
      { re: /\banchor[_\s]?box\w*\b|\bAnchorBoxes\b/i, fam: 'detection', kind: 'detection-seg', m: 'anchor box' },
      { re: /\bIoU\b|\biou_threshold\b/,         fam: 'detection',    kind: 'detection-seg', m: 'IoU' },
      { re: /\bNMS\b|\bnon[_-]?max(?:imum)?[_\s]?suppression\b/i, fam: 'detection', kind: 'detection-seg', m: 'NMS' },
      { re: /\bmAP\b/,                           fam: 'detection',    kind: 'detection-seg', m: 'mAP' },
      // ---- generative (image generative stacks) ----
      // NOTE: U-Net is claimed above by detection-seg; the generative U-Net
      // (UNet, no hyphen) is caught here so the diffusion arch still surfaces.
      { re: /\bdiffusion\b/i,                    fam: 'diffusion',    kind: 'generative',    m: 'diffusion' },
      { re: /\btext-to-image\b/i,                fam: 'diffusion',    kind: 'generative',    m: 'text-to-image' },
      { re: /\bUNet\b/,                          fam: 'diffusion',    kind: 'generative',    m: 'UNet' },
      { re: /\bVAE\b/,                           fam: 'VAE',          kind: 'generative',    m: 'VAE' },
      { re: /\blatent\b/i,                       fam: 'diffusion',    kind: 'generative',    m: 'latent' },
      { re: /\b(?:DDPM|DDIM|DPMSolver|Euler|PNDM|LMS|Heun|UniPC)\w*Scheduler\b|\bnoise[_\s]?scheduler\b/, fam: 'diffusion', kind: 'generative', m: 'scheduler' },
      { re: /\bdenoise\w*\b/i,                   fam: 'diffusion',    kind: 'generative',    m: 'denoise' },
      // ---- marker (explicit multimodal flags) ----
      { re: /\bmultimodal\b/i,                   fam: 'multimodal',   kind: 'marker',        m: 'multimodal' },
      { re: /\bvision-language\b/i,              fam: 'VLM',          kind: 'marker',        m: 'vision-language' },
      { re: /\bVLM\b/,                           fam: 'VLM',          kind: 'marker',        m: 'VLM' },
    ];
    const reDocFile = /\.(?:md|markdown|mdx|rst)$/i;
    const reComment = (t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');

    // Ambiguous markers that collide with non-vision usage: YOLO (pop-culture
    // "you only live once"), SSD (solid-state disk), bbox (UI/TUI element
    // bounding boxes, not just object-detection boxes). Gate them: a hit only
    // counts if the SAME FILE has a non-ambiguous vision marker to anchor it.
    // Stops `multimodal(YOLO)` in codex-rs and `bbox` in TUI-layout code.
    const AMBIGUOUS = new Set(['YOLO', 'SSD', 'bbox']);

    const out = [];
    for (const [filepath, lines] of this.fileLines) {
      if (reDocFile.test(filepath)) continue;
      const fileHits = [];
      let anchored = false;   // file has ≥1 non-ambiguous vision marker
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();
        if (reComment(trimmed)) continue;
        const d = table.find(e => e.re.test(line));
        if (d) {
          fileHits.push({ name: d.m, filepath, line: i + 1, kind: d.kind, family: d.fam, marker: d.m, tag: 'heuristic', snippet: trimmed.slice(0, 200) });
          if (!AMBIGUOUS.has(d.m)) anchored = true;
        }
      }
      for (const h of fileHits) {
        if (AMBIGUOUS.has(h.marker) && !anchored) continue;   // drop unanchored ambiguous
        out.push(h);
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(t =>
        (t.name || '').toLowerCase().includes(pat) || (t.filepath || '').toLowerCase().includes(pat)
        || (t.family || '').toLowerCase().includes(pat) || (t.kind || '').toLowerCase().includes(pat)
        || (t.marker || '').toLowerCase().includes(pat) || (t.snippet || '').toLowerCase().includes(pat));
    }
    const kindRank = { 'encoder': 0, 'cnn-arch': 1, 'detection-seg': 2, 'generative': 3, 'marker': 4 };
    result.sort((a, b) =>
      (kindRank[a.kind] - kindRank[b.kind]) || (a.family || '').localeCompare(b.family || '')
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * listDatasets(filter) — ML datasets (#99). Precision-tiered to avoid the
   * generic-I/O over-trigger (the #96 `createContext` / `.bin` lesson):
   *
   *   Tier 1 `definition` [mechanical] — the structural unit:
   *     - class decl whose base is Dataset/IterableDataset/TensorDataset/
   *       ConcatDataset (PyTorch/HF). __getitem__/__len__/__iter__ are
   *       CONFIRMATION only, NEVER standalone (scikit-learn has 22 __getitem__
   *       on Bunch/containers that are NOT datasets — would FP).
   *     - tf.data.Dataset pipelines (from_tensor_slices/from_generator) — TF
   *       datasets are functional, not subclassed.
   *   Tier 2 `loader` [mechanical] — ML-specific named loaders, with a `builtin`
   *     flag for toy/demo datasets (load_iris/MNIST/…) so tutorial noise filters.
   *   Tier 3 — generic I/O (pd.read_csv/np.load/open) — EXCLUDED entirely (63
   *     read_csv in .as_ml_pytest would otherwise be bogus datasets).
   */
  listDatasets(filter = null) {
    const PT = 'PyTorch', TF = 'TF/Keras', SK = 'scikit-learn', HF = 'HF', TV = 'torchvision';
    // Tier 1a — class base names that denote a dataset definition.
    const reDatasetClass = /^\s*(?:export\s+)?class\s+(\w+)\s*[(:][^)]*\b(Dataset|IterableDataset|TensorDataset|ConcatDataset|StackDataset|GeneratorBasedBuilder)\b/;
    // Tier 1b — tf.data pipeline construction.
    const reTfData = /\btf\.data\.Dataset\b|\.from_tensor_slices\s*\(|\bDataset\.from_generator\s*\(/;
    // Tier 2 — ML-specific loaders. [marker regex, family, isLoaderName-capture]
    const t2 = [
      { re: /\b(?:torch\.utils\.data\.)?DataLoader\s*\(/,                fam: PT, fmt: 'DataLoader' },
      // load_dataset/tfds.load take a string-id arg — match the call regardless
      // of arg form (was: required a quoted literal, so variable args were missed
      // entirely), then extract+resolve the id below. `not` skips a `def`.
      { re: /\bload_dataset\s*\(/, not: /\bdef\s+load_dataset/,          fam: HF, fmt: 'load_dataset', argId: true },
      { re: /\bsklearn\.datasets\.(\w+)|(?:^|[^.\w])datasets\.((?:load|fetch|make)_\w+)\s*\(/, fam: SK, fmt: 'sklearn.datasets' },
      { re: /\b(?:tf\.)?keras\.datasets\.(\w+)/,                         fam: TF, fmt: 'keras.datasets' },
      { re: /\btorch(?:vision|audio|text)\.datasets\.(\w+)/,             fam: TV, fmt: 'torchvision.datasets' },
      { re: /\btfds\.load\s*\(/,                                         fam: TF, fmt: 'tfds.load', argId: true },
    ];
    // toy/demo dataset ids → builtin flag.
    const reBuiltin = /\b(load_iris|load_digits|load_wine|load_breast_cancer|load_diabetes|load_boston|fetch_\w+|make_\w+|MNIST|FashionMNIST|fashion_mnist|CIFAR10|CIFAR100|cifar10|cifar100|ImageNet|KMNIST|EMNIST|titanic|tips|iris|penguins)\b/;
    const reConfirm = /\bdef\s+(?:__getitem__|__len__|__iter__)\s*\(/;
    const reComment = (t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');

    // .md/.rst docs aren't code — skip them (#102), as the other detectors do.
    const reDocFile = /\.(?:md|markdown|mdx|rst)$/i;
    const out = [];
    for (const [filepath, lines] of this.fileLines) {
      if (reDocFile.test(filepath)) continue;
      // Confirmation dunders are looked up within a small window after a class.
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();
        if (reComment(trimmed)) continue;

        // Tier 1a — dataset class definition (keyed on BASE, not dunder).
        const cm = reDatasetClass.exec(line);
        if (cm) {
          // confirmation: a contract dunder within the next ~40 lines
          let confirmed = false;
          for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
            if (/^\s*class\s/.test(lines[j] || '')) break;
            if (reConfirm.test(lines[j] || '')) { confirmed = true; break; }
          }
          out.push({ name: cm[1], filepath, line: i + 1, kind: 'definition',
                     family: cm[2] === 'GeneratorBasedBuilder' ? HF : PT, tier: 1,
                     builtin: false, marker: cm[2], confirmed, resolved: true,
                     tag: 'mechanical', snippet: trimmed.slice(0, 200) });
          continue;
        }
        // Tier 1b — tf.data pipeline.
        if (reTfData.test(line)) {
          out.push({ name: 'tf.data', filepath, line: i + 1, kind: 'definition',
                     family: TF, tier: 1, builtin: false, resolved: true,
                     marker: 'tf.data', confirmed: true, tag: 'mechanical',
                     snippet: trimmed.slice(0, 200) });
          continue;
        }
        // Tier 2 — ML loaders.
        let hit = null;
        for (const d of t2) {
          const m = d.re.exec(line);
          if (m && !(d.not && d.not.test(line))) { hit = { d, m, id: m[1] || m[2] || m[3] || null }; break; }
        }
        if (hit) {
          const fmt = hit.d.fmt;
          // argId markers (load_dataset/tfds.load): pull the first arg — a quoted
          // literal, or an identifier resolved via _resolveLiteral (honest <var>
          // when unresolvable). resolved=false flags the unresolved-variable case.
          let resolved = true;
          if (hit.d.argId) {
            const after = line.slice(hit.m.index + hit.m[0].length);
            const qm = after.match(/^\s*["'`]([^"'`]*)["'`]/);
            if (qm) { hit.id = qm[1]; }
            else {
              const im = after.match(/^\s*([A-Za-z_$][\w.$]*)\s*[,)]/);
              if (im) {
                const lit = this._resolveLiteral(lines, im[1], i);
                if (lit != null) hit.id = lit;
                else { hit.id = '<' + im[1] + '>'; resolved = false; }
              }
            }
          }
          // builtin/demo: whole loader families ARE standard/toy catalogs
          // (keras.datasets, torchvision.datasets, tfds — all benchmark data;
          // sklearn load_/fetch_/make_). HF load_dataset / DataLoader carry
          // arbitrary user datasets → builtin only when the id is a known toy.
          let builtin = reBuiltin.test(line);
          if (fmt === 'keras.datasets' || fmt === 'torchvision.datasets' || fmt === 'tfds.load') builtin = true;
          else if (fmt === 'sklearn.datasets' && /^(load|fetch|make)_/.test(hit.id || '')) builtin = true;
          out.push({ name: hit.id || fmt, filepath, line: i + 1, kind: 'loader',
                     family: hit.d.fam, tier: 2, builtin, marker: fmt, resolved,
                     confirmed: true, tag: 'mechanical', snippet: trimmed.slice(0, 200) });
          continue;
        }
        // Tier 3 (read_csv / np.load / open) — intentionally NOT detected.
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(d =>
        (d.name || '').toLowerCase().includes(pat)
        || (d.filepath || '').toLowerCase().includes(pat)
        || (d.family || '').toLowerCase().includes(pat)
        || (d.kind || '').toLowerCase().includes(pat)
        || (d.marker || '').toLowerCase().includes(pat)
        || (d.snippet || '').toLowerCase().includes(pat));
    }
    const kindRank = { 'definition': 0, 'loader': 1 };
    result.sort((a, b) =>
      a.family.localeCompare(b.family)
      || (kindRank[a.kind] - kindRank[b.kind])
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * listTraining(filter) — where a codebase trains (#100). Captures a dynamic
   * behavior statically. Two kinds:
   *
   *   training-loop : the call-site verbs
   *     Tier A [mechanical] — PyTorch loop (`.backward(` / optimizer `.step(` /
   *       `.zero_grad(`), HF `Trainer(` / `trainer.train(`, TF `GradientTape`.
   *     Tier B [heuristic, gated] — a `.fit(` CALL (`<recv>.fit(`), EXCLUDING
   *       `def fit/fit_transform/partial_fit` definitions (sklearn has 2763
   *       `.fit(` — overwhelmingly defs), gated on ML imports in the file.
   *   training-harness : `def training_step/validation_step/test_step/
   *     configure_optimizers` (Lightning).
   *
   * The `.fit(`-def exclusion is the #99 `__getitem__` / #96 `state_dict` lesson:
   * a generic method NAME must not be counted by its definition.
   */
  listTraining(filter = null) {
    const PT = 'PyTorch', HF = 'HF', KT = 'Keras/TF', SK = 'scikit-learn', LT = 'Lightning', ML = 'ML';
    const reBackward = /\.backward\s*\(/;
    const reOptStep  = /\b(?:optimizer|optim|opt)\.step\s*\(/;
    const reZeroGrad = /\.zero_grad\s*\(/;
    const reGradTape = /\bGradientTape\b/;
    const reTrainerTrain = /\b(?:trainer|self\.trainer)\.train\s*\(/;
    const reTrainer  = /\bTrainer\s*\(/;
    const reHarness  = /^\s*(?:async\s+)?def\s+(training_step|validation_step|test_step|configure_optimizers)\s*\(/;
    const reFitCall  = /\b(\w+)\.fit\s*\(/;
    const reFitDef   = /\bdef\s+(?:fit|fit_transform|partial_fit)\b/;
    const reComment  = (t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');

    // A `.fit()` in a TEST file is exercising training, not the project's own
    // training — and test suites of ML *libraries* (sklearn) call `.fit()`
    // thousands of times. Exclude test files from the heuristic Tier B so the
    // library-vs-consumer noise doesn't drown real signal. (Tier A mechanical
    // markers are trustworthy enough to keep regardless.)
    const reTestPath = /(?:^|[\\/])(?:tests?|conftest)(?:[\\/]|\.)|(?:^|[\\/])test_[^\\/]*$|_test\.[A-Za-z0-9]+$/i;
    const out = [];
    for (const [filepath, lines] of this.fileLines) {
      const isTest = reTestPath.test(filepath);
      const fileHasML = lines.some(l => /\b(?:import|from)\s+(?:sklearn|keras|tensorflow|tf|torch|xgboost|lightgbm)\b/.test(l));
      // Infer the family for a bare `.fit(` from the file's imports.
      let fitFam = ML;
      if (lines.some(l => /\b(?:import|from)\s+(?:keras|tensorflow)\b/.test(l))) fitFam = KT;
      else if (lines.some(l => /\bimport\s+sklearn|from\s+sklearn\b/.test(l))) fitFam = SK;
      else if (lines.some(l => /\b(?:import|from)\s+torch\b/.test(l))) fitFam = PT;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();
        if (reComment(trimmed)) continue;
        const push = (kind, family, tier, marker, tag, name) =>
          out.push({ name: name || marker, filepath, line: i + 1, kind, family, tier, marker, tag, snippet: trimmed.slice(0, 200) });

        // Tier A loop [mechanical] — most specific first.
        if (reBackward.test(line)) { push('training-loop', PT, 'A', 'backward', 'mechanical'); continue; }
        if (reZeroGrad.test(line)) { push('training-loop', PT, 'A', 'zero_grad', 'mechanical'); continue; }
        if (reOptStep.test(line))  { push('training-loop', PT, 'A', 'optimizer.step', 'mechanical'); continue; }
        if (reGradTape.test(line)) { push('training-loop', KT, 'A', 'GradientTape', 'mechanical'); continue; }
        if (reTrainerTrain.test(line)) { push('training-loop', HF, 'A', 'trainer.train', 'mechanical'); continue; }
        if (reTrainer.test(line))  { push('training-loop', HF, 'A', 'Trainer', 'mechanical'); continue; }
        // Tier A harness [mechanical].
        const hm = reHarness.exec(line);
        if (hm) { push('training-harness', LT, 'A', hm[1], 'mechanical', hm[1]); continue; }
        // Tier B [heuristic, gated] — a .fit() CALL, not a def, in a non-test ML file.
        if (fileHasML && !isTest && !reFitDef.test(line)) {
          const fm = reFitCall.exec(line);
          if (fm) { push('training-loop', fitFam, 'B', '.fit', 'heuristic', fm[1] + '.fit'); continue; }
        }
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(t =>
        (t.name || '').toLowerCase().includes(pat)
        || (t.filepath || '').toLowerCase().includes(pat)
        || (t.family || '').toLowerCase().includes(pat)
        || (t.kind || '').toLowerCase().includes(pat)
        || (t.marker || '').toLowerCase().includes(pat)
        || (t.snippet || '').toLowerCase().includes(pat));
    }
    const kindRank = { 'training-loop': 0, 'training-harness': 1 };
    result.sort((a, b) =>
      a.family.localeCompare(b.family)
      || (kindRank[a.kind] - kindRank[b.kind])
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * listInference(filter) — LOCAL model inference + autoregressive generation
   * (#101). Generation ⊂ Inference. The most generic-name-trap-dense unit, so
   * EVERYTHING is gated on the file importing an ML framework (keeps JS/cli.js
   * and bare configs at 0 — API-client LLM usage is a separate Wave-2 cell).
   *
   *   Tier A [mechanical] — clean LLM/ML-specific markers (low FP):
   *     generation: max_new_tokens / do_sample / num_beams / GenerationConfig /
   *                 SamplingParams (vLLM) / Text(Iterator)Streamer
   *     inference : torch.no_grad / inference_mode / InferenceSession (ONNX)
   *   Tier B [heuristic] — generic verbs (ML-file already required):
   *     .generate( ; .predict(/.predict_proba( (EXCLUDE def + test files —
   *       the #100 .fit lesson); pipeline( (require transformers import — sklearn
   *       Pipeline is the trap); model.eval() (require torch)
   *   Tier C [heuristic] — sampling params temperature/top_p/top_k, counted ONLY
   *     when a Tier-A generation marker co-occurs in the same file (sklearn
   *     top_k ×44 / cli.js temperature ×13 are otherwise FPs).
   */
  listInference(filter = null) {
    const HF = 'HF', PT = 'PyTorch', VL = 'vLLM', ONX = 'ONNX', SK = 'scikit-learn', KT = 'Keras/TF', ML = 'ML';
    const genA = [
      { re: /\bmax_new_tokens\b/, fam: HF, m: 'max_new_tokens' },
      { re: /\bdo_sample\b/,      fam: HF, m: 'do_sample' },
      { re: /\bnum_beams\b/,      fam: HF, m: 'num_beams' },
      { re: /\bGenerationConfig\b/, fam: HF, m: 'GenerationConfig' },
      { re: /\bSamplingParams\b/, fam: VL, m: 'SamplingParams' },
      { re: /\bText(?:Iterator)?Streamer\b/, fam: HF, m: 'TextStreamer' },
    ];
    const infA = [
      { re: /\b(?:torch\.)?no_grad\s*\(/, fam: PT, m: 'no_grad' },
      { re: /\binference_mode\b/, fam: PT, m: 'inference_mode' },
      { re: /\bInferenceSession\b/, fam: ONX, m: 'InferenceSession' },
    ];
    const reGenerate = /\b(\w+)\.generate\s*\(/;
    const rePredict  = /\b(\w+)\.predict(_proba)?\s*\(/;
    const rePredictDef = /\bdef\s+predict(?:_proba)?\b/;
    const rePipeline = /\bpipeline\s*\(/;
    const reEval     = /\b(\w+)\.eval\s*\(\s*\)/;
    const reParam    = /\b(temperature|top_p|top_k)\b/;
    const reGenAny   = /\bmax_new_tokens\b|\bdo_sample\b|\bnum_beams\b|\bGenerationConfig\b|\bSamplingParams\b|\.generate\s*\(/;
    const reTestPath = /(?:^|[\\/])(?:tests?|conftest)(?:[\\/]|\.)|(?:^|[\\/])test_[^\\/]*$|_test\.[A-Za-z0-9]+$/i;
    const reComment  = (t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');

    // Documentation markup (.md/.rst) is not code — a `llm.generate(...)` /
    // `from transformers import` in a README or SKILL.md is an EXAMPLE, not the
    // project's inference. Skip it. (The Prompts detector, by contrast,
    // intentionally treats SKILL.md/CLAUDE.md as first-class — different unit.)
    const reDocFile = /\.(?:md|markdown|mdx|rst)$/i;
    const out = [];
    for (const [filepath, lines] of this.fileLines) {
      if (reDocFile.test(filepath)) continue;
      // Gate the whole unit on the file importing an ML framework — this IS
      // local model inference (Python ML); keeps cli.js / JS / configs at 0.
      const fileHasML = lines.some(l => /\b(?:import|from)\s+(?:sklearn|keras|tensorflow|tf|torch|transformers|vllm|onnxruntime|onnx|xgboost|lightgbm|diffusers)\b/.test(l));
      if (!fileHasML) continue;
      const hasTransformers = lines.some(l => /\b(?:import|from)\s+transformers\b/.test(l));
      const hasTorch = lines.some(l => /\b(?:import|from)\s+torch\b/.test(l));
      const fileHasGen = lines.some(l => reGenAny.test(l));
      const isTest = reTestPath.test(filepath);
      let fam = ML;
      if (hasTransformers) fam = HF;
      else if (lines.some(l => /\b(?:import|from)\s+vllm\b/.test(l))) fam = VL;
      else if (lines.some(l => /\b(?:import|from)\s+onnxruntime\b/.test(l))) fam = ONX;
      else if (hasTorch) fam = PT;
      else if (lines.some(l => /\b(?:import|from)\s+(?:keras|tensorflow|tf)\b/.test(l))) fam = KT;
      else if (lines.some(l => /\bimport\s+sklearn|from\s+sklearn\b/.test(l))) fam = SK;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();
        if (reComment(trimmed)) continue;
        const push = (kind, family, tier, marker, tag, name, id = null, resolved = true) =>
          out.push({ name: name || marker, filepath, line: i + 1, kind, family, tier, marker, tag, id, resolved, snippet: trimmed.slice(0, 200) });

        // Tier A mechanical — generation then inference.
        let m = genA.find(d => d.re.test(line));
        if (m) { push('generation', m.fam, 'A', m.m, 'mechanical'); continue; }
        m = infA.find(d => d.re.test(line));
        if (m) { push('inference', m.fam, 'A', m.m, 'mechanical'); continue; }
        // Tier B gated calls.
        let gm = reGenerate.exec(line);
        if (gm) { push('generation', fam, 'B', '.generate', 'heuristic', gm[1] + '.generate'); continue; }
        if (!rePredictDef.test(line) && !isTest) {
          const pm = rePredict.exec(line);
          if (pm) { push('inference', fam, 'B', pm[2] ? '.predict_proba' : '.predict', 'heuristic', pm[1] + (pm[2] ? '.predict_proba' : '.predict')); continue; }
        }
        if (hasTransformers && rePipeline.test(line)) {
          const mm = rePipeline.exec(line);
          const { id, resolved } = this._extractCallId(line, mm.index, lines, i, 'model');
          push('inference', HF, 'B', 'pipeline', 'heuristic', null, id, resolved); continue;
        }
        if (hasTorch) { const em = reEval.exec(line); if (em) { push('inference', PT, 'B', 'model.eval', 'heuristic', em[1] + '.eval'); continue; } }
        // Tier C sampling params — only if the file has a generation marker.
        if (fileHasGen) {
          const cm = reParam.exec(line);
          if (cm) { push('generation', fam, 'C', cm[1], 'heuristic'); continue; }
        }
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(t =>
        (t.name || '').toLowerCase().includes(pat) || (t.filepath || '').toLowerCase().includes(pat)
        || (t.family || '').toLowerCase().includes(pat) || (t.kind || '').toLowerCase().includes(pat)
        || (t.marker || '').toLowerCase().includes(pat) || (t.snippet || '').toLowerCase().includes(pat));
    }
    const kindRank = { 'generation': 0, 'inference': 1 };
    result.sort((a, b) =>
      a.family.localeCompare(b.family) || (kindRank[a.kind] - kindRank[b.kind])
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * _resolveLiteral(lines, ident, beforeLine) — same-file variable→literal
   * resolver (#110 step 2 foundation, shared across the name-extracting cells).
   * Given an identifier used at `beforeLine`, find its string-literal value via a
   * lexical scan (no AST, no import graph):
   *   - direct assignment `VAR = "lit"` / `VAR: "lit"` — nearest assignment before
   *     the use site, whole-file last assignment as fallback;
   *   - argparse default — `add_argument('--x', …, default="lit")` (for `args.x` /
   *     `self.x` forms, and as a fallback for bare idents matching a flag).
   * For dotted idents (`args.model`) the argparse default is tried first; for plain
   * idents the direct assignment is tried first. Returns the literal or null
   * (cross-file constants / computed values stay unresolved — no guessing).
   */
  _resolveLiteral(lines, ident, beforeLine) {
    if (!ident) return null;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dotted = ident.includes('.');
    const attr = dotted ? ident.split('.').pop() : ident;

    const argparseDefault = () => {
      // add_argument(...) often spans lines (the flag, then `default=` below), so
      // accumulate the call across lines until its parens close (cap 8) before
      // looking for `default="lit"`.
      const flagRe = new RegExp('add_argument\\(\\s*["\']--?' + esc(attr) + '["\']', 'i');
      const defRe = /default\s*=\s*(["'`])([^"'`]+)\1/;
      for (let k = 0; k < lines.length; k++) {
        if (!flagRe.test(lines[k] || '')) continue;
        let depth = 0, buf = '';
        for (let j = k; j < lines.length && j < k + 8; j++) {
          const ln = lines[j] || '';
          buf += ' ' + ln;
          for (const ch of ln) { if (ch === '(') depth++; else if (ch === ')') depth--; }
          if (depth <= 0) break;
        }
        const m = defRe.exec(buf);
        if (m) return m[2];
      }
      return null;
    };
    const directAssign = () => {
      const assignRe = new RegExp('\\b' + esc(attr) + '\\s*[:=]\\s*(["\'`])([^"\'`]+)\\1');
      let prior = null, priorLine = -1, anyLast = null, anyLine = -1;
      for (let k = 0; k < lines.length; k++) {
        const m = assignRe.exec(lines[k] || '');
        if (!m) continue;
        if (k < beforeLine && k > priorLine) { prior = m[2]; priorLine = k; }
        if (k > anyLine) { anyLast = m[2]; anyLine = k; }
      }
      return prior != null ? prior : anyLast;
    };

    return dotted ? (argparseDefault() || directAssign()) : (directAssign() || argparseDefault());
  }

  /**
   * _extractCallId(line, afterIdx, lines, useLine, idArg) — pull an id argument
   * from a call (#110 step 2, shared by embeddings/inference). `idArg`: 'pos' =
   * the first positional string; otherwise a `|`-list of keyword names (e.g.
   * 'model' or 'index_name|collection_name'). Quoted literal → {id, resolved:true};
   * identifier → resolved via _resolveLiteral (or {id:'<v>', resolved:false} when
   * unresolvable); nothing found → {id:null, resolved:true}.
   */
  _extractCallId(line, afterIdx, lines, useLine, idArg) {
    const open = line.indexOf('(', afterIdx);
    if (open < 0) return { id: null, resolved: true };
    const seg = line.slice(open + 1, open + 1 + 200);
    const resolveIdent = (id) => {
      const lit = this._resolveLiteral(lines, id, useLine);
      return lit != null ? { id: lit, resolved: true } : { id: '<' + id + '>', resolved: false };
    };
    if (idArg === 'pos') {
      const qm = seg.match(/^\s*["'`]([^"'`]+)["'`]/);
      if (qm) return { id: qm[1], resolved: true };
      const im = seg.match(/^\s*([A-Za-z_$][\w.$]*)\s*[,)]/);
      if (im) return resolveIdent(im[1]);
      return { id: null, resolved: true };
    }
    const km = seg.match(new RegExp('\\b(?:' + idArg + ')\\s*=\\s*(\\S+)'));
    if (km) {
      const q = km[1].match(/^["'`]([^"'`]+)["'`]/);
      if (q) return { id: q[1], resolved: true };
      const idm = km[1].match(/^([A-Za-z_$][\w.$]*)/);
      if (idm) return resolveIdent(idm[1]);
    }
    return { id: null, resolved: true };
  }

  /**
   * listLlmCalls(filter) — the LLM-USE invocation layer (#103): where code issues
   * a completion/chat request to an LLM. Companion to Prompts (authored input);
   * NOT #101 Inference (low-level local generate), NOT Artifacts (load), NOT hooks
   * (shell automation). First cross-language app unit (JS/TS + Python).
   *
   *   Tier A [mechanical] — provider-specific SDK markers (call / client / wrapper).
   *   Tier B [heuristic]  — generic verbs (.invoke/.chat/.complete), gated on a
   *                         LangChain/LlamaIndex or SDK import.
   *   Tier C [heuristic]  — endpoint URLs in string literals (api.anthropic.com,
   *                         /v1/messages, …) — catches raw fetch/requests/axios
   *                         callers that bypass the SDK (CodeExam's remote path).
   *
   * `.md`/`.rst` docs skipped (#102).
   */
  listLlmCalls(filter = null) {
    const tierA = [
      // calls — chat.completions.create BEFORE completions.create (substring).
      { re: /\bmessages\.create\s*\(/,            prov: 'Anthropic', kind: 'call',   m: 'messages.create' },
      { re: /\bmessages\.stream\s*\(/,            prov: 'Anthropic', kind: 'call',   m: 'messages.stream' },
      { re: /\bchat\.completions\.create\s*\(/,   prov: 'OpenAI',    kind: 'call',   m: 'chat.completions.create' },
      { re: /\bcompletions\.create\s*\(/,         prov: 'OpenAI',    kind: 'call',   m: 'completions.create' },
      { re: /\bresponses\.create\s*\(/,           prov: 'OpenAI',    kind: 'call',   m: 'responses.create' },
      { re: /\bgenerate_content\s*\(/,            prov: 'Google',    kind: 'call',   m: 'generate_content' },
      { re: /\bcreate_chat_completion\s*\(/,      prov: 'local',     kind: 'call',   m: 'create_chat_completion' },
      { re: /\bcreate_completion\s*\(/,           prov: 'local',     kind: 'call',   m: 'create_completion' },
      { re: /\bco\.chat\s*\(/,                    prov: 'Cohere',    kind: 'call',   m: 'co.chat' },
      { re: /\bLlamaChatSession\s*\(/,            prov: 'local',     kind: 'call',   m: 'LlamaChatSession', lvc: true },
      // clients — NO space before `(` (an instantiation `OpenAI(api_key=…)`),
      // so "OpenAI (Inc.)" in a LICENSE/EULA prose line does NOT match.
      { re: /\b(?:Async)?Anthropic\(/,            prov: 'Anthropic', kind: 'client', m: 'Anthropic()' },
      { re: /\b(?:Async)?OpenAI\(/,               prov: 'OpenAI',    kind: 'client', m: 'OpenAI()' },
      { re: /\bgenai\.GenerativeModel\s*\(/,      prov: 'Google',    kind: 'client', m: 'GenerativeModel()' },
      { re: /\bMistralClient\s*\(/,               prov: 'Mistral',   kind: 'client', m: 'MistralClient()' },
      // wrappers (LangChain / LlamaIndex)
      { re: /\bChat(?:Anthropic|OpenAI|GoogleGenerativeAI|VertexAI|Bedrock|MistralAI|Cohere)\b/, prov: 'LangChain', kind: 'wrapper', m: 'ChatXxx' },
    ];
    const reInvoke = /\.(a?invoke)\s*\(/;
    const reChatComplete = /\.(chat|complete)\s*\(/;
    const reEndpoint = /(api\.anthropic\.com|\/v1\/messages|api\.openai\.com|\/v1\/chat\/completions|generativelanguage\.googleapis\.com|api\.cohere\.ai|api\.mistral\.ai|api\.together\.xyz|api\.groq\.com)/;
    const endpointProv = (u) =>
      /anthropic/.test(u) || /v1\/messages/.test(u) ? 'Anthropic'
      : /openai|chat\/completions/.test(u) ? 'OpenAI'
      : /googleapis/.test(u) ? 'Google' : /cohere/.test(u) ? 'Cohere'
      : /mistral/.test(u) ? 'Mistral' : 'other';
    const reDocFile = /\.(?:md|markdown|mdx|rst)$/i;
    const reComment = (t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');

    // #110 step 1 — literal-only model-identity extraction at the call/client site.
    // Covers `model=` / `model_name=` / `model_id=` / `model_path=` (hosted + HF +
    // llama.cpp) and the positional first string of GenerativeModel()/Llama(). A
    // quoted value is a literal (modelResolved:true); a bare identifier is shown as
    // `<var>` (modelResolved:false) — variable→literal resolution is step 2 (#96
    // resolver). Window: the marker line, extended over following lines only while
    // the call's parens stay open (cap 8 lines), so it can't bleed into the next
    // statement.
    const reModelKw = /\bmodel(?:_name|_id|_path)?\s*[:=]\s*(?:(["'`])([^"'`]+)\1|([A-Za-z_$][\w.$]*))/;
    const reFirstStr = /\(\s*(["'`])([^"'`]+)\1/;
    const extractModel = (lines, startIdx, marker) => {
      let depth = 0, started = false, buf = lines[startIdx] || '';
      for (const ch of buf) { if (ch === '(') { depth++; started = true; } else if (ch === ')') depth--; }
      if (started && depth > 0) {
        for (let k = startIdx + 1; k < lines.length && k < startIdx + 8; k++) {
          const ln = lines[k] || '';
          buf += ' ' + ln;
          for (const ch of ln) { if (ch === '(') depth++; else if (ch === ')') depth--; }
          if (depth <= 0) break;
        }
      }
      const kw = reModelKw.exec(buf);
      if (kw) {
        if (kw[2] != null) return { model: kw[2].slice(0, 80), modelResolved: true };
        if (kw[3] != null) {
          const lit = this._resolveLiteral(lines, kw[3], startIdx);
          if (lit != null) return { model: lit.slice(0, 80), modelResolved: true };
          return { model: '<' + kw[3] + '>', modelResolved: false };
        }
      }
      if (marker === 'Llama()' || marker === 'GenerativeModel()') {
        const p = reFirstStr.exec(buf);
        if (p) return { model: p[2].slice(0, 80), modelResolved: true };
      }
      return { model: null, modelResolved: false };
    };

    const out = [];
    for (const [filepath, lines] of this.fileLines) {
      if (reDocFile.test(filepath)) continue;
      const hasLangchain = lines.some(l => /\b(?:import|from|require)\b/.test(l) && /\b(?:langchain|llama_index|llamaindex|llamaIndex|@langchain)\b/.test(l));
      const hasSDK = lines.some(l => /\b(?:import|from|require)\b/.test(l) && /\b(?:anthropic|openai|cohere|mistralai|generativeai|node-llama-cpp|@anthropic-ai|together|groq)\b/.test(l));
      // llama-cpp-python: `from llama_cpp import Llama; llm = Llama(model_path=…)`.
      // `Llama(` (the instantiation) is the client; gate on the import so it
      // can't collide with an unrelated `Llama` class. (Direct calls `llm(...)`
      // are a generic verb → recall gap, tracked in #98.)
      const hasLlamaCpp = lines.some(l => /\b(?:from|import)\s+llama_cpp\b/.test(l));

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();
        if (reComment(trimmed)) continue;
        const push = (kind, prov, tier, marker, tag, lvc) => {
          const { model, modelResolved } = extractModel(lines, i, marker);
          out.push({ name: marker, filepath, line: i + 1, kind, provider: prov, tier, marker, tag, lvc: !!lvc, model, modelResolved, snippet: trimmed.slice(0, 200) });
        };

        // Tier A — provider-specific (first match wins).
        const a = tierA.find(d => d.re.test(line));
        if (a) { push(a.kind, a.prov, 'A', a.m, 'mechanical', a.lvc); continue; }
        // llama-cpp-python client (gated on its import).
        if (hasLlamaCpp && /\bLlama\(/.test(line)) { push('client', 'local', 'A', 'Llama()', 'mechanical'); continue; }
        // Tier B — gated generic verbs.
        if (hasLangchain) { const im = reInvoke.exec(line); if (im) { push('call', 'LangChain', 'B', '.' + im[1], 'heuristic'); continue; } }
        if (hasSDK) { const cm = reChatComplete.exec(line); if (cm) { push('call', 'SDK', 'B', '.' + cm[1], 'heuristic'); continue; } }
        // Tier C — endpoint URLs in string literals.
        const em = reEndpoint.exec(line);
        if (em) { push('endpoint', endpointProv(em[1]), 'C', em[1], 'heuristic'); continue; }
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(t =>
        (t.name || '').toLowerCase().includes(pat) || (t.filepath || '').toLowerCase().includes(pat)
        || (t.provider || '').toLowerCase().includes(pat) || (t.kind || '').toLowerCase().includes(pat)
        || (t.marker || '').toLowerCase().includes(pat) || (t.snippet || '').toLowerCase().includes(pat));
    }
    const kindRank = { 'call': 0, 'client': 1, 'wrapper': 2, 'endpoint': 3 };
    result.sort((a, b) =>
      a.provider.localeCompare(b.provider) || (kindRank[a.kind] - kindRank[b.kind])
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * listTools(filter) — the function-calling / tool layer (#104). `@tool` is
   * LangChain-only; most tools are SCHEMAS (input_schema/inputSchema) and MCP
   * registrations, so three sub-kinds:
   *   tool-def      — @tool / FunctionTool / StructuredTool / input_schema (a tool
   *                   the model can use)
   *   mcp           — setRequestHandler / server.tool / @mcp.tool / McpServer /
   *                   defineChatSessionFunction (node-llama-cpp, library-vs-consumer)
   *   tool-dispatch — tool_use / tool_calls / function_call (handling the model's
   *                   tool request)
   * Generic markers (inputSchema, tools=[…], tool_calls, function_call) are gated
   * on the file being LLM/agent/MCP code. Skips .md/.rst (#102).
   */
  listTools(filter = null) {
    // Tier A — specific, ungated.
    const tierA = [
      { re: /^@(?:tool|tool_plain|function_tool)\b/, kind: 'tool-def', fw: 'LangChain',  m: '@tool' },
      { re: /^@agent\.tool\b/,                       kind: 'tool-def', fw: 'pydantic-ai', m: '@agent.tool' },
      { re: /^@mcp\.tool\b/,                          kind: 'mcp',      fw: 'MCP',        m: '@mcp.tool' },
      { re: /\bStructuredTool\b/,                     kind: 'tool-def', fw: 'LangChain',  m: 'StructuredTool' },
      { re: /\bFunctionTool\b/,                       kind: 'tool-def', fw: 'LangChain/LlamaIndex', m: 'FunctionTool' },
      { re: /\binput_schema\b/,                       kind: 'tool-def', fw: '?',          m: 'input_schema' },  // #119: ambiguous (Anthropic API, MCP, Codex Rust) — not Anthropic-specific
      { re: /\bsetRequestHandler\b/,                  kind: 'mcp',      fw: 'MCP',        m: 'setRequestHandler' },
      { re: /\b(?:ListTools|CallTool)Request(?:Schema)?\b/, kind: 'mcp', fw: 'MCP',       m: 'MCP-request' },
      { re: /\bserver\.tool\s*\(/,                    kind: 'mcp',      fw: 'MCP',        m: 'server.tool' },
      { re: /\bMcpServer\b/,                          kind: 'mcp',      fw: 'MCP',        m: 'McpServer' },
      { re: /\bdefineChatSessionFunction\b/,          kind: 'mcp',      fw: 'node-llama-cpp', m: 'defineChatSessionFunction', lvc: true },
      { re: /\btool_use\b/,                           kind: 'tool-dispatch', fw: 'Anthropic', m: 'tool_use' },
    ];
    // Tier B — generic, gated on fileHasLLM.
    const tierB = [
      { re: /\binputSchema\b/,                        kind: 'tool-def',      fw: 'MCP',    m: 'inputSchema' },
      { re: /\btools\s*[=:]\s*\[/,                    kind: 'tool-def',      fw: '?',      m: 'tools=[]' },
      { re: /\btool_calls\b/,                         kind: 'tool-dispatch', fw: 'OpenAI', m: 'tool_calls' },
      { re: /\bfunction_call\b/,                      kind: 'tool-dispatch', fw: 'OpenAI', m: 'function_call' },
    ];
    const reDocFile = /\.(?:md|markdown|mdx|rst)$/i;
    const reComment = (t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');

    // Best-effort tool-NAME extraction (a name beats a bare marker like
    // "input_schema"). Covers the real forms: same-line `tools=["Read","Edit"]`
    // / `tools:[noopTool]`; `@tool("name")` or `@tool` → next `def NAME`;
    // multi-line `tools = [ {"name": "internet_search"}, … ]`; and a `"name":`
    // sibling near input_schema/inputSchema. Returns '' if nothing clean.
    const extractToolName = (d, line, lines, i) => {
      const reName = /["']?name["']?\s*:\s*["']([^"']+)["']/;
      if (d.m === '@tool' || d.m === '@agent.tool' || d.m === '@mcp.tool') {
        const am = line.match(/@[\w.]+\(\s*["']([^"']+)["']/);
        if (am) return am[1];
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const dm = (lines[j] || '').match(/^\s*(?:async\s+)?def\s+(\w+)/);
          if (dm) return dm[1];
        }
        return '';
      }
      if (d.m === 'tools=[]') {
        const inl = line.match(/tools\s*[=:]\s*\[([^\]]+)\]/);
        if (inl && inl[1].trim()) {
          const names = []; const re = /["']([^"'\s,]+)["']|\b([A-Za-z_]\w*)\b/g; let mm;
          while ((mm = re.exec(inl[1])) !== null) { const n = mm[1] || mm[2]; if (n) names.push(n); }
          if (names.length) return names.slice(0, 6).join(', ');
        }
        const names = [];   // multi-line array → collect "name": fields until ]/)
        for (let j = i; j < Math.min(i + 40, lines.length); j++) {
          const nm = (lines[j] || '').match(reName); if (nm) names.push(nm[1]);
          if (j > i && /^\s*[\]\)]/.test(lines[j] || '')) break;
        }
        return names.length ? names.slice(0, 6).join(', ') : '';
      }
      if (d.m === 'input_schema' || d.m === 'inputSchema') {
        for (let j = Math.max(0, i - 4); j < Math.min(i + 5, lines.length); j++) {
          const nm = (lines[j] || '').match(reName); if (nm) return nm[1];
        }
        return '';
      }
      if (d.kind === 'mcp') { const sm = line.match(/["']([A-Za-z_][\w\- ]{1,40})["']/); if (sm) return sm[1]; }
      return '';
    };

    const out = [];
    for (const [filepath, lines] of this.fileLines) {
      if (reDocFile.test(filepath)) continue;
      const fileHasLLM =
        lines.some(l => /\b(?:anthropic|openai|langchain|llama_index|llamaindex|cohere|mistralai|generativeai|node-llama-cpp|@anthropic-ai|@langchain|modelcontextprotocol|dspy|crewai|autogen|smolagents)\b/i.test(l))
        || lines.some(l => /\b(?:messages\.create|chat\.completions\.create|tool_use|input_schema|setRequestHandler|defineChatSessionFunction)\b/.test(l));

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();
        if (reComment(trimmed)) continue;
        const push = (d, tier, tag) =>
          out.push({ name: extractToolName(d, line, lines, i), filepath, line: i + 1, kind: d.kind, framework: d.fw, tier, marker: d.m, tag, lvc: !!d.lvc, snippet: trimmed.slice(0, 200) });

        const a = tierA.find(d => d.re.test(trimmed));
        if (a) { push(a, 'A', 'mechanical'); continue; }
        if (fileHasLLM) {
          const b = tierB.find(d => d.re.test(trimmed));
          if (b) { push(b, 'B', 'heuristic'); continue; }
        }
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(t =>
        (t.name || '').toLowerCase().includes(pat) || (t.filepath || '').toLowerCase().includes(pat)
        || (t.framework || '').toLowerCase().includes(pat) || (t.kind || '').toLowerCase().includes(pat)
        || (t.marker || '').toLowerCase().includes(pat) || (t.snippet || '').toLowerCase().includes(pat));
    }
    const kindRank = { 'tool-def': 0, 'mcp': 1, 'tool-dispatch': 2 };
    result.sort((a, b) =>
      (a.framework || '').localeCompare(b.framework || '') || (kindRank[a.kind] - kindRank[b.kind])
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * listChains(filter) — composition / orchestration (#105). Detects FRAMEWORK
   * primitives (LangChain / LangGraph / DSPy / CrewAI / AutoGen / LlamaIndex).
   * Hand-rolled agent loops (cli.js, openclaw) are structurally invisible and
   * correctly show ~0 — the GUI/CLI carries a SCOPE CAPTION (#106) so a 0 isn't
   * misread as "no agent here". LCEL `|` is mechanically invisible (RunnableSequence
   * catches its compiled form). Three sub-kinds: chain / graph / agent.
   */
  listChains(filter = null) {
    const tierA = [
      { re: /\bLLMChain\b/,             kind: 'chain', fw: 'LangChain', m: 'LLMChain' },
      { re: /\bSequentialChain\b/,      kind: 'chain', fw: 'LangChain', m: 'SequentialChain' },
      { re: /\bConversationChain\b/,    kind: 'chain', fw: 'LangChain', m: 'ConversationChain' },
      { re: /\bRetrievalQA\b/,          kind: 'chain', fw: 'LangChain', m: 'RetrievalQA' },
      { re: /\bcreate_\w*chain\b/,      kind: 'chain', fw: 'LangChain', m: 'create_*_chain' },
      { re: /\bRunnable(?:Sequence|Passthrough|Parallel|Lambda)\b/, kind: 'chain', fw: 'LangChain', m: 'Runnable*' },
      { re: /\bChainOfThought\b/,       kind: 'chain', fw: 'DSPy', m: 'ChainOfThought' },
      { re: /\bdspy\.Module\b/,         kind: 'chain', fw: 'DSPy', m: 'dspy.Module' },
      { re: /\bStateGraph\b/,           kind: 'graph', fw: 'LangGraph', m: 'StateGraph' },
      { re: /\badd_conditional_edges\b/, kind: 'graph', fw: 'LangGraph', m: 'add_conditional_edges' },
      { re: /\bMessagesState\b/,        kind: 'graph', fw: 'LangGraph', m: 'MessagesState' },
      { re: /\bAgentExecutor\b/,        kind: 'agent', fw: 'LangChain', m: 'AgentExecutor' },
      { re: /\bcreate_\w*_agent\b/,     kind: 'agent', fw: 'LangChain', m: 'create_*_agent' },
      { re: /\binitialize_agent\b/,     kind: 'agent', fw: 'LangChain', m: 'initialize_agent' },
      { re: /\b(?:Code|ToolCalling)Agent\b/, kind: 'agent', fw: 'smolagents', m: 'CodeAgent' },
      { re: /\b(?:Assistant|UserProxy)Agent\b/, kind: 'agent', fw: 'AutoGen', m: 'AssistantAgent' },
      { re: /\bGroupChat\b/,            kind: 'agent', fw: 'AutoGen', m: 'GroupChat', gate: 'autogen' },
      { re: /\b(?:ReActAgent|AgentRunner|FunctionAgent)\b/, kind: 'agent', fw: 'LlamaIndex', m: 'ReActAgent' },
      { re: /\bReAct\b/,                kind: 'agent', fw: 'DSPy', m: 'ReAct' },   // case-sensitive ≠ React
    ];
    const reGraphGen = /\badd_(?:node|edge)\s*\(/;          // generic graph terms
    const reAgentGen = /\b(?:Agent|Crew|Task)\s*\(/;        // generic agent ctors
    const reDocFile = /\.(?:md|markdown|mdx|rst)$/i;
    const reComment = (t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');
    const reAssign = /^(\w+)\s*=/;

    // Hand-rolled agent heuristic (#98): a bespoke agent has no framework
    // primitive — it's a module that LOOPS over an LLM CALL while DISPATCHING
    // tool calls. Detected at FILE level (call + dispatch + loop all present in
    // one file, no framework marker). This is meaningful only when files are
    // real modules — a single minified bundle is degenerate (everything
    // co-occurs), so it needs a bundle-seam-split or multi-file index. One flag
    // per file. Tier C, clearly heuristic.
    const reLoop = /\bwhile\s*\(|\bfor\s*\(|for\s+await|\bdo\s*\{/;
    // SDK calls + raw-HTTP endpoints (#118) — a framework-less agent (Moltbook)
    // calls the LLM via an endpoint URL, which listLlmCalls catches as Tier-C; the
    // hand-rolled gate (call + dispatch + loop) needs to see that as a "call" too.
    const reCall = /\bmessages\.create|chat\.completions\.create|\bcompletions\.create|\.generate\s*\(|create_chat_completion|api\.anthropic\.com|\/v1\/messages|api\.openai\.com|\/v1\/chat\/completions|generativelanguage\.googleapis\.com|api\.cohere\.ai|api\.mistral\.ai|api\.together\.xyz|api\.groq\.com/;
    const reDisp = /\btool_use\b|\btool_calls\b|\bfunction_call\b|\btool_result\b|toolResult/;

    const out = [];
    for (const [filepath, lines] of this.fileLines) {
      if (reDocFile.test(filepath)) continue;
      const hasLanggraph = lines.some(l => /\b(?:import|from)\s+langgraph\b|\blanggraph\b/.test(l));
      const hasAgentFw = lines.some(l => /\b(?:crewai|pydantic_ai|smolagents|autogen|llama_index|openai[._-]?agents)\b/i.test(l));
      // #120: GroupChat collides with messaging "group chat" (OpenClaw/Feishu) —
      // gate that marker on an autogen import in-file.
      const hasAutogen = lines.some(l => /\b(?:import|from|require)\b/i.test(l) && /\b(?:autogen|pyautogen|ag2)\b/i.test(l));
      let frameworkInFile = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();
        if (reComment(trimmed)) continue;
        const nameOf = (m) => { const am = trimmed.match(reAssign); return am ? am[1] : m; };
        const push = (kind, fw, tier, m, tag) =>
          out.push({ name: nameOf(m), filepath, line: i + 1, kind, framework: fw, tier, marker: m, tag, snippet: trimmed.slice(0, 200) });

        const a = tierA.find(d => d.re.test(line) && !(d.gate === 'autogen' && !hasAutogen));
        if (a) { frameworkInFile = true; push(a.kind, a.fw, 'A', a.m, 'mechanical'); continue; }
        if (hasLanggraph && reGraphGen.test(line)) { frameworkInFile = true; push('graph', 'LangGraph', 'B', 'add_node/edge', 'heuristic'); continue; }
        if (hasAgentFw && reAgentGen.test(line)) { frameworkInFile = true; push('agent', 'CrewAI/…', 'B', 'Agent()/Crew()', 'heuristic'); continue; }
      }

      // Hand-rolled agent pass — file-level co-occurrence, non-framework files only.
      if (!frameworkInFile) {
        let callLine = -1, hasDisp = false, hasLoop = false;
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i] || '';
          if (callLine < 0 && reCall.test(l)) callLine = i;
          if (!hasDisp && reDisp.test(l)) hasDisp = true;
          if (!hasLoop && reLoop.test(l)) hasLoop = true;
        }
        if (callLine >= 0 && hasDisp && hasLoop) {
          out.push({ name: 'hand-rolled agent', filepath, line: callLine + 1, kind: 'agent', framework: 'hand-rolled', tier: 'C', marker: 'call+dispatch+loop', tag: 'heuristic', snippet: (lines[callLine] || '').trimStart().slice(0, 200) });
        }
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(t =>
        (t.name || '').toLowerCase().includes(pat) || (t.filepath || '').toLowerCase().includes(pat)
        || (t.framework || '').toLowerCase().includes(pat) || (t.kind || '').toLowerCase().includes(pat)
        || (t.marker || '').toLowerCase().includes(pat) || (t.snippet || '').toLowerCase().includes(pat));
    }
    const kindRank = { 'chain': 0, 'graph': 1, 'agent': 2 };
    result.sort((a, b) =>
      (a.framework || '').localeCompare(b.framework || '') || (kindRank[a.kind] - kindRank[b.kind])
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * listEmbeddings(filter) — Embeddings & Vector Search (#109). RAG-AGNOSTIC: a
   * general capability (semantic search, clustering, dedup, recommendation), not
   * RAG-only. RAG = this cell's `search`/`vector-store` + #103 LLM call,
   * co-occurring (a derived Phase-2 signal, not detected here). Five sub-kinds:
   *   embedding / vector-store / search / chunking / distance.
   * Distance measures are co-occurrence-gated on an embedding/vector marker
   * (sklearn euclidean ×486 / transformers dot_product ×66 are clustering/
   * attention, NOT this). `.encode`/`Chroma`/`.query` gated. Skips .md/.rst (#102).
   */
  listEmbeddings(filter = null) {
    const tierA = [
      // embedding (any purpose) — idArg: which call arg carries the model id.
      { re: /\bOpenAIEmbeddings\b/,        kind: 'embedding', fw: 'OpenAI', m: 'OpenAIEmbeddings', idArg: 'model' },
      { re: /\bHuggingFaceEmbeddings\b/,   kind: 'embedding', fw: 'HF', m: 'HuggingFaceEmbeddings', idArg: 'model_name' },
      { re: /\bCohereEmbeddings\b/,        kind: 'embedding', fw: 'Cohere', m: 'CohereEmbeddings', idArg: 'model' },
      { re: /\bSentenceTransformer\b/,     kind: 'embedding', fw: 'sentence-transformers', m: 'SentenceTransformer', idArg: 'pos' },
      { re: /\bembed_query\b/,             kind: 'embedding', fw: 'LangChain', m: 'embed_query' },
      { re: /\bembed_documents\b/,         kind: 'embedding', fw: 'LangChain', m: 'embed_documents' },
      { re: /\bembeddings\.create\b/,      kind: 'embedding', fw: 'OpenAI', m: 'embeddings.create', idArg: 'model' },
      // vector-store — idArg: the index/collection name where the ctor takes one.
      { re: /\bFAISS\b/,                   kind: 'vector-store', fw: 'FAISS', m: 'FAISS' },
      { re: /\bPinecone\b/,                kind: 'vector-store', fw: 'Pinecone', m: 'Pinecone', idArg: 'index_name' },
      { re: /\bQdrant\b/,                  kind: 'vector-store', fw: 'Qdrant', m: 'Qdrant', idArg: 'collection_name' },
      { re: /\bWeaviate\b/,                kind: 'vector-store', fw: 'Weaviate', m: 'Weaviate', idArg: 'index_name|class_name' },
      { re: /\bMilvus\b/,                  kind: 'vector-store', fw: 'Milvus', m: 'Milvus', idArg: 'collection_name|collection' },
      { re: /\bLanceDB\b/,                 kind: 'vector-store', fw: 'LanceDB', m: 'LanceDB' },
      { re: /\bpgvector\b/,                kind: 'vector-store', fw: 'pgvector', m: 'pgvector' },
      { re: /\bVectorStore\b/,            kind: 'vector-store', fw: 'LangChain', m: 'VectorStore' },
      { re: /\bIndexFlat(?:L2|IP)\b/,      kind: 'vector-store', fw: 'FAISS', m: 'IndexFlat' },
      // search / retrieval
      { re: /\bsimilarity_search(?:_with_score)?\b/, kind: 'search', fw: 'LangChain', m: 'similarity_search' },
      { re: /\bmax_marginal_relevance_search\b/,     kind: 'search', fw: 'LangChain', m: 'mmr_search' },
      { re: /\bas_retriever\b/,            kind: 'search', fw: 'LangChain', m: 'as_retriever' },
      { re: /\bsemantic_search\b/,         kind: 'search', fw: '?', m: 'semantic_search' },
      // chunking (RAG-flavored document prep)
      { re: /\b(?:Recursive)?CharacterTextSplitter\b/, kind: 'chunking', fw: 'LangChain', m: 'TextSplitter' },
      { re: /\bTokenTextSplitter\b/,       kind: 'chunking', fw: 'LangChain', m: 'TokenTextSplitter' },
      { re: /\bsplit_documents\b/,         kind: 'chunking', fw: 'LangChain', m: 'split_documents' },
      { re: /\bsplit_text\b/,              kind: 'chunking', fw: 'LangChain', m: 'split_text' },
      { re: /\bchunk_overlap\b/,           kind: 'chunking', fw: '?', m: 'chunk_overlap' },
    ];
    const reEmbAny = /\bOpenAIEmbeddings\b|\bHuggingFaceEmbeddings\b|\bCohereEmbeddings\b|\bSentenceTransformer\b|\bembed_query\b|\bembed_documents\b|\bembeddings\.create\b/;
    const reVecAny = /\bFAISS\b|\bPinecone\b|\bQdrant\b|\bWeaviate\b|\bMilvus\b|\bLanceDB\b|\bpgvector\b|\bVectorStore\b|\bIndexFlat(?:L2|IP)\b|\bchromadb\b/;
    const reEncode = /\.encode\s*\(/;
    const reChroma = /\bChroma\b|\bchromadb\b/;
    const reVecOp = /\.query\s*\(|\.search\s*\(|\.upsert\s*\(/;
    // Distance measures are co-occurrence-gated (below), so the set can be
    // comprehensive without FP risk — these are heavily used in plain ML
    // (clustering/classification), but only count alongside an embedding/vector
    // marker. cityblock = Manhattan (scipy); centroid is clustering-flavored.
    const reDistance = /\bcosine_similarity\b|\bcosine_distance\b|\beuclidean(?:_distance)?\b|\bdot_product\b|\binner_product\b|\bmanhattan\b|\bcityblock\b|\bjaccard\b|\bminkowski\b|\bhamming\b|\bchebyshev\b|\bmahalanobis\b|\bcentroid\b|\bl2_distance\b|\bdistance_metric\b|\bmetric\s*=\s*["']cosine/;
    const reDocFile = /\.(?:md|markdown|mdx|rst)$/i;
    const reComment = (t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');

    const out = [];
    for (const [filepath, lines] of this.fileLines) {
      if (reDocFile.test(filepath)) continue;
      const hasST = lines.some(l => /\b(?:import|from)\s+sentence_transformers\b/.test(l));
      const hasChromadb = lines.some(l => /\bchromadb\b/i.test(l) || (/\b(?:import|from)\b/.test(l) && /\bChroma\b/.test(l)));
      const embFound = lines.some(l => reEmbAny.test(l));
      const vecFound = lines.some(l => reVecAny.test(l));

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();
        if (reComment(trimmed)) continue;
        const push = (kind, fw, tier, m, tag, id = null, resolved = true) =>
          out.push({ name: m, filepath, line: i + 1, kind, framework: fw, tier, marker: m, tag, id, resolved, snippet: trimmed.slice(0, 200) });

        const a = tierA.find(d => d.re.test(line));
        if (a) {
          let id = null, resolved = true;
          if (a.idArg) {
            const mm = a.re.exec(line);
            ({ id, resolved } = this._extractCallId(line, mm.index + mm[0].length, lines, i, a.idArg));
          }
          push(a.kind, a.fw, 'A', a.m, 'mechanical', id, resolved); continue;
        }
        // Tier B gated
        if (hasST && reEncode.test(line)) { push('embedding', 'sentence-transformers', 'B', '.encode', 'heuristic'); continue; }
        if (hasChromadb && reChroma.test(line)) {
          const mm = reChroma.exec(line);
          const { id, resolved } = this._extractCallId(line, mm.index + mm[0].length, lines, i, 'collection_name');
          push('vector-store', 'Chroma', 'B', 'Chroma', 'heuristic', id, resolved); continue;
        }
        if (vecFound && reVecOp.test(line)) { push('search', '?', 'B', 'query/search', 'heuristic'); continue; }
        // Tier C — distance, co-occurrence-gated on an embedding/vector marker
        if ((embFound || vecFound) && reDistance.test(line)) {
          const dm = (line.match(reDistance) || ['distance'])[0].trim();
          push('distance', '?', 'C', dm.slice(0, 20), 'heuristic'); continue;
        }
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(t =>
        (t.name || '').toLowerCase().includes(pat) || (t.filepath || '').toLowerCase().includes(pat)
        || (t.framework || '').toLowerCase().includes(pat) || (t.kind || '').toLowerCase().includes(pat)
        || (t.marker || '').toLowerCase().includes(pat) || (t.snippet || '').toLowerCase().includes(pat));
    }
    const kindRank = { 'embedding': 0, 'vector-store': 1, 'search': 2, 'chunking': 3, 'distance': 4 };
    result.sort((a, b) =>
      (kindRank[a.kind] - kindRank[b.kind]) || (a.framework || '').localeCompare(b.framework || '')
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * listModelsUsed(filter) — #110 step 3 capstone. A PROJECTION (not a marker
   * scan): harvests the model ids the per-cell detectors already extracted (step
   * 2), dedupes by id, and tags each api (hosted) vs local (loaded). Distinct from
   * listModels (#84, models DEFINED via class inheritance) — this is models USED.
   *
   *   - LLM-calls   `model`  → api, or local when provider==='local' (a GGUF path).
   *   - Artifacts   `path`   → local (loaded weights: from_pretrained/GGUF).
   *   - Embeddings  `id`     → api for OpenAI/Cohere, local for ST/HF (kind
   *                           'embedding' only — vector-store names aren't models).
   *   - Inference   `id`     → local (pipeline model).
   *
   * Only RESOLVED ids enter the deduped list; unresolved `<var>` sites are counted
   * and exposed as `result.unresolved` (#106 — disclosed, never silently dropped).
   * Returns the deduped array with `.unresolved` (count) attached.
   */
  listModelsUsed(filter = null) {
    this._ensureFunctionIndex();
    // Enclosing function for a (file, line) — innermost match — for the #115
    // drill-down (model → sites with function names → source).
    const funcAt = (fp, line) => {
      const funcs = (this.functionIndex && this.functionIndex[fp]) || {};
      let best = null, bestSpan = Infinity;
      for (const [name, info] of Object.entries(funcs)) {
        if (info.start <= line && line <= info.end && (info.end - info.start) < bestSpan) {
          bestSpan = info.end - info.start; best = info.base_name || name;
        }
      }
      return best;
    };

    const raw = [];
    const isUnresolved = (id, resolved) => resolved === false || (typeof id === 'string' && id.startsWith('<'));
    // Basename filesystem paths so ./models/x.gguf and x.gguf dedupe to one model;
    // HF hub ids (org/model) stay whole.
    const modelKey = (id) => {
      const looksPath = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(id)
        || /[\\/][^\\/]*\.(?:gguf|safetensors|onnx|ckpt|pth|pt|bin|h5)$/i.test(id);
      return looksPath ? (id.split(/[\\/]/).pop() || id) : id;
    };
    // Not every artifact is a MODEL — the artifacts cell also loads/saves
    // optimizer state, vocab, training args, configs, and bare suffixes. Gate
    // the projection so "models used" stays models, not all artifacts.
    const looksLikeModel = (id) => {
      if (!id || /[\s*{}=]/.test(id)) return false;            // prose / glob / template / kwarg fragment
      if (!/[a-z0-9]/i.test(id)) return false;                 // punctuation-only ("…")
      if (/^(?:cpu|cuda|mps|gpu|auto|none)(?::\d+)?$/i.test(id)) return false;   // device strings
      const base = id.split(/[\\/]/).pop();
      if (/^\./.test(base)) return false;                      // bare suffix (.bin, .h5) — on the BASENAME, so ./relative/paths survive
      if (/^(?:model|optimizer|scheduler|output|data|checkpoint|state|weights|none)$/i.test(base)) return false;  // bare generic word
      if (/\b(?:optimizer|scheduler|training_args|trainer_state|tokenizer|special_tokens|vocab|merges|corpus|rng_state|config)\b/i.test(base)) return false;  // non-model artifact files
      // #119: a bare .bin is a generic binary (test fixtures / blobs — file.bin,
      // x.bin, out.bin). Count it as a model only if the name carries a model
      // signal. Model-specific extensions (.gguf/.onnx/.safetensors/.ckpt/.pth/.h5)
      // are trusted as-is (handled above / kept).
      if (/\.bin$/i.test(base) && !/(?:model|weights?|adapter|checkpoint|ckpt|ggml|gguf|lora|pytorch|safetensors?)/i.test(base.replace(/\.bin$/i, ''))) return false;
      return true;
    };
    const add = (id, resolved, access, cell, marker, filepath, line) => {
      if (!looksLikeModel(id)) return;
      raw.push({ id, unresolved: isUnresolved(id, resolved), access, cell, marker, filepath, line });
    };

    for (const t of this.listLlmCalls())
      add(t.model, t.modelResolved, t.provider === 'local' ? 'local' : 'api', 'llm-call', t.marker, t.filepath, t.line);
    for (const a of this.listArtifacts())
      add(a.path, a.pathResolved, 'local', 'artifact', a.marker, a.filepath, a.line);
    for (const e of this.listEmbeddings())
      if (e.kind === 'embedding')
        add(e.id, e.resolved, (e.framework === 'OpenAI' || e.framework === 'Cohere') ? 'api' : 'local', 'embedding', e.marker, e.filepath, e.line);
    for (const inf of this.listInference())
      add(inf.id, inf.resolved, 'local', 'inference', inf.marker, inf.filepath, inf.line);

    const unresolved = raw.filter(r => r.unresolved).length;

    const byId = new Map();
    for (const r of raw) {
      if (r.unresolved) continue;                 // only concrete ids dedupe into models
      const key = modelKey(r.id);
      let m = byId.get(key);
      if (!m) { m = { model: key, access: r.access, cells: new Set(), sites: [], count: 0 }; byId.set(key, m); }
      if (m.access !== r.access) m.access = 'mixed';
      m.cells.add(r.cell);
      m.sites.push({ filepath: r.filepath, line: r.line, marker: r.marker, cell: r.cell, function: funcAt(r.filepath, r.line) });
      m.count++;
    }

    let result = [...byId.values()].map(m => ({ model: m.model, access: m.access, cells: [...m.cells], count: m.count, sites: m.sites }));
    if (filter) {
      const pat = filter.toLowerCase();
      result = result.filter(m =>
        m.model.toLowerCase().includes(pat) || m.access.includes(pat)
        || m.cells.join(',').toLowerCase().includes(pat));
    }
    const accessRank = { api: 0, local: 1, mixed: 2 };
    result.sort((a, b) =>
      (accessRank[a.access] - accessRank[b.access]) || (b.count - a.count) || a.model.localeCompare(b.model));
    result.unresolved = unresolved;
    return result;
  }

  /**
   * listStructuredOutput(filter) — the output-shaping LLM-use cell (#117): how the
   * code constrains an LLM's OUTPUT. Output-dual of Prompts; distinct from Tools
   * (#104, what the model can DO). Four sub-kinds:
   *   schema      — with_structured_output(Schema) / response_model=Schema (the
   *                 schema NAME is extracted as the identity)
   *   format      — response_format= / "json_object"|"json_schema" (API JSON mode)
   *   parser      — Pydantic/Json/Structured/OutputFixing OutputParser
   *   constrained — outlines / guidance (constrained decoding), gated on import
   * Bare BaseModel/Zod are NOT counted (1506 BaseModel in langchain alone). .md
   * skipped (#102).
   */
  listStructuredOutput(filter = null) {
    const reDocFile = /\.(?:md|markdown|mdx|rst)$/i;
    const reComment = (t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');
    const reWSO = /\bwith_structured_output\s*\(/;
    const reRespModel = /\bresponse_model\s*=\s*(?:["'`]([^"'`]+)["'`]|([A-Za-z_$][\w.$]*))/;
    const reRespFormat = /\bresponse_format\s*[=:]/;
    const reJsonMode = /["']json_object["']|["']json_schema["']/;
    const reParser = /\b(Pydantic|Json|Structured|OutputFixing)OutputParser\b/;
    const reConstrained = /\b(outlines|guidance)\s*[.(]/;
    // First arg of marker( …) — schema class ref or string, AS-IS (no resolution:
    // a schema name is a class identity, not a path/var to resolve).
    const firstArg = (line, fromIdx) => {
      const open = line.indexOf('(', fromIdx);
      if (open < 0) return null;
      const m = line.slice(open + 1, open + 121).match(/^\s*(?:["'`]([^"'`]+)["'`]|([A-Za-z_$][\w.$]*))/);
      return m ? (m[1] || m[2]) : null;
    };

    const out = [];
    for (const [filepath, lines] of this.fileLines) {
      if (reDocFile.test(filepath)) continue;
      const hasConstrainedImport = lines.some(l => /\b(?:import|from|require)\b/.test(l) && /\b(?:outlines|guidance)\b/.test(l));
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trimStart();
        if (reComment(trimmed)) continue;
        const push = (kind, fw, marker, tag, id = null) =>
          out.push({ name: id || marker, filepath, line: i + 1, kind, framework: fw, marker, tag, id, snippet: trimmed.slice(0, 200) });

        let mm = reWSO.exec(line);
        if (mm) { push('schema', 'LangChain', 'with_structured_output', 'mechanical', firstArg(line, mm.index)); continue; }
        const rm = line.match(reRespModel);
        if (rm) { push('schema', '?', 'response_model', 'mechanical', rm[1] || rm[2]); continue; }  // #119: response_model= is generic (instructor AND OpenAI SDK/pydantic)
        if (reRespFormat.test(line)) { push('format', 'OpenAI', 'response_format', 'mechanical'); continue; }
        if (reJsonMode.test(line)) { push('format', 'OpenAI', 'json-mode', 'mechanical'); continue; }
        const pm = line.match(reParser);
        if (pm) { push('parser', 'LangChain', pm[1] + 'OutputParser', 'mechanical'); continue; }
        if (hasConstrainedImport && reConstrained.test(line)) {
          push('constrained', 'outlines/guidance', (line.match(/\b(outlines|guidance)\b/) || [])[1] || 'constrained', 'heuristic'); continue;
        }
      }
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(t =>
        (t.name || '').toLowerCase().includes(pat) || (t.filepath || '').toLowerCase().includes(pat)
        || (t.kind || '').toLowerCase().includes(pat) || (t.framework || '').toLowerCase().includes(pat)
        || (t.marker || '').toLowerCase().includes(pat) || (t.snippet || '').toLowerCase().includes(pat));
    }
    const kindRank = { schema: 0, format: 1, parser: 2, constrained: 3 };
    result.sort((a, b) =>
      (kindRank[a.kind] - kindRank[b.kind]) || (a.framework || '').localeCompare(b.framework || '')
      || a.filepath.localeCompare(b.filepath) || a.line - b.line);
    return result;
  }

  /**
   * listPipelines(filter) — the connected-flow projection (#116). A PROJECTION,
   * not a marker scan: it harvests the per-cell detector hits, buckets them at TWO
   * granularities, classifies each bucket's pipeline SHAPE by which cells co-occur,
   * and threads the cell identities (model/dataset/schema names) through the stages.
   *
   * Granularity (file → leaf-folder fallback, Andrew's idea): file-level
   * co-occurrence is tight but fails on well-factored code that centralizes a
   * shared step across files (OpenClaw/Moltbook put the LLM call in one client
   * module). So a folder bucket = the LEAF folder (immediate dirname); a
   * folder-scoped pipeline is reported only for a shape NO single file in it
   * already formed (the fallback — no double-reporting).
   *
   * Shape priority (RAG > low-level > training > agent > inference > LLM-app) is by
   * SPECIFICITY / SUBSUMPTION, picking the most informative HEADLINE when several
   * match (all matches are still listed in `shapes`):
   *   - low-level (custom GPU kernels + model/inference) ranks just under RAG: rare
   *     and distinctive (DeepSeek/Mistral MoE kernels), so it headlines when present.
   *   - LLM-app is LAST: it's the generic catch-all (almost any LLM code qualifies);
   *     RAG and agent are SPECIALIZATIONS of it (RAG = LLM-app + retrieval; agent =
   *     LLM-app + tool-loop), so the richer label wins the headline.
   *   - RAG is FIRST: embed+vector-store+search is the most DISTINCTIVE signature
   *     (those cells co-occur ~only in retrieval), so a match is high-confidence.
   *   - training/agent/inference (middle) are all more specific than LLM-app and
   *     rarely co-occur with each other; agent>inference because agent subsumes
   *     LLM-app, inference is a narrower model-running shape.
   *
   * Honest (#106): co-occurrence (file or leaf-folder), NOT traced dataflow;
   * cross-FOLDER / import-graph assembly + a real graph are deferred Phase-2.5.
   */
  listPipelines(filter = null) {
    const reDocFile = /\.(?:md|markdown|mdx|rst)$/i;
    // Harvest (filepath, line, cell, id) from every cell. The `id` is the most
    // useful identity for the stage label (model/schema/dataset/framework name).
    const hits = [];
    // A keyword inside a string literal / doc-string is a MENTION, not usage, and
    // shouldn't anchor a pipeline stage (e.g. a vectorstore docstring "…use CLIP
    // models to create multimodal indexes" shouldn't make the file multimodal,
    // #142). The hit stays in the cell LIST; only pipeline assembly is affected.
    //
    // Conservative + SAFE: skip a record whose source line is itself a string
    // literal (trimmed line starts with a quote). A code line virtually never
    // starts with a bare quote, so this never over-filters real logic.
    //
    // NOTE: indented docstring *body* lines (e.g. marqo.py's `…use CLIP models…`)
    // start with prose, not a quote, so they're NOT caught here. A naive
    // triple-quote range scanner was tried and DESYNCED on transformers' complex
    // docstrings (embedded code examples / @auto_docstring), wrongly dropping
    // real CLIP pipelines (modeling_clip/x_clip/flava). Robust docstring
    // detection needs a language-aware parser → deferred; the big fake
    // module-scope pipelines are handled by the scope-demotion item.
    const isProseHit = (t) => {
      const ln = (this.fileLines.get(t.filepath) || [])[t.line - 1] || '';
      const c = ln.trimStart()[0];
      return c === '"' || c === "'" || c === '`';
    };
    const add = (cell, t, id) => { if (t && t.filepath && !reDocFile.test(t.filepath) && !isProseHit(t)) hits.push({ filepath: t.filepath, line: t.line, cell, id: id || null }); };
    for (const t of this.listModels())       add('model', t, t.name);
    for (const a of this.listArtifacts())     add(a.direction === 'save' ? 'artifact-save' : (a.direction === 'load' ? 'artifact-load' : 'artifact-ref'), a, a.path);
    for (const d of this.listDatasets())      add('dataset', d, d.name);
    for (const t of this.listTraining())      add('training', t, null);
    for (const t of this.listInference())     add('inference', t, t.id);
    for (const t of this.listLlmCalls())      add('llm-call', t, t.model || (t.provider && t.provider !== 'other' ? t.provider : null));
    for (const t of this.listTools())         add(t.kind === 'tool-dispatch' ? 'tool-dispatch' : 'tool-def', t, t.name);
    for (const t of this.listChains())        add('agent', t, t.framework);
    for (const e of this.listEmbeddings()) {
      const cell = e.kind === 'embedding' ? 'embed' : e.kind;   // embed / vector-store / search / chunking / distance
      if (cell === 'distance') continue;
      add(cell, e, e.id || e.framework);
    }
    for (const t of this.listStructuredOutput()) add('structured-output', t, t.id);
    for (const t of this.listKernels())       add('kernel', t, t.name || t.family);  // #116/#93: custom GPU kernels (DeepSeek/Mistral MoE) — the low-level model-impl signal
    for (const t of this.listMultimodal())    add('multimodal', t, t.name || t.family);  // #140: vision / VLM / generative-vision proxies

    const leafFolder = (fp) => { const n = fp.replace(/\\/g, '/'); const i = n.lastIndexOf('/'); return i >= 0 ? n.slice(0, i) : '.'; };
    // #121: module root = up to & incl. the first path segment after the zip '!'
    // marker (`archive.zip!repo-main`), else the top-level dir. The climb NEVER
    // crosses this — so a combined multi-model index can't fuse two models into a
    // phantom cross-repo pipeline (assembly stays within a repo; comparison is a
    // separate read over the per-model results).
    const moduleRoot = (fp) => {
      const n = fp.replace(/\\/g, '/');
      const bang = n.indexOf('!');
      if (bang >= 0) { const after = n.slice(bang + 1); const s = after.indexOf('/'); return n.slice(0, bang + 1) + (s >= 0 ? after.slice(0, s) : after); }
      const s = n.indexOf('/'); return s >= 0 ? n.slice(0, s) : n;
    };
    // Full ancestor chain of a folder, leaf→root, capped at the module root. Used
    // for claim propagation (block every ancestor, uncapped by depth).
    const folderAncestors = (folder) => {
      const root = moduleRoot(folder); const chain = []; let dir = folder;
      while (dir && dir.startsWith(root)) { chain.push(dir); if (dir === root) break; const i = dir.lastIndexOf('/'); if (i < 0) break; dir = dir.slice(0, i); }
      return chain;
    };
    // Bucket-building chain: leaf folder + up to CLIMB_DEPTH ancestors above it
    // (we only assemble within a couple levels; a deeper flat tree shouldn't
    // collapse into one mega-pipeline).
    const CLIMB_DEPTH = 2;
    const folderChain = (fp) => folderAncestors(leafFolder(fp)).slice(0, CLIMB_DEPTH + 1);
    const fileB = new Map();    // filepath → { cells: Map(cell → {ids:Set, sites:[]}) }
    const folderB = new Map();  // folder   → { cells, files:Set, leaves:Set }
    const bump = (b, cell, id, fp, line) => {
      let c = b.cells.get(cell); if (!c) { c = { ids: new Set(), sites: [] }; b.cells.set(cell, c); }
      if (id) c.ids.add(id); c.sites.push({ filepath: fp, line });
    };
    for (const h of hits) {
      let fb = fileB.get(h.filepath); if (!fb) { fb = { cells: new Map() }; fileB.set(h.filepath, fb); }
      bump(fb, h.cell, h.id, h.filepath, h.line);
      const leaf = leafFolder(h.filepath);
      for (const folder of folderChain(h.filepath)) {
        let gb = folderB.get(folder); if (!gb) { gb = { cells: new Map(), files: new Set(), leaves: new Set() }; folderB.set(folder, gb); }
        bump(gb, h.cell, h.id, h.filepath, h.line);
        gb.files.add(h.filepath); gb.leaves.add(leaf);
      }
    }

    // Shapes, built in priority order — shapes[0] is the headline.
    const classify = (cells) => {
      const has = (c) => cells.has(c);
      const s = [];
      if ((has('embed') && has('vector-store')) || (has('vector-store') && has('search'))) s.push('RAG');
      // low-level = custom GPU kernels co-occurring with model/inference/training —
      // the codebase IS the model's low-level implementation (DeepSeek/Mistral MoE
      // kernels), not a consumer. Distinctive + rare, so it headlines high.
      if (has('kernel') && (has('model') || has('inference') || has('training') || has('artifact-load') || has('artifact-save'))) s.push('low-level');
      if ((has('dataset') && has('training')) || (has('training') && has('artifact-save'))) s.push('training');
      // agent = an explicit chains/agents detection, OR (the cross-file case) an
      // LLM call co-occurring with tool-DISPATCH (handling the model's tool_use —
      // the agentic signal, vs tool-def which only declares tools).
      if (has('agent') || (has('llm-call') && has('tool-dispatch'))) s.push('agent');
      if (has('inference') && (has('artifact-load') || has('model'))) s.push('inference');
      if (has('llm-call') && (has('structured-output') || has('tool-def') || has('tool-dispatch'))) s.push('LLM-app');
      return s;
    };
    const STAGE_ORDER = ['dataset', 'chunking', 'embed', 'vector-store', 'search', 'model', 'multimodal', 'kernel', 'artifact-load', 'training', 'artifact-save', 'inference', 'llm-call', 'structured-output', 'tool-def', 'tool-dispatch', 'agent'];
    const makeRow = (shapes, scope, location, bucket) => {
      const stages = [];
      for (const cell of STAGE_ORDER) {
        const c = bucket.cells.get(cell);
        if (c) stages.push({ cell, ids: [...c.ids].slice(0, 6), count: c.sites.length, sites: c.sites.slice(0, 50) });
      }
      return { shape: shapes[0], shapes, scope, location, stages, cellCount: bucket.cells.size };
    };

    // universalRoot = the deepest folder that is an ancestor of EVERY contributing
    // file (the index's whole-repo root), computed from the real path structure —
    // build-agnostic (same whether the index came from a zip or a directory). A
    // climbed pipeline AT this folder spans the entire index ("the repo has these
    // cells somewhere"), too loose to be a real pipeline, so it's dropped. When
    // files share no common folder (a flat index like sklearn: `cluster/…`,
    // `ensemble/…`), universalRoot is '' and nothing is excluded — those top-level
    // submodules are legit assembly targets.
    let universalRoot = null;
    for (const h of hits) {
      const leaf = leafFolder(h.filepath);
      if (universalRoot === null) { universalRoot = leaf; continue; }
      const a = universalRoot.split('/'), b = leaf.split('/');
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      universalRoot = a.slice(0, i).join('/');
      if (!universalRoot) break;
    }

    const out = [];
    // claimedByFolder[folder] = shapes already reported at or below it (by a file or
    // a deeper folder). Reporting a shape propagates it up the whole ancestor chain,
    // so a looser ancestor never re-reports a tighter scope's pipeline.
    const claimedByFolder = new Map();
    const claimUp = (folder, sh) => { for (const anc of folderAncestors(folder)) { let s = claimedByFolder.get(anc); if (!s) { s = new Set(); claimedByFolder.set(anc, s); } s.add(sh); } };
    // 1) file-scoped — tightest.
    for (const [fp, fb] of fileB) {
      if (fb.cells.size < 2) continue;                         // a single cell isn't a pipeline
      const shapes = classify(new Set(fb.cells.keys()));
      if (!shapes.length) continue;
      out.push(makeRow(shapes, 'file', fp, fb));
      for (const sh of shapes) claimUp(leafFolder(fp), sh);
    }
    // 2) folder / module — deepest first, so a shape lands at the TIGHTEST folder
    // that forms it; report only shapes not already claimed below.
    const folders = [...folderB.keys()].sort((a, b) => (b.split('/').length - a.split('/').length) || a.localeCompare(b));
    for (const folder of folders) {
      const gb = folderB.get(folder);
      if (gb.files.size < 2 || gb.cells.size < 2) continue;    // needs genuine cross-file aggregation
      const shapes = classify(new Set(gb.cells.keys()));
      const claimed = claimedByFolder.get(folder) || new Set();
      const fresh = shapes.filter(sh => !claimed.has(sh));     // only shapes no tighter bucket formed
      if (!fresh.length) continue;
      // pure leaf (all files directly in it) → 'folder'; climbed across subfolders
      // → 'module' (looser confidence, disclosed).
      const scope = (gb.leaves.size === 1 && gb.leaves.has(folder)) ? 'folder' : 'module';
      // Don't report a CLIMBED pipeline at the whole-index root (see universalRoot
      // above) — too loose. Subfolders below it are kept.
      if (scope === 'module' && universalRoot && folder === universalRoot) continue;
      out.push(makeRow(fresh, scope, folder, gb));
      for (const sh of fresh) claimUp(folder, sh);
    }

    let result = out;
    if (filter) {
      const pat = filter.toLowerCase();
      result = out.filter(w =>
        w.shape.toLowerCase().includes(pat) || (w.location || '').toLowerCase().includes(pat)
        || w.scope.includes(pat) || w.shapes.join(',').toLowerCase().includes(pat)
        || w.stages.some(st => st.cell.includes(pat) || st.ids.join(',').toLowerCase().includes(pat)));
    }
    const shapeRank = { RAG: 0, 'low-level': 1, training: 2, agent: 3, inference: 4, 'LLM-app': 5 };
    const scopeRank = { file: 0, folder: 1, module: 2 };
    result.sort((a, b) =>
      (scopeRank[a.scope] - scopeRank[b.scope])
      || (shapeRank[a.shape] - shapeRank[b.shape]) || (b.cellCount - a.cellCount)
      || a.location.localeCompare(b.location));
    return result;
  }

}

// Prototype mixin, lifted from the carrier class above and Object.assign'd onto
// CodeSearchIndex.prototype in CodeSearchIndex.js.
export const aimlMethods = (() => {
  const out = {};
  for (const name of Object.getOwnPropertyNames(_AIMLMethods.prototype)) {
    if (name !== 'constructor') out[name] = _AIMLMethods.prototype[name];
  }
  return out;
})();

// Seed for the Phase B "9-file fan-out rationalization" CELLS registry (#133).
// Intentionally not consumed yet (the full registry adds route / responseKey /
// renderer per cell and drives metrics/server/api/app/html). Keep - not dead
// code. The 13 detectors are CSI-prototype methods (keyed by `method`);
// `prompts` is the one AI/ML command that predates the listX shape and lives in
// its own module by design (src/commands/prompts.js), keyed by module/command.
export const CELL_KEYS = [
  { key: 'models',            method: 'listModels' },
  { key: 'artifacts',         method: 'listArtifacts' },
  { key: 'kernels',           method: 'listKernels' },
  { key: 'multimodal',        method: 'listMultimodal' },
  { key: 'datasets',          method: 'listDatasets' },
  { key: 'training',          method: 'listTraining' },
  { key: 'inference',         method: 'listInference' },
  { key: 'llm-calls',         method: 'listLlmCalls' },
  { key: 'tools',             method: 'listTools' },
  { key: 'chains',            method: 'listChains' },
  { key: 'embeddings',        method: 'listEmbeddings' },
  { key: 'structured-output', method: 'listStructuredOutput' },
  { key: 'models-used',       method: 'listModelsUsed' },
  { key: 'pipelines',         method: 'listPipelines' },
  { key: 'prompts',           module: 'commands/prompts.js', command: 'doPromptCatalog' },
];

// #134 drill-down dedupe: generic grouper that collapses a flat detector row list
// into deduped groups. keyFn(row)->string dedup key; pick(row)->the per-site object
// to retain. Each group keeps the first row as `rep` (shared display fields), a
// `count`, and a `sites` array. First-seen order is preserved (rows arrive sorted),
// so grouping never reorders relative to the flat list. Pure; no `this`.
export function groupSites(rows, keyFn, pick) {
  const by = new Map();
  for (const r of (rows || [])) {
    const k = keyFn(r);
    let g = by.get(k);
    if (!g) { g = { key: k, rep: r, count: 0, sites: [] }; by.set(k, g); }
    g.count++;
    g.sites.push(pick ? pick(r) : r);
  }
  return [...by.values()];
}

// #142 drill-down dedupe for the Pipelines PROJECTION. Unlike the marker cells
// above, a pipeline row is a multi-stage flow ({ shape, stages:[{cell, ids, ...}] }),
// so its dedup signature is the shape plus the ordered stage cells with their
// FIRST id. Using the first id only collapses genuine repeats
// (`vector-store(LangChain) → search(LangChain)` over 186 files → ONE group) while
// keeping distinct backends apart (`vector-store(Milvus) → …` stays its own group).
// Rows arrive pre-sorted (file→folder→module), so first-seen order is preserved.
// Pure; no `this`. Returns [{ sig, rep, count, members }] where members are the
// full original rows (each retains its `stages`, so leaf drill still works).
export function pipelineSig(w) {
  return w.shape + '|' + (w.stages || []).map(s => s.cell + (s.ids && s.ids.length ? '(' + s.ids[0] + ')' : '')).join(' → ');
}
export function groupPipelines(flows) {
  const by = new Map();
  for (const w of (flows || [])) {
    const sig = pipelineSig(w);
    let g = by.get(sig);
    if (!g) { g = { sig, rep: w, count: 0, members: [] }; by.set(sig, g); }
    g.count++;
    g.members.push(w);
  }
  return [...by.values()];
}

// Per-cell drill-down spec (the only Kernels-specific part; seeds the Phase B
// CELLS registry). IDENTITY grouping by name `(family, kind, marker, name)`:
// collapse only same-named repeats (the 3 overloaded `Load`s -> `Load x3`;
// `act_quant_kernel x4` across version-dirs), while substantially different names
// (BitCast, Store, Zero) keep their own rows. Rationale (Andrew, on real data):
// distinct names are not clutter — clutter is the *same* thing over and over; pure
// `(family,kind,marker)` category grouping was too aggressive. The name shows in
// the left pane; each group's `sites` are its per-occurrence locations.
export const KERNELS_DRILLDOWN = {
  keyFn: k => `${k.family}|${k.kind}|${k.marker}|${k.name || ''}`,
  pick:  k => ({ name: k.name, filepath: k.filepath, line: k.line, snippet: k.snippet, tag: k.tag }),
  row:   k => ({ family: k.family, kind: k.kind, marker: k.marker, name: k.name, tag: k.tag }),
};

// #140 Multimodal / Vision. Same identity-grouping shape as KERNELS_DRILLDOWN:
// collapse only same-(family,kind,marker,name) repeats; distinct markers keep
// their own rows. name === marker for this cell, so the key is effectively
// (family, kind, marker).
export const MULTIMODAL_DRILLDOWN = {
  keyFn: t => `${t.family}|${t.kind}|${t.marker}|${t.name || ''}`,
  pick:  t => ({ name: t.name, filepath: t.filepath, line: t.line, snippet: t.snippet, tag: t.tag }),
  row:   t => ({ family: t.family, kind: t.kind, marker: t.marker, name: t.name, tag: t.tag }),
};

// #134 batch-1 identity cells (Models, Artifacts, Datasets, Tools). Same shape as
// KERNELS_DRILLDOWN: keyFn (name-identity, collapse only genuine repeats), pick
// (per-site fields), row (left-pane / response identity fields from the group rep).
// Models has no line/snippet (a class), so its sites carry filepath + method_count.
export const MODELS_DRILLDOWN = {
  keyFn: m => `${m.framework}|${m.name}`,
  pick:  m => ({ name: m.name, filepath: m.filepath, line: m.line, base: m.base, method_count: m.method_count }),
  row:   m => ({ framework: m.framework, base: m.base, name: m.name, ambiguous: m.ambiguous, method_count: m.method_count }),
  sort:  (a, b) => b.method_count - a.method_count,   // biggest classes first (parity with the old route)
};
// Basename of a model-artifact path (./models/foo.gguf -> foo.gguf) so the same
// artifact referenced across version-dirs collapses to one identity; HF hub ids
// (org/model) and bare ids are kept whole. Mirrors metrics.js basenameIfPath.
function artifactBasename(v) {
  if (!v) return '';
  const looksPath = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(v)
    || /[\\/][^\\/]*\.(?:gguf|safetensors|onnx|ckpt|pth|pt|bin|h5)$/i.test(v);
  return looksPath ? (v.split(/[\\/]/).pop() || v) : v;
}
export const ARTIFACTS_DRILLDOWN = {
  keyFn: a => `${a.family}|${a.format}|${artifactBasename(a.name)}`,
  pick:  a => ({ name: a.name, filepath: a.filepath, line: a.line, snippet: a.snippet, tag: a.tag }),
  row:   a => ({ family: a.family, format: a.format, name: artifactBasename(a.name), marker: a.marker, tag: a.tag }),
};
export const DATASETS_DRILLDOWN = {
  keyFn: d => `${d.family}|${d.kind}|${d.name || ''}`,
  pick:  d => ({ name: d.name, filepath: d.filepath, line: d.line, snippet: d.snippet, tag: d.tag }),
  row:   d => ({ family: d.family, kind: d.kind, name: d.name, marker: d.marker, tag: d.tag }),
};
export const TOOLS_DRILLDOWN = {
  keyFn: t => `${t.framework}|${t.kind}|${t.name || ''}`,
  pick:  t => ({ name: t.name, filepath: t.filepath, line: t.line, snippet: t.snippet, tag: t.tag }),
  row:   t => ({ framework: t.framework, kind: t.kind, name: t.name, marker: t.marker, tag: t.tag }),
};

// #134 batch-2 marker-driven cells. Default key = (group, kind, marker, identity),
// where identity is the resolved name/model where one exists, else the marker.
export const TRAINING_DRILLDOWN = {
  keyFn: t => `${t.family}|${t.kind}|${t.marker}|${t.name || ''}`,
  pick:  t => ({ name: t.name, filepath: t.filepath, line: t.line, snippet: t.snippet, tag: t.tag }),
  row:   t => ({ family: t.family, kind: t.kind, marker: t.marker, name: t.name, tier: t.tier, tag: t.tag }),
};
export const INFERENCE_DRILLDOWN = {
  keyFn: t => `${t.family}|${t.kind}|${t.marker}|${t.name || ''}`,
  pick:  t => ({ name: t.name, filepath: t.filepath, line: t.line, snippet: t.snippet, tag: t.tag }),
  row:   t => ({ family: t.family, kind: t.kind, marker: t.marker, name: t.name, id: t.id, tier: t.tier, tag: t.tag }),
};
export const LLMCALLS_DRILLDOWN = {
  keyFn: t => `${t.provider}|${t.kind}|${t.marker}|${t.model || ''}`,   // model is the identity; name is just the marker
  pick:  t => ({ name: t.name, filepath: t.filepath, line: t.line, snippet: t.snippet, tag: t.tag }),
  row:   t => ({ provider: t.provider, kind: t.kind, marker: t.marker, model: t.model, name: t.name, lvc: t.lvc, tier: t.tier, tag: t.tag }),
};
export const CHAINS_DRILLDOWN = {
  keyFn: t => `${t.framework}|${t.kind}|${t.marker}|${t.name || ''}`,
  pick:  t => ({ name: t.name, filepath: t.filepath, line: t.line, snippet: t.snippet, tag: t.tag }),
  row:   t => ({ framework: t.framework, kind: t.kind, marker: t.marker, name: t.name, tier: t.tier, tag: t.tag }),
};
export const EMBEDDINGS_DRILLDOWN = {
  keyFn: t => `${t.framework}|${t.kind}|${t.marker}`,   // name === marker for embeddings
  pick:  t => ({ name: t.name, filepath: t.filepath, line: t.line, snippet: t.snippet, tag: t.tag }),
  row:   t => ({ framework: t.framework, kind: t.kind, marker: t.marker, name: t.name, id: t.id, tier: t.tier, tag: t.tag }),
};
export const STRUCTURED_OUTPUT_DRILLDOWN = {
  keyFn: t => `${t.framework}|${t.kind}|${t.marker}|${t.name || ''}`,   // name = id||marker (schema is the identity)
  pick:  t => ({ name: t.name, filepath: t.filepath, line: t.line, snippet: t.snippet, tag: t.tag }),
  row:   t => ({ framework: t.framework, kind: t.kind, marker: t.marker, name: t.name, id: t.id, tag: t.tag }),
};
