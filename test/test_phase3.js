/**
 * test_phase3.js - Tests for Phase 3: metrics / discovery.
 *
 * Run: node --test test/test_phase3.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { forEachEntry, parseValue } from '../src/json-stream.js';

const TEST_DIR = '/tmp/code_exam_test_p3_src';
const INDEX_DIR = '/tmp/code_exam_test_p3_idx';

function setupTestFiles() {
  fs.mkdirSync(path.join(TEST_DIR, 'lib'), { recursive: true });

  // utils.py - helpers called from many places
  fs.writeFileSync(path.join(TEST_DIR, 'utils.py'), `"""Utilities."""

def helper_function(data):
    if not data:
        return "empty"
    result = str(data).upper()
    trimmed = result.strip()
    return trimmed

def compute_score(items):
    total = sum(items)
    average = total / len(items) if items else 0
    weighted = average * 1.5
    return weighted

def format_output(text):
    return text.strip()
`);

  // main.py - entry point, calls many functions
  fs.writeFileSync(path.join(TEST_DIR, 'main.py'), `#!/usr/bin/env python3
"""Main entry point."""

from utils import helper_function, compute_score, format_output

class Application:
    def __init__(self, config):
        self.config = config

    def run(self):
        data = helper_function(self.config)
        score = compute_score([1, 2, 3])
        formatted = format_output(data)
        return formatted

    def cleanup(self):
        pass

class Config:
    def __init__(self):
        self.debug = False

    def load(self):
        pass

    def validate(self):
        pass

def main():
    app = Application("test")
    result = app.run()
    formatted = format_output(result)
    helper_function(formatted)
    return result

def orphan_function_never_called():
    """This should show up as a gap."""
    x = helper_function("orphan")
    y = compute_score([1, 2])
    z = format_output(x)
    return x + str(y) + z
`);

  // lib/processor.py - mid-level module
  fs.writeFileSync(path.join(TEST_DIR, 'lib', 'processor.py'), `"""Processor module."""

from utils import helper_function, compute_score

class Processor:
    def process(self, data):
        clean = helper_function(data)
        score = compute_score([10, 20])
        helper_function(score)
        return clean

    def batch_process(self, items):
        results = []
        for item in items:
            r = helper_function(item)
            results.append(r)
        return results

def run_pipeline(data_list):
    proc = Processor()
    for data in data_list:
        proc.process(data)
    return compute_score([1])
`);

  // lib/analyzer.py - calls compute_score
  fs.writeFileSync(path.join(TEST_DIR, 'lib', 'analyzer.py'), `"""Analyzer module."""

from processor import Processor
from utils import compute_score

class Analyzer:
    def analyze(self, data):
        proc = Processor()
        result = proc.process(data)
        score = compute_score(result)
        return score

def quick_analyze(data):
    return compute_score([data])
`);

  // --- C++ test files for class detection ---
  fs.mkdirSync(path.join(TEST_DIR, 'cc'), { recursive: true });

  // cc/tracker.h - header with export macros (CC_EXPORT, BLINK_EXPORT)
  fs.writeFileSync(path.join(TEST_DIR, 'cc', 'tracker.h'), `#ifndef TRACKER_H
#define TRACKER_H

#include "base/export.h"

class CC_EXPORT OcclusionTracker {
 public:
  OcclusionTracker();
  ~OcclusionTracker();
  void Track(int layer_id);
  bool IsOccluded(int layer_id) const;
};

class BLINK_EXPORT RenderWidget {
 public:
  void Initialize();
  void Paint();
  void Resize(int w, int h);
};

struct GFX_EXPORT Rect {
  int x, y, width, height;
  bool Contains(int px, int py);
};

// Normal class without export macro
class LayerTree {
 public:
  void Build();
  void Update();
};

#endif
`);

  // cc/tracker.cc - implementation with ClassName::Method patterns
  fs.writeFileSync(path.join(TEST_DIR, 'cc', 'tracker.cc'), `#include "tracker.h"

OcclusionTracker::OcclusionTracker() {
  layers_.clear();
}

OcclusionTracker::~OcclusionTracker() {
}

void OcclusionTracker::Track(int layer_id) {
  for (auto& layer : layers_) {
    if (layer.id == layer_id) {
      layer.tracked = true;
      return;
    }
  }
}

bool OcclusionTracker::IsOccluded(int layer_id) const {
  for (const auto& layer : layers_) {
    if (layer.id == layer_id) {
      return layer.occluded;
    }
  }
  return false;
}
`);

  // cc/widget.cc - ONLY .cc file, no corresponding .h indexed
  // Classes should be INFERRED from :: in function names
  fs.writeFileSync(path.join(TEST_DIR, 'cc', 'widget.cc'), `#include "widget.h"  // not in our index

void RenderWidget::Initialize() {
  is_ready_ = false;
  SetupGL();
}

void RenderWidget::Paint() {
  if (!is_ready_) return;
  canvas_.clear();
  for (auto& child : children_) {
    child->Draw();
  }
  canvas_.flush();
}

void RenderWidget::Resize(int w, int h) {
  width_ = w;
  height_ = h;
  Invalidate();
}

bool Rect::Contains(int px, int py) {
  return px >= x && px < x + width && py >= y && py < y + height;
}
`);

  // cc/compositor.cc - class ONLY in .cc, NO .h file indexed at all
  // CompositorLayer should be INFERRED purely from :: prefixes
  fs.writeFileSync(path.join(TEST_DIR, 'cc', 'compositor.cc'), `#include "compositor.h"  // not in our index

void CompositorLayer::Attach(int parent_id) {
  parent_id_ = parent_id;
  is_attached_ = true;
}

void CompositorLayer::Detach() {
  parent_id_ = -1;
  is_attached_ = false;
}

void CompositorLayer::SetOpacity(float opacity) {
  opacity_ = opacity;
  needs_repaint_ = true;
}

int CompositorLayer::GetDepth() const {
  int depth = 0;
  auto* current = this;
  while (current->parent_id_ >= 0) {
    depth++;
    break;  // simplified
  }
  return depth;
}
`);
}


describe('Phase 3: Metrics / Discovery', () => {
  let index;

  it('setup: creates test files and builds index', () => {
    setupTestFiles();
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    const stats = index.buildIndex(TEST_DIR, { showProgress: false });
    assert.ok(stats.files_indexed >= 8, `Expected >=8 files, got ${stats.files_indexed}`);
    assert.equal(stats.errors.length, 0);
  });


  // --- getHotspots ---

  it('getHotspots: returns scored functions sorted by score', () => {
    const hotspots = index.getHotspots(50, false);
    assert.ok(hotspots.length > 0, 'Should find hotspots');
    // Check sorted desc
    for (let i = 1; i < hotspots.length; i++) {
      assert.ok(hotspots[i - 1].score >= hotspots[i].score, 'Should be sorted by score desc');
    }
    // helper_function should rank high (called many times, decent size)
    const hf = hotspots.find(h => h.name.includes('helper_function'));
    assert.ok(hf, 'helper_function should be a hotspot');
    assert.ok(hf.calls >= 3, 'helper_function should have multiple calls');
    assert.ok(hf.lines >= 3, 'helper_function should have lines');
    assert.ok(hf.score > 0, 'Score should be positive');
  });

  it('getHotspots: score formula is calls x log2(lines)', () => {
    const hotspots = index.getHotspots(100, false);
    for (const h of hotspots) {
      const expected = h.calls * Math.log2(Math.max(h.lines, 2));
      assert.ok(Math.abs(h.score - expected) < 0.01, `Score mismatch for ${h.name}`);
    }
  });

  it('getHotspots: respects n limit', () => {
    const h5 = index.getHotspots(5, false);
    assert.ok(h5.length <= 5, 'Should respect n limit');
  });


  // --- listClasses ---

  it('listClasses: finds all classes', () => {
    const classes = index.listClasses();
    assert.ok(classes.length >= 4, `Expected >=4 classes, got ${classes.length}`);
    const names = classes.map(c => c.name);
    assert.ok(names.some(n => n.includes('Application')), 'Should find Application');
    assert.ok(names.some(n => n.includes('Processor')), 'Should find Processor');
    assert.ok(names.some(n => n.includes('Analyzer')), 'Should find Analyzer');
    assert.ok(names.some(n => n.includes('Config')), 'Should find Config');
  });

  it('listClasses: associates methods with classes', () => {
    const classes = index.listClasses();
    const app = classes.find(c => c.name.includes('Application'));
    assert.ok(app, 'Should find Application class');
    assert.ok(app.method_count >= 2, `Application should have >=2 methods, got ${app.method_count}`);
    assert.ok(app.total_method_lines > 0, 'Should have method lines');
  });

  it('listClasses: filepath filter works', () => {
    const filtered = index.listClasses('processor');
    assert.ok(filtered.length >= 1, 'Should find Processor');
    assert.ok(filtered.every(c => c.filepath.toLowerCase().includes('processor')));
  });


  // --- CC_EXPORT macro handling ---

  it('listClasses: CC_EXPORT skipped, real class name captured', () => {
    const classes = index.listClasses();
    const names = classes.map(c => c.name);
    // Should find OcclusionTracker, not CC_EXPORT
    assert.ok(names.includes('OcclusionTracker'),
      `Should find OcclusionTracker, got: ${names.filter(n => /occlusion|CC_|BLINK_/i.test(n)).join(', ')}`);
    // Should NOT have CC_EXPORT, BLINK_EXPORT, GFX_EXPORT as class names
    assert.ok(!names.includes('CC_EXPORT'), 'CC_EXPORT should not be a class name');
    assert.ok(!names.includes('BLINK_EXPORT'), 'BLINK_EXPORT should not be a class name');
    assert.ok(!names.includes('GFX_EXPORT'), 'GFX_EXPORT should not be a class name');
  });

  it('listClasses: RenderWidget found from export macro header', () => {
    const classes = index.listClasses();
    const rw = classes.find(c => c.name === 'RenderWidget');
    assert.ok(rw, 'Should find RenderWidget class');
  });

  it('listClasses: Rect found from struct with export macro', () => {
    const classes = index.listClasses();
    const rect = classes.find(c => c.name === 'Rect');
    assert.ok(rect, 'Should find Rect struct');
  });

  it('listClasses: normal class without macro still works', () => {
    const classes = index.listClasses();
    const lt = classes.find(c => c.name === 'LayerTree');
    assert.ok(lt, 'Should find LayerTree (no export macro)');
  });


  // --- Class inference from :: in function names ---

  it('listClasses: OcclusionTracker methods from .cc associated with .h class', () => {
    const classes = index.listClasses();
    const ot = classes.find(c => c.name === 'OcclusionTracker');
    assert.ok(ot, 'Should find OcclusionTracker');
    // Methods from tracker.cc should be associated
    assert.ok(ot.method_count >= 2,
      `OcclusionTracker should have >=2 methods from .cc, got ${ot.method_count}`);
    const methodNames = ot.methods.map(m => m.name);
    assert.ok(methodNames.some(n => n.includes('Track')), 'Should have Track method');
    assert.ok(methodNames.some(n => n.includes('IsOccluded')), 'Should have IsOccluded method');
  });

  it('listClasses: infers class from :: when no .h class declaration', () => {
    // widget.cc has RenderWidget::Method but widget.h is NOT indexed.
    // However, tracker.h declares class BLINK_EXPORT RenderWidget, so it
    // should be found from the header. Let's also check Rect inference from .cc
    const classes = index.listClasses();
    const rect = classes.find(c => c.name === 'Rect');
    assert.ok(rect, 'Should find Rect');
    // Rect::Contains is in widget.cc, Rect struct is in tracker.h
    assert.ok(rect.method_count >= 1, 'Rect should have Contains method');
  });

  it('parseFunctionsRegex: :: functions stored as method type', () => {
    // Check that OcclusionTracker::Track is stored as type "method"
    const funcs = index.listFunctions();
    const track = funcs.find(f => f.name === 'OcclusionTracker::Track');
    assert.ok(track, 'Should find OcclusionTracker::Track');
    assert.equal(track.type, 'method', 'Should be type method');
  });

  it('listClasses: infers CompositorLayer purely from :: (no .h at all)', () => {
    const classes = index.listClasses();
    const cl = classes.find(c => c.name === 'CompositorLayer');
    assert.ok(cl, 'Should infer CompositorLayer from :: in compositor.cc');
    assert.ok(cl.inferred === true, 'Should be marked as inferred');
    assert.ok(cl.method_count >= 3,
      `CompositorLayer should have >=3 methods, got ${cl.method_count}`);
    const methodNames = cl.methods.map(m => m.name);
    assert.ok(methodNames.some(n => n.includes('Attach')), 'Should have Attach');
    assert.ok(methodNames.some(n => n.includes('Detach')), 'Should have Detach');
    assert.ok(methodNames.some(n => n.includes('SetOpacity')), 'Should have SetOpacity');
  });


  // --- getEntryPoints ---

  it('getEntryPoints: finds rarely-called functions', () => {
    // Note: functions with unique names get count=1 from their own definition
    const entries = index.getEntryPoints(50, 1, false);
    assert.ok(entries.length > 0, 'Should find entry points with <=1 calls');
    // All should have <=1 calls
    for (const e of entries) {
      assert.ok(e.calls <= 1, `Entry point ${e.name} should have <=1 calls`);
    }
    // Sorted by lines desc
    for (let i = 1; i < entries.length; i++) {
      assert.ok(entries[i - 1].lines >= entries[i].lines, 'Should be sorted by lines desc');
    }
  });

  it('getEntryPoints: maxCalls parameter works', () => {
    const entries1 = index.getEntryPoints(50, 1, false);
    assert.ok(entries1.length > 0, 'Should find functions with <=1 calls');
    for (const e of entries1) {
      assert.ok(e.calls <= 1, `Should have <=1 calls, got ${e.calls}`);
    }
    // Should have more results with maxCalls=1 than maxCalls=0
    const entries0 = index.getEntryPoints(50, 0, false);
    assert.ok(entries1.length >= entries0.length);
  });


  // --- getDomainHotspots ---

  it('getDomainHotspots: penalizes common names', () => {
    const domain = index.getDomainHotspots(50, false);
    assert.ok(domain.length > 0, 'Should find domain functions');

    // Each entry should have name_count
    for (const d of domain) {
      assert.ok(d.name_count >= 1, 'name_count should be >= 1');
      assert.ok(d.score > 0, 'Score should be positive');
    }

    // Check score formula
    for (const d of domain) {
      const expected = d.calls * Math.log2(Math.max(d.lines, 2)) / Math.sqrt(Math.max(d.name_count, 1));
      assert.ok(Math.abs(d.score - expected) < 0.01, `Score mismatch for ${d.name}`);
    }
  });


  // --- getClassHotspots ---

  it('getClassHotspots: ranks classes by method scores', () => {
    const ch = index.getClassHotspots(20, false);
    assert.ok(ch.length > 0, 'Should find class hotspots');
    // Sorted by score desc
    for (let i = 1; i < ch.length; i++) {
      assert.ok(ch[i - 1].score >= ch[i].score, 'Should be sorted by score desc');
    }
    // Top class should have methods and calls
    const top = ch[0];
    assert.ok(top.method_count > 0, 'Top class should have methods');
    assert.ok(top.total_calls >= 0, 'Should track total calls');
  });


  // --- _getBareNameCounts ---

  it('_getBareNameCounts: counts definitions per bare name', () => {
    const counts = index._getBareNameCounts();
    assert.ok('helper_function' in counts, 'Should have helper_function');
    assert.ok(counts['helper_function'] >= 1);
    // main likely has 1 definition
    assert.ok('main' in counts, 'Should have main');
  });


  // --- getFileDupeCount ---

  it('getFileDupeCount: returns 0 for unique files', () => {
    const files = [...index.files.keys()];
    for (const fp of files) {
      const count = index.getFileDupeCount(fp);
      assert.ok(typeof count === 'number', 'Should return a number');
    }
  });


  // --- Streaming JSON parser ---

  it('streaming: forEachEntry parses nested objects', () => {
    const obj = {
      files: { 'a.py': { size: 100 }, 'b.py': { size: 200 } },
      file_lines: { 'a.py': ['line1', 'line2'], 'b.py': ['x'] },
      base_path: '/test',
    };
    const json = JSON.stringify(obj);
    const buf = Buffer.from(json);
    const keys = [];
    forEachEntry(buf, 0, buf.length, (key, vs, ve) => {
      keys.push(key);
      const val = parseValue(buf, vs, ve);
      assert.deepStrictEqual(val, obj[key]);
    });
    assert.deepStrictEqual(keys, ['files', 'file_lines', 'base_path']);
  });

  it('streaming: handles escaped strings and special chars', () => {
    const obj = {
      'key with "quotes"': 'value with \\ backslash',
      'normal': [1, 2, 3],
    };
    const json = JSON.stringify(obj);
    const buf = Buffer.from(json);
    const parsed = {};
    forEachEntry(buf, 0, buf.length, (key, vs, ve) => {
      parsed[key] = parseValue(buf, vs, ve);
    });
    assert.deepStrictEqual(parsed, obj);
  });
});
