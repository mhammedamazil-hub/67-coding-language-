/**
 * Explicit runtime values for the 67 safe runtime. The host (browser/Node)
 * is never reachable from user programs: every value a program manipulates is
 * one of the classes below.
 */

import type { Module } from './format.js';

export type Value =
  | NumV
  | StrV
  | BoolV
  | NullV
  | ArrV
  | ObjV
  | FnV
  | BuiltinV
  | ClassV
  | InstV
  | ErrV
  | ModuleV;

export class NumV {
  readonly kind = 'number' as const;
  constructor(public readonly v: bigint | number) {}
  isInt(): boolean {
    return typeof this.v === 'bigint';
  }
  toFloat(): number {
    return typeof this.v === 'bigint' ? Number(this.v) : this.v;
  }
}

export class StrV {
  readonly kind = 'string' as const;
  constructor(public readonly v: string) {}
}

export class BoolV {
  readonly kind = 'boolean' as const;
  constructor(public readonly v: boolean) {}
}

export class NullV {
  readonly kind = 'null' as const;
}

export const NULL_VALUE = new NullV();
export const TRUE_VALUE = new BoolV(true);
export const FALSE_VALUE = new BoolV(false);
export const boolV = (b: boolean): BoolV => (b ? TRUE_VALUE : FALSE_VALUE);

export class ArrV {
  readonly kind = 'array' as const;
  constructor(public items: Value[]) {}
}

export class ObjV {
  readonly kind = 'object' as const;
  constructor(public props: Map<string, Value>) {}
}

/** Lexical environment: a flat slot array plus an optional parent chain. */
export class Env {
  slots: Value[];
  constructor(
    public parent: Env | null,
    slotCount: number,
  ) {
    this.slots = new Array(slotCount).fill(NULL_VALUE);
  }
}

export class FnV {
  readonly kind = 'function' as const;
  constructor(
    public fnIndex: number,
    public env: Env,
    public homeClass: ClassV | null = null,
    public name = '',
    public modRef: Module | null = null,
  ) {}
}

export class BuiltinV {
  readonly kind = 'builtin' as const;
  constructor(
    public id: number,
    public name: string,
  ) {}
}

export class ClassV {
  readonly kind = 'class' as const;
  constructor(
    public name: string,
    public parent: ClassV | null,
    public methods: Map<string, FnV>,
  ) {}
}

export class InstV {
  readonly kind = 'instance' as const;
  constructor(
    public cls: ClassV,
    public props: Map<string, Value>,
  ) {}
}

export class ErrV {
  readonly kind = 'error' as const;
  constructor(
    public message: string,
    public value: Value | null = null,
  ) {}
}

export class ModuleV {
  readonly kind = 'module' as const;
  constructor(
    public name: string,
    public env: Env,
    public exportNames: Map<string, number>,
  ) {}
  getExport(name: string): Value {
    const slot = this.exportNames.get(name);
    if (slot === undefined) throw new RuntimeError(`module '${this.name}' has no export '${name}'`);
    return this.env.slots[slot];
  }
}

export class RuntimeError extends Error {
  constructor(
    message: string,
    public readonly callStack: string[] = [],
  ) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export function typeName(v: Value): string {
  switch (v.kind) {
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    case 'function':
    case 'builtin':
      return 'function';
    case 'class':
      return 'class';
    case 'instance':
      return v.cls.name;
    case 'error':
      return 'error';
    case 'module':
      return 'module';
  }
}

export function isTruthy(v: Value): boolean {
  switch (v.kind) {
    case 'null':
      return false;
    case 'boolean':
      return v.v;
    case 'number':
      return typeof v.v === 'bigint' ? v.v !== 0n : v.v !== 0;
    case 'string':
      return v.v.length > 0;
    default:
      return true;
  }
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a.kind === 'null' || b.kind === 'null') return a.kind === b.kind;
  if (a.kind === 'boolean' && b.kind === 'boolean') return a.v === b.v;
  if (a.kind === 'number' && b.kind === 'number') {
    if (typeof a.v === 'bigint' && typeof b.v === 'bigint') return a.v === b.v;
    return a.toFloat() === b.toFloat();
  }
  if (a.kind === 'string' && b.kind === 'string') return a.v === b.v;
  return a === b;
}

function floatText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
  return String(n);
}

/** Render a value the way print() should show it (strings without quotes). */
export function toDisplayString(v: Value): string {
  switch (v.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return v.v ? 'true' : 'false';
    case 'number':
      return typeof v.v === 'bigint' ? v.v.toString() : floatText(v.v);
    case 'string':
      return v.v;
    case 'array':
      return '[' + v.items.map(toDisplayString).join(', ') + ']';
    case 'object': {
      const parts: string[] = [];
      for (const [k, val] of v.props) parts.push(`${k}: ${toDisplayString(val)}`);
      return '{' + parts.join(', ') + '}';
    }
    case 'function':
      return `<function ${v.name || 'anonymous'}>`;
    case 'builtin':
      return `<builtin ${v.name}>`;
    case 'class':
      return `<class ${v.name}>`;
    case 'instance':
      return `<${v.cls.name} instance>`;
    case 'error':
      return `Error: ${v.message}`;
    case 'module':
      return `<module ${v.name}>`;
  }
}

function asNumber(v: Value): bigint | number {
  if (v.kind === 'number') return v.v;
  if (v.kind === 'boolean') return v.v ? 1n : 0n;
  if (v.kind === 'null') return 0n;
  if (v.kind === 'string') {
    const t = v.v.trim();
    if (/^-?\d+$/.test(t)) return BigInt(t);
    const f = Number(t);
    if (!Number.isNaN(f)) return f;
    throw new RuntimeError(`cannot convert '${t}' to number`);
  }
  throw new RuntimeError(`cannot convert ${typeName(v)} to number`);
}

export { asNumber };
