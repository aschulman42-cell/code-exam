/**
 * test_models_used_fp.js — #206 slice: false-positive suppression in the
 * listModelsUsed projection. Locks in the four FP shapes that polluted the
 * "models used" signal (and that a small local-LLM overview faithfully
 * restated, per #196):
 *
 *   - method-call templates captured from quotes/backticks: `X.from_pretrained()`
 *   - dotted method references: `transformers.AutoConfig.from_pretrained`
 *   - minified / punctuation junk tokens: `,.H5`, `&.Pt`
 *   - loads inside comments / docstrings (CE examining its own detector source)
 *
 * …while a real model id (`bert-base-uncased`) still survives.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

// Build an index over synthetic in-memory files (no on-disk index — fileLines
// is populated directly, same pattern as test_explainability.js).
function indexOf(files) {
  const idx = new CodeSearchIndex({ indexPath: '.__test_models_used_fp_noindex__' });
  idx.fileLines = new Map(Object.entries(files).map(([p, src]) => [p, src.split('\n')]));
  return idx;
}

const FIXTURE = {
  'loader.py': [
    'm = AutoModel.from_pretrained("bert-base-uncased")',                        // real model id
    't1 = AutoModel.from_pretrained("AutoModelForCausalLM.from_pretrained()")',  // call template (parens)
    't2 = AutoModel.from_pretrained("transformers.AutoConfig.from_pretrained")', // dotted method reference
    'junk1 = ",.H5"',                                                            // minified junk (extRe .h5)
    'junk2 = "&.Pt"',                                                            // minified junk (extRe .pt)
    '# ghost = AutoModel.from_pretrained("ghost-in-comment")',                   // commented-out load
  ].join('\n'),
};

describe('listModelsUsed — false-positive suppression (#206)', () => {
  const ids = indexOf(FIXTURE).listModelsUsed().map(m => m.model);

  it('keeps a real model id', () => {
    assert.ok(ids.includes('bert-base-uncased'), `expected bert-base-uncased in ${JSON.stringify(ids)}`);
  });

  it('drops method-call templates (X.from_pretrained())', () => {
    assert.ok(!ids.some(id => id.includes('from_pretrained()')), JSON.stringify(ids));
  });

  it('drops dotted method-reference ids (…AutoConfig.from_pretrained)', () => {
    assert.ok(!ids.some(id => /\.from_pretrained$/i.test(id)), JSON.stringify(ids));
  });

  it('drops minified / punctuation junk tokens (,.H5  &.Pt)', () => {
    assert.ok(!ids.includes(',.H5'), JSON.stringify(ids));
    assert.ok(!ids.includes('&.Pt'), JSON.stringify(ids));
  });

  it('does not detect a model loaded inside a comment', () => {
    assert.ok(!ids.includes('ghost-in-comment'), JSON.stringify(ids));
  });

  it('capstone: only the real model survives the fixture', () => {
    assert.deepEqual(ids, ['bert-base-uncased']);
  });
});

describe('listModelsUsed — path comes from the positional arg, not incidental quotes (#206)', () => {
  // The artifact-path extractor must ignore quotes that are dict-access keys
  // (`cfg["path"]`), non-model kwarg values (`padding_side="left"`), or object
  // keys (`{"radius": …}`) — those leaked into models-used as bogus ids.
  const ids = indexOf({
    'k.py': [
      'a = AutoModel.from_pretrained(cfg["path"])',                     // dict-access key
      'b = AutoTokenizer.from_pretrained(local, padding_side="left")', // non-model kwarg value
      'torch.save({"radius": r}, dest)',                               // object key
      'c = AutoModel.from_pretrained(model_path="real-kwarg-model")',  // model-identity kwarg → kept
      'd = AutoModel.from_pretrained("real-positional-model")',        // positional literal → kept
    ].join('\n'),
  }).listModelsUsed().map(m => m.model);

  it('keeps a positional model literal', () => {
    assert.ok(ids.includes('real-positional-model'), JSON.stringify(ids));
  });
  it('keeps a model-identity kwarg value (model_path=)', () => {
    assert.ok(ids.includes('real-kwarg-model'), JSON.stringify(ids));
  });
  it('drops a dict-access key (cfg["path"])', () => {
    assert.ok(!ids.includes('path'), JSON.stringify(ids));
  });
  it('drops a non-model kwarg value (padding_side="left")', () => {
    assert.ok(!ids.includes('left'), JSON.stringify(ids));
  });
  it('drops an object key ({"radius": …})', () => {
    assert.ok(!ids.includes('radius'), JSON.stringify(ids));
  });
});
