// test_treesitter_added_grammars.js — the Kotlin, Swift, Scala and Objective-C grammars: every declaration kind by name and span, extension functions under their receiver, Swift computed properties and extensions, Objective-C selectors, the .m MATLAB sniff
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// tree-sitter-kotlin-swift-grammars (2026-11-13). Before this the four
// languages were at the regex tier: Kotlin extension functions were filed
// under their receiver type (`fun Fragment.waitForIdle()` listed as a function
// named `Fragment`, 23 of 23 in the Architecture Components samples), Swift
// computed properties and `extension` blocks were unseen (59 of 59 `var body`
// in the SwiftUI Tutorials, 101 of 101 in OpenClaw), and Scala and
// Objective-C had patterns and no measurement. The inline sources below are
// the fixtures for those shapes; every expected span was read from the
// grammar's own parse of the same text.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TreeSitterParser, looksObjectiveC } from '../src/core/TreeSitterParser.js';

const KT = `package demo

import android.view.View

fun topLevel(a: Int): Int = a + 1

fun View.fadeIn(duration: Long = 300) {
    animate().alpha(1f).setDuration(duration)
}

suspend fun <T> fetch(block: suspend () -> T): T = block()

class Repo(private val api: Api) {
    fun load(id: String): User? {
        return api.get(id)
    }

    constructor(api: Api, cache: Cache) : this(api) {
        warm(cache)
    }

    private fun warm(cache: Cache) {
        cache.clear()
    }

    companion object {
        fun create(): Repo = Repo(Api())
        const val TAG = "Repo"
    }
}

data class User(val id: String, val name: String)

sealed class Result {
    data class Ok(val value: Int) : Result()
    object Fail : Result()
}

enum class Color { RED, GREEN }

interface Api {
    fun get(id: String): User?
}

object Singleton {
    fun instance(): Singleton = this
}

val lambda = { x: Int -> x * 2 }
`.split('\n');

const SWIFT = `import SwiftUI

struct ContentView: View {
    @State private var count = 0
    var body: some View {
        Text("\\(count)")
    }
    func reset() {
        count = 0
    }
}

class Store: ObservableObject {
    @Published var items: [Int] = []
    init(items: [Int]) {
        self.items = items
    }
    deinit {
        items.removeAll()
    }
    subscript(i: Int) -> Int {
        return items[i]
    }
    static func shared() -> Store {
        return Store(items: [])
    }
}

extension Store {
    func add(_ x: Int) {
        items.append(x)
    }
    var total: Int { items.reduce(0, +) }
}

protocol Shape {
    func area() -> Double
}

enum Direction {
    case north, south
    func opposite() -> Direction {
        return self == .north ? .south : .north
    }
}

actor Counter {
    var value = 0
    func increment() { value += 1 }
}

func topLevel(a: Int) -> Int {
    return a + 1
}

let closure = { (x: Int) -> Int in x * 2 }
`.split('\n');

const SCALA = `package demo

import scala.collection.mutable

object Util {
  def helper(x: Int): Int = x + 1
  private def inner(): Unit = {
    def nested(y: Int) = y
    nested(1)
  }
  val f = (x: Int) => x * 2
}

class Repo(api: Api) extends Base with Logging {
  def load(id: String): Option[User] = {
    api.get(id)
  }
  override def toString: String = "Repo"
}

case class User(id: String, name: String) {
  def display: String = s"$name ($id)"
}

case object Empty

trait Api {
  def get(id: String): Option[User]
  def ping(): Unit = ()
}

abstract class Base {
  def name: String
}

sealed trait Result
final case class Ok(v: Int) extends Result
`.split('\n');

const OBJC = `#import <Foundation/Foundation.h>

@protocol Greeter <NSObject>
- (NSString *)greet:(NSString *)name;
@end

@interface Person : NSObject
@property (nonatomic, copy) NSString *name;
- (instancetype)initWithName:(NSString *)name;
- (void)sayHelloTo:(NSString *)other withPrefix:(NSString *)prefix;
+ (instancetype)personNamed:(NSString *)name;
@end

@implementation Person

- (instancetype)initWithName:(NSString *)name {
    self = [super init];
    if (self) { _name = [name copy]; }
    return self;
}

- (void)sayHelloTo:(NSString *)other withPrefix:(NSString *)prefix {
    NSLog(@"%@ %@ -> %@", prefix, _name, other);
}

+ (instancetype)personNamed:(NSString *)name {
    return [[self alloc] initWithName:name];
}

@end

@interface Person (Extras)
- (BOOL)isAnonymous;
@end

@implementation Person (Extras)
- (BOOL)isAnonymous {
    return _name.length == 0;
}
@end

static int helper(int x) {
    return x + 1;
}

struct point { int x; int y; };
`.split('\n');

const MATLAB = `function y = square(x)
% SQUARE returns the square of x
  y = x .* x;
end
`.split('\n');

function spans(r) {
  const out = {};
  for (const [name, e] of Object.entries(r)) out[name] = [e.start, e.end, e.type, e.kind || e.receiver || ''];
  return out;
}

describe('tree-sitter grammars added 2026-11-13: Kotlin, Swift, Scala, Objective-C', () => {
  it('the four grammars are vendored and load under the shipped web-tree-sitter', async () => {
    const ts = new TreeSitterParser();
    if (!(await ts.init())) return;
    for (const lang of ['kotlin', 'swift', 'scala', 'objc']) {
      assert.ok(ts.getAvailableGrammars().includes(lang), `${lang} grammar is in grammars/`);
      assert.ok(await ts.getLanguage(lang), `${lang} grammar loads (dylink.0; the tree-sitter-wasms bundle's legacy dylink files did not)`);
    }
  });

  it('Kotlin: classes, objects, companions, interfaces, enums; functions under their class; an extension function under its receiver, never named by it', async () => {
    const ts = new TreeSitterParser();
    if (!(await ts.init())) return;
    const r = await ts.parseFunctions('Demo.kt', KT);
    assert.ok(r, 'parsed with the grammar');
    assert.equal(ts.stats.filesWithErrors, 0, 'no error recovery on the sample');
    const s = spans(r);
    assert.deepEqual(s.topLevel, [5, 5, 'function', '']);
    assert.deepEqual(s['View::fadeIn'], [7, 9, 'method', 'View'], 'the receiver is a qualifier and the receiver field, not the name');
    assert.equal(s.View, undefined, 'no function named after the receiver');
    assert.equal(r['View::fadeIn'].base_name, 'fadeIn');
    assert.deepEqual(s.fetch, [11, 11, 'function', '']);
    assert.deepEqual(s.Repo, [13, 30, 'class', '']);
    assert.deepEqual(s['Repo::load'], [14, 16, 'method', '']);
    assert.deepEqual(s['Repo::constructor'], [18, 20, 'method', '']);
    assert.deepEqual(s['Repo::warm'], [22, 24, 'method', '']);
    assert.deepEqual(s['Repo::Companion'], [26, 29, 'class', '']);
    assert.deepEqual(s['Repo::create'], [27, 27, 'method', ''], "a companion's function belongs to the class, as Kotlin calls it");
    assert.deepEqual(s.User, [32, 32, 'class', '']);
    assert.deepEqual(s.Result, [34, 37, 'class', '']);
    assert.deepEqual(s.Ok, [35, 35, 'class', '']);
    assert.deepEqual(s.Fail, [36, 36, 'class', '']);
    assert.deepEqual(s.Color, [39, 39, 'class', '']);
    assert.deepEqual(s.Api, [41, 43, 'class', '']);
    assert.deepEqual(s['Api::get'], [42, 42, 'method', '']);
    assert.deepEqual(s.Singleton, [45, 47, 'class', '']);
    assert.deepEqual(s['Singleton::instance'], [46, 46, 'method', '']);
    for (const absent of ['lambda', 'TAG', 'api']) assert.equal(s[absent], undefined, `${absent} is not a definition`);
    assert.equal(Object.keys(r).length, 18);
  });

  it('Swift: struct, class, enum, actor and protocol as types; init, deinit, subscript; computed properties as functions; extension members under the extended type', async () => {
    const ts = new TreeSitterParser();
    if (!(await ts.init())) return;
    const r = await ts.parseFunctions('Demo.swift', SWIFT);
    assert.ok(r, 'parsed with the grammar');
    assert.equal(ts.stats.filesWithErrors, 0);
    const s = spans(r);
    assert.deepEqual(s.ContentView, [3, 11, 'class', 'struct']);
    assert.deepEqual(s['ContentView::body'], [5, 7, 'method', 'computed-property'], "a SwiftUI view's body is where its content lives");
    assert.deepEqual(s['ContentView::reset'], [8, 10, 'method', '']);
    assert.deepEqual(s.Store, [13, 27, 'class', 'class']);
    assert.deepEqual(s['Store::init'], [15, 17, 'method', '']);
    assert.deepEqual(s['Store::deinit'], [18, 20, 'method', '']);
    assert.deepEqual(s['Store::subscript'], [21, 23, 'method', '']);
    assert.deepEqual(s['Store::shared'], [24, 26, 'method', '']);
    assert.deepEqual(s['Store::add'], [30, 32, 'method', ''], 'an extension method belongs to the type it extends');
    assert.deepEqual(s['Store::total'], [33, 33, 'method', 'computed-property']);
    assert.equal(Object.keys(s).find((n) => /^Store@/.test(n)), undefined, 'the extension block is not a second Store type');
    assert.deepEqual(s.Shape, [36, 38, 'class', 'protocol']);
    assert.deepEqual(s['Shape::area'], [37, 37, 'method', '']);
    assert.deepEqual(s.Direction, [40, 45, 'class', 'enum']);
    assert.deepEqual(s['Direction::opposite'], [42, 44, 'method', '']);
    assert.deepEqual(s.Counter, [47, 50, 'class', 'actor']);
    assert.deepEqual(s['Counter::increment'], [49, 49, 'method', '']);
    assert.deepEqual(s.topLevel, [52, 54, 'function', '']);
    for (const absent of ['closure', 'ContentView::count', 'Store::items', 'Counter::value']) assert.equal(s[absent], undefined, `${absent} is not a definition`);
    assert.equal(Object.keys(r).length, 17);
  });

  it('Scala: classes, case classes, objects, case objects and traits as types with their kind; defs under their type, nested defs included; a val holding a lambda is not a definition', async () => {
    const ts = new TreeSitterParser();
    if (!(await ts.init())) return;
    const r = await ts.parseFunctions('Demo.scala', SCALA);
    assert.ok(r, 'parsed with the grammar');
    assert.equal(ts.stats.filesWithErrors, 0);
    const s = spans(r);
    assert.deepEqual(s.Util, [5, 12, 'class', 'object']);
    assert.deepEqual(s['Util::helper'], [6, 6, 'method', '']);
    assert.deepEqual(s['Util::inner'], [7, 10, 'method', '']);
    assert.deepEqual(s['Util::nested'], [8, 8, 'method', '']);
    assert.deepEqual(s.Repo, [14, 19, 'class', 'class']);
    assert.deepEqual(s['Repo::load'], [15, 17, 'method', '']);
    assert.deepEqual(s['Repo::toString'], [18, 18, 'method', '']);
    assert.deepEqual(s.User, [21, 23, 'class', 'case class']);
    assert.deepEqual(s['User::display'], [22, 22, 'method', '']);
    assert.deepEqual(s.Empty, [25, 25, 'class', 'case object']);
    assert.deepEqual(s.Api, [27, 30, 'class', 'trait']);
    assert.deepEqual(s['Api::get'], [28, 28, 'method', ''], 'an abstract def is a declaration the grammar still names');
    assert.deepEqual(s['Api::ping'], [29, 29, 'method', '']);
    assert.deepEqual(s.Base, [32, 34, 'class', 'class']);
    assert.deepEqual(s['Base::name'], [33, 33, 'method', '']);
    assert.deepEqual(s.Result, [36, 36, 'class', 'trait']);
    assert.deepEqual(s.Ok, [37, 37, 'class', 'case class']);
    assert.equal(s['Util::f'], undefined, 'a val is not a definition');
    assert.equal(Object.keys(r).length, 17);
  });

  it('Objective-C: protocol, interface and implementation as types; methods by full selector under their class, categories under the class they extend; C functions and structs as in C', async () => {
    const ts = new TreeSitterParser();
    if (!(await ts.init())) return;
    const r = await ts.parseFunctions('Demo.m', OBJC);
    assert.ok(r, 'parsed with the grammar');
    assert.equal(ts.stats.filesWithErrors, 0);
    const s = spans(r);
    assert.deepEqual(s.Greeter, [3, 5, 'class', 'protocol']);
    assert.deepEqual(s['Greeter::greet:'], [4, 4, 'method', ''], 'a protocol requirement is recorded');
    assert.deepEqual(s.Person, [7, 12, 'class', 'interface']);
    assert.deepEqual(s['Person@14'], [14, 30, 'class', 'implementation']);
    assert.deepEqual(s['Person::initWithName:'], [16, 20, 'method', '']);
    assert.deepEqual(s['Person::sayHelloTo:withPrefix:'], [22, 24, 'method', ''], 'the selector is kept whole');
    assert.equal(r['Person::sayHelloTo:withPrefix:'].base_name, 'sayHelloTo:withPrefix:');
    assert.deepEqual(s['Person::personNamed:'], [26, 28, 'method', '']);
    assert.deepEqual(s['Person::isAnonymous'], [37, 39, 'method', ''], "a category's method belongs to the class");
    assert.deepEqual(s.helper, [42, 44, 'function', '']);
    assert.deepEqual(s.point, [46, 46, 'class', '']);
    assert.equal(s.Extras, undefined, 'a category is not a type');
    assert.equal(Object.keys(s).filter((n) => /^Person::/.test(n)).length, 4, "the interface's method declarations do not duplicate the implementation's definitions");
    assert.equal(Object.keys(r).length, 10);
  });

  it('.m is sniffed: a MATLAB file goes to the regex tier, an Objective-C file to the grammar, .mm always to the grammar', async () => {
    assert.equal(looksObjectiveC(MATLAB), false);
    assert.equal(looksObjectiveC(OBJC), true);
    const ts = new TreeSitterParser();
    if (!(await ts.init())) return;
    assert.equal(await ts.parseFunctions('square.m', MATLAB), null, 'null signals the regex fallback');
    assert.ok(await ts.parseFunctions('Demo.m', OBJC));
    const mm = await ts.parseFunctions('Demo.mm', OBJC);
    assert.ok(mm && mm['Person::sayHelloTo:withPrefix:'], '.mm is Objective-C++ and never MATLAB');
  });
});
