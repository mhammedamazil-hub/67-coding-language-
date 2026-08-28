/** Hard safety limits enforced by the 67 runtime. */
export const LIMITS = {
  maxInstructions: 10_000_000,
  maxCallDepth: 200,
  maxOutputBytes: 1_000_000,
  maxArraySize: 100_000,
  maxStringBytes: 1_000_000,
  maxObjectProps: 100_000,
  maxPowExponent: 10_000,
  defaultTimeoutMs: 5_000,
} as const;
