/**
 * 67 binary module format (version 1).
 *
 * A .67 source file is a continuous stream of the symbols '6' (bit 0) and
 * '7' (bit 1). The stream is grouped into 8-bit bytes, most significant bit
 * first (see bits.ts). This module defines the deterministic, self-delimiting
 * byte-level format those bytes encode:
 *
 *   Module
 *     magic            4 bytes  = 0x36 0x37 0x01 0x00   ('6','7', major 1, minor 0)
 *     u32              constantCount
 *     Constant[constantCount]
 *     u32              importCount
 *     Import[importCount]            (u32 moduleNameConstIndex)
 *     u32              exportCount
 *     Export[exportCount]            (u32 nameConstIndex, u32 moduleSlot)
 *     u32              functionCount
 *     Function[functionCount]        (function 0 is the module initializer / entry)
 *
 *   Constant
 *     u8 tag   0x01 INT | 0x02 FLOAT | 0x03 STRING
 *     INT:     u8 sign (0 = zero, 1 = positive, 2 = negative), u32 magLen, magLen bytes (big-endian magnitude)
 *     FLOAT:   8 bytes IEEE-754 double (big-endian)
 *     STRING:  u32 utf8Len, utf8Len bytes
 *
 *   Function
 *     u32 nameConstIndex             (0xFFFFFFFF = anonymous)
 *     u32 paramCount, u32 nameConstIndex[paramCount]
 *     u32 localCount                 (slots 0..paramCount-1 are parameters)
 *     u32 codeLen, codeLen bytes     (instruction stream; see OP)
 *     u32 tryCount, TryRegion[tryCount]
 *       u32 start, u32 end, u32 catchAddr, u32 finallyAddr, u32 catchSlot
 *       (0xFFFFFFFF = no catch/finally; 0xFFFF = no catch variable slot)
 *     u32 debugCount, DebugEntry[debugCount]
 *       u32 codeOffset, u32 sourceBitOffset
 *
 * All integers are big-endian. All variable-length sections are length
 * prefixed, so the stream is fully self-delimiting.
 */

import { BitDecodeError, bytesToStream, streamToBytes } from './bits.js';

export const MAGIC = [0x36, 0x37, 0x01, 0x00] as const;
export const FORMAT_MAJOR = 1;

export const NO_INDEX = 0xffffffff;
export const NO_SLOT = 0xffff;

export type Constant =
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'str'; value: string };

export interface TryRegion {
  start: number;
  end: number;
  catchAddr: number; // NO_INDEX when absent
  finallyAddr: number; // NO_INDEX when absent
  catchSlot: number; // NO_SLOT when absent
}

export interface DebugEntry {
  codeOffset: number;
  bitOffset: number;
}

export interface FunctionDef {
  nameConst: number;
  params: number[]; // name constant indices
  localCount: number;
  code: Uint8Array;
  tries: TryRegion[];
  debug: DebugEntry[];
}

export interface ExportEntry {
  nameConst: number;
  slot: number;
}

export interface ImportEntry {
  moduleConst: number;
}

export interface Module {
  constants: Constant[];
  imports: ImportEntry[];
  exports: ExportEntry[];
  functions: FunctionDef[];
  sourceBitLength: number;
}

/** Opcodes for the instruction stream. */
export const OP = {
  LOAD_CONST: 0x01, // u16 constIndex
  LOAD_TRUE: 0x02,
  LOAD_FALSE: 0x03,
  LOAD_NULL: 0x04,
  LOAD_LOCAL: 0x05, // u16 slot
  STORE_LOCAL: 0x06, // u16 slot
  GET_UPVAR: 0x07, // u8 depth, u16 slot
  SET_UPVAR: 0x08, // u8 depth, u16 slot
  POP: 0x09,
  DUP: 0x0a,
  ADD: 0x0b,
  SUB: 0x0c,
  MUL: 0x0d,
  DIV: 0x0e,
  MOD: 0x0f,
  POW: 0x10,
  NEG: 0x11,
  NOT: 0x12,
  BAND: 0x13,
  BOR: 0x14,
  BXOR: 0x15,
  BNOT: 0x16,
  SHL: 0x17,
  SHR: 0x18,
  EQ: 0x19,
  NEQ: 0x1a,
  LT: 0x1b,
  LTE: 0x1c,
  GT: 0x1d,
  GTE: 0x1e,
  JUMP: 0x1f, // u32 target (code offset)
  JUMP_IF_FALSE: 0x20, // u32 target
  JUMP_IF_TRUE: 0x21, // u32 target
  CALL: 0x22, // u8 argc
  CALL_BUILTIN: 0x23, // u16 builtinId, u8 argc
  RETURN: 0x24,
  MAKE_FUNCTION: 0x25, // u16 functionIndex
  NEW_ARRAY: 0x26, // u16 elementCount
  NEW_OBJECT: 0x27, // u16 propCount, propCount * u16 keyConstIndex
  GET_PROP: 0x28, // u16 keyConstIndex
  SET_PROP: 0x29, // u16 keyConstIndex
  GET_INDEX: 0x2a,
  SET_INDEX: 0x2b,
  NEW_CLASS: 0x2c, // u16 nameConst, u16 methodCount, methodCount * (u16 nameConst, u16 funcIndex); pops parent
  NEW_INSTANCE: 0x2d, // u8 argc; pops class, then argc args
  CALL_METHOD: 0x2e, // u16 nameConst, u8 argc; pops receiver, then argc args
  LOAD_THIS: 0x2f,
  SUPER_CALL: 0x30, // u16 nameConst, u8 argc
  THROW: 0x31,
  FINALLY_END: 0x32,
  IMPORT: 0x33, // u16 moduleNameConst
} as const;

export type Opcode = (typeof OP)[keyof typeof OP];

/** Operand layout for each opcode (used by decoder, verifier, disassembler). */
export const OP_SPEC: Record<number, { name: string; ops: ReadonlyArray<'u8' | 'u16' | 'u32' | 'u16x' | 'methodx'> }> = {
  [OP.LOAD_CONST]: { name: 'LOAD_CONST', ops: ['u16'] },
  [OP.LOAD_TRUE]: { name: 'LOAD_TRUE', ops: [] },
  [OP.LOAD_FALSE]: { name: 'LOAD_FALSE', ops: [] },
  [OP.LOAD_NULL]: { name: 'LOAD_NULL', ops: [] },
  [OP.LOAD_LOCAL]: { name: 'LOAD_LOCAL', ops: ['u16'] },
  [OP.STORE_LOCAL]: { name: 'STORE_LOCAL', ops: ['u16'] },
  [OP.GET_UPVAR]: { name: 'GET_UPVAR', ops: ['u8', 'u16'] },
  [OP.SET_UPVAR]: { name: 'SET_UPVAR', ops: ['u8', 'u16'] },
  [OP.POP]: { name: 'POP', ops: [] },
  [OP.DUP]: { name: 'DUP', ops: [] },
  [OP.ADD]: { name: 'ADD', ops: [] },
  [OP.SUB]: { name: 'SUB', ops: [] },
  [OP.MUL]: { name: 'MUL', ops: [] },
  [OP.DIV]: { name: 'DIV', ops: [] },
  [OP.MOD]: { name: 'MOD', ops: [] },
  [OP.POW]: { name: 'POW', ops: [] },
  [OP.NEG]: { name: 'NEG', ops: [] },
  [OP.NOT]: { name: 'NOT', ops: [] },
  [OP.BAND]: { name: 'BAND', ops: [] },
  [OP.BOR]: { name: 'BOR', ops: [] },
  [OP.BXOR]: { name: 'BXOR', ops: [] },
  [OP.BNOT]: { name: 'BNOT', ops: [] },
  [OP.SHL]: { name: 'SHL', ops: [] },
  [OP.SHR]: { name: 'SHR', ops: [] },
  [OP.EQ]: { name: 'EQ', ops: [] },
  [OP.NEQ]: { name: 'NEQ', ops: [] },
  [OP.LT]: { name: 'LT', ops: [] },
  [OP.LTE]: { name: 'LTE', ops: [] },
  [OP.GT]: { name: 'GT', ops: [] },
  [OP.GTE]: { name: 'GTE', ops: [] },
  [OP.JUMP]: { name: 'JUMP', ops: ['u32'] },
  [OP.JUMP_IF_FALSE]: { name: 'JUMP_IF_FALSE', ops: ['u32'] },
  [OP.JUMP_IF_TRUE]: { name: 'JUMP_IF_TRUE', ops: ['u32'] },
  [OP.CALL]: { name: 'CALL', ops: ['u8'] },
  [OP.CALL_BUILTIN]: { name: 'CALL_BUILTIN', ops: ['u16', 'u8'] },
  [OP.RETURN]: { name: 'RETURN', ops: [] },
  [OP.MAKE_FUNCTION]: { name: 'MAKE_FUNCTION', ops: ['u16'] },
  [OP.NEW_ARRAY]: { name: 'NEW_ARRAY', ops: ['u16'] },
  [OP.NEW_OBJECT]: { name: 'NEW_OBJECT', ops: ['u16x'] },
  [OP.GET_PROP]: { name: 'GET_PROP', ops: ['u16'] },
  [OP.SET_PROP]: { name: 'SET_PROP', ops: ['u16'] },
  [OP.GET_INDEX]: { name: 'GET_INDEX', ops: [] },
  [OP.SET_INDEX]: { name: 'SET_INDEX', ops: [] },
  [OP.NEW_CLASS]: { name: 'NEW_CLASS', ops: ['methodx'] },
  [OP.NEW_INSTANCE]: { name: 'NEW_INSTANCE', ops: ['u8'] },
  [OP.CALL_METHOD]: { name: 'CALL_METHOD', ops: ['u16', 'u8'] },
  [OP.LOAD_THIS]: { name: 'LOAD_THIS', ops: [] },
  [OP.SUPER_CALL]: { name: 'SUPER_CALL', ops: ['u16', 'u8'] },
  [OP.THROW]: { name: 'THROW', ops: [] },
  [OP.FINALLY_END]: { name: 'FINALLY_END', ops: [] },
  [OP.IMPORT]: { name: 'IMPORT', ops: ['u16'] },
};

export class FormatError extends Error {
  constructor(
    message: string,
    public readonly byteOffset: number,
    public readonly bitOffset: number,
    public readonly expected?: string,
  ) {
    super(message);
    this.name = 'FormatError';
  }
}

class ByteReader {
  pos = 0;
  constructor(public readonly bytes: Uint8Array) {}

  need(n: number, what: string): void {
    if (this.pos + n > this.bytes.length) {
      throw new FormatError(
        `truncated module: expected ${n} byte(s) for ${what} at byte ${this.pos}`,
        this.pos,
        this.pos * 8,
        what,
      );
    }
  }

  u8(what: string): number {
    this.need(1, what);
    return this.bytes[this.pos++];
  }

  u16(what: string): number {
    this.need(2, what);
    const v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1];
    this.pos += 2;
    return v;
  }

  u32(what: string): number {
    this.need(4, what);
    const b = this.bytes;
    const v =
      (b[this.pos] * 0x1000000) +
      ((b[this.pos + 1] << 16) | (b[this.pos + 2] << 8) | b[this.pos + 3]);
    this.pos += 4;
    return v >>> 0;
  }

  take(n: number, what: string): Uint8Array {
    this.need(n, what);
    const slice = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }
}

class ByteWriter {
  private buf: number[] = [];

  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    this.buf.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }

  u32(v: number): this {
    this.buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }

  bytes(b: Uint8Array): this {
    for (let i = 0; i < b.length; i++) this.buf.push(b[i]);
    return this;
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.buf);
  }

  get length(): number {
    return this.buf.length;
  }
}

function encodeConstant(c: Constant, w: ByteWriter): void {
  if (c.kind === 'int') {
    w.u8(0x01);
    if (c.value === 0n) {
      w.u8(0);
      return;
    }
    w.u8(c.value < 0n ? 0x02 : 0x01);
    const mag = c.value < 0n ? -c.value : c.value;
    let hex = mag.toString(16);
    if (hex.length & 1) hex = '0' + hex;
    const len = hex.length / 2;
    w.u32(len);
    for (let i = 0; i < len; i++) w.u8(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  } else if (c.kind === 'float') {
    w.u8(0x02);
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, c.value, false);
    w.bytes(new Uint8Array(buf));
  } else {
    w.u8(0x03);
    const utf8 = new TextEncoder().encode(c.value);
    w.u32(utf8.length);
    w.bytes(utf8);
  }
}

function decodeConstant(r: ByteReader): Constant {
  const tag = r.u8('constant tag');
  const at = r.pos - 1;
  if (tag === 0x01) {
    const sign = r.u8('integer sign');
    if (sign === 0) return { kind: 'int', value: 0n };
    if (sign !== 0x01 && sign !== 0x02) {
      throw new FormatError(`invalid integer sign byte 0x${sign.toString(16)}`, at, at * 8, 'integer sign (0, 1 or 2)');
    }
    const magLen = r.u32('integer magnitude length');
    if (magLen > 64) {
      throw new FormatError(`integer magnitude too large (${magLen} bytes)`, at, at * 8, 'magnitude <= 64 bytes');
    }
    const magBytes = r.take(magLen, 'integer magnitude');
    let mag = 0n;
    for (let i = 0; i < magBytes.length; i++) mag = (mag << 8n) | BigInt(magBytes[i]);
    return { kind: 'int', value: sign === 0x02 ? -mag : mag };
  }
  if (tag === 0x02) {
    const raw = r.take(8, 'float64');
    const view = new DataView(raw.buffer, raw.byteOffset, 8);
    return { kind: 'float', value: view.getFloat64(0, false) };
  }
  if (tag === 0x03) {
    const len = r.u32('string length');
    if (len > 1 << 20) {
      throw new FormatError(`string constant too large (${len} bytes)`, at, at * 8, 'string <= 1 MiB');
    }
    const raw = r.take(len, 'string bytes');
    return { kind: 'str', value: new TextDecoder().decode(raw) };
  }
  throw new FormatError(`invalid constant tag 0x${tag.toString(16)}`, at, at * 8, '0x01 (int), 0x02 (float) or 0x03 (string)');
}

function encodeFunction(fn: FunctionDef, w: ByteWriter): void {
  w.u32(fn.nameConst);
  w.u32(fn.params.length);
  for (const p of fn.params) w.u32(p);
  w.u32(fn.localCount);
  w.u32(fn.code.length);
  w.bytes(fn.code);
  w.u32(fn.tries.length);
  for (const t of fn.tries) {
    w.u32(t.start);
    w.u32(t.end);
    w.u32(t.catchAddr);
    w.u32(t.finallyAddr);
    w.u32(t.catchSlot);
  }
  w.u32(fn.debug.length);
  for (const d of fn.debug) {
    w.u32(d.codeOffset);
    w.u32(d.bitOffset);
  }
}

function decodeFunction(r: ByteReader): FunctionDef {
  const nameConst = r.u32('function name constant');
  const paramCount = r.u32('parameter count');
  if (paramCount > 255) throw new FormatError(`too many parameters (${paramCount})`, r.pos, r.pos * 8, '<= 255 parameters');
  const params: number[] = [];
  for (let i = 0; i < paramCount; i++) params.push(r.u32('parameter name constant'));
  const localCount = r.u32('local slot count');
  if (localCount < paramCount) {
    throw new FormatError(`localCount (${localCount}) < paramCount (${paramCount})`, r.pos, r.pos * 8, 'localCount >= paramCount');
  }
  if (localCount > 65535) throw new FormatError(`too many local slots (${localCount})`, r.pos, r.pos * 8, '<= 65535 slots');
  const codeLen = r.u32('code length');
  const code = r.take(codeLen, 'function code');
  const tryCount = r.u32('try-region count');
  const tries: TryRegion[] = [];
  for (let i = 0; i < tryCount; i++) {
    const start = r.u32('try start');
    const end = r.u32('try end');
    const catchAddr = r.u32('catch address');
    const finallyAddr = r.u32('finally address');
    const catchSlot = r.u32('catch slot');
    if (start >= end || end > codeLen) {
      throw new FormatError(`malformed try region [${start}, ${end})`, r.pos, r.pos * 8, 'region within code bounds');
    }
    tries.push({ start, end, catchAddr, finallyAddr, catchSlot });
  }
  const debugCount = r.u32('debug entry count');
  const debug: DebugEntry[] = [];
  for (let i = 0; i < debugCount; i++) {
    debug.push({ codeOffset: r.u32('debug code offset'), bitOffset: r.u32('debug bit offset') });
  }
  return { nameConst, params, localCount, code, tries, debug };
}

/** Encode a module to bytes. */
export function encodeModule(module: Module): Uint8Array {
  const w = new ByteWriter();
  for (const m of MAGIC) w.u8(m);
  w.u32(module.constants.length);
  for (const c of module.constants) encodeConstant(c, w);
  w.u32(module.imports.length);
  for (const imp of module.imports) w.u32(imp.moduleConst);
  w.u32(module.exports.length);
  for (const e of module.exports) {
    w.u32(e.nameConst);
    w.u32(e.slot);
  }
  w.u32(module.functions.length);
  for (const fn of module.functions) encodeFunction(fn, w);
  return w.toUint8Array();
}

/** Encode a module to its 6/7 source stream. */
export function moduleToStream(module: Module): string {
  return bytesToStream(encodeModule(module));
}

/** Decode bytes into a module. */
export function decodeModule(bytes: Uint8Array): Module {
  const r = new ByteReader(bytes);
  for (let i = 0; i < MAGIC.length; i++) {
    const b = r.u8('magic header');
    if (b !== MAGIC[i]) {
      throw new FormatError(
        `bad magic: expected 0x${MAGIC.map((m) => m.toString(16)).join(' ')} at byte 0`,
        0,
        0,
        '67 module header (36 37 01 00)',
      );
    }
  }
  const constCount = r.u32('constant count');
  const constants: Constant[] = [];
  for (let i = 0; i < constCount; i++) constants.push(decodeConstant(r));
  const importCount = r.u32('import count');
  const imports: ImportEntry[] = [];
  for (let i = 0; i < importCount; i++) imports.push({ moduleConst: r.u32('import module constant') });
  const exportCount = r.u32('export count');
  const exports: ExportEntry[] = [];
  for (let i = 0; i < exportCount; i++) {
    exports.push({ nameConst: r.u32('export name constant'), slot: r.u32('export slot') });
  }
  const fnCount = r.u32('function count');
  if (fnCount < 1) throw new FormatError('module has no functions (module initializer missing)', r.pos, r.pos * 8, '>= 1 function');
  const functions: FunctionDef[] = [];
  for (let i = 0; i < fnCount; i++) functions.push(decodeFunction(r));
  // Re-base debug bit offsets from code-relative to whole-stream bit offsets.
  const codeOffsets = computeFunctionCodeOffsets(bytes);
  functions.forEach((fn, i) => {
    const base = codeOffsets[i] ?? 0;
    for (const d of fn.debug) d.bitOffset = (base + d.codeOffset) * 8;
  });
  if (r.pos !== bytes.length) {
    throw new FormatError(`trailing ${bytes.length - r.pos} byte(s) after module end`, r.pos, r.pos * 8, 'end of stream');
  }
  return { constants, imports, exports, functions, sourceBitLength: bytes.length * 8 };
}

/** Byte offsets of each function's code section inside an encoded module. */
export function computeFunctionCodeOffsets(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  let pos = 4; // magic
  const u32at = (p: number): number =>
    ((bytes[p] * 0x1000000) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  const constCount = u32at(pos);
  pos += 4;
  for (let i = 0; i < constCount; i++) {
    const tag = bytes[pos++];
    if (tag === 0x01) {
      const sign = bytes[pos++];
      if (sign !== 0) {
        const magLen = u32at(pos);
        pos += 4 + magLen;
      }
    } else if (tag === 0x02) {
      pos += 8;
    } else if (tag === 0x03) {
      const len = u32at(pos);
      pos += 4 + len;
    }
  }
  const importCount = u32at(pos);
  pos += 4 + importCount * 4;
  const exportCount = u32at(pos);
  pos += 4 + exportCount * 8;
  const fnCount = u32at(pos);
  pos += 4;
  for (let i = 0; i < fnCount; i++) {
    pos += 4; // nameConst
    const paramCount = u32at(pos);
    pos += 4 + paramCount * 4;
    pos += 4; // localCount
    const codeLen = u32at(pos);
    pos += 4;
    offsets.push(pos);
    pos += codeLen;
    const tryCount = u32at(pos);
    pos += 4 + tryCount * 20;
    const dbgCount = u32at(pos);
    pos += 4 + dbgCount * 8;
  }
  return offsets;
}

/** Decode a 6/7 source stream into a module. */
export function decodeStream(stream: string): Module {
  const bytes = streamToBytes(stream); // throws BitDecodeError on bad symbols / partial byte
  try {
    return decodeModule(bytes);
  } catch (e) {
    if (e instanceof BitDecodeError) throw e;
    throw e;
  }
}

export interface DisasmInstr {
  offset: number;
  bitOffset: number;
  name: string;
  operands: number[];
  raw: string;
}

/** Walk a function's instruction stream, one instruction at a time. */
export function iterateInstructions(
  fn: FunctionDef,
  visit: (offset: number, op: number, operands: number[], size: number) => void,
): void {
  const r = new ByteReader(fn.code);
  while (r.pos < fn.code.length) {
    const start = r.pos;
    const op = r.u8('opcode');
    const spec = OP_SPEC[op];
    if (!spec) {
      throw new FormatError(
        `invalid opcode 0x${op.toString(16).padStart(2, '0')}`,
        start,
        start * 8,
        'a known 67 opcode',
      );
    }
    const operands: number[] = [];
    for (const kind of spec.ops) {
      if (kind === 'u8') operands.push(r.u8(spec.name + ' operand'));
      else if (kind === 'u16') operands.push(r.u16(spec.name + ' operand'));
      else if (kind === 'u32') operands.push(r.u32(spec.name + ' operand'));
      else if (kind === 'u16x') {
        const count = r.u16(spec.name + ' count');
        operands.push(count);
        for (let i = 0; i < count; i++) operands.push(r.u16(spec.name + ' key'));
      } else {
        // methodx: u16 nameConst, u16 methodCount, methodCount * (u16 nameConst, u16 funcIndex)
        operands.push(r.u16('class name'));
        const count = r.u16('method count');
        operands.push(count);
        for (let i = 0; i < count; i++) {
          operands.push(r.u16('method name'));
          operands.push(r.u16('method function'));
        }
      }
    }
    visit(start, op, operands, r.pos - start);
  }
}

/** Disassemble a function for the instruction inspector panel. */
export function disassemble(fn: FunctionDef): DisasmInstr[] {
  const out: DisasmInstr[] = [];
  iterateInstructions(fn, (offset, op, operands, size) => {
    const spec = OP_SPEC[op];
    let raw = '';
    for (let i = 0; i < size; i++) {
      raw += fn.code[offset + i].toString(16).padStart(2, '0');
    }
    let bitOffset = -1;
    for (const d of fn.debug) {
      if (d.codeOffset === offset) bitOffset = d.bitOffset;
    }
    out.push({ offset, bitOffset, name: spec.name, operands, raw });
  });
  return out;
}
