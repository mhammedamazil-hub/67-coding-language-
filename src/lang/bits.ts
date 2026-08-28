/**
 * 67 bit-level encoding.
 *
 * The entire 67 source alphabet is two symbols:
 *
 *   '6'  ->  binary 0
 *   '7'  ->  binary 1
 *
 * This mapping is NEVER reversed. A source file is a continuous stream of
 * 6/7 symbols. Internally the stream is grouped into fixed-width 8-bit bytes
 * (MSB first); each byte is exactly eight symbols.
 */

export const SYM_ZERO = '6';
export const SYM_ONE = '7';

export class BitDecodeError extends Error {
  constructor(
    message: string,
    public readonly bitOffset: number,
    public readonly symbol?: string,
  ) {
    super(message);
    this.name = 'BitDecodeError';
  }
}

/** Convert a 6/7 stream into a byte array. Length must be a multiple of 8. */
export function streamToBytes(stream: string): Uint8Array {
  const bytes = new Uint8Array(stream.length >> 3);
  for (let i = 0; i < stream.length; i++) {
    const ch = stream[i];
    let bit: number;
    if (ch === SYM_ZERO) bit = 0;
    else if (ch === SYM_ONE) bit = 1;
    else {
      throw new BitDecodeError(
        `invalid symbol ${JSON.stringify(ch)}: 67 source may contain only '6' and '7'`,
        i,
        ch,
      );
    }
    if (bit) bytes[i >> 3] |= 1 << (7 - (i & 7));
  }
  if (stream.length & 7) {
    throw new BitDecodeError(
      `truncated byte: stream length ${stream.length} is not a multiple of 8 symbols`,
      stream.length,
    );
  }
  return bytes;
}

/** Convert a byte array into a 6/7 stream (8 symbols per byte, MSB first). */
export function bytesToStream(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    for (let bit = 7; bit >= 0; bit--) {
      out += (b >> bit) & 1 ? SYM_ONE : SYM_ZERO;
    }
  }
  return out;
}

/** Stream -> unsigned BigInt. Minimal-length streams map without leading zeros. */
export function streamToBigInt(stream: string): bigint {
  let value = 0n;
  for (let i = 0; i < stream.length; i++) {
    const ch = stream[i];
    let bit: bigint;
    if (ch === SYM_ZERO) bit = 0n;
    else if (ch === SYM_ONE) bit = 1n;
    else throw new BitDecodeError(`invalid symbol ${JSON.stringify(ch)} in numeric stream`, i, ch);
    value = (value << 1n) | bit;
  }
  return value;
}

/** Non-negative BigInt -> minimal 6/7 stream. Zero maps to a single '6'. */
export function bigIntToStream(value: bigint): string {
  if (value < 0n) throw new Error('bigIntToStream: value must be non-negative');
  if (value === 0n) return SYM_ZERO;
  let bits = '';
  let v = value;
  while (v > 0n) {
    bits = (v & 1n) === 1n ? SYM_ONE + bits : SYM_ZERO + bits;
    v >>= 1n;
  }
  return bits;
}

/** Encode UTF-8 text as a 6/7 stream (8 symbols per UTF-8 byte). */
export function textToStream(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // Empty text encodes to zero bytes; represent it as an empty stream.
  return bytes.length === 0 ? '' : bytesToStream(bytes);
}

/** Decode a 6/7 stream back into UTF-8 text (empty stream = empty string). */
export function streamToText(stream: string): string {
  if (stream.length === 0) return '';
  return new TextDecoder().decode(streamToBytes(stream));
}

/**
 * Soft-wrap a continuous stream into visual lines of `width` symbols.
 * Used purely for display; the stored source never contains separators.
 */
export function softWrap(stream: string, width: number): string[] {
  if (width <= 0) return [stream];
  const lines: string[] = [];
  for (let i = 0; i < stream.length; i += width) {
    lines.push(stream.slice(i, i + width));
  }
  if (lines.length === 0) lines.push('');
  return lines;
}

/** Convert a bit offset into a 1-based visual line/column for a wrap width. */
export function bitToLineCol(
  bitOffset: number,
  wrapWidth: number,
): { line: number; col: number } {
  if (wrapWidth <= 0) return { line: 1, col: bitOffset + 1 };
  return {
    line: Math.floor(bitOffset / wrapWidth) + 1,
    col: (bitOffset % wrapWidth) + 1,
  };
}
