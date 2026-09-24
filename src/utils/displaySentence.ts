/** Finish composed display prose without adding punctuation after a quoted
 * sentence. Only dangling separators outside quotes are replaced. */
export function finishDisplaySentence(message: string): string {
  const trimmed = message.trim();
  let end = trimmed.length;
  // Test one code unit at a time so interior runs cannot cause an end-anchored
  // regex to retry the same suffix. All JS whitespace and separators are BMP.
  while (end > 0 && /[\s:,;]/u.test(trimmed[end - 1])) end--;
  const body = trimmed.slice(0, end);
  return !body || /[.!?…]["'”’)\]}»›]*$/u.test(body) ? body : `${body}.`;
}
