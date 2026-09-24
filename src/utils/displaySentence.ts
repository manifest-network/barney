/** Finish composed display prose without adding punctuation after a quoted
 * sentence. Only dangling separators outside quotes are replaced. */
export function finishDisplaySentence(message: string): string {
  const body = message.trim().replace(/[:,;]+$/u, '').trimEnd();
  return !body || /[.!?…]["'”’)\]}»›]*$/u.test(body) ? body : `${body}.`;
}
