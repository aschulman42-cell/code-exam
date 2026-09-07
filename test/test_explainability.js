// test_explainability.js — explainability cell: import gating, kinds, variants, data/prose file skip
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_explainability.js — tests for the #155 Explainability / Analysis cell
 * (listExplainability). Focus on the precision-critical behaviors:
 *   - import-gating (a call counts ONLY in a file that imports its library)
 *   - the register-hook instrumentation kind (gated on `import torch`)
 *   - variant capture (IncrementalPCA stays distinct from PCA)
 *   - data/prose file skip (the tokenizer-JSON / transcript FPs #155 named)
 *   - kind assignment (attribution / dim-reduction / instrumentation)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

// Build an index over synthetic in-memory files. The constructor finds no
// index at this path, so fileLines starts empty; we populate it directly.
function indexOf(files) {
  const idx = new CodeSearchIndex({ indexPath: '.__test_explainability_noindex__' });
  idx.fileLines = new Map(Object.entries(files).map(([p, src]) => [p, src.split('\n')]));
  return idx;
}

const rows = (files, filter = null) => indexOf(files).listExplainability(filter);
const markers = (rs) => rs.map(r => r.marker);
const has = (rs, marker, kind, tier) =>
  rs.some(r => r.marker === marker && (kind == null || r.kind === kind) && (tier == null || r.tier === tier));

describe('listExplainability — import gating', () => {
  it('counts a concept call ONLY when its library is imported in the file', () => {
    const withImport = rows({ 'a.py': 'from sklearn.decomposition import PCA\nx = PCA(n_components=2)' });
    assert.ok(has(withImport, 'sklearn.decomposition', 'dim-reduction', 'anchor-import'));
    assert.ok(has(withImport, 'PCA', 'dim-reduction', 'concept-call'));

    // Same call, no import → nothing (the central FP guard).
    const noImport = rows({ 'b.py': 'x = PCA(n_components=2)  # PCA from who knows where' });
    assert.equal(noImport.length, 0);
  });

  it('does NOT treat a bare library mention in unrelated code as usage', () => {
    const r = rows({ 'c.py': 'label = "Use PCA or t-SNE for this"\nUMAP_CONSTANT = 3' });
    assert.equal(r.length, 0);
  });
});

describe('listExplainability — file skipping (the #155 false positives)', () => {
  it('skips data / prose files even when they contain the tokens', () => {
    const r = rows({
      'tokenizer.json': '{"tokens": ["PCA", "umap", "shap"], "lime": 1}',
      'notes.md': 'We tried LIME and SHAP and PCA in this writeup.',
      'transcript.txt': 'the speaker said lime and then PCA',
    });
    assert.equal(r.length, 0);
  });
});

describe('listExplainability — instrumentation (register-hook), gated on torch', () => {
  it('detects PyTorch forward/backward hook registration as instrumentation', () => {
    const r = rows({
      'probe.py': [
        'import torch',
        'h = layer.register_forward_hook(grab)',
        'b = layer.register_full_backward_hook(grab)',
        'p = layer.register_forward_pre_hook(grab)',
        't = tensor.register_hook(grab)',
      ].join('\n'),
    });
    assert.ok(has(r, 'register_forward_hook', 'instrumentation', 'concept-call'));
    assert.ok(has(r, 'register_full_backward_hook', 'instrumentation'));
    assert.ok(has(r, 'register_forward_pre_hook', 'instrumentation'));
    assert.ok(has(r, 'register_hook', 'instrumentation'));
  });

  it('requires the torch import — no torch, no hook detection', () => {
    const r = rows({ 'nohooktorch.py': 'h = widget.register_forward_hook(cb)  # not torch' });
    assert.equal(r.length, 0);
  });

  it('a bare torch import with no hooks yields nothing (torch alone is not a signal)', () => {
    const r = rows({ 'model.py': 'import torch\nclass Net(torch.nn.Module):\n    pass' });
    assert.equal(r.length, 0);
  });

  it('detects the hook CE\'s own --emit-harness generates', () => {
    // The shape emitted by src/commands/harness.js's activation-hook template.
    const r = rows({
      'Foo_harness.py': [
        'import torch',
        'def instrument(model):',
        '    for name, module in model.named_modules():',
        '        module.register_forward_hook(make_hook(name))',
      ].join('\n'),
    });
    assert.ok(has(r, 'register_forward_hook', 'instrumentation'));
  });
});

describe('listExplainability — variant capture', () => {
  it('keeps PCA variants distinct rather than collapsing to "PCA"', () => {
    const r = rows({
      'd.py': [
        'from sklearn.decomposition import PCA, IncrementalPCA, KernelPCA, TruncatedSVD',
        'a = PCA()',
        'b = IncrementalPCA()',
        'c = KernelPCA()',
        'e = TruncatedSVD()',
      ].join('\n'),
    });
    const m = markers(r);
    assert.ok(m.includes('IncrementalPCA'));
    assert.ok(m.includes('KernelPCA'));
    assert.ok(m.includes('TruncatedSVD'));
    assert.ok(m.includes('PCA'));
  });

  it('captures the specific captum attribution class, not a generic token', () => {
    const r = rows({
      'e.py': 'from captum.attr import IntegratedGradients\nig = IntegratedGradients(model)',
    });
    assert.ok(has(r, 'IntegratedGradients', 'attribution', 'concept-call'));
  });
});

describe('listExplainability — library coverage', () => {
  it('detects scanpy dim-reduction via tool/plotting namespaces', () => {
    const r = rows({ 'sc.py': 'import scanpy as sc\nsc.tl.pca(adata)\nsc.tl.umap(adata)' });
    assert.ok(has(r, 'scanpy', 'dim-reduction', 'anchor-import'));
    assert.ok(has(r, 'scanpy umap', 'dim-reduction', 'concept-call'));
  });

  it('detects sklearn.inspection model-agnostic methods', () => {
    const r = rows({
      'insp.py': 'from sklearn.inspection import permutation_importance\nr = permutation_importance(est, X, y)',
    });
    assert.ok(has(r, 'permutation_importance', 'attribution'));
  });

  it('detects Grad-CAM (vision pixel attribution) in both ecosystems', () => {
    const pt = rows({
      'cam.py': 'from pytorch_grad_cam import GradCAM\ncam = GradCAMPlusPlus(model=m, target_layers=t)',
    });
    assert.ok(has(pt, 'GradCAMPlusPlus', 'attribution'));

    // Keras side — tf_keras_vis spells it `Gradcam` (title case). This is the
    // form Molnar's book uses; the pytorch-only anchor + CAPS regex missed it.
    const keras = rows({
      'keras-vis.py': 'from tf_keras_vis.gradcam import Gradcam\ngradcam = Gradcam(model)\ncam = gradcam(loss, X)',
    });
    assert.ok(has(keras, 'Grad-CAM', 'attribution', 'anchor-import'));
    assert.ok(has(keras, 'Gradcam', 'attribution', 'concept-call'));
  });

  it('detects the mechanistic-interp stack as instrumentation', () => {
    const r = rows({
      'mi.py': 'import transformer_lens\nlogits, cache = model.run_with_cache(tokens)',
    });
    assert.ok(has(r, 'TransformerLens', 'instrumentation', 'anchor-import'));
    assert.ok(r.some(x => x.kind === 'instrumentation' && x.tier === 'concept-call'));
  });

  it('detects SAE library imports (mechanistic-interp feature decomposition)', () => {
    const r = rows({ 'sae.py': 'from sae_lens import SAE\nsae = SAE.from_pretrained(id)' });
    assert.ok(has(r, 'SAE', 'attribution', 'anchor-import'));
  });
});
