import { AI_HISTORY_ERROR_CHARS, AI_HISTORY_ERROR_TAIL_CHARS, FAILURE_DETAIL_CHARS } from '../config/constants';
import { sanitizeForDisplay } from './sanitizeText';

const OMISSION_NOTICE = '\n… [Part of this saved error was omitted.] …\n';

/** Keep bounded diagnostics on both sides of history persistence. Preserve
 * complete leading/trailing rows where possible, including closing guidance. */
export function boundPersistedError(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= AI_HISTORY_ERROR_CHARS) return value;

  let tailStart = value.length - AI_HISTORY_ERROR_TAIL_CHARS;
  const nextLine = value.indexOf('\n', tailStart);
  if (nextLine >= 0 && nextLine < value.length - 1) tailStart = nextLine + 1;
  // Do not retain half of a supplementary character at either cut boundary.
  if (/[\uDC00-\uDFFF]/u.test(value[tailStart])) tailStart++;
  const tail = value.slice(tailStart);
  let headEnd = AI_HISTORY_ERROR_CHARS - OMISSION_NOTICE.length - tail.length;
  const previousLine = value.lastIndexOf('\n', headEnd - 1);
  if (previousLine > 0) headEnd = previousLine;
  if (/[\uD800-\uDBFF]/u.test(value[headEnd - 1])) headEnd--;
  return `${value.slice(0, headEnd)}${OMISSION_NOTICE}${tail}`;
}

/** Older builds stored raw provider text. Only the exact persisted format
 * marker preserves multiline prose; the marker is removed by history parsing. */
export function loadPersistedError(value: unknown, format: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (format === 'authored') return boundPersistedError(value);
  return value === '' ? '' : sanitizeForDisplay(value, FAILURE_DETAIL_CHARS);
}
