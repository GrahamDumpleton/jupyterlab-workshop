import { load } from 'js-yaml';

import { WorkshopFormatError } from '../errors';
import { isRecord, isStringArray } from '../util';

/** The manifest API version this package understands. */
export const MANIFEST_API_VERSION = 'workshop.educates.dev/v1alpha1';

/** A variable declared in the workshop manifest. */
export interface IVariableDefinition {
  name: string;
  type?: string;
  description?: string;
  default?: string;
  required?: boolean;
  readonly?: boolean;
}

/** The parsed contents of a `workshop.yaml` manifest. */
export interface IWorkshopManifest {
  apiVersion: string;
  name: string;
  title: string;
  version?: string;
  description?: string;
  duration?: string;
  authors: string[];
  tags: string[];
  platforms: string[];
  pages: string[];
  variables: IVariableDefinition[];
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse and validate the YAML source of a workshop manifest.
 */
export function parseManifest(
  source: string,
  path = 'workshop.yaml'
): IWorkshopManifest {
  const data: unknown = load(source);

  if (!isRecord(data)) {
    throw new WorkshopFormatError('Manifest must be a mapping', path);
  }

  // Required fields.
  const apiVersion = requireString(data, 'apiVersion', path);

  if (apiVersion !== MANIFEST_API_VERSION) {
    throw new WorkshopFormatError(
      `Unsupported apiVersion "${apiVersion}", expected "${MANIFEST_API_VERSION}"`,
      path
    );
  }

  const name = requireString(data, 'name', path);

  if (!NAME.test(name)) {
    throw new WorkshopFormatError(
      `Invalid name "${name}": use lower case letters, digits and hyphens`,
      path
    );
  }

  const title = requireString(data, 'title', path);
  const pages = data.pages;

  if (!isStringArray(pages) || pages.length === 0) {
    throw new WorkshopFormatError(
      'Field "pages" must be a non-empty list of page paths',
      path
    );
  }

  return {
    apiVersion,
    name,
    title,
    version: optionalString(data, 'version', path),
    description: optionalString(data, 'description', path),
    duration: optionalString(data, 'duration', path),
    authors: optionalStringList(data, 'authors', path),
    tags: optionalStringList(data, 'tags', path),
    platforms: optionalStringList(data, 'platforms', path),
    pages,
    variables: parseVariables(data.variables, path)
  };
}

function requireString(
  data: Record<string, unknown>,
  field: string,
  path: string
): string {
  const value = data[field];

  if (typeof value !== 'string' || value === '') {
    throw new WorkshopFormatError(
      `Field "${field}" is required and must be a string`,
      path
    );
  }

  return value;
}

function optionalString(
  data: Record<string, unknown>,
  field: string,
  path: string
): string | undefined {
  const value = data[field];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new WorkshopFormatError(`Field "${field}" must be a string`, path);
  }

  return String(value);
}

function optionalStringList(
  data: Record<string, unknown>,
  field: string,
  path: string
): string[] {
  const value = data[field];

  if (value === undefined || value === null) {
    return [];
  }

  if (!isStringArray(value)) {
    throw new WorkshopFormatError(
      `Field "${field}" must be a list of strings`,
      path
    );
  }

  return value;
}

function parseVariables(value: unknown, path: string): IVariableDefinition[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new WorkshopFormatError('Field "variables" must be a list', path);
  }

  return value.map((item: unknown, index: number) => {
    if (!isRecord(item) || typeof item.name !== 'string') {
      throw new WorkshopFormatError(
        `Variable ${index + 1} must be a mapping with a "name"`,
        path
      );
    }

    return {
      name: item.name,
      type: typeof item.type === 'string' ? item.type : undefined,
      description:
        typeof item.description === 'string' ? item.description : undefined,
      default: item.default === undefined ? undefined : String(item.default),
      required: item.required === true,
      readonly: item.readonly === true
    };
  });
}
