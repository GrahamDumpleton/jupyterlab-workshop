/**
 * Catalog files: published lists of collections. A catalog restates each
 * collection's title, description, publisher and icon so the browser can
 * show what is on offer without fetching every index, and gives the URL
 * to attach it by.
 */

import {
  ICollectionInfo,
  IPublisher,
  parseCollectionInfo,
  parsePublisher,
  resolveLocation
} from '../collection';
import { isRecord } from '../util';

/** A collection a catalog lists. */
export interface ICatalogEntry extends ICollectionInfo {
  /** Location of the collection index, as the catalog gives it. */
  url: string;
}

/** A parsed catalog. */
export interface ICatalog {
  version: 1;
  title?: string;
  description?: string;
  publisher?: IPublisher;
  homepage?: string;

  /** Icon URL, possibly relative to the catalog file. */
  icon?: string;

  /** The collections, in the order the catalog lists them. */
  collections: ICatalogEntry[];
}

/** The catalog format version this package understands. */
export const CATALOG_VERSION = 1;

/** The file name a catalog is published under by convention. */
export const CATALOG_FILE = 'catalog.json';

/**
 * Parse and validate the JSON value of a catalog.
 */
export function parseCatalog(data: unknown): ICatalog {
  if (!isRecord(data)) {
    throw new Error('A catalog must be an object');
  }

  if (data.version !== CATALOG_VERSION) {
    throw new Error(
      `Unsupported catalog version ${String(data.version)}, expected ${CATALOG_VERSION}`
    );
  }

  if (!Array.isArray(data.collections)) {
    throw new Error('A catalog needs a "collections" list');
  }

  const catalog: ICatalog = {
    version: CATALOG_VERSION,
    collections: data.collections.map((item: unknown, index: number) =>
      parseCatalogEntry(item, index)
    )
  };

  if (typeof data.title === 'string' && data.title !== '') {
    catalog.title = data.title;
  }

  if (typeof data.description === 'string' && data.description !== '') {
    catalog.description = data.description;
  }

  const publisher = parsePublisher(data.publisher);

  if (publisher) {
    catalog.publisher = publisher;
  }

  if (typeof data.homepage === 'string' && data.homepage !== '') {
    catalog.homepage = data.homepage;
  }

  if (typeof data.icon === 'string' && data.icon !== '') {
    catalog.icon = data.icon;
  }

  return catalog;
}

/**
 * A catalog with every relative location resolved against the location
 * the catalog was read from: the collection URLs and the icons.
 */
export function resolveCatalog(catalog: ICatalog, location: string): ICatalog {
  return {
    ...catalog,
    icon: catalog.icon ? resolveLocation(location, catalog.icon) : undefined,
    collections: catalog.collections.map(entry => ({
      ...entry,
      url: resolveLocation(location, entry.url),
      icon: entry.icon ? resolveLocation(location, entry.icon) : undefined
    }))
  };
}

function parseCatalogEntry(item: unknown, index: number): ICatalogEntry {
  if (!isRecord(item) || typeof item.url !== 'string' || item.url === '') {
    throw new Error(`Catalog entry ${index + 1} needs a "url"`);
  }

  return { url: item.url, ...parseCollectionInfo(item) };
}
