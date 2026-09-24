import { AI_HISTORY_ERROR_CHARS } from '../config/constants';

/** Keep bounded diagnostics on both sides of history persistence. This is a
 * storage bound, so preserve existing row breaks and display formatting. */
export function boundPersistedError(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= AI_HISTORY_ERROR_CHARS) return value;
  const prefix = value.slice(0, AI_HISTORY_ERROR_CHARS - 1);
  // The UTF-16 storage bound must not split a supplementary character.
  return `${prefix.replace(/[\uD800-\uDBFF]$/u, '')}…`;
}
