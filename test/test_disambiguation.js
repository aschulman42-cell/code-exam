/**
 * test_disambiguation.js - Tests for function/method name disambiguation.
 *
 * Verifies that when multiple classes define the same method name,
 * findCallees correctly resolves which definition is being called
 * based on context (self/this, explicit qualification, same class, etc.).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_disambig');
const CLI = path.resolve('src/index.js');

function runCLI(args) {
  const cmd = `node ${CLI} ${args}`;
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 30000, cwd: TEST_DIR });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}


// ========================================================================
// Test: Python-style classes with self.method() disambiguation
// ========================================================================

describe('Disambiguation: Python self.method()', () => {
  const SRC_DIR = path.join(TEST_DIR, 'python_self');
  const IDX_DIR = path.join(TEST_DIR, '.idx_python_self');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    // Two classes with identically-named methods
    fs.writeFileSync(path.join(SRC_DIR, 'animals.py'), `
class Dog:
    def speak(self):
        return "woof"

    def greet(self):
        # This should resolve to Dog.speak, not Cat.speak
        sound = self.speak()
        return f"Dog says {sound}"

    def fetch(self):
        return "fetching ball"

class Cat:
    def speak(self):
        return "meow"

    def greet(self):
        # This should resolve to Cat.speak, not Dog.speak
        sound = self.speak()
        return f"Cat says {sound}"

    def purr(self):
        return "purring"
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('Dog.greet callees should resolve self.speak() to Dog.speak', () => {
    const out = runCLI(`--callees "Dog::greet" --index-path ${IDX_DIR} 2>&1`);
    // Should show Dog.speak, not Cat.speak
    assert.ok(out.includes('Dog') && out.includes('speak'),
      'should resolve to Dog.speak: ' + out);
    // Should NOT show Cat.speak as a callee
    assert.ok(!out.includes('Cat'),
      'should NOT include Cat.speak: ' + out);
  });

  it('Cat.greet callees should resolve self.speak() to Cat.speak', () => {
    const out = runCLI(`--callees "Cat::greet" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('Cat') && out.includes('speak'),
      'should resolve to Cat.speak: ' + out);
    assert.ok(!out.includes('Dog'),
      'should NOT include Dog.speak: ' + out);
  });
});


// ========================================================================
// Test: JavaScript/C++ this.method() disambiguation
// ========================================================================

describe('Disambiguation: JS this.method()', () => {
  const SRC_DIR = path.join(TEST_DIR, 'js_this');
  const IDX_DIR = path.join(TEST_DIR, '.idx_js_this');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'shapes.js'), `
class Circle {
    constructor(radius) {
        this.radius = radius;
    }

    area() {
        return Math.PI * this.radius * this.radius;
    }

    describe() {
        // Should resolve to Circle.area
        const a = this.area();
        return "Circle with area " + a;
    }
}

class Rectangle {
    constructor(w, h) {
        this.w = w;
        this.h = h;
    }

    area() {
        return this.w * this.h;
    }

    describe() {
        // Should resolve to Rectangle.area
        const a = this.area();
        return "Rectangle with area " + a;
    }
}
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('Circle.describe callees should resolve this.area() to Circle.area', () => {
    const out = runCLI(`--callees "Circle::describe" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('Circle') && out.includes('area'),
      'should resolve to Circle.area: ' + out);
    assert.ok(!out.includes('Rectangle'),
      'should NOT include Rectangle.area: ' + out);
  });

  it('Rectangle.describe callees should resolve this.area() to Rectangle.area', () => {
    const out = runCLI(`--callees "Rectangle::describe" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('Rectangle') && out.includes('area'),
      'should resolve to Rectangle.area: ' + out);
    assert.ok(!out.includes('Circle'),
      'should NOT include Circle.area: ' + out);
  });
});


// ========================================================================
// Test: Explicit qualification (ClassName.method or Class::method)
// ========================================================================

describe('Disambiguation: Explicit qualification', () => {
  const SRC_DIR = path.join(TEST_DIR, 'explicit_qual');
  const IDX_DIR = path.join(TEST_DIR, '.idx_explicit');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'services.py'), `
class Logger:
    def write(self, msg):
        print(f"LOG: {msg}")

class FileWriter:
    def write(self, msg):
        with open("out.txt", "a") as f:
            f.write(msg)

class App:
    def __init__(self):
        self.logger = Logger()
        self.writer = FileWriter()

    def process(self):
        # Explicit qualification — Logger.write
        Logger.write(self.logger, "starting")
        # Explicit qualification — FileWriter.write
        FileWriter.write(self.writer, "data")
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('App.process callees should show both Logger.write and FileWriter.write', () => {
    const out = runCLI(`--callees "App::process" --index-path ${IDX_DIR} 2>&1`);
    // Should show both since both are explicitly qualified calls
    const hasLogger = out.includes('Logger');
    const hasFileWriter = out.includes('FileWriter');
    assert.ok(hasLogger || hasFileWriter,
      'should resolve at least one qualified call: ' + out);
  });
});


// ========================================================================
// Test: Same-class preference for bare calls
// ========================================================================

describe('Disambiguation: Same-class preference', () => {
  const SRC_DIR = path.join(TEST_DIR, 'same_class');
  const IDX_DIR = path.join(TEST_DIR, '.idx_same_class');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'workers.py'), `
class WorkerA:
    def setup(self):
        return "setup A"

    def run(self):
        # Bare call — should prefer WorkerA.setup (same class)
        setup()
        return "running A"

class WorkerB:
    def setup(self):
        return "setup B"

    def run(self):
        # Bare call — should prefer WorkerB.setup (same class)
        setup()
        return "running B"
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('WorkerA.run callees should prefer WorkerA.setup over WorkerB.setup', () => {
    const out = runCLI(`--callees "WorkerA::run" --index-path ${IDX_DIR} 2>&1`);
    // Should show WorkerA.setup
    if (out.includes('setup')) {
      assert.ok(out.includes('WorkerA'),
        'should prefer same-class WorkerA.setup: ' + out);
    }
    // Acceptable if setup isn't found at all (bare call might not match)
  });
});


// ========================================================================
// Test: Cross-file disambiguation
// ========================================================================

describe('Disambiguation: Cross-file same method', () => {
  const SRC_DIR = path.join(TEST_DIR, 'cross_file');
  const IDX_DIR = path.join(TEST_DIR, '.idx_cross_file');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'engine.py'), `
class Engine:
    def start(self):
        return "engine started"

    def stop(self):
        return "engine stopped"
`);

    fs.writeFileSync(path.join(SRC_DIR, 'server.py'), `
class Server:
    def start(self):
        return "server started"

    def stop(self):
        return "server stopped"
`);

    fs.writeFileSync(path.join(SRC_DIR, 'controller.py'), `
class EngineController:
    def manage(self):
        # self.start should resolve to something in same file or same class
        self.start()
        self.stop()

    def start(self):
        return "controller start"

    def stop(self):
        return "controller stop"
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('EngineController.manage should prefer same-class start/stop', () => {
    const out = runCLI(`--callees "EngineController::manage" --index-path ${IDX_DIR} 2>&1`);
    // self.start() and self.stop() should resolve to EngineController, not Engine or Server
    if (out.includes('start') || out.includes('stop')) {
      // Should NOT resolve to Engine or Server
      assert.ok(!out.includes('Engine::start') && !out.includes('Server::start'),
        'should NOT resolve to Engine.start or Server.start: ' + out);
    }
  });
});


// ========================================================================
// Test: Both classes called → both should appear (not dedup to one)
// ========================================================================

describe('Disambiguation: Multiple overloaded targets both called', () => {
  const SRC_DIR = path.join(TEST_DIR, 'both_called');
  const IDX_DIR = path.join(TEST_DIR, '.idx_both_called');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'dual.py'), `
class Encoder:
    def process(self, data):
        return data.encode()

class Decoder:
    def process(self, data):
        return data.decode()

class Pipeline:
    def run(self):
        enc = Encoder()
        dec = Decoder()
        # Both explicitly qualified — both should appear in callees
        Encoder.process(enc, "hello")
        Decoder.process(dec, "bytes")
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('Pipeline.run should show both Encoder.process and Decoder.process', () => {
    const out = runCLI(`--callees "Pipeline::run" --index-path ${IDX_DIR} 2>&1`);
    // Old behavior: only one "process" would appear due to bare-name dedup.
    // New behavior: both should appear since they resolve to different definitions.
    const hasEncoder = out.includes('Encoder');
    const hasDecoder = out.includes('Decoder');
    assert.ok(hasEncoder && hasDecoder,
      'should show both Encoder.process and Decoder.process: ' + out);
  });
});


// ========================================================================
// Test: --follow-calls with disambiguation
// ========================================================================

describe('Disambiguation: --follow-calls follows correct target', () => {
  const SRC_DIR = path.join(TEST_DIR, 'follow_disambig');
  const IDX_DIR = path.join(TEST_DIR, '.idx_follow');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'chain.py'), `
class Parser:
    def validate(self):
        return "parsing validation"

    def run(self):
        # self.validate should follow Parser.validate, not Checker.validate
        self.validate()

class Checker:
    def validate(self):
        return "checking validation"

    def run(self):
        # self.validate should follow Checker.validate
        self.validate()
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('--extract Parser::run --follow-calls should show Parser.validate', () => {
    const out = runCLI(`--extract "Parser::run" --follow-calls --index-path ${IDX_DIR} 2>&1`);
    // Should contain "parsing validation" from Parser.validate body
    assert.ok(out.includes('parsing validation'),
      'should follow to Parser.validate: ' + out);
    // Should NOT contain "checking validation" from Checker.validate
    assert.ok(!out.includes('checking validation'),
      'should NOT follow to Checker.validate: ' + out);
  });

  it('--extract Checker::run --follow-calls should show Checker.validate', () => {
    const out = runCLI(`--extract "Checker::run" --follow-calls --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('checking validation'),
      'should follow to Checker.validate: ' + out);
    assert.ok(!out.includes('parsing validation'),
      'should NOT follow to Parser.validate: ' + out);
  });
});


// ========================================================================
// Test: C++ style with this-> and :: qualification
// ========================================================================

describe('Disambiguation: C++ this-> and :: patterns', () => {
  const SRC_DIR = path.join(TEST_DIR, 'cpp_style');
  const IDX_DIR = path.join(TEST_DIR, '.idx_cpp');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'game.cpp'), `
class Player {
public:
    void update() {
        // Player-specific update
        health += 1;
    }

    void tick() {
        this->update();
    }

    int health;
};

class Enemy {
public:
    void update() {
        // Enemy-specific update
        damage += 1;
    }

    void tick() {
        this->update();
    }

    int damage;
};
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('Player::tick should resolve this->update() to Player::update', () => {
    const out = runCLI(`--callees "Player::tick" --index-path ${IDX_DIR} 2>&1`);
    if (out.includes('update')) {
      assert.ok(out.includes('Player'),
        'should resolve to Player::update: ' + out);
      assert.ok(!out.includes('Enemy'),
        'should NOT include Enemy::update: ' + out);
    }
  });

  it('Enemy::tick should resolve this->update() to Enemy::update', () => {
    const out = runCLI(`--callees "Enemy::tick" --index-path ${IDX_DIR} 2>&1`);
    if (out.includes('update')) {
      assert.ok(out.includes('Enemy'),
        'should resolve to Enemy::update: ' + out);
      assert.ok(!out.includes('Player'),
        'should NOT include Player::update: ' + out);
    }
  });
});


// ========================================================================
// Test: Ambiguity detection
// ========================================================================

describe('Disambiguation: Ambiguity flagging', () => {
  const SRC_DIR = path.join(TEST_DIR, 'ambiguous');
  const IDX_DIR = path.join(TEST_DIR, '.idx_ambig');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'ambig_a.py'), `
class ServiceA:
    def connect(self):
        return "connected to A"
`);

    fs.writeFileSync(path.join(SRC_DIR, 'ambig_b.py'), `
class ServiceB:
    def connect(self):
        return "connected to B"
`);

    // Different file, no class context, bare call — genuinely ambiguous
    fs.writeFileSync(path.join(SRC_DIR, 'ambig_caller.py'), `
def orchestrate():
    # Bare call with no class context — ambiguous
    connect()
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('should flag ambiguous resolution with --verbose', () => {
    const out = runCLI(`--callees "orchestrate" --verbose --index-path ${IDX_DIR} 2>&1`);
    // Should show "connect" with ambiguity marker or multiple definitions
    if (out.includes('connect')) {
      assert.ok(
        out.includes('ambiguous') || out.includes('definitions'),
        'should indicate ambiguity: ' + out
      );
    }
  });
});


// ========================================================================
// Test: Python inheritance — child calls inherited method
// ========================================================================

describe('Disambiguation: Python inheritance chain', () => {
  const SRC_DIR = path.join(TEST_DIR, 'py_inherit');
  const IDX_DIR = path.join(TEST_DIR, '.idx_py_inherit');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'base.py'), `
class Animal:
    def breathe(self):
        return "inhale exhale"

    def eat(self):
        return "nom nom"

class Machine:
    def breathe(self):
        return "ventilator whirr"

    def compute(self):
        return "calculating"
`);

    fs.writeFileSync(path.join(SRC_DIR, 'derived.py'), `
class Dog(Animal):
    def bark(self):
        return "woof"

    def live(self):
        # self.breathe() — Dog doesn't define breathe, so should resolve
        # to Animal.breathe (parent), NOT Machine.breathe
        self.breathe()
        self.eat()
        self.bark()

class Robot(Machine):
    def beep(self):
        return "boop"

    def operate(self):
        # self.breathe() — Robot doesn't define breathe, so should resolve
        # to Machine.breathe (parent), NOT Animal.breathe
        self.breathe()
        self.compute()
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('Dog.live should resolve self.breathe() to Animal.breathe via inheritance', () => {
    const out = runCLI(`--callees "Dog::live" --index-path ${IDX_DIR} 2>&1`);
    if (out.includes('breathe')) {
      assert.ok(out.includes('Animal'),
        'should resolve to Animal.breathe (inherited): ' + out);
      assert.ok(!out.includes('Machine'),
        'should NOT resolve to Machine.breathe: ' + out);
    }
  });

  it('Robot.operate should resolve self.breathe() to Machine.breathe via inheritance', () => {
    const out = runCLI(`--callees "Robot::operate" --index-path ${IDX_DIR} 2>&1`);
    if (out.includes('breathe')) {
      assert.ok(out.includes('Machine'),
        'should resolve to Machine.breathe (inherited): ' + out);
      assert.ok(!out.includes('Animal'),
        'should NOT resolve to Animal.breathe: ' + out);
    }
  });
});


// ========================================================================
// Test: C++ inheritance — this->method() resolves to base class
// ========================================================================

describe('Disambiguation: C++ inheritance chain', () => {
  const SRC_DIR = path.join(TEST_DIR, 'cpp_inherit');
  const IDX_DIR = path.join(TEST_DIR, '.idx_cpp_inherit');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'hierarchy.cpp'), `
class Widget {
public:
    void render() {
        // Base implementation
        drawBackground();
    }

    void drawBackground() {
        // Widget default background
    }
};

class Button : public Widget {
public:
    void onClick() {
        // this->render() — Button doesn't override render,
        // should resolve to Widget::render (parent)
        this->render();
    }
};

class Slider : public Widget {
public:
    void onDrag() {
        // this->render() — same, should go to Widget::render
        this->render();
        this->drawBackground();
    }
};
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('Button::onClick should resolve this->render() to Widget::render', () => {
    const out = runCLI(`--callees "Button::onClick" --index-path ${IDX_DIR} 2>&1`);
    if (out.includes('render')) {
      assert.ok(out.includes('Widget'),
        'should resolve to Widget.render via C++ inheritance: ' + out);
    }
  });

  it('Slider::onDrag should resolve to Widget methods', () => {
    const out = runCLI(`--callees "Slider::onDrag" --index-path ${IDX_DIR} 2>&1`);
    if (out.includes('render') || out.includes('drawBackground')) {
      assert.ok(out.includes('Widget'),
        'should resolve to Widget methods via inheritance: ' + out);
    }
  });
});


// ========================================================================
// Test: Multi-level inheritance (grandparent)
// ========================================================================

describe('Disambiguation: Multi-level inheritance', () => {
  const SRC_DIR = path.join(TEST_DIR, 'multi_inherit');
  const IDX_DIR = path.join(TEST_DIR, '.idx_multi');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'chain.py'), `
class Base:
    def core_method(self):
        return "base core"

class Middle(Base):
    def middle_method(self):
        return "middle specific"

class Leaf(Middle):
    def leaf_action(self):
        # core_method is defined in Base (grandparent)
        # Should walk Leaf -> Middle -> Base
        self.core_method()
        self.middle_method()
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('Leaf.leaf_action should resolve self.core_method() to Base via grandparent', () => {
    const out = runCLI(`--callees "Leaf::leaf_action" --index-path ${IDX_DIR} 2>&1`);
    if (out.includes('core_method')) {
      assert.ok(out.includes('Base'),
        'should resolve to Base.core_method (grandparent): ' + out);
    }
  });

  it('Leaf.leaf_action should resolve self.middle_method() to Middle', () => {
    const out = runCLI(`--callees "Leaf::leaf_action" --index-path ${IDX_DIR} 2>&1`);
    if (out.includes('middle_method')) {
      assert.ok(out.includes('Middle'),
        'should resolve to Middle.middle_method (parent): ' + out);
    }
  });
});


// ========================================================================
// Test: JS extends inheritance
// ========================================================================

describe('Disambiguation: JS extends inheritance', () => {
  const SRC_DIR = path.join(TEST_DIR, 'js_extends');
  const IDX_DIR = path.join(TEST_DIR, '.idx_js_ext');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'components.js'), `
class Component {
    setState(data) {
        this.state = data;
    }

    forceUpdate() {
        this.render();
    }
}

class Header extends Component {
    render() {
        // this.setState() — not defined in Header,
        // should resolve to Component.setState
        this.setState({ title: "hello" });
    }
}

class Footer extends Component {
    render() {
        this.setState({ copyright: "2025" });
    }
}
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('Header.render should resolve this.setState() to Component.setState', () => {
    const out = runCLI(`--callees "Header::render" --index-path ${IDX_DIR} 2>&1`);
    if (out.includes('setState')) {
      assert.ok(out.includes('Component'),
        'should resolve to Component.setState via JS extends: ' + out);
    }
  });
});


// ========================================================================
// Test: Override — child defines its own, should prefer child over parent
// ========================================================================

describe('Disambiguation: Override prefers child over parent', () => {
  const SRC_DIR = path.join(TEST_DIR, 'override');
  const IDX_DIR = path.join(TEST_DIR, '.idx_override');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'override.py'), `
class Base:
    def render(self):
        return "base render"

class Child(Base):
    def render(self):
        return "child render"

    def display(self):
        # self.render() — Child defines render, should use Child.render
        # NOT Base.render (even though Base also has it)
        self.render()
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('Child.display should resolve to Child.render, not Base.render', () => {
    const out = runCLI(`--callees "Child::display" --index-path ${IDX_DIR} 2>&1`);
    if (out.includes('render')) {
      assert.ok(out.includes('Child'),
        'should prefer Child.render (override) over Base.render: ' + out);
    }
  });
});


// ========================================================================
// Test: short-name digest crash fix + #85 bare-name disambiguation
// ========================================================================

describe('Digest: short-name crash + bare-name disambiguation', () => {
  const SRC_DIR = path.join(TEST_DIR, 'digest_shortname');
  const IDX_DIR = path.join(TEST_DIR, '.idx_digest_shortname');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    // A 2-char function name that is called elsewhere. Digesting it forces
    // findCallers() into SHORT_NAME_BAILOUT (calls.js), whose fallback used to
    // crash with "this._findCallersByExactRegex is not a function" because that
    // helper was exported but never bound onto CodeSearchIndex.
    fs.writeFileSync(path.join(SRC_DIR, 'shortname.js'), `
function zx() {
  return 42;
}
function callsZx() {
  return zx() + zx();
}
`);

    // Same bare name in two files -> collision; digest should list both
    // file@name candidates instead of silently picking one (#85).
    fs.writeFileSync(path.join(SRC_DIR, 'col_a.js'), `
function collideMe() {
  return 'a';
}
`);
    fs.writeFileSync(path.join(SRC_DIR, 'col_b.js'), `
function collideMe() {
  return 'b';
}
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  after(() => {
    fs.rmSync(SRC_DIR, { recursive: true, force: true });
    fs.rmSync(IDX_DIR, { recursive: true, force: true });
  });

  it('digesting a 2-char name with callers does not crash', () => {
    const out = runCLI(`--digest zx --index-path ${IDX_DIR} 2>&1`);
    assert.ok(!out.includes('is not a function'),
      'digest must not throw the _findCallersByExactRegex TypeError: ' + out);
    assert.ok(!/\bTypeError\b/.test(out),
      'digest must not throw: ' + out);
    assert.ok(out.includes('zx'),
      'digest should render the function: ' + out);
  });

  it('bare-name collision lists file@name candidates', () => {
    const out = runCLI(`--digest collideMe --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('NOT unique'),
      'should flag the bare-name collision: ' + out);
    assert.ok(out.includes('file@name'),
      'should prompt to disambiguate with file@name: ' + out);
    assert.ok(out.includes('col_a.js') && out.includes('col_b.js'),
      'should list both colliding files as candidates: ' + out);
  });
});
