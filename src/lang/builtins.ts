/**
 * The 67 standard library. Every built-in operation has a numeric id; binary
 * source references operations only through CALL_BUILTIN with that id. No
 * readable name ever appears in .67 source.
 */

import { LIMITS } from './limits.js';
import { bigIntToStream, streamToBigInt } from './bits.js';
import {
  ArrV,
  ErrV,
  FnV,
  NumV,
  RuntimeError,
  StrV,
  Value,
  asNumber,
  boolV,
  isTruthy,
  NULL_VALUE,
  toDisplayString,
  typeName,
} from './values.js';

export interface BuiltinContext {
  print(text: string): void;
  input(prompt: string): Promise<string>;
  callFunction(fn: Value, args: Value[]): Promise<Value>;
  checkBudget(): void;
}

export type BuiltinFn = (args: Value[], ctx: BuiltinContext) => Value | Promise<Value>;

export interface BuiltinDef {
  id: number;
  name: string;
  fn: BuiltinFn;
}

function num(v: Value): bigint | number {
  return asNumber(v);
}

function int(v: Value): bigint {
  const n = asNumber(v);
  return typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
}

function float(v: Value): number {
  const n = asNumber(v);
  return typeof n === 'bigint' ? Number(n) : n;
}

function expectArg(args: Value[], i: number, name: string): Value {
  if (i >= args.length) throw new RuntimeError(`built-in '${name}' expects at least ${i + 1} argument(s)`);
  return args[i];
}

function checkLen(args: Value[], min: number, name: string): void {
  if (args.length < min) throw new RuntimeError(`built-in '${name}' expects at least ${min} argument(s), got ${args.length}`);
}

function checkStr(v: Value, name: string): string {
  if (v.kind !== 'string') throw new RuntimeError(`'${name}' expects a string, got ${typeName(v)}`);
  return v.v;
}

function checkArray(v: Value, name: string): ArrV {
  if (v.kind !== 'array') throw new RuntimeError(`'${name}' expects an array, got ${typeName(v)}`);
  return v;
}

function checkCallable(v: Value, name: string): FnV {
  if (v.kind !== 'function') throw new RuntimeError(`'${name}' expects a function, got ${typeName(v)}`);
  return v;
}

function checkAlloc(size: number, kind: string, max: number): void {
  if (size > max) throw new RuntimeError(`allocation of ${size} ${kind} exceeds the safety limit of ${max}`);
}

export class ThrowSignal {
  constructor(public readonly error: ErrV) {}
}

function err(message: string): never {
  throw new ThrowSignal(new ErrV(message));
}

function builtinsList(): BuiltinDef[] {
  const list: BuiltinDef[] = [];
  const reg = (name: string, fn: BuiltinFn): void => {
    list.push({ id: list.length + 1, name, fn });
  };

  // --- output / input -----------------------------------------------------
  reg('print', (args, ctx) => {
    ctx.print(args.map(toDisplayString).join(' ') + '\n');
    return NULL_VALUE;
  });
  reg('write', (args, ctx) => {
    ctx.print(args.map(toDisplayString).join(' '));
    return NULL_VALUE;
  });
  reg('input', async (args, ctx) => {
    const prompt = args.length ? toDisplayString(args[0]) : '';
    const text = await ctx.input(prompt);
    return new StrV(text);
  });

  // --- introspection / conversion ----------------------------------------
  reg('typeof', (args) => new StrV(typeName(expectArg(args, 0, 'typeof'))));
  reg('toString', (args) => new StrV(toDisplayString(expectArg(args, 0, 'toString'))));
  reg('toNumber', (args) => {
    checkLen(args, 1, 'toNumber');
    return new NumV(num(args[0]));
  });
  reg('toInt', (args) => new NumV(int(expectArg(args, 0, 'toInt'))));
  reg('toFloat', (args) => new NumV(float(expectArg(args, 0, 'toFloat'))));
  reg('length', (args) => {
    const v = expectArg(args, 0, 'length');
    if (v.kind === 'string') return new NumV(BigInt(v.v.length));
    if (v.kind === 'array') return new NumV(BigInt(v.items.length));
    if (v.kind === 'object') return new NumV(BigInt(v.props.size));
    if (v.kind === 'instance') return new NumV(BigInt(v.props.size));
    throw new RuntimeError(`length() expects a string, array or object, got ${typeName(v)}`);
  });

  // --- 6/7 binary number system -------------------------------------------
  reg('to67', (args) => {
    const n = int(expectArg(args, 0, 'to67'));
    if (n < 0n) throw new RuntimeError('to67() expects a non-negative integer');
    return new StrV(bigIntToStream(n));
  });
  reg('from67', (args) => {
    const s = checkStr(expectArg(args, 0, 'from67'), 'from67');
    if (!/^[67]+$/.test(s)) throw new RuntimeError('from67() expects a string containing only 6 and 7');
    return new NumV(streamToBigInt(s));
  });
  reg('binary', (args) => {
    const n = int(expectArg(args, 0, 'binary'));
    if (n < 0n) throw new RuntimeError('binary() expects a non-negative integer');
    return new StrV(bigIntToStream(n).replace(/6/g, '0').replace(/7/g, '1'));
  });
  reg('decimal', (args) => {
    const s = checkStr(expectArg(args, 0, 'decimal'), 'decimal');
    if (!/^[01]+$/.test(s)) throw new RuntimeError('decimal() expects a binary string of 0 and 1');
    return new NumV(BigInt('0b' + s));
  });

  // --- math ----------------------------------------------------------------
  reg('abs', (args) => {
    const n = num(expectArg(args, 0, 'abs'));
    return new NumV(typeof n === 'bigint' ? (n < 0n ? -n : n) : Math.abs(n));
  });
  reg('min', (args) => {
    checkLen(args, 1, 'min');
    let best = num(args[0]);
    for (let i = 1; i < args.length; i++) {
      const cand = num(args[i]);
      const bestF = typeof best === 'bigint' ? Number(best) : best;
      const candF = typeof cand === 'bigint' ? Number(cand) : cand;
      if (candF < bestF) best = cand;
    }
    return new NumV(best);
  });
  reg('max', (args) => {
    checkLen(args, 1, 'max');
    let best = num(args[0]);
    for (let i = 1; i < args.length; i++) {
      const cand = num(args[i]);
      const bestF = typeof best === 'bigint' ? Number(best) : best;
      const candF = typeof cand === 'bigint' ? Number(cand) : cand;
      if (candF > bestF) best = cand;
    }
    return new NumV(best);
  });
  reg('sqrt', (args) => new NumV(Math.sqrt(float(expectArg(args, 0, 'sqrt')))));
  reg('floor', (args) => new NumV(BigInt(Math.floor(float(expectArg(args, 0, 'floor'))))));
  reg('ceil', (args) => new NumV(BigInt(Math.ceil(float(expectArg(args, 0, 'ceil'))))));
  reg('round', (args) => new NumV(BigInt(Math.round(float(expectArg(args, 0, 'round'))))));
  reg('random', (_args, ctx) => {
    ctx.checkBudget();
    return new NumV(Math.random());
  });
  reg('pow', (args) => {
    const base = num(expectArg(args, 0, 'pow'));
    const exp = expectArg(args, 1, 'pow');
    if (typeof base === 'bigint') {
      const e = int(exp);
      if (e < 0n) return new NumV(Math.pow(Number(base), Number(e)));
      if (e > BigInt(LIMITS.maxPowExponent)) throw new RuntimeError(`pow exponent ${e} exceeds the safety limit`);
      const result = base ** e;
      if (result.toString().length > LIMITS.maxStringBytes) throw new RuntimeError('pow result too large');
      return new NumV(result);
    }
    return new NumV(Math.pow(base, float(exp)));
  });

  // --- arrays ---------------------------------------------------------------
  reg('push', (args) => {
    const a = checkArray(expectArg(args, 0, 'push'), 'push');
    for (let i = 1; i < args.length; i++) {
      if (a.items.length >= LIMITS.maxArraySize) throw new RuntimeError('array size limit reached');
      a.items.push(args[i]);
    }
    return new NumV(BigInt(a.items.length));
  });
  reg('pop', (args) => {
    const a = checkArray(expectArg(args, 0, 'pop'), 'pop');
    if (a.items.length === 0) return NULL_VALUE;
    return a.items.pop() as Value;
  });
  reg('shift', (args) => {
    const a = checkArray(expectArg(args, 0, 'shift'), 'shift');
    if (a.items.length === 0) return NULL_VALUE;
    return a.items.shift() as Value;
  });
  reg('join', (args) => {
    const a = checkArray(expectArg(args, 0, 'join'), 'join');
    const sep = args.length > 1 ? checkStr(args[1], 'join') : ',';
    return new StrV(a.items.map(toDisplayString).join(sep));
  });
  reg('slice', (args) => {
    const v = expectArg(args, 0, 'slice');
    const start = Number(int(expectArg(args, 1, 'slice')));
    const end = args.length > 2 ? Number(int(args[2])) : undefined;
    if (v.kind === 'array') return new ArrV(v.items.slice(start, end));
    if (v.kind === 'string') return new StrV(v.v.slice(start, end));
    throw new RuntimeError('slice() expects an array or string');
  });
  reg('indexOf', (args) => {
    const v = expectArg(args, 0, 'indexOf');
    const target = expectArg(args, 1, 'indexOf');
    if (v.kind === 'array') {
      const idx = v.items.findIndex((it) => it.kind === target.kind && toDisplayString(it) === toDisplayString(target));
      return new NumV(BigInt(idx));
    }
    if (v.kind === 'string') return new NumV(BigInt(v.v.indexOf(checkStr(target, 'indexOf'))));
    throw new RuntimeError('indexOf() expects an array or string');
  });
  reg('includes', (args) => {
    const v = expectArg(args, 0, 'includes');
    const target = expectArg(args, 1, 'includes');
    if (v.kind === 'array') {
      return boolV(v.items.some((it) => it.kind === target.kind && toDisplayString(it) === toDisplayString(target)));
    }
    if (v.kind === 'string') return boolV(v.v.includes(checkStr(target, 'includes')));
    throw new RuntimeError('includes() expects an array or string');
  });
  reg('reverse', (args) => {
    const v = expectArg(args, 0, 'reverse');
    if (v.kind === 'array') return new ArrV([...v.items].reverse());
    if (v.kind === 'string') return new StrV([...v.v].reverse().join(''));
    throw new RuntimeError('reverse() expects an array or string');
  });
  reg('map', async (args, ctx) => {
    const a = checkArray(expectArg(args, 0, 'map'), 'map');
    const f = checkCallable(expectArg(args, 1, 'map'), 'map');
    const out: Value[] = [];
    for (let i = 0; i < a.items.length; i++) {
      ctx.checkBudget();
      out.push(await ctx.callFunction(f, [a.items[i], new NumV(BigInt(i))]));
    }
    return new ArrV(out);
  });
  reg('filter', async (args, ctx) => {
    const a = checkArray(expectArg(args, 0, 'filter'), 'filter');
    const f = checkCallable(expectArg(args, 1, 'filter'), 'filter');
    const out: Value[] = [];
    for (let i = 0; i < a.items.length; i++) {
      ctx.checkBudget();
      const r = await ctx.callFunction(f, [a.items[i], new NumV(BigInt(i))]);
      if (isTruthy(r)) out.push(a.items[i]);
    }
    return new ArrV(out);
  });
  reg('reduce', async (args, ctx) => {
    const a = checkArray(expectArg(args, 0, 'reduce'), 'reduce');
    const f = checkCallable(expectArg(args, 1, 'reduce'), 'reduce');
    let acc: Value = args.length > 2 ? args[2] : a.items[0];
    const start = args.length > 2 ? 0 : 1;
    for (let i = start; i < a.items.length; i++) {
      ctx.checkBudget();
      acc = await ctx.callFunction(f, [acc, a.items[i], new NumV(BigInt(i))]);
    }
    return acc;
  });

  // --- strings ---------------------------------------------------------------
  reg('upper', (args) => new StrV(checkStr(expectArg(args, 0, 'upper'), 'upper').toUpperCase()));
  reg('lower', (args) => new StrV(checkStr(expectArg(args, 0, 'lower'), 'lower').toLowerCase()));
  reg('split', (args) => {
    const s = checkStr(expectArg(args, 0, 'split'), 'split');
    const sep = args.length > 1 ? checkStr(args[1], 'split') : '';
    const parts = sep === '' ? [...s] : s.split(sep);
    return new ArrV(parts.map((p) => new StrV(p)));
  });
  reg('repeat', (args) => {
    const s = checkStr(expectArg(args, 0, 'repeat'), 'repeat');
    const n = Number(int(expectArg(args, 1, 'repeat')));
    checkAlloc(n * s.length, 'characters', LIMITS.maxStringBytes);
    return new StrV(s.repeat(n));
  });
  reg('startsWith', (args) =>
    boolV(checkStr(expectArg(args, 0, 'startsWith'), 'startsWith').startsWith(checkStr(expectArg(args, 1, 'startsWith'), 'startsWith'))),
  );
  reg('endsWith', (args) =>
    boolV(checkStr(expectArg(args, 0, 'endsWith'), 'endsWith').endsWith(checkStr(expectArg(args, 1, 'endsWith'), 'endsWith'))),
  );
  reg('contains', (args) => {
    const v = expectArg(args, 0, 'contains');
    const t = checkStr(expectArg(args, 1, 'contains'), 'contains');
    if (v.kind === 'string') return boolV(v.v.includes(t));
    if (v.kind === 'array') return boolV(v.items.some((it) => it.kind === 'string' && it.v === t));
    throw new RuntimeError('contains() expects a string or array');
  });
  reg('charCode', (args) => new NumV(BigInt(checkStr(expectArg(args, 0, 'charCode'), 'charCode').charCodeAt(Number(int(args[1] ?? new NumV(0n)))))));
  reg('fromCharCode', (args) => new StrV(String.fromCharCode(Number(int(expectArg(args, 0, 'fromCharCode'))))));
  reg('trim', (args) => new StrV(checkStr(expectArg(args, 0, 'trim'), 'trim').trim()));

  // --- objects ---------------------------------------------------------------
  reg('keys', (args) => {
    const v = expectArg(args, 0, 'keys');
    let map: Map<string, Value>;
    if (v.kind === 'object') map = v.props;
    else if (v.kind === 'instance') map = v.props;
    else throw new RuntimeError('keys() expects an object');
    return new ArrV([...map.keys()].map((k) => new StrV(k)));
  });
  reg('values', (args) => {
    const v = expectArg(args, 0, 'values');
    let map: Map<string, Value>;
    if (v.kind === 'object') map = v.props;
    else if (v.kind === 'instance') map = v.props;
    else throw new RuntimeError('values() expects an object');
    return new ArrV([...map.values()]);
  });
  reg('has', (args) => {
    const v = expectArg(args, 0, 'has');
    const key = checkStr(expectArg(args, 1, 'has'), 'has');
    if (v.kind === 'object') return boolV(v.props.has(key));
    if (v.kind === 'instance') return boolV(v.props.has(key));
    throw new RuntimeError('has() expects an object');
  });

  // --- assertions / errors ----------------------------------------------------
  reg('assert', (args) => {
    const cond = args.length > 0 ? isTruthy(args[0]) : false;
    if (!cond) err(args.length > 1 ? toDisplayString(args[1]) : 'assertion failed');
    return NULL_VALUE;
  });
  reg('assertEq', (args) => {
    const a = expectArg(args, 0, 'assertEq');
    const b = expectArg(args, 1, 'assertEq');
    const eq =
      a.kind === b.kind &&
      (a.kind === 'number' || a.kind === 'string' || a.kind === 'boolean'
        ? toDisplayString(a) === toDisplayString(b)
        : a === b);
    if (!eq) err(`assertion failed: ${toDisplayString(a)} != ${toDisplayString(b)}`);
    return NULL_VALUE;
  });
  reg('error', (args) => {
    err(args.length ? toDisplayString(args[0]) : 'error');
  });

  // --- misc -------------------------------------------------------------------
  reg('isInt', (args) => {
    const v = expectArg(args, 0, 'isInt');
    return boolV(v.kind === 'number' && typeof v.v === 'bigint');
  });
  reg('array', (args) => new ArrV([...args]));

  return list;
}

export const BUILTINS: BuiltinDef[] = builtinsList();
export const BUILTIN_BY_ID: Map<number, BuiltinDef> = new Map(BUILTINS.map((b) => [b.id, b]));
export const BUILTIN_BY_NAME: Map<string, BuiltinDef> = new Map(BUILTINS.map((b) => [b.name, b]));
