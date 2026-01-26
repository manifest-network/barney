/**
 * Utility for combining class names
 * Simple version of clsx/tailwind-merge pattern
 */
export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}
