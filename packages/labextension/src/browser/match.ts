/**
 * Matching installed workshops to the subscribed collections, and the
 * places they hold in a collection that declares an order. The browser
 * uses this to order and number its cards, and the Finish dialog to
 * offer the next workshop of a sequence.
 */

import { ICollectionEntry, ICollectionIndex } from '@jupyterlab-workshop/core';

import { IInstalledWorkshop, IWorkshopManager, errorMessage } from '../tokens';
import { ISubscribedSource, sameLocation } from './sources';

/** A subscribed collection that has been read, or failed to be. */
export interface ILoadedCollection extends ISubscribedSource {
  title: string;
  index?: ICollectionIndex;
  error?: string;
}

/** A subscribed collection an installed workshop belongs to, and its entry. */
export interface IMatchedCollection {
  collection: ILoadedCollection;
  entry?: ICollectionEntry;
}

/** A workshop's place in an ordered collection: its step, from one, of the total. */
export interface ISequenceStep {
  step: number;
  total: number;
}

/** What follows an installed workshop in its ordered collection. */
export interface INextWorkshop {
  collection: ILoadedCollection;
  entry: ICollectionEntry;

  /** The installed copy of the next workshop, when there is one. */
  installed?: IInstalledWorkshop;
}

/**
 * Read a subscribed collection's index, keeping the failure as a message
 * rather than losing the subscription from the list.
 */
export async function loadCollection(
  manager: IWorkshopManager,
  item: ISubscribedSource
): Promise<ILoadedCollection> {
  try {
    const index = await manager.fetchCollection(item.url);

    return { ...item, title: index.title ?? item.url, index };
  } catch (error) {
    return { ...item, title: item.url, error: errorMessage(error) };
  }
}

/**
 * The subscribed collection an installed workshop belongs to, and the
 * entry listing it. An install that recorded its collection belongs to
 * that one, whether or not its index still lists the name. A workshop
 * with no record, a local directory or an older install, belongs to the
 * one subscribed collection that lists its name; a name that two
 * collections offer is ambiguous and matches neither, so the browser
 * never guesses which one a directory came from.
 */
export function collectionOf(
  item: IInstalledWorkshop,
  collections: readonly ILoadedCollection[]
): IMatchedCollection | undefined {
  const entryIn = (
    collection: ILoadedCollection
  ): ICollectionEntry | undefined =>
    collection.index?.workshops.find(candidate => candidate.name === item.name);

  if (item.collection !== null) {
    const recorded = item.collection;
    const collection = collections.find(candidate =>
      sameLocation(candidate.url, recorded)
    );

    return collection ? { collection, entry: entryIn(collection) } : undefined;
  }

  const matches: IMatchedCollection[] = [];

  for (const collection of collections) {
    const entry = entryIn(collection);

    if (entry) {
      matches.push({ collection, entry });
    }
  }

  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Where a matched workshop stands in its collection, when the collection
 * declares its workshops a sequence; nothing for an unordered one.
 */
export function sequenceStep(
  found: IMatchedCollection | undefined
): ISequenceStep | undefined {
  const index = found?.collection.index;

  if (!index?.ordered || !found?.entry) {
    return undefined;
  }

  const step = index.workshops.indexOf(found.entry) + 1;

  return step > 0 ? { step, total: index.workshops.length } : undefined;
}

/**
 * Whether an installed workshop has been finished: every page done.
 */
export function isFinished(item: IInstalledWorkshop): boolean {
  return item.pages > 0 && item.done >= item.pages;
}

/**
 * The installed workshop that is a collection's entry, if any, matched
 * the way the browser matches: by record, or by a unique name.
 */
export function installedFor(
  entry: ICollectionEntry,
  collection: ILoadedCollection,
  installed: readonly IInstalledWorkshop[],
  collections: readonly ILoadedCollection[]
): IInstalledWorkshop | undefined {
  return installed.find(item => {
    const found = collectionOf(item, collections);

    return found?.collection === collection && found.entry === entry;
  });
}

/**
 * The first workshop of an ordered collection the learner has not
 * finished, installed or not; nothing for an unordered collection or
 * one that is finished throughout.
 */
export function upNext(
  collection: ILoadedCollection,
  installed: readonly IInstalledWorkshop[],
  collections: readonly ILoadedCollection[]
): ICollectionEntry | undefined {
  const index = collection.index;

  if (!index?.ordered) {
    return undefined;
  }

  return index.workshops.find(entry => {
    const item = installedFor(entry, collection, installed, collections);

    return !item || !isFinished(item);
  });
}

/**
 * The workshop that follows an installed one in its ordered collection,
 * with its installed copy when there is one.
 */
export function nextAfter(
  current: IInstalledWorkshop,
  installed: readonly IInstalledWorkshop[],
  collections: readonly ILoadedCollection[]
): INextWorkshop | undefined {
  const found = collectionOf(current, collections);
  const index = found?.collection.index;

  if (!found?.entry || !index?.ordered) {
    return undefined;
  }

  const entry = index.workshops[index.workshops.indexOf(found.entry) + 1];

  if (!entry) {
    return undefined;
  }

  return {
    collection: found.collection,
    entry,
    installed: installedFor(entry, found.collection, installed, collections)
  };
}
