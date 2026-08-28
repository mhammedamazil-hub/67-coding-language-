/**
 * The 67 safe runtime: a stack-based bytecode interpreter over explicit
 * runtime values. No host object (window, document, fetch, fs, ...) is ever
 * reachable from a program; the only host contact is the injected HostIO.
 */

import {
  FunctionDef,
  Module,
  NO_INDEX,
  NO_SLOT,
  OP,
  decodeStream,
} from './format.js';
import { LIMITS } from './limits.js';
import { BUILTIN_BY_ID, BuiltinContext, ThrowSignal } from './builtins.js';
import {
  ArrV,
  ClassV,
  Env,
  ErrV,
  FnV,
  InstV,
  ModuleV,
  NumV,
  ObjV,
  RuntimeError,
  StrV,
  Value,
  asNumber,
  boolV,
  isTruthy,
  NULL_VALUE,
  toDisplayString,
  valuesEqual,
  typeName,
} from './values.js';

export interface HostIO {
  print?: (text: string) => void;
  input?: (prompt: string) => Promise<string>;
}

export interface RunOptions {
  io?: HostIO;
  loadModule?: (name: string) => Promise<Module | null>;
  signal?: AbortSignal;
  maxInstructions?: number;
  timeoutMs?: number;
}

export interface RunResult {
  output: string;
  ok: boolean;
  error: string | null;
}

interface Frame {
  fn: FunctionDef;
  mod: Module;
  env: Env;
  pc: number;
  name: string;
  baseDepth: number;
  thisValue: Value | null;
  homeClass: ClassV | null;
  pending: ErrV | null;
}

/** Internal control signal: an exception is being unwound to a handler frame. */
class UnwindSignal {
  constructor(public readonly error: ErrV) {}
}

function constToValue(c: Module['constants'][number]): Value {
  if (c.kind === 'int') return new NumV(c.value);
  if (c.kind === 'float') return new NumV(c.value);
  return new StrV(c.value);
}

export class Interpreter {
  private stack: Value[] = [];
  private frames: Frame[] = [];
  private output = '';
  private instructions = 0;
  private startTime = 0;
  private moduleCache = new Map<string, ModuleV>();
  private limits: Required<Pick<RunOptions, 'maxInstructions' | 'timeoutMs'>>;

  constructor(
    private module: Module,
    private opts: RunOptions = {},
  ) {
    this.limits = {
      maxInstructions: opts.maxInstructions ?? LIMITS.maxInstructions,
      timeoutMs: opts.timeoutMs ?? LIMITS.defaultTimeoutMs,
    };
  }

  async run(): Promise<RunResult> {
    this.startTime = Date.now();
    try {
      const main = this.module.functions[0];
      const env = new Env(null, main.localCount);
      await this.callFnIndex(0, env, [], '<module>', null, null, true);
      return { output: this.output, ok: true, error: null };
    } catch (e) {
      if (e instanceof ThrowSignal) {
        return { output: this.output, ok: false, error: `Uncaught error: ${e.error.message}\n${this.formatStack()}` };
      }
      if (e instanceof RuntimeError) {
        return { output: this.output, ok: false, error: `${e.message}\n${this.formatStack()}` };
      }
      return { output: this.output, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private formatStack(): string {
    const lines: string[] = [];
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      const bit = this.pcToBit(f.fn, f.pc);
      lines.push(`  at ${f.name} (byte ${f.pc}, bit ${bit})`);
    }
    return lines.join('\n');
  }

  private pcToBit(fn: FunctionDef, pc: number): number {
    let bit = -1;
    for (const d of fn.debug) {
      if (d.codeOffset <= pc) bit = d.bitOffset;
      else break;
    }
    return bit;
  }

  private checkBudget(): void {
    if ((this.instructions & 1023) === 0) {
      if (this.instructions > this.limits.maxInstructions) {
        throw new RuntimeError(`instruction limit of ${this.limits.maxInstructions} exceeded (possible infinite loop)`);
      }
      if (this.opts.signal?.aborted) throw new RuntimeError('execution stopped by user');
      if (Date.now() - this.startTime > this.limits.timeoutMs) throw new RuntimeError('execution timed out');
    }
  }

  private write(text: string): void {
    if (this.output.length + text.length > LIMITS.maxOutputBytes) {
      throw new RuntimeError('output size limit exceeded');
    }
    this.output += text;
    this.opts.io?.print?.(text);
  }

  private ctx(): BuiltinContext {
    return {
      print: (t) => this.write(t),
      input: async (p) => {
        if (!this.opts.io?.input) throw new RuntimeError('input is not available in this environment');
        return this.opts.io.input(p);
      },
      callFunction: (fn, args) => this.callValue(fn, args),
      checkBudget: () => this.checkBudget(),
    };
  }

  private fnName(mod: Module, fnIndex: number): string {
    const fn = mod.functions[fnIndex];
    if (!fn) return `<fn#${fnIndex}>`;
    const c = fn.nameConst !== NO_INDEX ? mod.constants[fn.nameConst] : null;
    return c && c.kind === 'str' ? c.value : `<fn#${fnIndex}>`;
  }

  private async callFnIndex(
    fnIndex: number,
    parentEnv: Env,
    args: Value[],
    name: string,
    homeClass: ClassV | null = null,
    thisValue: Value | null = null,
    reuseEnv = false,
    mod: Module = this.module,
  ): Promise<Value> {
    const fn = mod.functions[fnIndex];
    if (!fn) throw new RuntimeError(`invalid function index ${fnIndex}`);
    if (this.frames.length >= LIMITS.maxCallDepth) throw new RuntimeError('maximum recursion depth exceeded');
    // Each invocation gets a fresh slot environment whose parent is the
    // closing-over environment; module initializers reuse the module env
    // directly so exports land in the exported slot array.
    const env = reuseEnv ? parentEnv : new Env(parentEnv, fn.localCount);
    const frame: Frame = {
      fn,
      mod,
      env,
      pc: 0,
      name,
      baseDepth: this.stack.length,
      thisValue,
      homeClass,
      pending: null,
    };
    this.frames.push(frame);
    const result = await this.execFrame(frame, args);
    this.frames.pop();
    return result;
  }

  private async execFrame(frame: Frame, args: Value[]): Promise<Value> {
    const { fn, env } = frame;
    for (let i = 0; i < fn.params.length; i++) env.slots[i] = i < args.length ? args[i] : NULL_VALUE;
    return this.frameLoop(frame);
  }

  private async frameLoop(frame: Frame): Promise<Value> {
    const fn = frame.fn;
    const env = frame.env;
    const mod = frame.mod;
    let returnValue: Value | null = null;
    try {
      for (;;) {
        if (frame.pc >= fn.code.length) {
          returnValue ??= NULL_VALUE;
          break;
        }
      this.instructions++;
      this.checkBudget();
      const op = fn.code[frame.pc++];
      switch (op) {
        case OP.LOAD_CONST: {
          const idx = this.readU16(fn, frame);
          const c = mod.constants[idx];
          if (!c) throw new RuntimeError(`invalid constant index ${idx}`);
          this.stack.push(constToValue(c));
          break;
        }
        case OP.LOAD_TRUE: this.stack.push(boolV(true)); break;
        case OP.LOAD_FALSE: this.stack.push(boolV(false)); break;
        case OP.LOAD_NULL: this.stack.push(NULL_VALUE); break;
        case OP.LOAD_LOCAL: {
          const slot = this.readU16(fn, frame);
          this.assertSlot(fn, slot);
          this.stack.push(env.slots[slot]);
          break;
        }
        case OP.STORE_LOCAL: {
          const slot = this.readU16(fn, frame);
          this.assertSlot(fn, slot);
          env.slots[slot] = this.stack.pop()!;
          break;
        }
        case OP.GET_UPVAR: {
          const depth = fn.code[frame.pc++];
          const slot = this.readU16(fn, frame);
          let e: Env | null = env;
          for (let i = 0; i < depth && e; i++) e = e.parent;
          if (!e) throw new RuntimeError('invalid upvalue depth (corrupt closure)');
          this.stack.push(e.slots[slot]);
          break;
        }
        case OP.SET_UPVAR: {
          const depth = fn.code[frame.pc++];
          const slot = this.readU16(fn, frame);
          let e: Env | null = env;
          for (let i = 0; i < depth && e; i++) e = e.parent;
          if (!e) throw new RuntimeError('invalid upvalue depth (corrupt closure)');
          e.slots[slot] = this.stack.pop()!;
          break;
        }
        case OP.POP: this.stack.pop(); break;
        case OP.DUP: this.stack.push(this.stack[this.stack.length - 1]); break;
        case OP.ADD: this.binop(fn, frame, (a, b) => this.add(a, b)); break;
        case OP.SUB: this.binop(fn, frame, (a, b) => this.numeric(a, b, (x, y) => x - y, (x, y) => x - y)); break;
        case OP.MUL: this.binop(fn, frame, (a, b) => this.numeric(a, b, (x, y) => x * y, (x, y) => x * y)); break;
        case OP.DIV: this.binop(fn, frame, (a, b) => this.div(a, b)); break;
        case OP.MOD: this.binop(fn, frame, (a, b) => this.mod(a, b)); break;
        case OP.POW: this.binop(fn, frame, (a, b) => this.pow(a, b)); break;
        case OP.NEG: {
          const a = this.stack.pop()!;
          const n = asNumber(a);
          this.stack.push(new NumV(typeof n === 'bigint' ? -n : -n));
          break;
        }
        case OP.NOT: this.stack.push(boolV(!isTruthy(this.stack.pop()!))); break;
        case OP.BAND: this.binop(fn, frame, (a, b) => new NumV(this.asInt(a) & this.asInt(b))); break;
        case OP.BOR: this.binop(fn, frame, (a, b) => new NumV(this.asInt(a) | this.asInt(b))); break;
        case OP.BXOR: this.binop(fn, frame, (a, b) => new NumV(this.asInt(a) ^ this.asInt(b))); break;
        case OP.BNOT: {
          const a = this.stack.pop()!;
          this.stack.push(new NumV(~this.asInt(a)));
          break;
        }
        case OP.SHL: this.binop(fn, frame, (a, b) => new NumV(this.asInt(a) << this.asInt(b))); break;
        case OP.SHR: this.binop(fn, frame, (a, b) => new NumV(this.asInt(a) >> this.asInt(b))); break;
        case OP.EQ: {
          const b = this.stack.pop()!;
          const a = this.stack.pop()!;
          this.stack.push(boolV(valuesEqual(a, b)));
          break;
        }
        case OP.NEQ: {
          const b = this.stack.pop()!;
          const a = this.stack.pop()!;
          this.stack.push(boolV(!valuesEqual(a, b)));
          break;
        }
        case OP.LT: this.compare(fn, frame, (x) => x < 0); break;
        case OP.LTE: this.compare(fn, frame, (x) => x <= 0); break;
        case OP.GT: this.compare(fn, frame, (x) => x > 0); break;
        case OP.GTE: this.compare(fn, frame, (x) => x >= 0); break;
        case OP.JUMP: frame.pc = this.readU32(fn, frame); break;
        case OP.JUMP_IF_FALSE: {
          const target = this.readU32(fn, frame);
          if (!isTruthy(this.stack.pop()!)) frame.pc = target;
          break;
        }
        case OP.JUMP_IF_TRUE: {
          const target = this.readU32(fn, frame);
          if (isTruthy(this.stack.pop()!)) frame.pc = target;
          break;
        }
        case OP.CALL: {
          const argc = fn.code[frame.pc++];
          const args = this.popArgs(argc);
          const callee = this.stack.pop()!;
          this.stack.push(await this.callValue(callee, args));
          break;
        }
        case OP.CALL_BUILTIN: {
          const id = this.readU16(fn, frame);
          const argc = fn.code[frame.pc++];
          const args = this.popArgs(argc);
          const def = BUILTIN_BY_ID.get(id);
          if (!def) throw new RuntimeError(`invalid built-in id ${id}`);
          const r = await def.fn(args, this.ctx());
          this.stack.push(r);
          break;
        }
        case OP.RETURN:
          returnValue = this.stack.pop()!;
          this.stack.length = frame.baseDepth;
          break;
        case OP.MAKE_FUNCTION: {
          const idx = this.readU16(fn, frame);
          this.stack.push(new FnV(idx, env, null, this.fnName(mod, idx), mod));
          break;
        }
        case OP.NEW_ARRAY: {
          const count = this.readU16(fn, frame);
          const items: Value[] = [];
          for (let i = 0; i < count; i++) items.unshift(this.stack.pop()!);
          if (items.length > LIMITS.maxArraySize) throw new RuntimeError('array size limit exceeded');
          this.stack.push(new ArrV(items));
          break;
        }
        case OP.NEW_OBJECT: {
          const count = this.readU16(fn, frame);
          const props = new Map<string, Value>();
          const keys: string[] = [];
          for (let i = 0; i < count; i++) {
            const kc = this.readU16(fn, frame);
            const kcVal = mod.constants[kc];
            if (!kcVal || kcVal.kind !== 'str') throw new RuntimeError('object key must be a string constant');
            keys.unshift(kcVal.value);
          }
          for (let i = 0; i < count; i++) {
            const v = this.stack.pop()!;
            props.set(keys[i], v);
          }
          if (props.size > LIMITS.maxObjectProps) throw new RuntimeError('object property limit exceeded');
          this.stack.push(new ObjV(props));
          break;
        }
        case OP.GET_PROP: {
          const kc = this.readU16(fn, frame);
          const key = this.stringConst(mod, kc);
          this.stack.push(this.getProp(this.stack.pop()!, key));
          break;
        }
        case OP.SET_PROP: {
          const kc = this.readU16(fn, frame);
          const key = this.stringConst(mod, kc);
          const value = this.stack.pop()!;
          const obj = this.stack.pop()!;
          this.setProp(obj, key, value);
          this.stack.push(value);
          break;
        }
        case OP.GET_INDEX: {
          const index = this.stack.pop()!;
          const target = this.stack.pop()!;
          this.stack.push(this.getIndex(target, index));
          break;
        }
        case OP.SET_INDEX: {
          const value = this.stack.pop()!;
          const index = this.stack.pop()!;
          const target = this.stack.pop()!;
          this.setIndex(target, index, value);
          this.stack.push(value);
          break;
        }
        case OP.NEW_CLASS: {
          const nameC = this.readU16(fn, frame);
          const name = this.stringConst(mod, nameC);
          const methodCount = this.readU16(fn, frame);
          const methods = new Map<string, FnV>();
          const pairs: Array<[string, number]> = [];
          for (let i = 0; i < methodCount; i++) {
            const mn = this.stringConst(mod, this.readU16(fn, frame));
            const fi = this.readU16(fn, frame);
            pairs.unshift([mn, fi]);
          }
          const parentVal = this.stack.pop()!;
          const parent = parentVal.kind === 'class' ? parentVal : null;
          const cls = new ClassV(name, parent, methods);
          for (const [mn, fi] of pairs) {
            methods.set(mn, new FnV(fi, env, cls, `${name}.${mn}`, mod));
          }
          this.stack.push(cls);
          break;
        }
        case OP.NEW_INSTANCE: {
          const argc = fn.code[frame.pc++];
          const args = this.popArgs(argc);
          const cls = this.stack.pop()!;
          if (cls.kind !== 'class') throw new RuntimeError(`cannot instantiate ${typeName(cls)}`);
          const inst = new InstV(cls, new Map());
          const ctor = this.lookupMethod(cls, 'constructor');
          if (ctor) {
            await this.invokeMethod(ctor, inst, args, ctor.homeClass);
          } else if (args.length > 0) {
            throw new RuntimeError(`class '${cls.name}' has no constructor but got ${args.length} argument(s)`);
          }
          this.stack.push(inst);
          break;
        }
        case OP.CALL_METHOD: {
          const kc = this.readU16(fn, frame);
          const name = this.stringConst(mod, kc);
          const argc = fn.code[frame.pc++];
          const args = this.popArgs(argc);
          const receiver = this.stack.pop()!;
          this.stack.push(await this.callMethod(receiver, name, args));
          break;
        }
        case OP.LOAD_THIS: {
          this.stack.push(frame.thisValue ?? NULL_VALUE);
          break;
        }
        case OP.SUPER_CALL: {
          const kc = this.readU16(fn, frame);
          const name = this.stringConst(mod, kc);
          const argc = fn.code[frame.pc++];
          const args = this.popArgs(argc);
          if (!frame.homeClass || !frame.homeClass.parent) {
            throw new RuntimeError('super call without a parent class');
          }
          if (!frame.thisValue) throw new RuntimeError('super call outside of a method');
          const method = this.lookupMethod(frame.homeClass.parent, name);
          if (!method) throw new RuntimeError(`parent class has no method '${name}'`);
          this.stack.push(await this.invokeMethod(method, frame.thisValue, args, method.homeClass));
          break;
        }
        case OP.THROW: {
          const v = this.stack.pop()!;
          const err = v.kind === 'error' ? v : new ErrV(toDisplayString(v), v);
          this.handleThrow(err);
          break;
        }
        case OP.FINALLY_END: {
          if (frame.pending) {
            const e = frame.pending;
            frame.pending = null;
            this.handleThrow(e);
          }
          break;
        }
        case OP.IMPORT: {
          const nameC = this.readU16(fn, frame);
          const name = this.stringConst(mod, nameC);
          this.stack.push(await this.importModule(name));
          break;
        }
        default:
          throw new RuntimeError(`invalid opcode 0x${op.toString(16)} at byte ${frame.pc - 1}`);
      }

        if (returnValue !== null) break;
      }
    } catch (e) {
      if (e instanceof UnwindSignal && this.frames[this.frames.length - 1] === frame) {
        // The unwound exception landed in this frame's handler; resume there.
        return this.frameLoop(frame);
      }
      if (e instanceof ThrowSignal) {
        // A thrown value (explicit throw, error()/assert built-ins) is routed
        // through this frame's try tables, propagating to handlers as needed.
        this.handleThrow(e.error);
        if (this.frames[this.frames.length - 1] === frame) return this.frameLoop(frame);
        throw e;
      }
      if (e instanceof RuntimeError) {
        // Runtime faults (division by zero, bad index, ...) are catchable too.
        this.handleThrow(new ErrV(e.message));
        if (this.frames[this.frames.length - 1] === frame) return this.frameLoop(frame);
        throw e;
      }
      throw e;
    }
    return returnValue ?? NULL_VALUE;
  }

  private readU16(fn: FunctionDef, frame: Frame): number {
    if (frame.pc + 2 > fn.code.length) throw new RuntimeError('truncated instruction: expected u16 operand');
    const v = (fn.code[frame.pc] << 8) | fn.code[frame.pc + 1];
    frame.pc += 2;
    return v;
  }

  private readU32(fn: FunctionDef, frame: Frame): number {
    if (frame.pc + 4 > fn.code.length) throw new RuntimeError('truncated instruction: expected u32 operand');
    const v =
      (fn.code[frame.pc] * 0x1000000) |
      (fn.code[frame.pc + 1] << 16) |
      (fn.code[frame.pc + 2] << 8) |
      fn.code[frame.pc + 3];
    frame.pc += 4;
    return v >>> 0;
  }

  private assertSlot(fn: FunctionDef, slot: number): void {
    if (slot >= fn.localCount) throw new RuntimeError(`local slot ${slot} out of range (function has ${fn.localCount} slots)`);
  }

  private stringConst(mod: Module, idx: number): string {
    const c = mod.constants[idx];
    if (!c || c.kind !== 'str') throw new RuntimeError(`expected string constant at index ${idx}`);
    return c.value;
  }

  private popArgs(argc: number): Value[] {
    const args: Value[] = [];
    for (let i = 0; i < argc; i++) args.unshift(this.stack.pop()!);
    return args;
  }

  private asInt(v: Value): bigint {
    const n = asNumber(v);
    return typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
  }

  private numeric(a: Value, b: Value, intOp: (x: bigint, y: bigint) => bigint, floatOp: (x: number, y: number) => number): Value {
    const x = asNumber(a);
    const y = asNumber(b);
    if (typeof x === 'bigint' && typeof y === 'bigint') return new NumV(intOp(x, y));
    return new NumV(floatOp(typeof x === 'bigint' ? Number(x) : x, typeof y === 'bigint' ? Number(y) : y));
  }

  private add(a: Value, b: Value): Value {
    if (a.kind === 'string' || b.kind === 'string') return new StrV(toDisplayString(a) + toDisplayString(b));
    if (a.kind === 'array' && b.kind === 'array') {
      if (a.items.length + b.items.length > LIMITS.maxArraySize) throw new RuntimeError('array size limit exceeded');
      return new ArrV([...a.items, ...b.items]);
    }
    return this.numeric(a, b, (x, y) => x + y, (x, y) => x + y);
  }

  private div(a: Value, b: Value): Value {
    const x = asNumber(a);
    const y = asNumber(b);
    const yz = typeof y === 'bigint' ? y === 0n : y === 0;
    if (yz) throw new RuntimeError('division by zero');
    if (typeof x === 'bigint' && typeof y === 'bigint') {
      if (x % y === 0n) return new NumV(x / y);
      return new NumV(Number(x) / Number(y));
    }
    return new NumV((typeof x === 'bigint' ? Number(x) : x) / (typeof y === 'bigint' ? Number(y) : y));
  }

  private mod(a: Value, b: Value): Value {
    const x = asNumber(a);
    const y = asNumber(b);
    const yz = typeof y === 'bigint' ? y === 0n : y === 0;
    if (yz) throw new RuntimeError('modulo by zero');
    if (typeof x === 'bigint' && typeof y === 'bigint') return new NumV(x % y);
    return new NumV((typeof x === 'bigint' ? Number(x) : x) % (typeof y === 'bigint' ? Number(y) : y));
  }

  private pow(a: Value, b: Value): Value {
    const x = asNumber(a);
    const y = asNumber(b);
    if (typeof x === 'bigint' && typeof y === 'bigint') {
      if (y < 0n) return new NumV(Number(x) ** Number(y));
      if (y > BigInt(LIMITS.maxPowExponent)) throw new RuntimeError('pow exponent exceeds the safety limit');
      const r = x ** y;
      if (r.toString().length > LIMITS.maxStringBytes) throw new RuntimeError('pow result too large');
      return new NumV(r);
    }
    return new NumV((typeof x === 'bigint' ? Number(x) : x) ** (typeof y === 'bigint' ? Number(y) : y));
  }

  private compare(_fn: FunctionDef, _frame: Frame, cmp: (r: number) => boolean): void {
    const b = this.stack.pop()!;
    const a = this.stack.pop()!;
    let r: number;
    if (a.kind === 'string' && b.kind === 'string') r = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    else {
      const x = asNumber(a);
      const y = asNumber(b);
      const xf = typeof x === 'bigint' ? Number(x) : x;
      const yf = typeof y === 'bigint' ? Number(y) : y;
      r = xf < yf ? -1 : xf > yf ? 1 : 0;
    }
    this.stack.push(boolV(cmp(r)));
  }

  private binop(_fn: FunctionDef, _frame: Frame, op: (a: Value, b: Value) => Value): void {
    const b = this.stack.pop()!;
    const a = this.stack.pop()!;
    this.stack.push(op(a, b));
  }

  private lookupMethod(cls: ClassV, name: string): FnV | null {
    let c: ClassV | null = cls;
    while (c) {
      const m = c.methods.get(name);
      if (m) return m;
      c = c.parent;
    }
    return null;
  }

  private async callValue(callee: Value, args: Value[]): Promise<Value> {
    if (callee.kind === 'function') {
      return this.callFnIndex(callee.fnIndex, callee.env, args, callee.name, callee.homeClass, null, false, callee.modRef ?? this.module);
    }
    if (callee.kind === 'class') {
      const inst = new InstV(callee, new Map());
      const ctor = this.lookupMethod(callee, 'constructor');
      if (ctor) await this.invokeMethod(ctor, inst, args, ctor.homeClass);
      else if (args.length) throw new RuntimeError(`class '${callee.name}' has no constructor`);
      return inst;
    }
    if (callee.kind === 'builtin') {
      const def = BUILTIN_BY_ID.get(callee.id);
      if (!def) throw new RuntimeError('invalid builtin');
      return def.fn(args, this.ctx());
    }
    throw new RuntimeError(`attempted to call a ${typeName(callee)} value`);
  }

  private async invokeMethod(method: FnV, thisValue: Value, args: Value[], homeClass: ClassV | null): Promise<Value> {
    return this.callFnIndex(method.fnIndex, method.env, args, method.name, homeClass ?? method.homeClass, thisValue, false, method.modRef ?? this.module);
  }

  private async callMethod(receiver: Value, name: string, args: Value[]): Promise<Value> {
    if (receiver.kind === 'instance') {
      const own = receiver.props.get(name);
      if (own && own.kind === 'function') return this.invokeMethod(own, receiver, args, own.homeClass);
      const method = this.lookupMethod(receiver.cls, name);
      if (method) return this.invokeMethod(method, receiver, args, method.homeClass);
      throw new RuntimeError(`'${receiver.cls.name}' has no method '${name}'`);
    }
    if (receiver.kind === 'object') {
      const v = receiver.props.get(name);
      if (v && v.kind === 'function') return this.invokeMethod(v, receiver, args, v.homeClass);
      throw new RuntimeError(`object has no method '${name}'`);
    }
    if (receiver.kind === 'array') {
      if (name === 'length') return new NumV(BigInt(receiver.items.length));
      if (name === 'push' || name === 'pop' || name === 'join' || name === 'slice' || name === 'reverse' || name === 'includes' || name === 'indexOf' || name === 'map' || name === 'filter' || name === 'reduce') {
        throw new RuntimeError(`array method '${name}' is available as a built-in function, not a method`);
      }
      throw new RuntimeError(`arrays have no method '${name}'`);
    }
    if (receiver.kind === 'module') {
      return receiver.getExport(name);
    }
    throw new RuntimeError(`cannot read method '${name}' of ${typeName(receiver)}`);
  }

  private getProp(obj: Value, key: string): Value {
    if (obj.kind === 'object' || obj.kind === 'instance') {
      const v = obj.props.get(key);
      if (v !== undefined) return v;
      if (obj.kind === 'instance') {
        const method = this.lookupMethod(obj.cls, key);
        if (method) return method;
      }
      return NULL_VALUE;
    }
    if (obj.kind === 'module') return obj.getExport(key);
    if (obj.kind === 'error' && key === 'message') return new StrV(obj.message);
    if (obj.kind === 'array' && key === 'length') return new NumV(BigInt(obj.items.length));
    if (obj.kind === 'class') {
      // static members are not supported; surface null
      return NULL_VALUE;
    }
    if (obj.kind === 'string') {
      if (key === 'length') return new NumV(BigInt(obj.v.length));
      return NULL_VALUE;
    }
    throw new RuntimeError(`cannot read property '${key}' of ${typeName(obj)}`);
  }

  private setProp(obj: Value, key: string, value: Value): void {
    if (obj.kind === 'object' || obj.kind === 'instance') {
      if (obj.props.size >= LIMITS.maxObjectProps && !obj.props.has(key)) throw new RuntimeError('object property limit exceeded');
      obj.props.set(key, value);
      return;
    }
    throw new RuntimeError(`cannot set property '${key}' on ${typeName(obj)}`);
  }

  private getIndex(target: Value, index: Value): Value {
    if (target.kind === 'array') {
      const i = Number(this.asInt(index));
      const idx = i < 0 ? target.items.length + i : i;
      return target.items[idx] ?? NULL_VALUE;
    }
    if (target.kind === 'string') {
      const i = Number(this.asInt(index));
      return target.v[i] ? new StrV(target.v[i]) : NULL_VALUE;
    }
    if (target.kind === 'object') {
      const key = toDisplayString(index);
      return target.props.get(key) ?? NULL_VALUE;
    }
    if (target.kind === 'instance') {
      const key = toDisplayString(index);
      return target.props.get(key) ?? NULL_VALUE;
    }
    throw new RuntimeError(`cannot index ${typeName(target)}`);
  }

  private setIndex(target: Value, index: Value, value: Value): void {
    if (target.kind === 'array') {
      const i = Number(this.asInt(index));
      const idx = i < 0 ? target.items.length + i : i;
      if (idx < 0 || idx >= LIMITS.maxArraySize) throw new RuntimeError('array index out of range');
      while (target.items.length <= idx) target.items.push(NULL_VALUE);
      target.items[idx] = value;
      return;
    }
    if (target.kind === 'object' || target.kind === 'instance') {
      target.props.set(toDisplayString(index), value);
      return;
    }
    throw new RuntimeError(`cannot index ${typeName(target)}`);
  }

  private async importModule(name: string): Promise<ModuleV> {
    const cached = this.moduleCache.get(name);
    if (cached) return cached;
    if (!this.opts.loadModule) throw new RuntimeError(`module '${name}' cannot be loaded (no module loader)`);
    const mod = await this.opts.loadModule(name);
    if (!mod) throw new RuntimeError(`module '${name}' not found`);
    const init = mod.functions[0];
    const env = new Env(null, init.localCount);
    const exportNames = new Map<string, number>();
    for (const e of mod.exports) {
      const c = mod.constants[e.nameConst];
      if (c && c.kind === 'str') exportNames.set(c.value, e.slot);
    }
    const moduleV = new ModuleV(name, env, exportNames);
    this.moduleCache.set(name, moduleV);
    const child = new Interpreter(mod, { ...this.opts, loadModule: (n) => this.opts.loadModule!(n) });
    child.moduleCache = this.moduleCache;
    child.output = this.output;
    await child.callFnIndex(0, env, [], `<module ${name}>`, null, null, true);
    this.output = child.output;
    return moduleV;
  }

  private handleThrow(err: ErrV): void {
    for (let fi = this.frames.length - 1; fi >= 0; fi--) {
      const f = this.frames[fi];
      const pc = f.pc;
      for (const t of f.fn.tries) {
        // A region covers an instruction if that instruction's LAST byte lies
        // inside it (pc has advanced past the throwing instruction).
        const inBody = pc > t.start && pc <= t.end;
        const inCatch =
          t.catchAddr !== NO_INDEX &&
          t.finallyAddr !== NO_INDEX &&
          pc > t.catchAddr &&
          pc <= t.finallyAddr;
        if (inCatch && t.finallyAddr !== NO_INDEX) {
          // Exception inside a catch body: run the finally block once, then propagate.
          f.pending = err;
          f.pc = t.finallyAddr;
          this.stack.length = f.baseDepth;
          if (fi < this.frames.length - 1) {
            this.frames.length = fi + 1;
            throw new UnwindSignal(err);
          }
          return;
        }
        if (inBody) {
          this.stack.length = f.baseDepth;
          if (t.catchAddr !== NO_INDEX) {
            if (t.catchSlot !== NO_SLOT) f.env.slots[t.catchSlot] = err;
            f.pending = null;
            f.pc = t.catchAddr;
          } else if (t.finallyAddr !== NO_INDEX) {
            f.pending = err;
            f.pc = t.finallyAddr;
          } else {
            continue;
          }
          if (fi < this.frames.length - 1) {
            this.frames.length = fi + 1;
            throw new UnwindSignal(err);
          }
          return;
        }
      }
    }
    // No handler anywhere: abort the whole program.
    this.frames.length = 0;
    throw new ThrowSignal(err);
  }
}

/** Decode and run a 6/7 source stream in a fresh runtime. */
export async function runStream(stream: string, opts: RunOptions = {}): Promise<RunResult> {
  const mod = decodeStream(stream);
  const interp = new Interpreter(mod, opts);
  return interp.run();
}
