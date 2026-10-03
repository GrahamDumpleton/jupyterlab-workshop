/**
 * Version requirements as a workshop manifest states them for tools, the
 * same grammar the server's preflight uses.
 */

const REQUIREMENT = /^\s*(>=|<=|==|>|<|=)?\s*(\d+(?:\.\d+)*)\s*$/;

/**
 * Whether a dotted version meets a requirement such as `>=2.30`.
 *
 * The requirement is one comparison, `>=`, `<=`, `==`, `>` or `<`, and
 * a dotted number, or a bare number meaning at least that. Missing
 * trailing parts count as zero, so `3.12.0` equals `3.12`. A requirement
 * in any other form is taken as met, and an empty version meets none.
 */
export function satisfiesVersion(
  version: string,
  requirement: string
): boolean {
  const match = REQUIREMENT.exec(requirement);

  if (!match) {
    return true;
  }

  if (!version.trim()) {
    return false;
  }

  const operator = match[1] || '>=';
  const wanted = match[2].split('.').map(Number);
  const actual = version.trim().split('.').map(Number);
  const width = Math.max(wanted.length, actual.length);
  let order = 0;

  for (let index = 0; index < width && order === 0; index += 1) {
    const left = actual[index] ?? 0;
    const right = wanted[index] ?? 0;

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return false;
    }

    order = left === right ? 0 : left < right ? -1 : 1;
  }

  switch (operator) {
    case '>=':
      return order >= 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '<':
      return order < 0;
    default:
      return order === 0;
  }
}
