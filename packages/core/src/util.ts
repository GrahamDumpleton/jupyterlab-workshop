/**
 * Test whether a value is a plain object with string keys.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Test whether a value is an array containing only strings.
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * Escape text for inclusion in HTML element content or attribute values.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Return the final path component of a path without its extension.
 */
export function pathStem(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');

  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Test whether a string is an `http` or `https` URL, the only kind the
 * manifest's `homepage` and `issues` links may be, since they are opened
 * in the learner's browser.
 */
export function isWebLink(value: string): boolean {
  return /^https?:\/\/\S+$/.test(value);
}
