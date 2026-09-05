/**
 * Registry index files: lists of workshops that can be installed, each
 * with the sources of its versions. The extension's browser reads them,
 * the CLI builds them, and both agree on the shape through this module.
 */

import { isRecord, isStringArray } from '../util';

/** Where one version of a registry workshop is fetched from. */
export interface IRegistrySource {
  /** Repository URL, when the version lives in git. */
  git?: string;
  ref?: string;
  subdir?: string;

  /** Direct archive URL, when the version is an archive. */
  archive?: string;
}

/** One installable version of a registry workshop. */
export interface IRegistryVersion {
  version: string;
  source: IRegistrySource;

  /** Expected SHA-256 of the archive, when known. */
  sha256?: string;
}

/** A workshop listed in a registry. */
export interface IRegistryEntry {
  name: string;
  title: string;
  description: string;
  tags: string[];
  platforms: string[];
  capabilities: string[];
  duration?: string;
  authors: string[];

  /** Versions newest first. */
  versions: IRegistryVersion[];
}

/** A parsed registry index. */
export interface IRegistryIndex {
  version: 1;
  title?: string;
  workshops: IRegistryEntry[];
}

/** The registry index format version this package understands. */
export const REGISTRY_VERSION = 1;

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse and validate the JSON value of a registry index.
 */
export function parseRegistryIndex(data: unknown): IRegistryIndex {
  if (!isRecord(data)) {
    throw new Error('A registry index must be an object');
  }

  if (data.version !== REGISTRY_VERSION) {
    throw new Error(
      `Unsupported registry version ${String(data.version)}, expected ${REGISTRY_VERSION}`
    );
  }

  if (!Array.isArray(data.workshops)) {
    throw new Error('A registry index needs a "workshops" list');
  }

  return {
    version: REGISTRY_VERSION,
    title: typeof data.title === 'string' ? data.title : undefined,
    workshops: data.workshops.map((item: unknown, index: number) =>
      parseEntry(item, index)
    )
  };
}

/**
 * The version installed by default: the first listed.
 */
export function latestVersion(entry: IRegistryEntry): IRegistryVersion {
  return entry.versions[0];
}

/**
 * The entries matching a free text query and a set of tags, in registry
 * order. The query matches names, titles, descriptions and tags without
 * regard to case; every selected tag must be present.
 */
export function searchRegistry(
  entries: readonly IRegistryEntry[],
  query: string,
  tags: readonly string[] = []
): IRegistryEntry[] {
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
export function registryTags(entries: readonly IRegistryEntry[]): string[] {
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
  entry: IRegistryEntry,
  platform: string
): boolean {
  return entry.platforms.length === 0 || entry.platforms.includes(platform);
}

/**
 * The stable key of a registry source, in the form trust decisions and
 * `trustedSources` prefixes use.
 */
export function registrySourceKey(source: IRegistrySource): string {
  if (source.archive) {
    return `archive:${source.archive}`;
  }

  const ref = source.ref ? `@${source.ref}` : '';
  const subdir = source.subdir ? `/${source.subdir}` : '';

  return `git:${source.git ?? ''}${ref}${subdir}`;
}

/**
 * Add or replace an entry in a list, keeping the list sorted by name and
 * merging versions so the newest is first and duplicates are dropped.
 */
export function mergeRegistryEntry(
  entries: readonly IRegistryEntry[],
  entry: IRegistryEntry
): IRegistryEntry[] {
  const existing = entries.find(item => item.name === entry.name);
  const merged: IRegistryEntry = existing
    ? {
        ...existing,
        ...entry,
        versions: mergeVersions(entry.versions, existing.versions)
      }
    : entry;

  return [...entries.filter(item => item.name !== entry.name), merged].sort(
    (a, b) => a.name.localeCompare(b.name)
  );
}

function mergeVersions(
  incoming: IRegistryVersion[],
  existing: IRegistryVersion[]
): IRegistryVersion[] {
  const seen = new Set<string>();
  const versions: IRegistryVersion[] = [];

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

function parseEntry(item: unknown, index: number): IRegistryEntry {
  if (!isRecord(item) || typeof item.name !== 'string') {
    throw new Error(`Registry entry ${index + 1} needs a "name"`);
  }

  if (!NAME.test(item.name)) {
    throw new Error(
      `Registry entry "${item.name}" has an invalid name; use lower case letters, digits and hyphens`
    );
  }

  if (typeof item.title !== 'string' || item.title === '') {
    throw new Error(`Registry entry "${item.name}" needs a "title"`);
  }

  if (!Array.isArray(item.versions) || item.versions.length === 0) {
    throw new Error(`Registry entry "${item.name}" needs at least one version`);
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

function parseVersion(item: unknown, name: string): IRegistryVersion {
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
