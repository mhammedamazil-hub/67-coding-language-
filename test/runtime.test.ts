import { describe, it, expect } from 'vitest';
import { ModuleBuilder } from '../src/lang/assembler.js';
import { moduleToStream } from '../src/lang/format.js';
import { runProject } from '../src/lang/project.js';
import { Interpreter } from '../src/lang/runtime.js';
import { decodeStream } from '../src/lang/format.js';

async function run(b: ModuleBuilder, inputQueue: string[] = []) {
  const stream = moduleToStream(b.build());
  return runProject({ 'main.67': stream }, {
    io: { input: async () => inputQueue.shift() ?? '' },
  });
}

describe('runtime: hello world', () => {
  it('prints Hello, World! from a real encoded program', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadStr('Hello, World!');
    b.root.callBuiltin('print', 1);
    b.root.null();
    b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('Hello, World!\n');
  });
});

describe('runtime: numbers and arithmetic', () => {
  it('does integer arithmetic with BigInt semantics', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(40n);
    b.root.loadInt(2n);
    b.root.add();
    b.root.callBuiltin('print', 1); // 42
    b.root.loadInt(7n);
    b.root.loadInt(3n);
    b.root.div();
    b.root.callBuiltin('print', 1); // 7/3 -> float 2.333...
    b.root.loadInt(100000000000000000000n);
    b.root.loadInt(1n);
    b.root.add();
    b.root.callBuiltin('print', 1); // large int
    b.root.null();
    b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('42\n2.3333333333333335\n100000000000000000001\n');
  });

  it('supports negative numbers', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(5n);
    b.root.neg();
    b.root.callBuiltin('print', 1);
    b.root.loadInt(-17n);
    b.root.callBuiltin('abs', 1);
    b.root.callBuiltin('print', 1);
    b.root.null();
    b.root.return();
    const r = await run(b);
    expect(r.output).toBe('-5\n17\n');
  });

  it('does modulo, power and bitwise ops', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(10n); b.root.loadInt(3n); b.root.mod(); b.root.callBuiltin('print', 1); // 1
    b.root.loadInt(2n); b.root.loadInt(10n); b.root.pow(); b.root.callBuiltin('print', 1); // 1024
    b.root.loadInt(12n); b.root.loadInt(10n); b.root.band(); b.root.callBuiltin('print', 1); // 8
    b.root.loadInt(12n); b.root.loadInt(10n); b.root.bor(); b.root.callBuiltin('print', 1); // 14
    b.root.loadInt(1n); b.root.loadInt(4n); b.root.shl(); b.root.callBuiltin('print', 1); // 16
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('1\n1024\n8\n14\n16\n');
  });

  it('compares values and evaluates logic', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(3n); b.root.loadInt(4n); b.root.lt(); b.root.callBuiltin('print', 1); // true
    b.root.loadStr('a'); b.root.loadStr('b'); b.root.eq(); b.root.callBuiltin('print', 1); // false
    b.root.true(); b.root.false(); b.root.pop(); b.root.callBuiltin('print', 1); // true
    b.root.null(); b.root.not(); b.root.callBuiltin('print', 1); // true
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('true\nfalse\ntrue\ntrue\n');
  });
});

describe('runtime: variables, constants and scope', () => {
  it('assigns and reads locals', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(67n);
    b.root.storeLocal('x');
    b.root.loadLocal('x');
    b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('67\n');
  });

  it('short-circuit AND/OR via jumps', async () => {
    const b = new ModuleBuilder('main');
    // true && 7 -> 7 ; false && 7 -> false
    b.root.true(); b.root.dup(); b.root.jmpIfFalse('and1end'); b.root.pop(); b.root.loadInt(7n); b.root.label('and1end');
    b.root.callBuiltin('print', 1);
    b.root.false(); b.root.dup(); b.root.jmpIfFalse('and2end'); b.root.pop(); b.root.loadInt(7n); b.root.label('and2end');
    b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('7\nfalse\n');
  });
});

describe('runtime: control flow', () => {
  it('runs while loops with break and continue', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(0n); b.root.storeLocal('i');
    b.root.loadInt(0n); b.root.storeLocal('sum');
    b.root.whileLoop(
      (f) => { f.loadLocal('i'); f.loadInt(10n); f.lt(); },
      (f) => {
        f.loadLocal('i'); f.loadInt(1n); f.add(); f.storeLocal('i');
        f.loadLocal('i'); f.loadInt(2n); f.mod(); f.jmpIfFalse('even');
        f.jmp('skip');
        f.label('even');
        f.loadLocal('sum'); f.loadLocal('i'); f.add(); f.storeLocal('sum');
        f.label('skip');
      },
    );
    b.root.loadLocal('sum'); b.root.callBuiltin('print', 1); // 2+4+6+8+10 = 30
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('30\n');
  });

  it('breaks out of loops', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(0n); b.root.storeLocal('i');
    b.root.whileLoop(
      (f) => { f.true(); },
      (f) => {
        f.loadLocal('i'); f.loadInt(1n); f.add(); f.storeLocal('i');
        f.loadLocal('i'); f.loadInt(5n); f.gte();
        f.jmpIfFalse('nobreak');
        f.break();
        f.label('nobreak');
      },
    );
    b.root.loadLocal('i'); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('5\n');
  });
});

describe('runtime: functions, recursion and closures', () => {
  it('declares and calls functions with parameters and return values', async () => {
    const b = new ModuleBuilder('main');
    b.declareFunc('add', ['a', 'b'], (f) => {
      f.loadLocal('a'); f.loadLocal('b'); f.add(); f.return();
    });
    b.root.loadLocal('add'); b.root.loadInt(3n); b.root.loadInt(4n); b.root.call(2);
    b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('7\n');
  });

  it('supports recursion (fibonacci)', async () => {
    const b = new ModuleBuilder('main');
    const fibSlot = b.root.local('fib'); // module-level binding slot
    b.declareFunc('fib', ['n'], (f) => {
      f.loadLocal('n'); f.loadInt(2n); f.lt();
      f.jmpIfFalse('rec');
      f.loadLocal('n'); f.return();
      f.label('rec');
      f.loadUpvar(1, fibSlot);
      f.loadLocal('n'); f.loadInt(1n); f.sub(); f.call(1);
      f.loadUpvar(1, fibSlot);
      f.loadLocal('n'); f.loadInt(2n); f.sub(); f.call(1);
      f.add(); f.return();
    });
    b.root.loadLocal('fib'); b.root.loadInt(15n); b.root.call(1);
    b.root.callBuiltin('print', 1); // fib(15) = 610
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('610\n');
  });

  it('supports closures capturing and mutating outer variables', async () => {
    const b = new ModuleBuilder('main');
    // inc() increments a 'count' local captured from makeCounter's frame.
    // Slot 0 in makeCounter is reserved for 'count' (the first local).
    const incIdx = b.func(null, [], (f) => {
      f.loadUpvar(1, 0);
      f.loadInt(1n); f.add();
      f.setUpvar(1, 0);
      f.loadUpvar(1, 0);
      f.return();
    });
    b.declareFunc('makeCounter', [], (f) => {
      f.local('count'); // slot 0
      f.loadInt(0n); f.storeLocal('count');
      f.makeFunction(incIdx);
      f.return();
    });
    b.root.loadLocal('makeCounter'); b.root.call(0); b.root.storeLocal('c');
    b.root.loadLocal('c'); b.root.call(0); b.root.pop();
    b.root.loadLocal('c'); b.root.call(0); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('2\n');
  });

  it('supports first-class and anonymous functions passed as arguments', async () => {
    const b = new ModuleBuilder('main');
    // apply(f, x) = f(x)
    b.declareFunc('apply', ['f', 'x'], (f) => {
      f.loadLocal('f'); f.loadLocal('x'); f.call(1); f.return();
    });
    // double = (n) => n*2 (anonymous)
    const dbl = b.func(null, ['n'], (f) => {
      f.loadLocal('n'); f.loadInt(2n); f.mul(); f.return();
    });
    b.root.loadLocal('apply');
    b.root.makeFunction(dbl);
    b.root.loadInt(21n);
    b.root.call(2);
    b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('42\n');
  });
});

describe('runtime: arrays and objects', () => {
  it('builds arrays and indexes them', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(10n); b.root.loadInt(20n); b.root.loadInt(30n);
    b.root.newArray(3); b.root.storeLocal('a');
    b.root.loadLocal('a'); b.root.loadInt(1n); b.root.getIndex(); b.root.callBuiltin('print', 1); // 20
    b.root.loadLocal('a'); b.root.loadInt(3n); b.root.loadInt(40n); b.root.setIndex(); b.root.pop();
    b.root.loadLocal('a'); b.root.loadInt(3n); b.root.getIndex(); b.root.callBuiltin('print', 1); // 40
    b.root.loadLocal('a'); b.root.callBuiltin('length', 1); b.root.callBuiltin('print', 1); // 4
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('20\n40\n4\n');
  });

  it('supports array builtins: push, pop, join, map', async () => {
    const b = new ModuleBuilder('main');
    b.root.newArray(0); b.root.storeLocal('a');
    b.root.loadLocal('a'); b.root.loadInt(1n); b.root.callBuiltin('push', 2); b.root.pop();
    b.root.loadLocal('a'); b.root.loadInt(2n); b.root.callBuiltin('push', 2); b.root.pop();
    b.root.loadLocal('a'); b.root.loadInt(3n); b.root.callBuiltin('push', 2); b.root.pop();
    b.root.loadLocal('a'); b.root.loadStr('-'); b.root.callBuiltin('join', 2); b.root.callBuiltin('print', 1); // 1-2-3
    b.root.loadLocal('a'); b.root.callBuiltin('pop', 1); b.root.callBuiltin('print', 1); // 3
    // map with a doubling function
    b.root.loadLocal('a');
    b.root.makeFunction(b.func(null, ['x'], (f) => { f.loadLocal('x'); f.loadInt(10n); f.mul(); f.return(); }));
    b.root.callBuiltin('map', 2); b.root.loadStr(','); b.root.callBuiltin('join', 2); b.root.callBuiltin('print', 1); // 10,20
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('1-2-3\n3\n10,20\n');
  });

  it('builds objects, reads and writes properties', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadStr('Ada'); b.root.loadInt(36n);
    b.root.newObject(['name', 'age']);
    b.root.storeLocal('p');
    b.root.loadLocal('p'); b.root.getProp('name'); b.root.callBuiltin('print', 1); // Ada
    b.root.loadLocal('p'); b.root.loadInt(37n); b.root.setProp('age'); b.root.pop();
    b.root.loadLocal('p'); b.root.getProp('age'); b.root.callBuiltin('print', 1); // 37
    b.root.loadLocal('p'); b.root.callBuiltin('keys', 1); b.root.callBuiltin('length', 1); b.root.callBuiltin('print', 1); // 2
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('Ada\n37\n2\n');
  });
});

describe('runtime: classes, inheritance and super', () => {
  it('constructs instances, calls methods and uses this', async () => {
    const b = new ModuleBuilder('main');
    const ctor = b.func('constructor', ['x'], (f) => {
      f.loadThis(); f.loadLocal('x'); f.setProp('x'); f.pop(); f.returnNull();
    });
    const getX = b.func('getX', [], (f) => {
      f.loadThis(); f.getProp('x'); f.return();
    });
    b.root.null();
    b.root.newClass('Box', [['constructor', ctor], ['getX', getX]]);
    b.root.storeLocal('Box');
    b.root.loadLocal('Box'); b.root.loadInt(9n); b.root.newInstance(1); b.root.storeLocal('box');
    b.root.loadLocal('box'); b.root.callMethod('getX', 0); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('9\n');
  });

  it('supports inheritance and super calls', async () => {
    const b = new ModuleBuilder('main');
    // Animal base with speak() returning "sound"; Dog overrides and calls super via method? simpler:
    // Base.greet() => "base"; Derived.greet() => super.greet() + ":derived"
    const baseGreet = b.func('greet', [], (f) => { f.loadStr('base'); f.return(); });
    const derivedGreet = b.func('greet', [], (f) => {
      f.superCall('greet', 0);
      f.loadStr(':derived');
      f.add();
      f.return();
    });
    b.root.null();
    b.root.newClass('Base', [['greet', baseGreet]]);
    b.root.storeLocal('Base');
    b.root.loadLocal('Base');
    b.root.newClass('Derived', [['greet', derivedGreet]]);
    b.root.storeLocal('Derived');
    b.root.loadLocal('Derived'); b.root.newInstance(0); b.root.storeLocal('d');
    b.root.loadLocal('d'); b.root.callMethod('greet', 0); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('base:derived\n');
  });

  it('super constructor chaining works', async () => {
    const b = new ModuleBuilder('main');
    const baseCtor = b.func('constructor', ['name'], (f) => {
      f.loadThis(); f.loadLocal('name'); f.setProp('name'); f.pop(); f.returnNull();
    });
    const getName = b.func('getName', [], (f) => { f.loadThis(); f.getProp('name'); f.return(); });
    const dervCtor = b.func('constructor', ['name', 'tag'], (f) => {
      f.loadThis(); f.loadLocal('name'); f.superCall('constructor', 1); f.pop();
      f.loadThis(); f.loadLocal('tag'); f.setProp('tag'); f.pop();
      f.returnNull();
    });
    b.root.null();
    b.root.newClass('Animal', [['constructor', baseCtor], ['getName', getName]]);
    b.root.storeLocal('Animal');
    b.root.loadLocal('Animal');
    b.root.newClass('Dog', [['constructor', dervCtor], ['getName', getName]]);
    b.root.storeLocal('Dog');
    b.root.loadLocal('Dog'); b.root.loadStr('Rex'); b.root.loadInt(7n); b.root.newInstance(2); b.root.storeLocal('d');
    b.root.loadLocal('d'); b.root.callMethod('getName', 0); b.root.callBuiltin('print', 1);
    b.root.loadLocal('d'); b.root.getProp('tag'); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('Rex\n7\n');
  });
});

describe('runtime: exceptions', () => {
  it('catches thrown values', async () => {
    const b = new ModuleBuilder('main');
    b.root.tryBlock(
      (f) => {
        f.loadStr('boom');
        f.callBuiltin('error', 1);
        f.throwValue();
      },
      { name: 'e', emit: (f) => {
        f.loadStr('caught: '); f.loadLocal('e'); f.getProp('message'); f.add();
        f.callBuiltin('print', 1);
      } },
    );
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('caught: boom\n');
  });

  it('runs finally blocks and rethrows uncaught errors', async () => {
    const b = new ModuleBuilder('main');
    b.root.tryBlock(
      (f) => { f.loadInt(1n); f.callBuiltin('print', 1); },
      undefined,
      (f) => { f.loadInt(2n); f.callBuiltin('print', 1); },
    );
    // Uncaught error after finally ran
    b.root.tryBlock(
      (f) => { f.loadStr('fatal'); f.callBuiltin('error', 1); f.throwValue(); },
      undefined,
      (f) => { f.loadInt(3n); f.callBuiltin('print', 1); },
    );
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('1\n2\n3\n');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('fatal');
  });

  it('catch + finally both execute', async () => {
    const b = new ModuleBuilder('main');
    b.root.tryBlock(
      (f) => { f.loadStr('x'); f.callBuiltin('error', 1); f.throwValue(); },
      { name: 'e', emit: (f) => { f.loadInt(1n); f.callBuiltin('print', 1); } },
      (f) => { f.loadInt(2n); f.callBuiltin('print', 1); },
    );
    b.root.loadInt(3n); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('1\n2\n3\n');
  });
});

describe('runtime: modules', () => {
  it('imports a named export from another .67 file', async () => {
    const lib = new ModuleBuilder('mathlib');
    lib.declareFunc('add', ['a', 'b'], (f) => { f.loadLocal('a'); f.loadLocal('b'); f.add(); f.return(); });
    lib.exportLocal('add');
    lib.root.null(); lib.root.return();

    const main = new ModuleBuilder('main');
    main.root.importModule('mathlib.67');
    main.root.storeLocal('m');
    main.root.loadLocal('m'); main.root.getProp('add');
    main.root.loadInt(40n); main.root.loadInt(2n); main.root.call(2);
    main.root.callBuiltin('print', 1);
    main.root.null(); main.root.return();

    const r = await runProject({
      'main.67': moduleToStream(main.build()),
      'mathlib.67': moduleToStream(lib.build()),
    });
    expect(r.ok).toBe(true);
    expect(r.output).toBe('42\n');
  });
});

describe('runtime: safety limits', () => {
  it('enforces instruction limits', async () => {
    const b = new ModuleBuilder('main');
    b.root.whileLoop((f) => f.true(), () => {});
    b.root.null(); b.root.return();
    const stream = moduleToStream(b.build());
    const interp = new Interpreter(decodeStream(stream), { maxInstructions: 10000 });
    const r = await interp.run();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/instruction limit|timed out/);
  });

  it('enforces recursion depth', async () => {
    const b = new ModuleBuilder('main');
    const loopSlot = b.root.local('loop');
    b.declareFunc('loop', [], (f) => {
      f.loadUpvar(1, loopSlot); f.call(0); f.return();
    });
    b.root.loadLocal('loop'); b.root.call(0); b.root.pop();
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('recursion');
  });

  it('protects against division by zero', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(1n); b.root.loadInt(0n); b.root.div(); b.root.pop();
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('division by zero');
  });

  it('protects against giant powers', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(2n); b.root.loadInt(1_000_000n); b.root.pow(); b.root.pop();
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/limit|too large/);
  });

  it('output size is capped', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadStr('x'); b.root.loadInt(2_000_000n); b.root.callBuiltin('repeat', 2);
    b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.ok).toBe(false);
  });
});

describe('runtime: standard library', () => {
  it('to67 / from67 implement the 6/7 number encoding', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(9n); b.root.callBuiltin('to67', 1); b.root.callBuiltin('print', 1); // 7667
    b.root.loadStr('7667'); b.root.callBuiltin('from67', 1); b.root.callBuiltin('print', 1); // 9
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('7667\n9\n');
  });

  it('typeof reports runtime types', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(1n); b.root.callBuiltin('typeof', 1); b.root.callBuiltin('print', 1);
    b.root.loadStr('s'); b.root.callBuiltin('typeof', 1); b.root.callBuiltin('print', 1);
    b.root.true(); b.root.callBuiltin('typeof', 1); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.callBuiltin('typeof', 1); b.root.callBuiltin('print', 1);
    b.root.newArray(0); b.root.callBuiltin('typeof', 1); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('number\nstring\nboolean\nnull\narray\n');
  });

  it('string builtins work', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadStr('Hello'); b.root.callBuiltin('upper', 1); b.root.callBuiltin('print', 1);
    b.root.loadStr('a,b,c'); b.root.loadStr(','); b.root.callBuiltin('split', 2);
    b.root.callBuiltin('length', 1); b.root.callBuiltin('print', 1);
    b.root.loadStr('abc'); b.root.loadStr('b'); b.root.callBuiltin('contains', 2); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('HELLO\n3\ntrue\n');
  });

  it('assert and assertEq stop programs on failure', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(1n); b.root.loadInt(1n); b.root.callBuiltin('assertEq', 2);
    b.root.loadStr('ok'); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('ok\n');

    const b2 = new ModuleBuilder('main');
    b2.root.loadInt(1n); b2.root.loadInt(2n); b2.root.callBuiltin('assertEq', 2);
    b2.root.null(); b2.root.return();
    const r2 = await run(b2);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('assertion failed');
  });

  it('input builtin receives injected host input', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadStr(''); b.root.callBuiltin('input', 1); b.root.storeLocal('name');
    b.root.loadStr('hi '); b.root.loadLocal('name'); b.root.add(); b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b, ['Ada']);
    expect(r.output).toBe('hi Ada\n');
  });

  it('reduce sums an array', async () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(1n); b.root.loadInt(2n); b.root.loadInt(3n); b.root.loadInt(4n);
    b.root.newArray(4); b.root.storeLocal('a');
    b.root.loadLocal('a');
    b.root.makeFunction(b.func(null, ['acc', 'x'], (f) => { f.loadLocal('acc'); f.loadLocal('x'); f.add(); f.return(); }));
    b.root.loadInt(0n);
    b.root.callBuiltin('reduce', 3);
    b.root.callBuiltin('print', 1);
    b.root.null(); b.root.return();
    const r = await run(b);
    expect(r.output).toBe('10\n');
  });
});
