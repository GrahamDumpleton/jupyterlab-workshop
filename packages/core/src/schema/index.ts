import registry from './registry.schema.json';
import schema from './workshop.schema.json';

/** JSON Schema (draft 7) describing the `workshop.yaml` manifest. */
export const WORKSHOP_SCHEMA: Readonly<Record<string, unknown>> = schema;

/** JSON Schema (draft 7) describing a registry index file. */
export const REGISTRY_SCHEMA: Readonly<Record<string, unknown>> = registry;
