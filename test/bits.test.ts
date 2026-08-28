import { describe, it, expect } from 'vitest';
import {
  bigIntToStream,
  bytesToStream,
  streamToBigInt,
  streamToBytes,
  streamToText,
  textToStream,
  BitDecodeError,
} from '../src/lang/bits.js';

describe('6/7 number system (6 = binary 0, 7 = binary 1)', () => {
  it('maps single symbols', () => {
    expect(streamToBigInt('6')).toBe(0n);
    expect(streamToBigInt('7')).toBe(1n);
  });

  it('maps the spec examples exactly', () => {
    expect(streamToBigInt('67')).toBe(1n); // 01
    expect(streamToBigInt('76')).toBe(2n); // 10
    expect(streamToBigInt('77')).toBe(3n); // 11
    expect(streamToBigInt('7667')).toBe(9n); // 1001
  });

  it('decodes 6776767666 by replacing 6->0 and 7->1', () => {
    expect(streamToBigInt('6776767666')).toBe(BigInt('0b0110101000'));
    expect(BigInt('0b0110101000')).toBe(424n);
  });

  it('round-trips many decimal values', () => {
    for (let i = 0n; i < 200n; i++) {
      const s = bigIntToStream(i);
      expect(streamToBigInt(s)).toBe(i);
      expect(/^[67]+$/.test(s)).toBe(true);
    }
  });

  it('round-trips large BigInts', () => {
    const values = [
      1n << 64n,
      (1n << 128n) - 1n,
      2n ** 256n,
      BigInt('1234567890123456789012345678901234567890'),
    ];
    for (const v of values) {
      const s = bigIntToStream(v);
      expect(streamToBigInt(s)).toBe(v);
      // Zero round trip
      expect(bigIntToStream(0n)).toBe('6');
    }
  });

  it('never reverses the mapping: 6 is zero, 7 is one', () => {
    expect(streamToBytes('66666666')[0]).toBe(0b00000000);
    expect(streamToBytes('77777777')[0]).toBe(0b11111111);
    expect(streamToBytes('76676667')[0]).toBe(0b10010001);
  });

  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 200, 255, 0x36, 0x37]);
    const stream = bytesToStream(bytes);
    expect(/^[67]+$/.test(stream)).toBe(true);
    expect(streamToBytes(stream)).toEqual(bytes);
  });

  it('round-trips UTF-8 text', () => {
    for (const text of ['Hello, World!', '', '67', 'héllo — wörld ✓', '日本語']) {
      const stream = textToStream(text);
      expect(/^[67]*$/.test(stream)).toBe(true);
      expect(streamToText(stream)).toBe(text);
    }
  });

  it('rejects every symbol other than 6 and 7', () => {
    for (const bad of ['0', '1', 'a', ' ', '6 7', '677.67', '6\n7', 'let x = 67', '676;']) {
      expect(() => streamToBytes(bad)).toThrow(BitDecodeError);
    }
  });

  it('reports the invalid bit offset and symbol', () => {
    try {
      streamToBytes('667X7777');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BitDecodeError);
      expect((e as BitDecodeError).bitOffset).toBe(3);
      expect((e as BitDecodeError).symbol).toBe('X');
    }
  });

  it('rejects truncated (non-byte-aligned) streams', () => {
    expect(() => streamToBytes('677')).toThrow(BitDecodeError);
  });
});
