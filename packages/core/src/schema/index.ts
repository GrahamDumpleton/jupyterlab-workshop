import catalog from './catalog.schema.json';
import collection from './collection.schema.json';
import schema from './workshop.schema.json';

/** JSON Schema (draft 7) describing the `workshop.yaml` manifest. */
export const WORKSHOP_SCHEMA: Readonly<Record<string, unknown>> = schema;

/** JSON Schema (draft 7) describing a collection index file. */
export const COLLECTION_SCHEMA: Readonly<Record<string, unknown>> = collection;

/** JSON Schema (draft 7) describing a catalog file. */
export const CATALOG_SCHEMA: Readonly<Record<string, unknown>> = catalog;
