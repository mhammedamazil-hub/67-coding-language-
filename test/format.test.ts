import { describe, it, expect } from 'vitest';
import { bytesToStream } from '../src/lang/bits.js';
import {
  FormatError,
  MAGIC,
  decodeModule,
  decodeStream,
  encodeModule,
  moduleToStream,
  disassemble,
  OP,
} from '../src/lang/format.js';
import { ModuleBuilder, FuncBuilder } from '../src/lang/assembler.js';
import { verifyModule, SemanticError } from '../src/lang/semantic.js';

function raw(bytes: number[]): string {
  return bytesToStream(Uint8Array.from(bytes));
}

interface RawCode {
  u8(n: number): void;
  u16(n: number): void;
  u32(n: number): void;
}

/** Emit raw bytes straight into a function builder's code buffer (test only). */
function rawEmit(b: ModuleBuilder, ...bytes: number[]): void {
  const root = (b as unknown as { root: FuncBuilder }).root as unknown as { code: RawCode };
  for (const x of bytes) root.code.u8(x);
}
function rawU16(b: ModuleBuilder, n: number): void {
  const root = (b as unknown as { root: FuncBuilder }).root as unknown as { code: RawCode };
  root.code.u16(n);
}

describe('binary module decoder', () => {
  it('accepts a valid encoded module and rejects invalid symbols before decoding', () => {
    const b = new ModuleBuilder('main');
    b.root.loadStr('ok');
    b.root.pop();
    b.root.null();
    b.root.return();
    const stream = moduleToStream(b.build());
    expect(/^[67]+$/.test(stream)).toBe(true);
    const mod = decodeStream(stream);
    expect(mod.functions.length).toBe(1);
  });

  it('rejects bad magic', () => {
    const bad = raw([0x36, 0x38, 0x01, 0x00, 0, 0, 0, 0]);
    expect(() => decodeStream(bad)).toThrow(FormatError);
  });

  it('rejects a truncated module (declared section runs past end)', () => {
    const bad = raw([...MAGIC, 0, 0, 0, 100]);
    expect(() => decodeStream(bad)).toThrow(FormatError);
  });

  it('rejects invalid constant tags', () => {
    const bad = raw([...MAGIC, 0, 0, 0, 1, 0x77]);
    expect(() => decodeStream(bad)).toThrow(FormatError);
  });

  it('rejects invalid integer sign bytes', () => {
    const bad = raw([...MAGIC, 0, 0, 0, 1, 0x01, 0x09, 0, 0, 0, 0]);
    expect(() => decodeStream(bad)).toThrow(FormatError);
  });

  it('rejects malformed length fields (string length beyond stream)', () => {
    const bad = raw([...MAGIC, 0, 0, 0, 1, 0x03, 0, 0, 1, 0xf4, 0x61, 0x62, 0x63]);
    expect(() => decodeStream(bad)).toThrow(FormatError);
  });

  it('rejects modules with trailing bytes', () => {
    const b = new ModuleBuilder('main');
    b.root.null();
    b.root.return();
    const bytes = Array.from(encodeModule(b.build()));
    bytes.push(0xff, 0xff);
    expect(() => decodeModule(Uint8Array.from(bytes))).toThrow(/trailing/);
  });

  it('rejects modules with no functions', () => {
    const bytes = [...MAGIC, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(() => decodeModule(Uint8Array.from(bytes))).toThrow(FormatError);
  });

  it('rejects invalid opcodes with byte offsets', () => {
    const b = new ModuleBuilder('main');
    b.root.null();
    b.root.return();
    const mod = b.build();
    mod.functions[0].code[0] = 0x77; // invalid opcode
    const decoded = decodeModule(encodeModule(mod));
    expect(() => disassemble(decoded.functions[0])).toThrow(FormatError);
    expect(() => verifyModule(decoded)).toThrow(SemanticError);
  });

  it('rejects truncated instructions (operand runs past code end)', () => {
    const b = new ModuleBuilder('main');
    b.root.loadInt(1n);
    b.root.return();
    const mod = b.build();
    // Cut off the RETURN and one operand byte: LOAD_CONST now has only half its u16.
    mod.functions[0].code = mod.functions[0].code.slice(0, -2);
    const decoded = decodeModule(encodeModule(mod));
    expect(() => verifyModule(decoded)).toThrow(SemanticError);
  });

  it('rejects invalid constant indices', () => {
    const b = new ModuleBuilder('main');
    b.root.loadConst(9999);
    b.root.callBuiltin('print', 1);
    b.root.null();
    b.root.return();
    const mod = b.build();
    expect(() => verifyModule(mod)).toThrow(/invalid constant index/);
  });

  it('rejects invalid local slots', () => {
    const b = new ModuleBuilder('main');
    rawEmit(b, OP.STORE_LOCAL);
    rawU16(b, 500);
    b.root.null();
    b.root.return();
    const mod = b.build();
    expect(() => verifyModule(mod)).toThrow(/local slot/);
  });

  it('rejects unresolved jump labels at assembly time', () => {
    const b = new ModuleBuilder('main');
    b.root.true();
    b.root.jmpIfFalse('nowhere');
    b.root.pop();
    b.root.null();
    b.root.return();
    expect(() => b.build()).toThrow(/unresolved label/);
  });

  it('rejects jump targets landing mid-instruction', () => {
    // Hand-built code: LOAD_NULL(1) POP(1) JUMP(5) target=3 LOAD_NULL RETURN
    // Target 3 lands in the middle of JUMP's operand bytes, never on an opcode.
    const code = new Uint8Array([OP.LOAD_NULL, OP.POP, OP.JUMP, 0, 0, 0, 3, OP.LOAD_NULL, OP.RETURN]);
    const b = new ModuleBuilder('main');
    const mod = b.build();
    mod.functions[0].code = code;
    const decoded = decodeModule(encodeModule(mod));
    expect(() => verifyModule(decoded)).toThrow(SemanticError);
  });

  it('rejects invalid builtin ids', () => {
    const b = new ModuleBuilder('main');
    rawEmit(b, OP.CALL_BUILTIN);
    rawU16(b, 60000);
    rawEmit(b, 0);
    b.root.null();
    b.root.return();
    const mod = b.build();
    expect(() => verifyModule(mod)).toThrow(/built-in/);
  });

  it('rejects invalid function references', () => {
    const b = new ModuleBuilder('main');
    b.root.makeFunction(999);
    b.root.pop();
    b.root.null();
    b.root.return();
    const mod = b.build();
    expect(() => verifyModule(mod)).toThrow(/invalid function index/);
  });

  it('rejects stack underflow (more pops than values)', () => {
    const b = new ModuleBuilder('main');
    b.root.pop(); // nothing on the stack
    b.root.null();
    b.root.return();
    const mod = b.build();
    expect(() => verifyModule(mod)).toThrow(/stack underflow/);
  });

  it('rejects malformed try regions', () => {
    const b = new ModuleBuilder('main');
    b.root.null();
    b.root.return();
    const mod = b.build();
    mod.functions[0].tries = [
      { start: 500, end: 600, catchAddr: 0xffffffff, finallyAddr: 0xffffffff, catchSlot: 0xffff },
    ];
    expect(() => verifyModule(mod)).toThrow(SemanticError);
  });

  it('diagnostics carry byte and bit offsets', () => {
    try {
      decodeStream(raw([...MAGIC, 0, 0, 0, 1, 0x77]));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FormatError);
      const fe = e as FormatError;
      expect(fe.byteOffset).toBeGreaterThanOrEqual(0);
      expect(fe.bitOffset).toBe(fe.byteOffset * 8);
      expect(fe.expected).toBeDefined();
    }
  });
});
