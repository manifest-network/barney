/** Share a bounded budget fairly, returning unused space from short entries to
 * longer ones. Copies accounts for text repeated in structured data and prose. */
export function allocateDiagnosticBudgets(demands: ReadonlyArray<{ size: number; copies: number }>, budget: number): number[] {
  const result = demands.map(() => 0);
  let remaining = Math.max(0, Math.floor(budget));
  let copies = demands.reduce((total, entry) => total + entry.copies, 0);
  for (const { index, size, copies: count } of demands.map((entry, index) => ({ ...entry, index })).sort((a, b) => a.size - b.size)) {
    const share = Math.min(size, Math.floor(remaining / Math.max(1, copies)));
    result[index] = share;
    remaining -= share * count;
    copies -= count;
  }
  return result;
}
