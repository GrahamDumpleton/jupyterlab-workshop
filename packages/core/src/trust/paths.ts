/**
 * Where a write-files action may write: inside the workshop's workspace
 * directory only, and never at the workshop's own files (the manifest,
 * the pages, the shipped files and the requirements file). Shared by
 * the trust policy, which refuses the action, and the linter, which
 * reports it while the workshop is written.
 */

import { WORKSHOP_FILES_DIR, WORKSPACE_DIR } from '../format/manifest';

/** The parts of a manifest that say what a write may not touch. */
export interface IWriteLayout {
  /** The environment's requirements file, relative to the workshop. */
  requirements?: string;
}

/** Options of a write-files action that name what it writes. */
const WRITE_OPTIONS: readonly string[] = ['path', 'to'];

/**
 * Normalise a relative path against a starting directory inside the
 * workshop, both given as forward-slash paths relative to the workshop.
 * Returns the segments of the result, or null when it climbs above the
 * workshop directory or is not relative.
 */
function resolveInside(start: string, value: string): string[] | null {
  if (
    value.startsWith('/') ||
    value.startsWith('~') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return null;
  }

  const segments = start.split('/').filter(Boolean);

  for (const part of value.split('/')) {
    if (part === '..') {
      if (segments.length === 0) {
        return null;
      }

      segments.pop();
    } else if (part !== '' && part !== '.') {
      segments.push(part);
    }
  }

  return segments;
}

/**
 * Whether a path relative to the workshop is one of the workshop's own
 * files: the manifest, anything under pages/ or files/, or the
 * requirements file.
 */
function isWorkshopSource(segments: string[], layout: IWriteLayout): boolean {
  const joined = segments.join('/');

  if (segments.length === 0) {
    return false;
  }

  if (joined === 'workshop.yaml' || joined === layout.requirements) {
    return true;
  }

  return segments[0] === 'pages' || segments[0] === WORKSHOP_FILES_DIR;
}

/**
 * The reason a write-files action may not write where it names, or null
 * when it may. `type` and `options` are the action's.
 */
export function writeTargetProblem(
  type: string,
  options: Readonly<Record<string, string>>,
  layout: IWriteLayout
): string | null {
  const start = WORKSPACE_DIR;

  for (const option of WRITE_OPTIONS) {
    const value = options[option];

    if (value === undefined || value === '') {
      continue;
    }

    const segments = resolveInside(start, value);

    // Paths outside the workshop are the resolver's business; only what
    // lands inside is judged here.
    if (segments === null) {
      continue;
    }

    if (isWorkshopSource(segments, layout)) {
      return `${type} would write ${segments.join('/')}, which is part of the workshop itself and cannot be changed by an action`;
    }

    const root = start.split('/').filter(Boolean);
    const inside =
      segments.length >= root.length &&
      root.every((part, index) => segments[index] === part);

    if (!inside) {
      return `${type} would write outside the workspace ${start}, which write actions cannot do`;
    }
  }

  return null;
}
