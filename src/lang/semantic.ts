/**
 * Semantic analysis / bytecode verification.
 *
 * Walks every decoded instruction, validates operand references (constants,
 * locals, functions, jump targets, class methods), checks try regions, and
 * performs an abstract stack-depth pass over the control-flow graph so that
 * malformed streams (stack underflow, bad jumps, invalid operands) are
 * rejected before the runtime ever executes them.
 */

import {
  FunctionDef,
  Module,
  NO_INDEX,
  NO_SLOT,
  OP,
  iterateInstructions,
} from './format.js';
import { BUILTIN_BY_ID } from './builtins.js';

export class SemanticError extends Error {
  constructor(
    message: string,
    public readonly functionIndex: number,
    public readonly codeOffset: number,
    public readonly bitOffset: number,
  ) {
    super(message);
    this.name = 'SemanticError';
  }
}

function isStringConst(mod: Module, idx: number): boolean {
  const c = mod.constants[idx];
  return !!c && c.kind === 'str';
}

function stackDelta(op: number, operands: number[]): number {
  switch (op) {
    case OP.LOAD_CONST:
    case OP.LOAD_TRUE:
    case OP.LOAD_FALSE:
    case OP.LOAD_NULL:
    case OP.LOAD_LOCAL:
    case OP.GET_UPVAR:
    case OP.DUP:
    case OP.LOAD_THIS:
      return 1;
    case OP.MAKE_FUNCTION:
    case OP.IMPORT:
      return 1;
    case OP.NEW_CLASS:
      return 0; // parent popped, class pushed
    case OP.STORE_LOCAL:
    case OP.SET_UPVAR:
    case OP.POP:
      return -1;
    case OP.ADD: case OP.SUB: case OP.MUL: case OP.DIV: case OP.MOD: case OP.POW:
    case OP.BAND: case OP.BOR: case OP.BXOR: case OP.SHL: case OP.SHR:
    case OP.EQ: case OP.NEQ: case OP.LT: case OP.LTE: case OP.GT: case OP.GTE:
      return -1;
    case OP.NEG: case OP.NOT: case OP.BNOT:
      return 0;
    case OP.JUMP:
      return 0;
    case OP.JUMP_IF_FALSE:
    case OP.JUMP_IF_TRUE:
      return -1;
    case OP.CALL:
      return -operands[0]; // callee + argc args popped, 1 result pushed
    case OP.CALL_BUILTIN:
      return 1 - operands[1];
    case OP.RETURN:
      return -1;
    case OP.NEW_ARRAY:
      return 1 - operands[0];
    case OP.NEW_OBJECT:
      return 1 - operands[0];
    case OP.GET_PROP:
      return 0; // object popped, property pushed
    case OP.SET_PROP:
      return -1; // object + value popped, value pushed back
    case OP.GET_INDEX:
      return -1; // target + index popped, value pushed
    case OP.SET_INDEX:
      return -2; // target, index, value popped; value pushed back
    case OP.NEW_INSTANCE:
      return -operands[0]; // class + args popped, instance pushed
    case OP.CALL_METHOD:
      return -operands[1]; // receiver + args popped, result pushed
    case OP.SUPER_CALL:
      return 1 - operands[1]; // args popped, result pushed
    case OP.THROW:
      return -1;
    case OP.FINALLY_END:
      return 0;
    default:
      return 0;
  }
}

function jumpTargets(op: number, operands: number[]): number[] {
  if (op === OP.JUMP || op === OP.JUMP_IF_FALSE || op === OP.JUMP_IF_TRUE) return [operands[0]];
  return [];
}

function nextOffset(offset: number, size: number): number {
  return offset + size;
}

export function verifyModule(mod: Module): void {
  // --- module-level checks ------------------------------------------------
  mod.imports.forEach((imp, i) => {
    if (!isStringConst(mod, imp.moduleConst)) {
      throw new SemanticError(`import #${i} references a non-string module name constant`, -1, 0, 0);
    }
  });
  mod.exports.forEach((e, i) => {
    if (!isStringConst(mod, e.nameConst)) {
      throw new SemanticError(`export #${i} references a non-string name constant`, -1, 0, 0);
    }
  });

  mod.functions.forEach((fn, fnIndex) => verifyFunction(mod, fn, fnIndex));
}

function verifyFunction(mod: Module, fn: FunctionDef, fnIndex: number): void {
  const err = (msg: string, offset: number): never => {
    const bit = fn.debug.find((d) => d.codeOffset === offset)?.bitOffset ?? offset * 8;
    throw new SemanticError(msg, fnIndex, offset, bit);
  };

  // Parameter name constants.
  fn.params.forEach((p, i) => {
    if (!isStringConst(mod, p)) err(`parameter #${i} name is not a string constant`, 0);
  });

  // First pass: decode every instruction, validate operands, collect CFG.
  interface Instr {
    offset: number;
    size: number;
    op: number;
    operands: number[];
  }
  const instrs: Instr[] = [];
  const instrStarts = new Set<number>();

  try {
    iterateInstructions(fn, (offset, op, operands, size) => {
      instrs.push({ offset, size, op, operands });
      instrStarts.add(offset);
    });
  } catch (e) {
    if (e instanceof Error) {
      const offsetMatch = /byte (\d+)/.exec(e.message);
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
      throw new SemanticError(e.message, fnIndex, offset, offset * 8);
    }
    throw e;
  }

  const codeLen = fn.code.length;

  for (const ins of instrs) {
    const { op, operands, offset } = ins;
    const requireConst = (idx: number, what: string): void => {
      if (idx >= mod.constants.length) err(`invalid constant index ${idx} (${what})`, offset);
    };
    switch (op) {
      case OP.LOAD_CONST:
        requireConst(operands[0], 'LOAD_CONST');
        break;
      case OP.LOAD_LOCAL:
      case OP.STORE_LOCAL:
        if (operands[0] >= fn.localCount) err(`local slot ${operands[0]} out of range (0..${fn.localCount - 1})`, offset);
        break;
      case OP.GET_UPVAR:
      case OP.SET_UPVAR:
        if (operands[0] < 1) err('upvalue depth must be >= 1', offset);
        break;
      case OP.CALL_BUILTIN:
        if (!BUILTIN_BY_ID.has(operands[0])) err(`invalid built-in id ${operands[0]}`, offset);
        break;
      case OP.MAKE_FUNCTION:
        if (operands[0] >= mod.functions.length) err(`invalid function index ${operands[0]}`, offset);
        if (operands[0] === 0 && fnIndex !== 0) err('function cannot reference the module initializer', offset);
        break;
      case OP.GET_PROP:
      case OP.SET_PROP:
      case OP.CALL_METHOD:
      case OP.SUPER_CALL:
      case OP.NEW_CLASS:
        requireConst(operands[0], 'name');
        if (!isStringConst(mod, operands[0])) err('name operand must be a string constant', offset);
        if (op === OP.NEW_CLASS) {
          for (let i = 0; i < operands[1]; i++) {
            const nameC = operands[2 + i * 2];
            const fnIdx = operands[3 + i * 2];
            if (!isStringConst(mod, nameC)) err('method name must be a string constant', offset);
            if (fnIdx >= mod.functions.length) err(`invalid method function index ${fnIdx}`, offset);
          }
        }
        break;
      case OP.NEW_OBJECT:
        for (let i = 0; i < operands[0]; i++) {
          const kc = operands[1 + i];
          requireConst(kc, 'object key');
          if (!isStringConst(mod, kc)) err('object key must be a string constant', offset);
        }
        break;
      case OP.IMPORT:
        requireConst(operands[0], 'module name');
        if (!isStringConst(mod, operands[0])) err('import module name must be a string constant', offset);
        break;
    }
    for (const target of jumpTargets(op, operands)) {
      if (target >= codeLen || !instrStarts.has(target)) {
        err(`invalid jump target ${target} (must be a valid instruction offset within 0..${codeLen - 1})`, offset);
      }
    }
  }

  // Try regions.
  for (const t of fn.tries) {
    if (t.start >= t.end || t.end > codeLen) err('malformed try region bounds', t.start);
    if (!instrStarts.has(t.start)) err('try start does not land on an instruction', t.start);
    if (!instrStarts.has(t.end)) err('try end does not land on an instruction', t.end);
    if (t.catchAddr === NO_INDEX && t.finallyAddr === NO_INDEX) err('try region has neither catch nor finally', t.start);
    if (t.catchAddr !== NO_INDEX && !instrStarts.has(t.catchAddr)) err('catch address is not an instruction', t.start);
    if (t.finallyAddr !== NO_INDEX && !instrStarts.has(t.finallyAddr)) err('finally address is not an instruction', t.start);
    if (t.catchSlot !== NO_SLOT && t.catchSlot >= fn.localCount) err('catch slot out of range', t.start);
  }

  // Abstract stack-depth pass over the control flow graph. Depth is modelled
  // per control-flow edge: a merge point records the minimum depth seen there
  // (both branches leave at least that many values on the stack).
  const depthAt = new Map<number, number>();
  const worklist: number[] = [0];
  depthAt.set(0, 0);
  const byOffset = new Map<number, Instr>();
  for (const ins of instrs) byOffset.set(ins.offset, ins);

  const visit = (target: number, depthAfter: number): void => {
    if (target >= codeLen) return;
    const prev = depthAt.get(target);
    if (prev === undefined) {
      depthAt.set(target, depthAfter);
      worklist.push(target);
    } else {
      depthAt.set(target, Math.min(prev, depthAfter));
    }
  };

  while (worklist.length) {
    const off = worklist.pop()!;
    const ins = byOffset.get(off);
    if (!ins) continue;
    const depth = depthAt.get(off)!;
    const delta = stackDelta(ins.op, ins.operands);
    if (depth + delta < 0) {
      err('stack underflow: instruction would pop more values than are on the stack', off);
    }
    const after = depth + delta;
    const fall = nextOffset(ins.offset, ins.size);
    const branches = jumpTargets(ins.op, ins.operands);
    const isUnconditional = ins.op === OP.JUMP || ins.op === OP.RETURN || ins.op === OP.THROW;
    if (!isUnconditional && fall < codeLen) visit(fall, after);
    for (const target of branches) visit(target, after);
  }
}
