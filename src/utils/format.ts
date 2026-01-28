/**
 * Shared formatting utilities
 */

/**
 * UUID validation regex pattern
 * Matches standard UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates if a string is a valid UUID format
 */
export function isValidUUID(uuid: string): boolean {
  return UUID_REGEX.test(uuid);
}

/**
 * Parses a JSON string or value into an array of strings.
 * Returns an error message if validation fails, or the parsed array if valid.
 *
 * @param rawArgs - The raw arguments (string or array)
 * @returns Object with either `data` (string array) or `error` (error message)
 */
export function parseJsonStringArray(
  rawArgs: unknown
): { data: string[]; error?: never } | { data?: never; error: string } {
  // Only treat null/undefined as "no args"
  if (rawArgs == null) {
    return { data: [] };
  }

  // Reject other invalid types (number, boolean, etc.)
  if (typeof rawArgs !== 'string' && !Array.isArray(rawArgs)) {
    return { error: `Invalid args format: expected a JSON string or array, got ${typeof rawArgs}.` };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
  } catch {
    return { error: 'Invalid args format: could not parse JSON. Use format: ["arg1", "arg2"]' };
  }

  if (!Array.isArray(parsedArgs)) {
    return { error: 'Invalid args format: must be a JSON array of strings.' };
  }

  for (let i = 0; i < parsedArgs.length; i++) {
    if (typeof parsedArgs[i] !== 'string') {
      return { error: `Invalid args format: element at index ${i} must be a string.` };
    }
  }

  return { data: parsedArgs as string[] };
}
