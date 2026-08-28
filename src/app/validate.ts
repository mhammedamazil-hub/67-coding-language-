/**
 * Editor-facing diagnostics: decode + verify a stream and return structured
 * problems with bit offsets, visual line/column and human explanations.
 */

import { bitToLineCol } from '../lang/bits.js';
import { decodeStream, FormatError, disassemble } from '../lang/format.js';
import { verifyModule, SemanticError } from '../lang/semantic.js';
import { BitDecodeError } from '../lang/bits.js';

export interface Diagnostic {
  severity: 'error' | 'warning';
  bitOffset: number;
  byteOffset: number;
  line: number;
  col: number;
  message: string;
  expected?: string;
}

export function validateSource(source: string, wrapWidth: number): { ok: boolean; diagnostics: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  const at = (bitOffset: number): Pick<Diagnostic, 'bitOffset' | 'byteOffset' | 'line' | 'col'> => {
    const { line, col } = bitToLineCol(bitOffset, wrapWidth);
    return { bitOffset, byteOffset: Math.floor(bitOffset / 8), line, col };
  };

  // Fast lexical scan: mark every invalid symbol.
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== '6' && ch !== '7') {
      diags.push({ severity: 'error', ...at(i), message: `invalid symbol ${JSON.stringify(ch)}: 67 source may contain only '6' and '7'` });
    }
  }
  if (diags.length > 0) return { ok: false, diagnostics: diags.slice(0, 20) };

  if (source.length === 0) {
    return { ok: false, diagnostics: [{ severity: 'error', bitOffset: 0, byteOffset: 0, line: 1, col: 1, message: 'empty source: a 67 module needs at least a header' }] };
  }
  if (source.length % 8 !== 0) {
    diags.push({
      severity: 'error',
      ...at(source.length),
      message: `truncated byte: stream is ${source.length} symbols; bytes are exactly 8 symbols`,
    });
    return { ok: false, diagnostics: diags };
  }

  try {
    const mod = decodeStream(source);
    try {
      verifyModule(mod);
    } catch (e) {
      if (e instanceof SemanticError) {
        diags.push({ severity: 'error', ...at(e.bitOffset), message: e.message });
      } else if (e instanceof Error) {
        diags.push({ severity: 'error', ...at(0), message: e.message });
      }
      return { ok: false, diagnostics: diags };
    }
    // Disassemble every function to catch structural problems early.
    try {
      for (const fn of mod.functions) disassemble(fn);
    } catch (e) {
      if (e instanceof FormatError) {
        diags.push({ severity: 'error', ...at(e.bitOffset), message: e.message, expected: e.expected });
      }
    }
    return { ok: diags.length === 0, diagnostics: diags };
  } catch (e) {
    if (e instanceof BitDecodeError) {
      diags.push({ severity: 'error', ...at(e.bitOffset), message: e.message });
    } else if (e instanceof FormatError) {
      diags.push({ severity: 'error', ...at(e.bitOffset), message: e.message, expected: e.expected });
    } else if (e instanceof Error) {
      diags.push({ severity: 'error', bitOffset: 0, byteOffset: 0, line: 1, col: 1, message: e.message });
    }
    return { ok: false, diagnostics: diags };
  }
}
