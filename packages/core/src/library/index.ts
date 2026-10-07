/**
 * Workshop libraries. A library is a workshops directory holding a
 * `library.json` registry: the collections and catalogs its owner
 * subscribes to, where each collection's workshops are installed, and
 * the projects whose workshops it shows. Inside it, workshops installed
 * from a collection live under `collections/<collection>/`, workshops
 * downloaded from a URL of their own under `standalone/`, the owner's
 * own under `personal/`, and repositories being worked on under
 * `projects/`. A directory without the registry is a plain workshops
 * directory and behaves as one always has.
 *
 * The directories under `collections/` and `standalone/` always carry a
 * short hash of where their workshops came from, so two sources never
 * compete for a name. Nobody chooses or types these names; they keep the
 * layout unambiguous.
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

/** Where workshops installed from a collection go, a directory per collection. */
export const COLLECTIONS_DIRECTORY = 'collections';

/** Where workshops downloaded from a URL of their own go. */
export const STANDALONE_DIRECTORY = 'standalone';

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

  /** The directory under `collections/` for each collection location. */
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
 * The short hash of a collection location: the suffix of its directory
 * under `collections/`, and the suffix that tells two clashing names
 * apart for installs outside a library.
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
 * The directory under `collections/` for a collection that has none yet:
 * the slug of its id followed by the location's hash, or the hash alone
 * when there is no usable id. The hash makes it unique to the location,
 * whatever id another collection claims.
 */
export function chooseCollectionDirectory(
  location: string,
  id: string | undefined
): string {
  const hash = collectionHash(location);
  const slug = id ? slugifyCollectionId(id) : null;

  return slug === null ? hash : `${slug}-${hash}`;
}

/** Where a workshop was downloaded from, as its source record holds it. */
export interface IDownloadSource {
  /** `git` for a repository or gist, `archive` for an archive URL. */
  kind: string;
  url: string;

  /** The directory of the repository or archive holding the workshop. */
  subdir?: string;
}

/**
 * What identifies a download, whatever revision of it was taken: its
 * kind, its URL compared as collection locations are with any `.git`
 * dropped, and its subdirectory. A gist is named by its id alone, since
 * its owner can be left out of the URL. Two downloads with the same key
 * are the same workshop, so one may replace the other.
 */
export function downloadKey(source: IDownloadSource): string {
  let url = normalizeLocation(source.url).replace(/\.git$/, '');
  const gist = /^https:\/\/gist\.github\.com\/(?:[^/]+\/)?([0-9a-fA-F]+)$/.exec(
    url
  );

  if (gist) {
    url = `https://gist.github.com/${gist[1].toLowerCase()}`;
  }

  const subdir = (source.subdir ?? '')
    .split('/')
    .filter(part => part !== '')
    .join('/');

  return subdir ? `${source.kind}:${url}#${subdir}` : `${source.kind}:${url}`;
}

/**
 * The directory under `standalone/` for a workshop downloaded from a URL
 * of its own: its name followed by the short hash of its download key,
 * so the same source always lands in the same place and no other can.
 */
export function standaloneDirectory(
  name: string,
  source: IDownloadSource
): string {
  return `${name}-${sha256(downloadKey(source)).slice(0, 7)}`;
}

/**
 * Whether a directory's source record says it is a download that a new
 * download may replace: one from the same source, or one installed from
 * the same collection, as an update of it is. Anything else, a local
 * workshop above all, is never replaced.
 */
export function mayReplaceDownload(
  record: unknown,
  source: IDownloadSource,
  collection?: string
): boolean {
  if (!isRecord(record) || !isRecord(record.source)) {
    return false;
  }

  const recorded = record.source;

  if (
    (recorded.kind !== 'git' && recorded.kind !== 'archive') ||
    typeof recorded.url !== 'string'
  ) {
    return false;
  }

  if (
    collection &&
    typeof record.collection === 'string' &&
    normalizeLocation(record.collection) === normalizeLocation(collection)
  ) {
    return true;
  }

  return (
    downloadKey({
      kind: recorded.kind,
      url: recorded.url,
      subdir: typeof recorded.subdir === 'string' ? recorded.subdir : ''
    }) === downloadKey(source)
  );
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
  const directory = chooseCollectionDirectory(location, id);

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
  return isUnderLibraryTrees(workshopsDirectory, path, [
    PERSONAL_DIRECTORY,
    PROJECTS_DIRECTORY
  ]);
}

/**
 * Whether a workshop path is one of the library owner's own under
 * `personal/`. Such a workshop has no other copy, but it is the owner's
 * to delete, so removing it may take the directory too.
 */
export function isPersonalLibraryPath(
  workshopsDirectory: string,
  path: string
): boolean {
  return isUnderLibraryTrees(workshopsDirectory, path, [PERSONAL_DIRECTORY]);
}

function isUnderLibraryTrees(
  workshopsDirectory: string,
  path: string,
  trees: string[]
): boolean {
  const base = normalizeWorkshopsDirectory(workshopsDirectory);
  const target = normalizeWorkshopsDirectory(path);

  if (target.split('/').some(part => part === '..')) {
    return false;
  }

  return trees.some(tree => {
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

/** A catalog a project may hold at its top, listing its collections. */
export const PROJECT_CATALOG = 'catalog.json';

/** A collection index a project may hold at its top. */
export const PROJECT_COLLECTION = 'collection.json';

/** A collection a project's own catalog lists, found inside the project. */
export interface IProjectCollection {
  /** Where its index is, relative to the project. */
  path: string;

  /** What the catalog calls it. */
  title: string;
}

/**
 * The path inside a project that a location in one of its index files
 * names, resolved against the file's own path: null for a URL, an
 * absolute path, or anything that climbs out of the project. The
 * project itself is the empty string.
 */
export function projectPath(base: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) {
    return null;
  }

  const directory = base.includes('/')
    ? base.slice(0, base.lastIndexOf('/'))
    : '';
  const segments: string[] = [];

  for (const part of `${directory}/${target}`.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }

    if (part === '..') {
      if (segments.length === 0) {
        return null;
      }

      segments.pop();
    } else {
      segments.push(part);
    }
  }

  return segments.join('/');
}

/**
 * The collections a project's catalog lists that are inside the project,
 * in catalog order. A collection the catalog names by URL is somewhere
 * else, and left out. The catalog is read leniently: anything unreadable
 * is skipped rather than refusing the rest.
 */
export function catalogCollections(
  catalog: unknown,
  catalogPath: string
): IProjectCollection[] {
  if (!isRecord(catalog) || !Array.isArray(catalog.collections)) {
    return [];
  }

  const found: IProjectCollection[] = [];

  for (const item of catalog.collections as unknown[]) {
    if (!isRecord(item) || typeof item.url !== 'string') {
      continue;
    }

    const path = projectPath(catalogPath, item.url);

    if (path) {
      found.push({
        path,
        title: typeof item.title === 'string' && item.title ? item.title : path
      });
    }
  }

  return found;
}

/**
 * The directories, relative to the project, of the workshops a
 * collection index in it lists, in index order: each entry's newest
 * version, the first listed, names its directory with the `subdir` of
 * its git source, or the project itself with none. An entry fetched as
 * an archive, or one whose directory is outside the project, is left
 * out.
 */
export function collectionWorkshops(collection: unknown): string[] {
  if (!isRecord(collection) || !Array.isArray(collection.workshops)) {
    return [];
  }

  const found: string[] = [];

  for (const entry of collection.workshops as unknown[]) {
    const versions = isRecord(entry) ? entry.versions : undefined;
    const newest = Array.isArray(versions)
      ? (versions[0] as unknown)
      : undefined;
    const source = isRecord(newest) ? newest.source : undefined;

    if (!isRecord(source) || typeof source.git !== 'string') {
      continue;
    }

    // A subdir is always within the repository, however it is written.
    const subdir =
      typeof source.subdir === 'string'
        ? source.subdir.replace(/^\/+/, '')
        : '';
    const path = projectPath('', subdir);

    if (path !== null && !found.includes(path)) {
      found.push(path);
    }
  }

  return found;
}

/** The title a collection index gives itself, or the fallback. */
export function collectionTitle(collection: unknown, fallback: string): string {
  return isRecord(collection) &&
    typeof collection.title === 'string' &&
    collection.title
    ? collection.title
    : fallback;
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
