/** Finish composed display prose without adding punctuation after a quoted
 * sentence. Only dangling separators outside quotes are replaced. */
export function finishDisplaySentence(message: string): string {
  const text = message.trim();
  if (!text || /[.!?…]["'”’)\]}»›]*$/u.test(text)) return text;
  const body = text.replace(/[:,;]+$/u, '');
  return body ? `${body}.` : '';
}
