import {
  collectionHash,
  ICollectionEntry,
  latestVersion
} from '@jupyterlab-workshop/core';
import { CommandRegistry } from '@lumino/commands';

import { CommandIDs, IFetchRequest, IInstalledWorkshop } from '../tokens';
import { sameLocation } from './sources';

/**
 * Whether an installed workshop is the one a collection lists: the same
 * collection and name when the install recorded its collection, else
 * the same name, as for local directories and older installs.
 */
export function isInstalledFrom(
  item: IInstalledWorkshop,
  collection: string,
  name: string
): boolean {
  // A workshop library's own workshops, single or in a course, are never
  // a collection's, whatever they are called.
  if (
    item.name !== name ||
    item.kind === 'personal' ||
    item.kind === 'course'
  ) {
    return false;
  }

  return item.collection === null || sameLocation(item.collection, collection);
}

/**
 * The directory name to install a collection workshop under: its own
 * name, unless an installed workshop of that name came from a different
 * collection, when the collection's hash is appended, so two collections
 * that both offer a `git-basics` never fight over one directory and the
 * same collection always lands in the same place. An installed workshop
 * with no collection recorded, a local directory or an older install, is
 * taken to be the same workshop, as the browser's matching does.
 */
export function installName(
  entry: ICollectionEntry,
  collection: string,
  installed: readonly IInstalledWorkshop[]
): string {
  // In a workshop library every record has a kind, and each collection
  // installs into a directory of its own, so names never clash there.
  const clash = installed.some(
    item =>
      item.kind === undefined &&
      item.name === entry.name &&
      item.collection !== null &&
      !sameLocation(item.collection, collection)
  );

  return clash ? `${entry.name}-${collectionHash(collection)}` : entry.name;
}

/**
 * The download request for the newest version of a collection entry:
 * what the open-URL command builds from the same fields, for callers
 * that talk to the manager directly, such as Install all.
 */
export function fetchRequestFor(
  entry: ICollectionEntry,
  collection: string,
  directory: string,
  installed: readonly IInstalledWorkshop[]
): IFetchRequest {
  const chosen = latestVersion(entry);
  const source = chosen.source;

  return {
    url: source.archive ?? source.git ?? '',
    ref: source.ref,
    subdir: source.subdir,
    sha256: chosen.sha256,
    archive: source.archive !== undefined,
    directory,
    name: installName(entry, collection, installed),
    collection
  };
}

/** What to pass along with an install: launch link values, mostly. */
export interface IInstallOptions {
  variables?: Record<string, string>;
  launch?: boolean;

  /** Whether to open the workshop once installed; the browser does not. */
  open?: boolean;
}

/**
 * Install the newest version of a collection entry through the open-URL
 * command, recording the collection it came from, and open it when
 * asked to.
 */
export function installEntry(
  commands: CommandRegistry,
  collection: string,
  entry: ICollectionEntry,
  installed: readonly IInstalledWorkshop[],
  options: IInstallOptions = {}
): Promise<unknown> {
  const chosen = latestVersion(entry);
  const source = chosen.source;

  return commands.execute(CommandIDs.openUrl, {
    url: source.archive ?? source.git ?? '',
    ref: source.ref,
    subdir: source.subdir,
    sha256: chosen.sha256,
    archive: source.archive !== undefined,
    collection,
    name: installName(entry, collection, installed),
    variables: options.variables,
    launch: options.launch,
    open: options.open ?? true
  });
}
