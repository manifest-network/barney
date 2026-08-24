/**
 * Display-boundary sanitizer for provider-controlled text.
 *
 * Ported verbatim from `sanitizeForDisplay` in
 * `@manifest-network/manifest-mcp-core`. It is NOT re-exported from any
 * `@manifest-network/manifest-sdk` facade (their re-export of core is type-only),
 * and manifest-mcp-core is not a declared barney dependency — importing it
 * directly would risk a second core copy, which `src/build/bundleGuard.test.ts`
 * forbids. Hence the local copy: keep it behaviourally identical to core's so a
 * future facade export is a drop-in replacement.
 */

/**
 * Truncate to `maxCodePoints` retained code points, appending a single-code-point
 * ellipsis when truncated (so a truncated result is `maxCodePoints + 1` long).
 *
 * Iterates by CODE POINT via `Array.from`, not `String.prototype.slice`, which
 * indexes by UTF-16 code unit and can bisect a surrogate pair, leaving a LONE
 * SURROGATE that only turns into `U+FFFD` once encoded or rendered.
 */
function capLength(s: string, maxCodePoints: number): string {
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 0) return s;
  const codePoints = Array.from(s);
  if (codePoints.length <= maxCodePoints) return s;
  return `${codePoints.slice(0, maxCodePoints).join('')}…`;
}

/**
 * Strip and cap an untrusted string on its way into human- or model-facing prose.
 *
 * Normalizes to NFC, replaces every Cc/Cf/Zl/Zp code point with a space (so a
 * provider cannot smuggle a bidi override, a NUL, or a line separator into
 * rendered text), collapses runs of whitespace, trims, then caps by code point.
 *
 * Callers keep the RAW value for logic and matching — the chain and the provider
 * are authoritative by string equality — and pass it through here only where a
 * human or the model reads it.
 *
 * @param raw - Untrusted value; typed `unknown` because any nullish/non-string
 *   input is coerced (`String(raw ?? '')`) rather than rejected
 * @param maxLength - Cap on RETAINED CODE POINTS (default 64); a truncated result
 *   is `maxLength + 1` code points long because of the appended ellipsis
 * @param placeholder - Returned when nothing survives stripping
 */
export function sanitizeForDisplay(
  raw: unknown,
  maxLength = 64,
  placeholder = '(hidden)'
): string {
  const cleaned = String(raw ?? '')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return placeholder;
  return capLength(cleaned, maxLength);
}

/**
 * Per-field caps on provider-controlled provider-health text. Match mono
 * `packages/fred/src/tools/browseCatalog.ts` exactly, so barney's
 * `browse_catalog` rows stay byte-comparable with the SDK's own.
 */

/** Cap on a single `checks` key rendered into `healthError`. */
export const CHECK_NAME_CHARS = 64;
/** Cap on a single check's `message` rendered into `healthError`. */
export const CHECK_MESSAGE_CHARS = 120;
/** Whole-summary backstop, so one provider's `healthError` stays bounded no
 *  matter how the per-field caps and the check count multiply out. */
export const MAX_HEALTH_ERROR_CHARS = 1024;
/** The `/health` verdict is provider-controlled too, and is echoed as `health_status`. */
export const HEALTH_STATUS_CHARS = 32;
/** Cap on the number of failing checks folded into one provider's `healthError`. */
export const MAX_REPORTED_CHECKS = 5;
