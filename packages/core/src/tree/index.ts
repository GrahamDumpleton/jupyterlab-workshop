/**
 * The tree file of a workshop published as a gist. A gist holds no
 * directories, so `jupyter workshop gist` stores each file under a flat
 * name and writes `workshop-tree.json` beside them, mapping every
 * workshop-relative path to the gist file that holds it. A download of
 * the gist puts each file back at its path, so the workshop arrives
 * exactly as it was written. The map is authoritative: a gist file it
 * does not list is left out.
 *
 * The map comes from the gist, so it is untrusted: every path must stay
 * inside the workshop directory, and nothing may be written into the
 * workshop's state directory. The server extension applies the same
 * rules in Python.
 */

import { isRecord } from '../util';

/** The name of the tree file at the top of a gist. */
export const TREE_FILE = 'workshop-tree.json';

/** The tree file format version this package understands. */
export const TREE_VERSION = 1;

/** How a gist file encodes its content when it is not the text itself. */
export type TreeEncoding = 'base64';

/** One file of the workshop and where the gist holds it. */
export interface ITreeEntry {
  /** Workshop-relative POSIX path the file is restored to. */
  path: string;

  /**
   * The gist file holding the content. Absent for an empty file, which
   * a gist cannot hold.
   */
  name?: string;

  /** Set when the gist file holds an encoding of the content. */
  encoding?: TreeEncoding;

  /** Set for an empty file, which has no gist file of its own. */
  empty?: boolean;
}

/** A parsed tree file. */
export interface IWorkshopTree {
  version: 1;

  /** Every file of the workshop, the manifest included. */
  files: ITreeEntry[];
}

const MANIFEST_FILE = 'workshop.yaml';

/** The extension's state directory, which a download never writes into. */
const STATE_DIR = '_workshop';

const ENTRY_KEYS: ReadonlySet<string> = new Set([
  'path',
  'name',
  'encoding',
  'empty'
]);

/**
 * Parse and validate the JSON value of a tree file, refusing anything
 * that could write outside the workshop directory or into its state
 * directory, or that leaves the result ambiguous: two entries for one
 * path (compared without case, as macOS and Windows file systems do), a
 * path that is both a file and a directory, or two entries reading one
 * gist file. The first problem found is thrown, naming the entry.
 */
export function parseWorkshopTree(data: unknown): IWorkshopTree {
  if (!isRecord(data)) {
    throw new Error(`${TREE_FILE} must be an object`);
  }

  if (data.version !== TREE_VERSION) {
    throw new Error(
      `Unsupported ${TREE_FILE} version ${String(data.version)}, expected ${TREE_VERSION}`
    );
  }

  if (!Array.isArray(data.files)) {
    throw new Error(`${TREE_FILE} needs a "files" list`);
  }

  const files = data.files.map((item: unknown, index: number) =>
    parseEntry(item, index)
  );

  // Paths are compared folded, since a case-insensitive file system
  // would write two that differ only in case to the same file.
  const paths = new Map<string, string>();
  const names = new Map<string, string>();

  for (const entry of files) {
    const folded = entry.path.toLowerCase();
    const clash = paths.get(folded);

    if (clash !== undefined) {
      throw new Error(
        `${TREE_FILE} lists ${entry.path} and ${clash}, which are the same file`
      );
    }

    paths.set(folded, entry.path);

    if (entry.name !== undefined) {
      const taken = names.get(entry.name.toLowerCase());

      if (taken !== undefined) {
        throw new Error(
          `${TREE_FILE} reads ${entry.name} for both ${taken} and ${entry.path}`
        );
      }

      names.set(entry.name.toLowerCase(), entry.path);
    }
  }

  // A path that is also the directory of another cannot be both.
  for (const entry of files) {
    const parts = entry.path.toLowerCase().split('/');

    for (let end = 1; end < parts.length; end++) {
      const directory = paths.get(parts.slice(0, end).join('/'));

      if (directory !== undefined) {
        throw new Error(
          `${TREE_FILE} lists ${directory} as a file and as the directory of ${entry.path}`
        );
      }
    }
  }

  if (!paths.has(MANIFEST_FILE)) {
    throw new Error(`${TREE_FILE} does not list ${MANIFEST_FILE}`);
  }

  return { version: TREE_VERSION, files };
}

/**
 * Whether a value is a workshop-relative path a download may write: a
 * relative POSIX path with no empty, `.` or `..` parts, no backslash or
 * drive letter, outside the state directory and not a `.git` directory.
 */
export function isRestorablePath(value: string): boolean {
  if (
    value === '' ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }

  const parts = value.split('/');

  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    return false;
  }

  if (parts[0].toLowerCase() === STATE_DIR) {
    return false;
  }

  if (parts.some(part => part.toLowerCase() === '.git')) {
    return false;
  }

  return value !== TREE_FILE;
}

/**
 * Decode the base64 a gist file holds, ignoring the line breaks it is
 * wrapped with, and return it as base64 without them, ready for the
 * contents API. Anything that is not base64 is refused.
 */
export function cleanBase64(text: string): string {
  const cleaned = text.replace(/\s+/g, '');

  if (cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new Error('The content is not valid base64');
  }

  return cleaned;
}

function parseEntry(item: unknown, index: number): ITreeEntry {
  const where = `${TREE_FILE} entry ${index + 1}`;

  if (!isRecord(item)) {
    throw new Error(`${where} must be an object`);
  }

  for (const key of Object.keys(item)) {
    if (!ENTRY_KEYS.has(key)) {
      throw new Error(`${where} has an unknown field "${key}"`);
    }
  }

  const path = item.path;

  if (typeof path !== 'string' || !isRestorablePath(path)) {
    throw new Error(
      `${where} has a path that is not a file inside the workshop: ${JSON.stringify(path)}`
    );
  }

  // An empty file has nothing for a gist file to hold.
  if (item.empty !== undefined) {
    if (item.empty !== true) {
      throw new Error(`${where} (${path}) has "empty", which can only be true`);
    }

    if (item.name !== undefined || item.encoding !== undefined) {
      throw new Error(`${where} (${path}) is empty, so names no gist file`);
    }

    return { path, empty: true };
  }

  const name = item.name;

  if (typeof name !== 'string' || !isGistFileName(name)) {
    throw new Error(
      `${where} (${path}) has a gist file name that is not one: ${JSON.stringify(name)}`
    );
  }

  const entry: ITreeEntry = { path, name };

  if (item.encoding !== undefined) {
    if (item.encoding !== 'base64') {
      throw new Error(
        `${where} (${path}) has an unknown encoding ${JSON.stringify(item.encoding)}`
      );
    }

    entry.encoding = 'base64';
  }

  return entry;
}

function isGistFileName(value: string): boolean {
  return (
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    value !== TREE_FILE &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}
