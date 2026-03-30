/** JSON replacer that converts BigInt values to strings to avoid JSON.stringify errors. */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? String(value) : value;
}
