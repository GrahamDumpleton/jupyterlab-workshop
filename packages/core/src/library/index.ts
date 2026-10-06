/**
 * Workshop libraries. A library is a workshops directory holding a
 * `library.json` registry: the collections and catalogs its owner
 * subscribes to, where each collection's workshops are installed, and
 * the projects whose workshops it shows. Inside it, downloaded workshops
 * live under `installed/<collection>/`, the owner's own under
 * `personal/`, and repositories being worked on under `projects/`. A
 * directory without the registry is a plain workshops directory and
 * behaves as one always has.
 *
 * The Python package mirrors these rules in `jupyterlab_workshop/library.py`,
 * and the two must agree on the directory names they choose.
 */

import { normalizeLocation } from '../collection';
import { sha256 } from '../hash';
import { isRecord, isStringArray } from '../util';

/** The registry file that makes a workshops directory a library. */
export const LIBRARY_FILE = 'library.json';

/** The registry format version this package understands. */
export const LIBRARY_VERSION = 1;

/** Where downloaded workshops go, one directory per collection. */
export const INSTALLED_DIRECTORY = 'installed';

/** Where the owner's own workshops go. */
export const PERSONAL_DIRECTORY = 'personal';

/** Where projects go, cloned in or linked from elsewhere. */
export const PROJECTS_DIRECTORY = 'projects';

/** A project's workshops directory when its entry does not name one. */
export const DEFAULT_PROJECT_WORKSHOPS = 'workshops';

/** The longest slug made from a collection id, before any suffix. */
const MAX_SLUG = 64;

/** The keys of a registry, in the order they are written. */
const KEY_ORDER: readonly (keyof ILibrary)[] = [
  'version',
  'collections',
  'catalogs',
  'directories',
  'projects'
];

const PROJECT_KEYS = new Set(['name', 'target', 'workshops']);

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DIRECTORY_NAME = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * Names Windows refuses for a file or directory, whatever follows a dot.
 */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
]);

/** A project the registry says something about. */
export interface ILibraryProject {
  /** The project's directory under `projects/`. */
  name: string;

  /** For a project linked in from outside, the directory it links to. */
  target?: string;

  /** Its workshops directory relative to it, when not `workshops`. */
  workshops?: string;
}

/** A parsed `library.json`. */
export interface ILibrary {
  version: 1;

  /**
   * Subscribed collections in order. Absent means the settings apply;
   * present, even empty, it takes their place.
   */
  collections?: string[];

  /** Subscribed catalogs in order, absent or present as for collections. */
  catalogs?: string[];

  /** The directory under `installed/` for each collection location. */
  directories?: Record<string, string>;

  /** Projects with something to say about them. */
  projects?: ILibraryProject[];
}

/** A new, empty registry. */
export function emptyLibrary(): ILibrary {
  return { version: LIBRARY_VERSION };
}

/**
 * Parse and validate the JSON value of a `library.json`.
 */
export function parseLibrary(data: unknown): ILibrary {
  if (!isRecord(data)) {
    throw new Error('A workshop library registry must be an object');
  }

  if (data.version !== LIBRARY_VERSION) {
    throw new Error(
      `Unsupported library version ${String(data.version)}, expected ${LIBRARY_VERSION}`
    );
  }

  // Unknown keys are refused, as the schema and the command line refuse
  // them, rather than dropped, which a later write would make permanent.
  const unknown = Object.keys(data).filter(
    key => !(KEY_ORDER as readonly string[]).includes(key)
  );

  if (unknown.length > 0) {
    throw new Error(
      `The library registry has unknown keys ${unknown.sort().join(', ')}`
    );
  }

  const library: ILibrary = { version: LIBRARY_VERSION };

  for (const key of ['collections', 'catalogs'] as const) {
    if (data[key] === undefined) {
      continue;
    }

    if (!isStringArray(data[key]) || data[key].some(item => item === '')) {
      throw new Error(`The library's "${key}" must be a list of locations`);
    }

    library[key] = [...data[key]];
  }

  if (data.directories !== undefined) {
    library.directories = parseDirectories(data.directories);
  }

  if (data.projects !== undefined) {
    library.projects = parseProjects(data.projects);
  }

  return library;
}

/**
 * The text of a registry as written to `library.json`: two space
 * indents and a final newline, with the keys in a fixed order so that
 * writes by the browser and by the command line give the same file.
 */
export function serializeLibrary(library: ILibrary): string {
  const ordered: Record<string, unknown> = {};

  for (const key of KEY_ORDER) {
    if (library[key] !== undefined) {
      ordered[key] = library[key];
    }
  }

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * The short hash of a collection location: the directory under
 * `installed/` when its id gives no usable name, and the suffix that
 * tells two clashing names apart, as it is for clashing installs
 * outside a library.
 */
export function collectionHash(location: string): string {
  return sha256(normalizeLocation(location)).slice(0, 7);
}

/**
 * A directory name made from a collection id, or null when the id gives
 * nothing usable. Ids look like `example.org/course`, so the slashes and
 * anything else outside lower case letters, digits, dots and hyphens
 * become hyphens, and a Windows reserved name is refused.
 */
export function slugifyCollectionId(id: string): string | null {
  let slug = id
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');

  if (slug.length > MAX_SLUG) {
    slug = slug.slice(0, MAX_SLUG).replace(/[.-]+$/, '');
  }

  if (slug === '' || !DIRECTORY_NAME.test(slug)) {
    return null;
  }

  if (RESERVED.has(slug.split('.')[0])) {
    return null;
  }

  return slug;
}

/**
 * The directory under `installed/` for a collection that has none yet:
 * the slug of its id, with the location's hash appended when another
 * collection already has that directory, or the hash alone when there
 * is no usable id. `taken` holds the directories already chosen.
 */
export function chooseCollectionDirectory(
  location: string,
  id: string | undefined,
  taken: Iterable<string>
): string {
  const hash = collectionHash(location);
  const slug = id ? slugifyCollectionId(id) : null;

  if (slug === null) {
    return hash;
  }

  const used = new Set(Array.from(taken, name => name.toLowerCase()));

  return used.has(slug) ? `${slug}-${hash}` : slug;
}

/**
 * The directory recorded for a collection location, matched the way
 * subscriptions are, or undefined when none has been chosen.
 */
export function recordedDirectory(
  library: ILibrary,
  location: string
): string | undefined {
  const wanted = normalizeLocation(location);

  for (const [key, directory] of Object.entries(library.directories ?? {})) {
    if (normalizeLocation(key) === wanted) {
      return directory;
    }
  }

  return undefined;
}

/**
 * The directory a collection's workshops are installed into, choosing
 * and recording one when it has none. Returns the directory and the
 * registry to write back, which is the one given when nothing changed.
 */
export function assignCollectionDirectory(
  library: ILibrary,
  location: string,
  id: string | undefined
): { directory: string; library: ILibrary } {
  const recorded = recordedDirectory(library, location);

  if (recorded !== undefined) {
    return { directory: recorded, library };
  }

  const directories = library.directories ?? {};
  const directory = chooseCollectionDirectory(
    location,
    id,
    Object.values(directories)
  );

  return {
    directory,
    library: {
      ...library,
      directories: { ...directories, [location]: directory }
    }
  };
}

/**
 * The workshops directory setting in the form paths are joined with:
 * the root itself, given as `.`, `./` or nothing, becomes the empty
 * string, and surrounding slashes go.
 */
export function normalizeWorkshopsDirectory(directory: string): string {
  const trimmed = directory
    .trim()
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+|\/+$/g, '');

  return trimmed === '.' ? '' : trimmed;
}

/**
 * Join relative path parts with `/`, leaving out empty parts, so that a
 * workshops directory at the root gives no leading slash.
 */
export function joinLibraryPath(...parts: string[]): string {
  return parts
    .map(part => part.replace(/^\/+|\/+$/g, ''))
    .filter(part => part !== '' && part !== '.')
    .join('/');
}

/** The path of the registry for a workshops directory. */
export function libraryFilePath(workshopsDirectory: string): string {
  return joinLibraryPath(
    normalizeWorkshopsDirectory(workshopsDirectory),
    LIBRARY_FILE
  );
}

/**
 * Whether a workshop path belongs to the library's owner: under
 * `personal/`, or under `projects/`, whether cloned there or linked in.
 * Such a workshop is trusted by where it is, when it has no download
 * record; anything downloaded keeps the usual checks wherever it lands.
 */
export function isOwnLibraryPath(
  workshopsDirectory: string,
  path: string
): boolean {
  const base = normalizeWorkshopsDirectory(workshopsDirectory);
  const target = normalizeWorkshopsDirectory(path);

  if (target.split('/').some(part => part === '..')) {
    return false;
  }

  return [PERSONAL_DIRECTORY, PROJECTS_DIRECTORY].some(tree => {
    const prefix = `${joinLibraryPath(base, tree)}/`;

    return target.startsWith(prefix) && target.length > prefix.length;
  });
}

/**
 * A subscribed source and where its subscription came from: the user's
 * settings, the shipped defaults or an administrator's overrides, the
 * workshop library's registry, or a launch link for this session.
 */
export interface IMergedSource {
  url: string;
  origin: 'user' | 'defaults' | 'library' | 'session';
}

/**
 * The subscribed sources of one kind, in order and without duplicates:
 * the configured list, labelled with where it came from, then those a
 * launch link added for the session. The configured list is the user's
 * own when they have one, from their settings or their library's
 * registry, which replaces the defaults rather than adding to them.
 */
export function mergeSources(
  configured: readonly string[],
  origin: 'user' | 'defaults' | 'library',
  session: readonly string[]
): IMergedSource[] {
  const seen = new Set<string>();
  const sources: IMergedSource[] = [];

  const add = (url: string, from: IMergedSource['origin']): void => {
    const key = normalizeLocation(url);

    if (key === '' || seen.has(key)) {
      return;
    }

    seen.add(key);
    sources.push({ url, origin: from });
  };

  for (const url of configured) {
    add(url, origin);
  }

  for (const url of session) {
    add(url, 'session');
  }

  return sources;
}

/** The workshops directory of a project, relative to the project. */
export function projectWorkshops(project: ILibraryProject): string {
  return project.workshops ?? DEFAULT_PROJECT_WORKSHOPS;
}

/**
 * The project entry for a name, or a bare entry for a project the
 * registry says nothing about.
 */
export function projectEntry(library: ILibrary, name: string): ILibraryProject {
  return (
    (library.projects ?? []).find(project => project.name === name) ?? {
      name
    }
  );
}

function parseDirectories(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`The library's "directories" must be an object`);
  }

  const directories: Record<string, string> = {};

  for (const [location, directory] of Object.entries(value)) {
    if (typeof directory !== 'string' || !DIRECTORY_NAME.test(directory)) {
      throw new Error(
        `The library's directory for ${location} must be a lower case name`
      );
    }

    directories[location] = directory;
  }

  return directories;
}

function parseProjects(value: unknown): ILibraryProject[] {
  if (!Array.isArray(value)) {
    throw new Error(`The library's "projects" must be a list`);
  }

  return value.map((item: unknown, index: number) => {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      !PROJECT_NAME.test(item.name)
    ) {
      throw new Error(`Library project ${index + 1} needs a valid "name"`);
    }

    const unknown = Object.keys(item).filter(key => !PROJECT_KEYS.has(key));

    if (unknown.length > 0) {
      throw new Error(
        `Library project "${item.name}" has unknown keys ${unknown.sort().join(', ')}`
      );
    }

    const project: ILibraryProject = { name: item.name };

    for (const key of ['target', 'workshops'] as const) {
      if (item[key] === undefined) {
        continue;
      }

      if (typeof item[key] !== 'string' || item[key] === '') {
        throw new Error(
          `Library project "${item.name}" has an invalid "${key}"`
        );
      }

      project[key] = item[key];
    }

    return project;
  });
}
