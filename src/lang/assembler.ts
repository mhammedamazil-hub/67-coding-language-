/**
 * Developer-side assembler (internal instruction builder).
 *
 * End users never touch this: it only exists so the compiler toolchain, the
 * test-suite and the example generator can emit valid 67 binary modules. It
 * builds the same module structure the binary decoder consumes — the
 * assembler is NOT a readable language and never replaces the pipeline.
 */

import {
  DebugEntry,
  ExportEntry,
  FunctionDef,
  ImportEntry,
  Module,
  NO_INDEX,
  NO_SLOT,
  OP,
  computeFunctionCodeOffsets,
  encodeModule,
} from './format.js';
import { BUILTIN_BY_NAME } from './builtins.js';

export class AssemblyError extends Error {}

class CodeBuffer {
  private buf: number[] = [];
  get length(): number {
    return this.buf.length;
  }
  u8(v: number): void {
    this.buf.push(v & 0xff);
  }
  u16(v: number): void {
    this.buf.push((v >> 8) & 0xff, v & 0xff);
  }
  u32(v: number): void {
    this.buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  writeBytes(b: ArrayLike<number>): void {
    for (let i = 0; i < b.length; i++) this.buf.push(b[i]);
  }
  patchU32(at: number, v: number): void {
    this.buf[at] = (v >>> 24) & 0xff;
    this.buf[at + 1] = (v >>> 16) & 0xff;
    this.buf[at + 2] = (v >>> 8) & 0xff;
    this.buf[at + 3] = v & 0xff;
  }
  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

interface LoopCtx {
  breakLabel: string;
  continueLabel: string;
}

export class FuncBuilder {
  private code = new CodeBuffer();
  private localMap = new Map<string, number>();
  private locals = 0;
  private labels = new Map<string, number>();
  private labelRefs: Array<{ label: string; at: number }> = [];
  private debug: DebugEntry[] = [];
  private loopStack: LoopCtx[] = [];
  private anonLabels = 0;
  params: number[] = [];

  constructor(
    private mgr: ModuleBuilder,
    public nameConst: number,
    paramNames: string[],
  ) {
    for (const p of paramNames) {
      this.params.push(this.mgr.stringConst(p));
      this.local(p);
    }
  }

  /** Emit an instruction and record its code offset for the debug table. */
  private emitStart(): number {
    const off = this.code.length;
    this.debug.push({ codeOffset: off, bitOffset: off });
    return off;
  }

  local(name: string): number {
    const existing = this.localMap.get(name);
    if (existing !== undefined) return existing;
    const slot = this.locals++;
    this.localMap.set(name, slot);
    return slot;
  }

  slot(name: string): number {
    const s = this.localMap.get(name);
    if (s === undefined) throw new AssemblyError(`unknown local '${name}'`);
    return s;
  }

  // --- constants / locals ----------------------------------------------------
  constInt(value: bigint): number {
    return this.mgr.intConst(value);
  }
  constStr(value: string): number {
    return this.mgr.stringConst(value);
  }
  constFloat(value: number): number {
    return this.mgr.floatConst(value);
  }

  loadInt(value: bigint | number): this {
    this.emitStart();
    this.code.u8(OP.LOAD_CONST);
    this.code.u16(this.mgr.intConst(typeof value === 'bigint' ? value : BigInt(value)));
    return this;
  }
  loadStr(value: string): this {
    this.emitStart();
    this.code.u8(OP.LOAD_CONST);
    this.code.u16(this.mgr.stringConst(value));
    return this;
  }
  loadFloat(value: number): this {
    this.emitStart();
    this.code.u8(OP.LOAD_CONST);
    this.code.u16(this.mgr.floatConst(value));
    return this;
  }
  loadConst(idx: number): this {
    this.emitStart();
    this.code.u8(OP.LOAD_CONST);
    this.code.u16(idx);
    return this;
  }
  true(): this {
    this.emitStart();
    this.code.u8(OP.LOAD_TRUE);
    return this;
  }
  false(): this {
    this.emitStart();
    this.code.u8(OP.LOAD_FALSE);
    return this;
  }
  null(): this {
    this.emitStart();
    this.code.u8(OP.LOAD_NULL);
    return this;
  }
  loadLocal(name: string): this {
    this.emitStart();
    this.code.u8(OP.LOAD_LOCAL);
    this.code.u16(this.slot(name));
    return this;
  }
  storeLocal(name: string): this {
    this.emitStart();
    this.code.u8(OP.STORE_LOCAL);
    this.code.u16(this.local(name));
    return this;
  }
  loadUpvar(depth: number, slot: number): this {
    this.emitStart();
    this.code.u8(OP.GET_UPVAR);
    this.code.u8(depth);
    this.code.u16(slot);
    return this;
  }
  setUpvar(depth: number, slot: number): this {
    this.emitStart();
    this.code.u8(OP.SET_UPVAR);
    this.code.u8(depth);
    this.code.u16(slot);
    return this;
  }
  loadThis(): this {
    this.emitStart();
    this.code.u8(OP.LOAD_THIS);
    return this;
  }

  // --- stack ------------------------------------------------------------------
  pop(): this {
    this.emitStart();
    this.code.u8(OP.POP);
    return this;
  }
  dup(): this {
    this.emitStart();
    this.code.u8(OP.DUP);
    return this;
  }

  // --- arithmetic / logic ------------------------------------------------------
  private op(opcode: number): this {
    this.emitStart();
    this.code.u8(opcode);
    return this;
  }
  add(): this { return this.op(OP.ADD); }
  sub(): this { return this.op(OP.SUB); }
  mul(): this { return this.op(OP.MUL); }
  div(): this { return this.op(OP.DIV); }
  mod(): this { return this.op(OP.MOD); }
  pow(): this { return this.op(OP.POW); }
  neg(): this { return this.op(OP.NEG); }
  not(): this { return this.op(OP.NOT); }
  band(): this { return this.op(OP.BAND); }
  bor(): this { return this.op(OP.BOR); }
  bxor(): this { return this.op(OP.BXOR); }
  bnot(): this { return this.op(OP.BNOT); }
  shl(): this { return this.op(OP.SHL); }
  shr(): this { return this.op(OP.SHR); }
  eq(): this { return this.op(OP.EQ); }
  neq(): this { return this.op(OP.NEQ); }
  lt(): this { return this.op(OP.LT); }
  lte(): this { return this.op(OP.LTE); }
  gt(): this { return this.op(OP.GT); }
  gte(): this { return this.op(OP.GTE); }

  // --- labels / jumps -------------------------------------------------------------
  label(name: string): this {
    if (this.labels.has(name)) throw new AssemblyError(`duplicate label '${name}'`);
    this.labels.set(name, this.code.length);
    return this;
  }
  private ref(name: string): void {
    this.labelRefs.push({ label: name, at: this.code.length });
  }
  jmp(label: string): this {
    this.emitStart();
    this.code.u8(OP.JUMP);
    this.ref(label);
    this.code.u32(0);
    return this;
  }
  jmpIfFalse(label: string): this {
    this.emitStart();
    this.code.u8(OP.JUMP_IF_FALSE);
    this.ref(label);
    this.code.u32(0);
    return this;
  }
  jmpIfTrue(label: string): this {
    this.emitStart();
    this.code.u8(OP.JUMP_IF_TRUE);
    this.ref(label);
    this.code.u32(0);
    return this;
  }

  /** Emit a condition-jump wrapper: emit code, jump to `skip` when falsy. */
  ifThen(emitBody: (f: FuncBuilder) => void): this {
    const skip = `_if${this.anonLabels++}`;
    this.jmpIfFalse(skip);
    emitBody(this);
    this.label(skip);
    return this;
  }

  /** while(cond) body: `continue` -> cond, `break` -> end. */
  whileLoop(emitCond: (f: FuncBuilder) => void, emitBody: (f: FuncBuilder) => void): this {
    const n = this.anonLabels++;
    const cond = `_whileCond${n}`;
    const end = `_whileEnd${n}`;
    const ctx: LoopCtx = { breakLabel: end, continueLabel: cond };
    this.loopStack.push(ctx);
    this.label(cond);
    emitCond(this);
    this.jmpIfFalse(end);
    emitBody(this);
    this.jmp(cond);
    this.label(end);
    this.loopStack.pop();
    return this;
  }
  break(): this {
    const ctx = this.loopStack[this.loopStack.length - 1];
    if (!ctx) throw new AssemblyError('break outside of a loop');
    return this.jmp(ctx.breakLabel);
  }
  continue(): this {
    const ctx = this.loopStack[this.loopStack.length - 1];
    if (!ctx) throw new AssemblyError('continue outside of a loop');
    return this.jmp(ctx.continueLabel);
  }

  // --- calls ----------------------------------------------------------------------
  call(argc: number): this {
    this.emitStart();
    this.code.u8(OP.CALL);
    this.code.u8(argc);
    return this;
  }
  callBuiltin(name: string, argc: number): this {
    const def = BUILTIN_BY_NAME.get(name);
    if (!def) throw new AssemblyError(`unknown built-in '${name}'`);
    this.emitStart();
    this.code.u8(OP.CALL_BUILTIN);
    this.code.u16(def.id);
    this.code.u8(argc);
    return this;
  }
  makeFunction(fnIndex: number): this {
    this.emitStart();
    this.code.u8(OP.MAKE_FUNCTION);
    this.code.u16(fnIndex);
    return this;
  }
  return(): this {
    this.emitStart();
    this.code.u8(OP.RETURN);
    return this;
  }
  returnNull(): this {
    this.null();
    return this.return();
  }

  // --- data structures ---------------------------------------------------------------
  newArray(count: number): this {
    this.emitStart();
    this.code.u8(OP.NEW_ARRAY);
    this.code.u16(count);
    return this;
  }
  newObject(keys: string[]): this {
    this.emitStart();
    this.code.u8(OP.NEW_OBJECT);
    this.code.u16(keys.length);
    for (const k of keys) this.code.u16(this.mgr.stringConst(k));
    return this;
  }
  getProp(key: string): this {
    this.emitStart();
    this.code.u8(OP.GET_PROP);
    this.code.u16(this.mgr.stringConst(key));
    return this;
  }
  setProp(key: string): this {
    this.emitStart();
    this.code.u8(OP.SET_PROP);
    this.code.u16(this.mgr.stringConst(key));
    return this;
  }
  getIndex(): this {
    this.emitStart();
    this.code.u8(OP.GET_INDEX);
    return this;
  }
  setIndex(): this {
    this.emitStart();
    this.code.u8(OP.SET_INDEX);
    return this;
  }

  // --- classes / exceptions / modules -------------------------------------------------
  newClass(name: string, methods: Array<[string, number]>): this {
    this.emitStart();
    this.code.u8(OP.NEW_CLASS);
    this.code.u16(this.mgr.stringConst(name));
    this.code.u16(methods.length);
    for (const [mn, fi] of methods) {
      this.code.u16(this.mgr.stringConst(mn));
      this.code.u16(fi);
    }
    return this;
  }
  newInstance(argc: number): this {
    this.emitStart();
    this.code.u8(OP.NEW_INSTANCE);
    this.code.u8(argc);
    return this;
  }
  callMethod(name: string, argc: number): this {
    this.emitStart();
    this.code.u8(OP.CALL_METHOD);
    this.code.u16(this.mgr.stringConst(name));
    this.code.u8(argc);
    return this;
  }
  superCall(name: string, argc: number): this {
    this.emitStart();
    this.code.u8(OP.SUPER_CALL);
    this.code.u16(this.mgr.stringConst(name));
    this.code.u8(argc);
    return this;
  }
  throwValue(): this {
    this.emitStart();
    this.code.u8(OP.THROW);
    return this;
  }
  finallyEnd(): this {
    this.emitStart();
    this.code.u8(OP.FINALLY_END);
    return this;
  }
  importModule(name: string): this {
    this.emitStart();
    this.code.u8(OP.IMPORT);
    this.code.u16(this.mgr.stringConst(name));
    return this;
  }

  /**
   * try { body } catch (name) { handler } finally { cleanup }
   * Catch/finally emit callbacks are optional.
   */
  tryBlock(
    body: (f: FuncBuilder) => void,
    handler?: { name: string | null; emit: (f: FuncBuilder) => void },
    cleanup?: (f: FuncBuilder) => void,
  ): this {
    const n = this.anonLabels++;
    const catchLabel = `_catch${n}`;
    const finallyLabel = `_finally${n}`;
    const exitLabel = `_tryEnd${n}`;
    const hasCatch = !!handler;
    const hasFinally = !!cleanup;
    if (!hasCatch && !hasFinally) throw new AssemblyError('try block needs a catch or finally');

    const start = this.code.length;
    let catchSlot = NO_SLOT;
    if (hasCatch && handler!.name) catchSlot = this.local(handler!.name);

    body(this);
    if (hasFinally) this.jmp(finallyLabel);
    else this.jmp(exitLabel);
    const end = this.code.length;

    this.label(catchLabel);
    if (hasCatch) {
      handler!.emit(this);
      if (hasFinally) this.jmp(finallyLabel);
      else this.jmp(exitLabel);
    }

    if (hasFinally) {
      this.label(finallyLabel);
      cleanup!(this);
      this.finallyEnd();
    }
    this.label(exitLabel);

    this.mgr.recordTry({
      start,
      end,
      catchAddr: hasCatch ? this.labels.get(catchLabel)! : NO_INDEX,
      finallyAddr: hasFinally ? this.labels.get(finallyLabel)! : NO_INDEX,
      catchSlot,
    });
    return this;
  }

  /** Build the finished function definition (labels resolved). */
  build(): { fn: FunctionDef; codeOffset: number } {
    for (const ref of this.labelRefs) {
      const target = this.labels.get(ref.label);
      if (target === undefined) throw new AssemblyError(`unresolved label '${ref.label}'`);
      this.code.patchU32(ref.at, target);
    }
    const fn: FunctionDef = {
      nameConst: this.nameConst,
      params: this.params,
      localCount: this.locals,
      code: this.code.toUint8Array(),
      tries: this.mgr.takeTries(),
      debug: this.debug,
    };
    return { fn, codeOffset: -1 };
  }
}

interface PendingTry {
  start: number;
  end: number;
  catchAddr: number;
  finallyAddr: number;
  catchSlot: number;
}

export class ModuleBuilder {
  constants: Module['constants'] = [];
  constIndex = new Map<string, number>();
  imports: ImportEntry[] = [];
  exports: ExportEntry[] = [];
  private funcs: FunctionDef[] = [];
  private pendingTries: PendingTry[] = [];
  private init!: FuncBuilder;

  constructor(moduleName = '<module>') {
    // Function 0 is the module initializer (anonymous).
    this.init = new FuncBuilder(this, this.stringConst(moduleName === '<module>' ? '' : moduleName), []);
    // Reserve function slot 0.
    this.funcs.push(null as unknown as FunctionDef);
  }

  stringConst(value: string): number {
    const key = 's:' + value;
    const existing = this.constIndex.get(key);
    if (existing !== undefined) return existing;
    const idx = this.constants.length;
    this.constants.push({ kind: 'str', value });
    this.constIndex.set(key, idx);
    return idx;
  }

  intConst(value: bigint): number {
    const key = 'i:' + value.toString();
    const existing = this.constIndex.get(key);
    if (existing !== undefined) return existing;
    const idx = this.constants.length;
    this.constants.push({ kind: 'int', value });
    this.constIndex.set(key, idx);
    return idx;
  }

  floatConst(value: number): number {
    const key = 'f:' + String(value);
    const existing = this.constIndex.get(key);
    if (existing !== undefined) return existing;
    const idx = this.constants.length;
    this.constants.push({ kind: 'float', value });
    this.constIndex.set(key, idx);
    return idx;
  }

  /** The module initializer (top-level code). */
  get root(): FuncBuilder {
    return this.init;
  }

  /** Create a function and return its index. */
  func(name: string | null, params: string[], emit: (f: FuncBuilder) => void): number {
    const f = new FuncBuilder(this, name === null ? NO_INDEX : this.stringConst(name), params);
    emit(f);
    const { fn } = f.build();
    const index = this.funcs.length;
    this.funcs.push(fn);
    return index;
  }

  /** Declare a named function in the current (module) scope and return its index. */
  declareFunc(name: string, params: string[], emit: (f: FuncBuilder) => void): number {
    // Allocate the module-level binding first so recursive references inside
    // the body can resolve the upvalue slot.
    const slot = this.init.local(name);
    const index = this.func(name, params, emit);
    this.init.makeFunction(index);
    this.init.storeLocal(name);
    void slot;
    return index;
  }

  exportLocal(name: string): void {
    const slot = this.init.slot(name);
    this.exports.push({ nameConst: this.stringConst(name), slot });
  }

  importModule(name: string): void {
    this.imports.push({ moduleConst: this.stringConst(name) });
  }

  recordTry(t: PendingTry): void {
    this.pendingTries.push(t);
  }

  takeTries(): PendingTry[] {
    const t = this.pendingTries;
    this.pendingTries = [];
    return t;
  }

  build(): Module {
    const { fn: initFn } = this.init.build();
    this.funcs[0] = initFn;
    const module: Module = {
      constants: this.constants,
      imports: this.imports,
      exports: this.exports,
      functions: this.funcs,
      sourceBitLength: 0,
    };
    // Re-base debug bit offsets to whole-stream positions (same as the decoder).
    const bytes = encodeModule(module);
    const codeOffsets = computeFunctionCodeOffsets(bytes);
    module.functions.forEach((fn, i) => {
      const base = codeOffsets[i] ?? 0;
      for (const d of fn.debug) d.bitOffset = (base + d.codeOffset) * 8;
    });
    module.sourceBitLength = bytes.length * 8;
    return module;
  }
}
