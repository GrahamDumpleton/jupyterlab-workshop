/**
 * Workshop libraries. A library is a workshops directory holding a
 * `library.json` registry: the collections and catalogs its owner
 * subscribes to, where each collection's workshops are installed, and
 * the courses that need saying something about. Inside it, what the
 * owner made is kept apart from what they installed: their own single
 * workshops live under `personal/workshops/` and their courses, each a
 * repository of workshops with its indexes, under `personal/courses/`;
 * workshops installed from a collection live under
 * `installed/collections/<collection>/` and those downloaded from a URL
 * of their own under `installed/workshops/`. A directory without the
 * registry is a plain workshops directory and behaves as one always has.
 *
 * The directories under `installed/` always carry a short hash of where
 * their workshops came from, so two sources never compete for a name.
 * Nobody chooses or types these names; they keep the layout unambiguous.
 *
 * The Python package mirrors these rules in `jupyterlab_workshop/library.py`,
 * and the two must agree on the directory names they choose.
 */

import { normalizeLocation } from '../collection';
import { sha256 } from '../hash';
import { isRecord, isStringArray } from '../util';

/** The registry file that makes a workshops directory a library. */
export const LIBRARY_FILE = 'library.json';

/** The learning journal's directory at the library root. */
export const JOURNAL_DIRECTORY = 'journal';

/** The registry format version this package understands. */
export const LIBRARY_VERSION = 2;

/**
 * The registry format version before this one, whose library kept its
 * own workshops under `personal/`, its courses under `projects/` and its
 * downloads under `collections/` and `standalone/`. Such a registry is
 * read, so the browser can say the library needs upgrading, but never
 * written to.
 */
export const LEGACY_LIBRARY_VERSION = 1;

/** The tree of what the library's owner made. */
export const PERSONAL_DIRECTORY = 'personal';

/** The tree of what was installed from elsewhere. */
export const INSTALLED_DIRECTORY = 'installed';

/** Where the owner's own single workshops go. */
export const PERSONAL_WORKSHOPS_DIRECTORY = `${PERSONAL_DIRECTORY}/workshops`;

/** Where courses go, cloned in or linked from elsewhere. */
export const COURSES_DIRECTORY = `${PERSONAL_DIRECTORY}/courses`;

/** Where workshops installed from a collection go, a directory per collection. */
export const COLLECTIONS_DIRECTORY = `${INSTALLED_DIRECTORY}/collections`;

/** Where workshops downloaded from a URL of their own go. */
export const INSTALLED_WORKSHOPS_DIRECTORY = `${INSTALLED_DIRECTORY}/workshops`;

/** A course's workshops directory when its entry does not name one. */
export const DEFAULT_COURSE_WORKSHOPS = 'workshops';

/** The longest slug made from a collection id, before any suffix. */
const MAX_SLUG = 64;

/** The keys of a registry, in the order they are written. */
const KEY_ORDER: readonly (keyof ILibrary)[] = [
  'version',
  'collections',
  'catalogs',
  'directories',
  'courses'
];

/** The key the previous format kept its courses under. */
const LEGACY_COURSES_KEY = 'projects';

const COURSE_KEYS = new Set(['name', 'target', 'workshops']);

const COURSE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

/** A course the registry says something about. */
export interface ILibraryCourse {
  /** The course's directory under `personal/courses/`. */
  name: string;

  /** For a course linked in from outside, the directory it links to. */
  target?: string;

  /** Its workshops directory relative to it, when not `workshops`. */
  workshops?: string;
}

/** A parsed `library.json`. */
export interface ILibrary {
  /** The format version, `2`; `1` for a library that needs upgrading. */
  version: 1 | 2;

  /**
   * Subscribed collections in order. Absent means the settings apply;
   * present, even empty, it takes their place.
   */
  collections?: string[];

  /** Subscribed catalogs in order, absent or present as for collections. */
  catalogs?: string[];

  /** The directory under `installed/collections/` for each collection location. */
  directories?: Record<string, string>;

  /** Courses with something to say about them. */
  courses?: ILibraryCourse[];
}

/** A new, empty registry. */
export function emptyLibrary(): ILibrary {
  return { version: LIBRARY_VERSION };
}

/**
 * Whether a registry is in the previous format, so its library keeps
 * its workshops in the previous layout and must be upgraded before it
 * is used.
 */
export function needsUpgrade(library: ILibrary): boolean {
  return library.version !== LIBRARY_VERSION;
}

/** The message for a write refused because the library needs upgrading. */
export const NEEDS_UPGRADE_MESSAGE =
  'The workshop library was made by an earlier release and keeps its ' +
  'workshops in the previous layout; upgrade it from the workshop browser, ' +
  'or by starting it with jupyter workshop library, before changing it';

/**
 * Parse and validate the JSON value of a `library.json`. A registry in
 * the previous format is accepted, with its `projects` read as courses,
 * so that a library can be seen to need upgrading.
 */
export function parseLibrary(data: unknown): ILibrary {
  if (!isRecord(data)) {
    throw new Error('A workshop library registry must be an object');
  }

  if (
    data.version !== LIBRARY_VERSION &&
    data.version !== LEGACY_LIBRARY_VERSION
  ) {
    throw new Error(
      `Unsupported library version ${String(data.version)}, expected ${LIBRARY_VERSION}`
    );
  }

  const version = data.version as ILibrary['version'];
  const coursesKey =
    version === LEGACY_LIBRARY_VERSION ? LEGACY_COURSES_KEY : 'courses';
  const allowed = KEY_ORDER.map(key =>
    key === 'courses' ? coursesKey : (key as string)
  );

  // Unknown keys are refused, as the schema and the command line refuse
  // them, rather than dropped, which a later write would make permanent.
  const unknown = Object.keys(data).filter(key => !allowed.includes(key));

  if (unknown.length > 0) {
    throw new Error(
      `The library registry has unknown keys ${unknown.sort().join(', ')}`
    );
  }

  const library: ILibrary = { version };

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

  if (data[coursesKey] !== undefined) {
    library.courses = parseCourses(data[coursesKey]);
  }

  return library;
}

/**
 * The text of a registry as written to `library.json`: two space
 * indents and a final newline, with the keys in a fixed order so that
 * writes by the browser and by the command line give the same file. A
 * registry that needs upgrading is never written, since the layout it
 * describes is the previous one.
 */
export function serializeLibrary(library: ILibrary): string {
  if (needsUpgrade(library)) {
    throw new Error(NEEDS_UPGRADE_MESSAGE);
  }

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
 * under `installed/collections/`, and the suffix that tells two clashing
 * names apart for installs outside a library.
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
 * The directory under `installed/collections/` for a collection that has
 * none yet: the slug of its id followed by the location's hash, or the
 * hash alone when there is no usable id. The hash makes it unique to the
 * location, whatever id another collection claims.
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
 * The directory under `installed/workshops/` for a workshop downloaded
 * from a URL of its own: its name followed by the short hash of its
 * download key, so the same source always lands in the same place and
 * no other can.
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
 * `personal/workshops/`, or under `personal/courses/`, whether a course
 * cloned there or linked in. Such a workshop is trusted by where it is,
 * when it has no download record; anything downloaded keeps the usual
 * checks wherever it lands.
 */
export function isOwnLibraryPath(
  workshopsDirectory: string,
  path: string
): boolean {
  return isUnderLibraryTrees(workshopsDirectory, path, [
    PERSONAL_WORKSHOPS_DIRECTORY,
    COURSES_DIRECTORY
  ]);
}

/**
 * The course a path, relative to the root, is or lies in: for a path at
 * or under `personal/courses/<name>`, the course's own path and the rest
 * of the path within it, empty for the course itself; null otherwise.
 * Lexical only, like `isOwnLibraryPath`, and the same rule as the
 * server's `course_of_path`.
 */
export function courseOfPath(
  workshopsDirectory: string,
  path: string
): { course: string; inside: string } | null {
  const base = normalizeWorkshopsDirectory(workshopsDirectory);
  const target = normalizeWorkshopsDirectory(path);

  if (target.split('/').includes('..')) {
    return null;
  }

  const prefix = base
    ? `${base}/${COURSES_DIRECTORY}/`
    : `${COURSES_DIRECTORY}/`;

  if (!target.startsWith(prefix) || target.length === prefix.length) {
    return null;
  }

  const rest = target.slice(prefix.length);
  const slash = rest.indexOf('/');
  const name = slash < 0 ? rest : rest.slice(0, slash);

  return {
    course: prefix + name,
    inside: slash < 0 ? '' : rest.slice(slash + 1)
  };
}

/**
 * Whether a workshop path is one of the library owner's own single
 * workshops under `personal/workshops/`. Such a workshop has no other
 * copy, but it is the owner's to delete, so removing it may take the
 * directory too.
 */
export function isPersonalLibraryPath(
  workshopsDirectory: string,
  path: string
): boolean {
  return isUnderLibraryTrees(workshopsDirectory, path, [
    PERSONAL_WORKSHOPS_DIRECTORY
  ]);
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

/** The workshops directory of a course, relative to the course. */
export function courseWorkshops(course: ILibraryCourse): string {
  return course.workshops ?? DEFAULT_COURSE_WORKSHOPS;
}

/** A catalog a course may hold at its top, listing its collections. */
export const COURSE_CATALOG = 'catalog.json';

/** A collection index a course may hold at its top. */
export const COURSE_COLLECTION = 'collection.json';

/** A collection a course's own catalog lists, found inside the course. */
export interface ICourseCollection {
  /** Where its index is, relative to the course. */
  path: string;

  /** What the catalog calls it. */
  title: string;
}

/**
 * The path inside a course that a location in one of its index files
 * names, resolved against the file's own path: null for a URL, an
 * absolute path, or anything that climbs out of the course. The course
 * itself is the empty string.
 */
export function coursePath(base: string, target: string): string | null {
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
 * The collections a course's catalog lists that are inside the course,
 * in catalog order. A collection the catalog names by URL is somewhere
 * else, and left out. The catalog is read leniently: anything unreadable
 * is skipped rather than refusing the rest.
 */
export function catalogCollections(
  catalog: unknown,
  catalogPath: string
): ICourseCollection[] {
  if (!isRecord(catalog) || !Array.isArray(catalog.collections)) {
    return [];
  }

  const found: ICourseCollection[] = [];

  for (const item of catalog.collections as unknown[]) {
    if (!isRecord(item) || typeof item.url !== 'string') {
      continue;
    }

    const path = coursePath(catalogPath, item.url);

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
 * The directories, relative to the course, of the workshops a
 * collection index in it lists, in index order: each entry's newest
 * version, the first listed, names its directory with the `subdir` of
 * its git source, or the course itself with none. An entry fetched as
 * an archive, or one whose directory is outside the course, is left
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
    const path = coursePath('', subdir);

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
 * The course entry for a name, or a bare entry for a course the
 * registry says nothing about.
 */
export function courseEntry(library: ILibrary, name: string): ILibraryCourse {
  return (
    (library.courses ?? []).find(course => course.name === name) ?? {
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

function parseCourses(value: unknown): ILibraryCourse[] {
  if (!Array.isArray(value)) {
    throw new Error(`The library's "courses" must be a list`);
  }

  return value.map((item: unknown, index: number) => {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      !COURSE_NAME.test(item.name)
    ) {
      throw new Error(`Library course ${index + 1} needs a valid "name"`);
    }

    const unknown = Object.keys(item).filter(key => !COURSE_KEYS.has(key));

    if (unknown.length > 0) {
      throw new Error(
        `Library course "${item.name}" has unknown keys ${unknown.sort().join(', ')}`
      );
    }

    const course: ILibraryCourse = { name: item.name };

    for (const key of ['target', 'workshops'] as const) {
      if (item[key] === undefined) {
        continue;
      }

      if (typeof item[key] !== 'string' || item[key] === '') {
        throw new Error(
          `Library course "${item.name}" has an invalid "${key}"`
        );
      }

      course[key] = item[key];
    }

    return course;
  });
}
