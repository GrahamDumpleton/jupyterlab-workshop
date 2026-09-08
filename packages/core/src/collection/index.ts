/**
 * Collection index files: published lists of workshops that can be
 * installed, each with the sources of its versions. The extension's
 * browser reads them, the CLI builds them, and both agree on the shape
 * through this module.
 */

import { isRecord, isStringArray } from '../util';

/** Who publishes a collection or a catalog. */
export interface IPublisher {
  name: string;
  url?: string;
}

/** Where one version of a collection workshop is fetched from. */
export interface ICollectionSource {
  /** Repository URL, when the version lives in git. */
  git?: string;
  ref?: string;
  subdir?: string;

  /** Direct archive URL, when the version is an archive. */
  archive?: string;
}

/** One installable version of a collection workshop. */
export interface ICollectionVersion {
  version: string;
  source: ICollectionSource;

  /** Expected SHA-256 of the archive, when known. */
  sha256?: string;
}

/** A workshop listed in a collection. */
export interface ICollectionEntry {
  name: string;
  title: string;
  description: string;
  tags: string[];
  platforms: string[];
  capabilities: string[];
  duration?: string;
  authors: string[];

  /** Versions newest first. */
  versions: ICollectionVersion[];
}

/** Metadata describing a collection, as its index or a catalog gives it. */
export interface ICollectionInfo {
  title?: string;
  description?: string;
  publisher?: IPublisher;
  homepage?: string;

  /** Icon URL, possibly relative to the file it appears in. */
  icon?: string;
  tags: string[];
}

/** A parsed collection index. */
export interface ICollectionIndex extends ICollectionInfo {
  version: 1;

  /**
   * Whether the workshops form a sequence meant to be taken in the order
   * listed, as a course does, rather than a set.
   */
  ordered: boolean;

  /** The workshops, in the order the collection lists them. */
  workshops: ICollectionEntry[];
}

/** The collection index format version this package understands. */
export const COLLECTION_VERSION = 1;

/** The file name a collection index is published under by convention. */
export const COLLECTION_FILE = 'collection.json';

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse and validate the JSON value of a collection index.
 */
export function parseCollectionIndex(data: unknown): ICollectionIndex {
  if (!isRecord(data)) {
    throw new Error('A collection index must be an object');
  }

  if (data.version !== COLLECTION_VERSION) {
    throw new Error(
      `Unsupported collection version ${String(data.version)}, expected ${COLLECTION_VERSION}`
    );
  }

  if (!Array.isArray(data.workshops)) {
    throw new Error('A collection index needs a "workshops" list');
  }

  return {
    version: COLLECTION_VERSION,
    ...parseCollectionInfo(data),
    ordered: data.ordered === true,
    workshops: data.workshops.map((item: unknown, index: number) =>
      parseEntry(item, index)
    )
  };
}

/**
 * The descriptive fields of a collection, from an index or a catalog
 * entry. Absent and malformed fields are left out rather than refused.
 */
export function parseCollectionInfo(
  data: Record<string, unknown>
): ICollectionInfo {
  const info: ICollectionInfo = { tags: stringList(data.tags) };

  if (typeof data.title === 'string' && data.title !== '') {
    info.title = data.title;
  }

  if (typeof data.description === 'string' && data.description !== '') {
    info.description = data.description;
  }

  const publisher = parsePublisher(data.publisher);

  if (publisher) {
    info.publisher = publisher;
  }

  if (typeof data.homepage === 'string' && data.homepage !== '') {
    info.homepage = data.homepage;
  }

  if (typeof data.icon === 'string' && data.icon !== '') {
    info.icon = data.icon;
  }

  return info;
}

/**
 * Parse a publisher, given as an object with a name or as a bare name.
 */
export function parsePublisher(value: unknown): IPublisher | undefined {
  if (typeof value === 'string') {
    return value === '' ? undefined : { name: value };
  }

  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') {
    return undefined;
  }

  const url =
    typeof value.url === 'string' && value.url !== '' ? value.url : undefined;

  return url ? { name: value.name, url } : { name: value.name };
}

/**
 * The version installed by default: the first listed.
 */
export function latestVersion(entry: ICollectionEntry): ICollectionVersion {
  return entry.versions[0];
}

/**
 * The entries matching a free text query and a set of tags, in collection
 * order. The query matches names, titles, descriptions and tags without
 * regard to case; every selected tag must be present.
 */
export function searchCollection(
  entries: readonly ICollectionEntry[],
  query: string,
  tags: readonly string[] = []
): ICollectionEntry[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word !== '');

  return entries.filter(entry => {
    const haystack = [entry.name, entry.title, entry.description, ...entry.tags]
      .join(' ')
      .toLowerCase();

    return (
      words.every(word => haystack.includes(word)) &&
      tags.every(tag => entry.tags.includes(tag))
    );
  });
}

/**
 * Every tag used by the entries, most common first and then alphabetical.
 */
export function collectionTags(entries: readonly ICollectionEntry[]): string[] {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    for (const tag of entry.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

/**
 * Whether an entry lists a platform, or lists none and so runs anywhere.
 */
export function supportsPlatform(
  entry: ICollectionEntry,
  platform: string
): boolean {
  return entry.platforms.length === 0 || entry.platforms.includes(platform);
}

/** One entry of a collection as the Install all dialog presents it. */
export interface IInstallPlanItem {
  entry: ICollectionEntry;

  /** Whether the workshop is installed already, so cannot be chosen. */
  installed: boolean;

  /** Whether the entry lists the current platform, or lists none. */
  supported: boolean;

  /** Whether the dialog starts with the entry ticked. */
  selected: boolean;
}

/**
 * What Install all offers for a collection: every entry in the
 * collection's order, with those already installed greyed out and the
 * rest ticked unless they do not list the current platform. An empty
 * platform, as when it is not known yet, leaves every entry supported.
 */
export function planInstallAll(
  entries: readonly ICollectionEntry[],
  platform: string,
  isInstalled: (entry: ICollectionEntry) => boolean
): IInstallPlanItem[] {
  return entries.map(entry => {
    const installed = isInstalled(entry);
    const supported = platform === '' || supportsPlatform(entry, platform);

    return { entry, installed, supported, selected: !installed && supported };
  });
}

/**
 * The stable key of a collection source, in the form trust decisions and
 * `trustedSources` prefixes use.
 */
export function collectionSourceKey(source: ICollectionSource): string {
  if (source.archive) {
    return `archive:${source.archive}`;
  }

  const ref = source.ref ? `@${source.ref}` : '';
  const subdir = source.subdir ? `/${source.subdir}` : '';

  return `git:${source.git ?? ''}${ref}${subdir}`;
}

/**
 * Add or replace an entry in a list, keeping the list's order: an entry
 * already present is updated in place and a new one is appended. The
 * versions are merged so the newest is first and duplicates are dropped.
 */
export function mergeCollectionEntry(
  entries: readonly ICollectionEntry[],
  entry: ICollectionEntry
): ICollectionEntry[] {
  const position = entries.findIndex(item => item.name === entry.name);

  if (position < 0) {
    return [...entries, entry];
  }

  const existing = entries[position];
  const merged: ICollectionEntry = {
    ...existing,
    ...entry,
    versions: mergeVersions(entry.versions, existing.versions)
  };

  return entries.map((item, index) => (index === position ? merged : item));
}

function mergeVersions(
  incoming: ICollectionVersion[],
  existing: ICollectionVersion[]
): ICollectionVersion[] {
  const seen = new Set<string>();
  const versions: ICollectionVersion[] = [];

  for (const item of [...incoming, ...existing]) {
    if (!seen.has(item.version)) {
      seen.add(item.version);
      versions.push(item);
    }
  }

  return versions.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Compare dotted version strings numerically, falling back to text.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const x = left[index] ?? '0';
    const y = right[index] ?? '0';
    const nx = Number(x);
    const ny = Number(y);

    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) {
        return nx - ny;
      }
    } else if (x !== y) {
      return x.localeCompare(y);
    }
  }

  return 0;
}

/**
 * Whether a location is an absolute http(s) URL rather than a path.
 */
export function isHttpUrl(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

/**
 * Resolve a location found inside a collection or catalog file, such as
 * an icon or a collection URL, against the location of that file. An
 * absolute URL or a `data:` URI is returned as is; anything else is
 * taken as relative to the file's directory, whether the file is a URL
 * or a path under the JupyterLab root.
 */
export function resolveLocation(base: string, target: string): string {
  if (isHttpUrl(target) || /^data:/i.test(target)) {
    return target;
  }

  if (isHttpUrl(base)) {
    return new URL(target, base).toString();
  }

  // A path base: join the directory of the file and the target, then
  // collapse `.` and `..` segments so the result stays a clean path.
  const directory = base.includes('/')
    ? base.slice(0, base.lastIndexOf('/'))
    : '';
  const segments: string[] = [];

  for (const part of `${directory}/${target}`.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }

    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }

  return segments.join('/');
}

/**
 * Normalise a collection location for comparison and hashing: the scheme
 * and host of a URL in lower case, and no trailing slash.
 */
export function normalizeLocation(location: string): string {
  const trimmed = location.trim().replace(/\/+$/, '');

  if (!isHttpUrl(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);

    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname}${url.search}`;
  } catch {
    return trimmed;
  }
}

function parseEntry(item: unknown, index: number): ICollectionEntry {
  if (!isRecord(item) || typeof item.name !== 'string') {
    throw new Error(`Collection entry ${index + 1} needs a "name"`);
  }

  if (!NAME.test(item.name)) {
    throw new Error(
      `Collection entry "${item.name}" has an invalid name; use lower case letters, digits and hyphens`
    );
  }

  if (typeof item.title !== 'string' || item.title === '') {
    throw new Error(`Collection entry "${item.name}" needs a "title"`);
  }

  if (!Array.isArray(item.versions) || item.versions.length === 0) {
    throw new Error(
      `Collection entry "${item.name}" needs at least one version`
    );
  }

  return {
    name: item.name,
    title: item.title,
    description: typeof item.description === 'string' ? item.description : '',
    tags: stringList(item.tags),
    platforms: stringList(item.platforms),
    capabilities: stringList(item.capabilities),
    duration: typeof item.duration === 'string' ? item.duration : undefined,
    authors: stringList(item.authors),
    versions: item.versions.map((version: unknown) =>
      parseVersion(version, item.name as string)
    )
  };
}

function parseVersion(item: unknown, name: string): ICollectionVersion {
  if (!isRecord(item) || !isRecord(item.source)) {
    throw new Error(
      `Each version of "${name}" needs a "version" and a "source"`
    );
  }

  const source = item.source;
  const git = typeof source.git === 'string' ? source.git : undefined;
  const archive =
    typeof source.archive === 'string' ? source.archive : undefined;

  if (!git && !archive) {
    throw new Error(
      `A version of "${name}" has a source with neither "git" nor "archive"`
    );
  }

  const sha256 = typeof item.sha256 === 'string' ? item.sha256 : undefined;

  if (sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error(`A version of "${name}" has an invalid sha256`);
  }

  return {
    version: String(item.version ?? ''),
    source: {
      git,
      ref: typeof source.ref === 'string' ? source.ref : undefined,
      subdir: typeof source.subdir === 'string' ? source.subdir : undefined,
      archive
    },
    sha256: sha256?.toLowerCase()
  };
}

function stringList(value: unknown): string[] {
  return isStringArray(value) ? value : [];
}
