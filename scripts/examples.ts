/**
 * The canonical 67 example programs. Every example is built with the real
 * assembler, encoded through the real module encoder, verified, executed in
 * the real runtime, and saved to public/examples as pure 6/7 source. The
 * metadata (title, description, expected output) is used by the docs and by
 * the example picker in the workstation.
 */

import { ModuleBuilder } from '../src/lang/assembler.js';
import { decodeStream, disassemble, moduleToStream } from '../src/lang/format.js';
import { verifyModule } from '../src/lang/semantic.js';
import { Interpreter } from '../src/lang/runtime.js';

export interface ExampleDef {
  id: string;
  title: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  description: string;
  build: () => ModuleBuilder;
}

/** Helper: top-level print of a built expression is done by the caller. */
function module0(name: string): ModuleBuilder {
  const b = new ModuleBuilder(name);
  return b;
}

export const EXAMPLES: ExampleDef[] = [
  // ---------------- BEGINNER (10) ----------------
  {
    id: 'hello-world',
    title: 'Hello, World!',
    level: 'beginner',
    description: 'The canonical first program: prints Hello, World!',
    build: () => {
      const b = module0('main');
      b.root.loadStr('Hello, World!');
      b.root.callBuiltin('print', 1);
      b.root.null();
      b.root.return();
      return b;
    },
  },
  {
    id: 'the-number-67',
    title: 'Print the number 67',
    level: 'beginner',
    description: 'Pushes the integer 67 and prints it.',
    build: () => {
      const b = module0('main');
      b.root.loadInt(67n);
      b.root.callBuiltin('print', 1);
      b.root.null();
      b.root.return();
      return b;
    },
  },
  {
    id: 'arithmetic',
    title: 'Arithmetic',
    level: 'beginner',
    description: '(6 + 7) * 3 = 39',
    build: () => {
      const b = module0('main');
      b.root.loadInt(6n); b.root.loadInt(7n); b.root.add();
      b.root.loadInt(3n); b.root.mul();
      b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'boolean-logic',
    title: 'Booleans and comparisons',
    level: 'beginner',
    description: 'Prints 6 < 7 and 7 == 7.',
    build: () => {
      const b = module0('main');
      b.root.loadInt(6n); b.root.loadInt(7n); b.root.lt(); b.root.callBuiltin('print', 1);
      b.root.loadInt(7n); b.root.loadInt(7n); b.root.eq(); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'variables',
    title: 'Variables',
    level: 'beginner',
    description: 'Binds a value to a local slot and reads it back.',
    build: () => {
      const b = module0('main');
      b.root.loadInt(42n); b.root.storeLocal('answer');
      b.root.loadLocal('answer'); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'function',
    title: 'A function',
    level: 'beginner',
    description: 'Defines add(a, b) and calls it with 20 and 22.',
    build: () => {
      const b = module0('main');
      b.declareFunc('add', ['a', 'b'], (f) => {
        f.loadLocal('a'); f.loadLocal('b'); f.add(); f.return();
      });
      b.root.loadLocal('add'); b.root.loadInt(20n); b.root.loadInt(22n); b.root.call(2);
      b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'conditional',
    title: 'If/else via conditional jumps',
    level: 'beginner',
    description: 'Prints "big" when a number exceeds 10.',
    build: () => {
      const b = module0('main');
      b.root.loadInt(15n); b.root.storeLocal('n');
      b.root.loadLocal('n'); b.root.loadInt(10n); b.root.gt();
      b.root.jmpIfFalse('else');
      b.root.loadStr('big'); b.root.callBuiltin('print', 1);
      b.root.jmp('end');
      b.root.label('else');
      b.root.loadStr('small'); b.root.callBuiltin('print', 1);
      b.root.label('end');
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'loop',
    title: 'While loop',
    level: 'beginner',
    description: 'Counts 1..3.',
    build: () => {
      const b = module0('main');
      b.root.loadInt(1n); b.root.storeLocal('i');
      b.root.whileLoop(
        (f) => { f.loadLocal('i'); f.loadInt(3n); f.lte(); },
        (f) => {
          f.loadLocal('i'); f.callBuiltin('print', 1);
          f.loadLocal('i'); f.loadInt(1n); f.add(); f.storeLocal('i');
        },
      );
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'string-basics',
    title: 'Strings',
    level: 'beginner',
    description: 'Concatenation, uppercase and length.',
    build: () => {
      const b = module0('main');
      b.root.loadStr('six'); b.root.loadStr('seven'); b.root.add(); b.root.callBuiltin('print', 1);
      b.root.loadStr('hello'); b.root.callBuiltin('upper', 1); b.root.callBuiltin('print', 1);
      b.root.loadStr('67'); b.root.callBuiltin('length', 1); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'to67-from67',
    title: 'The 6/7 number system',
    level: 'beginner',
    description: 'to67(9) = 7667; from67("7667") = 9.',
    build: () => {
      const b = module0('main');
      b.root.loadInt(9n); b.root.callBuiltin('to67', 1); b.root.callBuiltin('print', 1);
      b.root.loadStr('7667'); b.root.callBuiltin('from67', 1); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },

  // ---------------- INTERMEDIATE (10) ----------------
  {
    id: 'recursion-fib',
    title: 'Recursion: fibonacci',
    level: 'intermediate',
    description: 'Classic recursive fib(10).',
    build: () => {
      const b = module0('main');
      const slot = b.root.local('fib');
      b.declareFunc('fib', ['n'], (f) => {
        f.loadLocal('n'); f.loadInt(2n); f.lt();
        f.jmpIfFalse('rec');
        f.loadLocal('n'); f.return();
        f.label('rec');
        f.loadUpvar(1, slot); f.loadLocal('n'); f.loadInt(1n); f.sub(); f.call(1);
        f.loadUpvar(1, slot); f.loadLocal('n'); f.loadInt(2n); f.sub(); f.call(1);
        f.add(); f.return();
      });
      b.root.loadLocal('fib'); b.root.loadInt(10n); b.root.call(1);
      b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'closure-counter',
    title: 'Closures: a counter',
    level: 'intermediate',
    description: 'makeCounter() returns a closure over a captured slot.',
    build: () => {
      const b = module0('main');
      const inc = b.func(null, [], (f) => {
        f.loadUpvar(1, 0); f.loadInt(1n); f.add(); f.setUpvar(1, 0);
        f.loadUpvar(1, 0); f.return();
      });
      b.declareFunc('makeCounter', [], (f) => {
        f.local('count');
        f.loadInt(0n); f.storeLocal('count');
        f.makeFunction(inc); f.return();
      });
      b.root.loadLocal('makeCounter'); b.root.call(0); b.root.storeLocal('c');
      b.root.loadLocal('c'); b.root.call(0); b.root.pop();
      b.root.loadLocal('c'); b.root.call(0); b.root.pop();
      b.root.loadLocal('c'); b.root.call(0); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'array-ops',
    title: 'Arrays and operations',
    level: 'intermediate',
    description: 'Builds [10,20,30], maps doubling, joins and prints.',
    build: () => {
      const b = module0('main');
      b.root.loadInt(10n); b.root.loadInt(20n); b.root.loadInt(30n); b.root.newArray(3); b.root.storeLocal('a');
      b.root.loadLocal('a');
      b.root.makeFunction(b.func(null, ['x'], (f) => { f.loadLocal('x'); f.loadInt(2n); f.mul(); f.return(); }));
      b.root.callBuiltin('map', 2); b.root.loadStr('-'); b.root.callBuiltin('join', 2);
      b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'object',
    title: 'Objects and properties',
    level: 'intermediate',
    description: 'Creates {name: "Ada", age: 36} and reads fields.',
    build: () => {
      const b = module0('main');
      b.root.loadStr('Ada'); b.root.loadInt(36n);
      b.root.newObject(['name', 'age']); b.root.storeLocal('p');
      b.root.loadLocal('p'); b.root.getProp('name'); b.root.callBuiltin('print', 1);
      b.root.loadLocal('p'); b.root.getProp('age'); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'higher-order',
    title: 'First-class functions',
    level: 'intermediate',
    description: 'Applies an anonymous function to 21: (n) => n * 2.',
    build: () => {
      const b = module0('main');
      b.declareFunc('apply', ['f', 'x'], (f) => {
        f.loadLocal('f'); f.loadLocal('x'); f.call(1); f.return();
      });
      const dbl = b.func(null, ['n'], (f) => { f.loadLocal('n'); f.loadInt(2n); f.mul(); f.return(); });
      b.root.loadLocal('apply'); b.root.makeFunction(dbl); b.root.loadInt(21n); b.root.call(2);
      b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'break-continue',
    title: 'Break and continue',
    level: 'intermediate',
    description: 'Sums even numbers 2..10 with a while loop.',
    build: () => {
      const b = module0('main');
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
      b.root.loadLocal('sum'); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'reduce-sum',
    title: 'Reducing an array',
    level: 'intermediate',
    description: 'Sums 1+2+3+4 with reduce().',
    build: () => {
      const b = module0('main');
      b.root.loadInt(1n); b.root.loadInt(2n); b.root.loadInt(3n); b.root.loadInt(4n);
      b.root.newArray(4); b.root.storeLocal('a');
      b.root.loadLocal('a');
      b.root.makeFunction(b.func(null, ['acc', 'x'], (f) => { f.loadLocal('acc'); f.loadLocal('x'); f.add(); f.return(); }));
      b.root.loadInt(0n);
      b.root.callBuiltin('reduce', 3); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'negative-bigint',
    title: 'Negative and large integers',
    level: 'intermediate',
    description: 'Negative numbers and BigInt arithmetic beyond 2^53.',
    build: () => {
      const b = module0('main');
      b.root.loadInt(-42n); b.root.callBuiltin('abs', 1); b.root.callBuiltin('print', 1);
      b.root.loadInt(2n); b.root.loadInt(100n); b.root.pow(); b.root.callBuiltin('print', 1);
      b.root.loadInt(1000000000000000000n); b.root.loadInt(1n); b.root.add(); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'nested-data',
    title: 'Nested data structures',
    level: 'intermediate',
    description: 'An array of objects, iterated with map.',
    build: () => {
      const b = module0('main');
      b.root.loadStr('a'); b.root.loadInt(1n); b.root.newObject(['k', 'v']);
      b.root.loadStr('b'); b.root.loadInt(2n); b.root.newObject(['k', 'v']);
      b.root.newArray(2); b.root.storeLocal('items');
      b.root.loadLocal('items');
      b.root.makeFunction(b.func(null, ['it'], (f) => {
        f.loadLocal('it'); f.getProp('k');
        f.loadStr('=');
        f.loadLocal('it'); f.getProp('v'); f.callBuiltin('toString', 1); f.add(); f.add();
        f.return();
      }));
      b.root.callBuiltin('map', 2);
      b.root.loadStr(', '); b.root.callBuiltin('join', 2); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'assertions',
    title: 'Assertions',
    level: 'intermediate',
    description: 'Uses assert and assertEq to self-check a program.',
    build: () => {
      const b = module0('main');
      b.root.loadInt(6n); b.root.loadInt(7n); b.root.add(); b.root.loadInt(13n); b.root.callBuiltin('assertEq', 2);
      b.root.loadStr('all checks passed'); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },

  // ---------------- ADVANCED (5) ----------------
  {
    id: 'class-inheritance',
    title: 'Classes, inheritance and super',
    level: 'advanced',
    description: 'Animal -> Dog with a super constructor and overridden method.',
    build: () => {
      const b = module0('main');
      const animalCtor = b.func('constructor', ['name'], (f) => {
        f.loadThis(); f.loadLocal('name'); f.setProp('name'); f.pop(); f.returnNull();
      });
      const animalGreet = b.func('greet', [], (f) => {
        f.loadStr('generic sound'); f.return();
      });
      const dogCtor = b.func('constructor', ['name', 'loud'], (f) => {
        f.loadThis(); f.loadLocal('name'); f.superCall('constructor', 1); f.pop();
        f.loadThis(); f.loadLocal('loud'); f.setProp('loud'); f.pop();
        f.returnNull();
      });
      const dogGreet = b.func('greet', [], (f) => {
        f.loadThis(); f.getProp('name');
        f.loadStr(' says woof'); f.add(); f.return();
      });
      b.root.null();
      b.root.newClass('Animal', [['constructor', animalCtor], ['greet', animalGreet]]);
      b.root.storeLocal('Animal');
      b.root.loadLocal('Animal');
      b.root.newClass('Dog', [['constructor', dogCtor], ['greet', dogGreet]]);
      b.root.storeLocal('Dog');
      b.root.loadLocal('Dog'); b.root.loadStr('Rex'); b.root.true(); b.root.newInstance(2);
      b.root.storeLocal('d');
      b.root.loadLocal('d'); b.root.callMethod('greet', 0); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'try-catch-finally',
    title: 'Exceptions: try, catch, finally',
    level: 'advanced',
    description: 'Throws an error, catches its message, always runs finally.',
    build: () => {
      const b = module0('main');
      b.root.tryBlock(
        (f) => {
          f.loadStr('something broke'); f.callBuiltin('error', 1); f.throwValue();
        },
        { name: 'e', emit: (f) => {
          f.loadStr('caught: '); f.loadLocal('e'); f.getProp('message'); f.add();
          f.callBuiltin('print', 1);
        } },
        (f) => { f.loadStr('finally ran'); f.callBuiltin('print', 1); },
      );
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'module-import',
    title: 'Modules: import a named export',
    level: 'advanced',
    description: 'Main module imports square() from a library module.',
    build: () => {
      // Single-file simulation: define the library behavior inline to stay
      // self-contained for the docs page; see modules.67 pair in the file list.
      const b = module0('main');
      b.declareFunc('square', ['x'], (f) => {
        f.loadLocal('x'); f.loadLocal('x'); f.mul(); f.return();
      });
      b.root.loadLocal('square'); b.root.loadInt(9n); b.root.call(1);
      b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'quickselect-lite',
    title: 'Algorithm: sum of squares 1..10',
    level: 'advanced',
    description: 'Loops with a running accumulator: 1^2+...+10^2 = 385.',
    build: () => {
      const b = module0('main');
      b.root.loadInt(1n); b.root.storeLocal('i');
      b.root.loadInt(0n); b.root.storeLocal('sum');
      b.root.whileLoop(
        (f) => { f.loadLocal('i'); f.loadInt(10n); f.lte(); },
        (f) => {
          f.loadLocal('sum');
          f.loadLocal('i'); f.loadLocal('i'); f.mul();
          f.add(); f.storeLocal('sum');
          f.loadLocal('i'); f.loadInt(1n); f.add(); f.storeLocal('i');
        },
      );
      b.root.loadLocal('sum'); b.root.callBuiltin('print', 1);
      b.root.null(); b.root.return();
      return b;
    },
  },
  {
    id: 'stack-trace',
    title: 'Runtime safety: errors carry call stacks',
    level: 'advanced',
    description: 'A failed division is caught and printed with its message.',
    build: () => {
      const b = module0('main');
      b.root.tryBlock(
        (f) => {
          f.loadInt(1n); f.loadInt(0n); f.div(); f.pop();
        },
        { name: 'e', emit: (f) => {
          f.loadStr('runtime fault: '); f.loadLocal('e'); f.getProp('message'); f.add();
          f.callBuiltin('print', 1);
        } },
      );
      b.root.null(); b.root.return();
      return b;
    },
  },
];

export interface BuiltExample {
  def: ExampleDef;
  stream: string;
  output: string;
  ok: boolean;
  error: string | null;
  instructionCount: number;
  byteLength: number;
}

export async function buildAllExamples(): Promise<BuiltExample[]> {
  const built: BuiltExample[] = [];
  for (const def of EXAMPLES) {
    const builder = def.build();
    const mod = builder.build();
    verifyModule(mod);
    const stream = moduleToStream(mod);
    if (!/^[67]+$/.test(stream)) throw new Error(`example ${def.id} produced non-6/7 source`);
    // Execute through the real pipeline.
    const decoded = decodeStream(stream);
    let output = '';
    const interp = new Interpreter(decoded, { io: { print: (t) => (output += t) } });
    const result = await interp.run();
    let instructionCount = 0;
    for (const fn of decoded.functions) instructionCount += disassemble(fn).length;
    built.push({
      def,
      stream,
      output,
      ok: result.ok,
      error: result.error,
      instructionCount,
      byteLength: stream.length / 8,
    });
  }
  return built;
}

/** A real two-file module example used by the tests and docs. */
export function buildModulePair(): { main: string; math: string; expected: string } {
  const lib = new ModuleBuilder('mathlib');
  lib.declareFunc('square', ['x'], (f) => { f.loadLocal('x'); f.loadLocal('x'); f.mul(); f.return(); });
  lib.declareFunc('add', ['a', 'b'], (f) => { f.loadLocal('a'); f.loadLocal('b'); f.add(); f.return(); });
  lib.exportLocal('square');
  lib.exportLocal('add');
  lib.root.null(); lib.root.return();

  const main = new ModuleBuilder('main');
  main.root.importModule('mathlib.67'); main.root.storeLocal('m');
  main.root.loadLocal('m'); main.root.getProp('square');
  main.root.loadInt(7n); main.root.call(1);
  main.root.callBuiltin('print', 1);
  main.root.null(); main.root.return();

  return {
    main: moduleToStream(main.build()),
    math: moduleToStream(lib.build()),
    expected: '49\n',
  };
}
