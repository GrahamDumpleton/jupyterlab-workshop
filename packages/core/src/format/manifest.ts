import { load } from 'js-yaml';

import { WorkshopFormatError } from '../errors';
import { isRecord, isStringArray } from '../util';

/** Capability names and write scopes a manifest may declare. */
const CAPABILITY_NAMES: readonly string[] = [
  'terminal',
  'write-files',
  'network',
  'install-packages',
  'kernel-exec',
  'auto-run',
  'ui-settings'
];

const WRITE_SCOPES: readonly string[] = ['workspace', 'home', 'any'];

/** The manifest API version this package understands. */
export const MANIFEST_API_VERSION = 'jupyterlab-workshop/v1alpha1';

/** Field types a variable may declare. */
export type VariableType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'secret'
  | 'path'
  | 'url'
  | 'email';

/** A variable declared in the workshop manifest. */
export interface IVariableDefinition {
  name: string;
  type: VariableType;
  description?: string;
  default?: string;
  required: boolean;
  readonly: boolean;
  secret: boolean;
  options: string[];
}

/** A track learners can choose between. */
export interface ITrack {
  id: string;
  label: string;
}

/** A tool the workshop needs on the machine. */
export interface IToolRequirement {
  name: string;
  version?: string;
  optional: boolean;
  hint: Record<string, string>;
}

/** Preflight requirements. */
export interface IRequirements {
  tools: IToolRequirement[];
  shell?: string;
}

/** Optional isolated environment. */
export interface IEnvironment {
  /** Requirements file, relative to the workshop, installed into a venv. */
  requirements?: string;

  /** Kernelspec name to register for the environment. */
  kernel?: string;

  /**
   * Whether terminals and commands see the environment on their PATH;
   * true unless the manifest says false.
   */
  terminals: boolean;
}

/** Where a workshop asks to report progress events. */
export interface IAnalytics {
  /** URL that receives batches of events as JSON lines, after opt-in. */
  sink?: string;
}

/** One region of a named layout. */
export interface ILayoutArea {
  /** Edge of the main area the region splits off. */
  area: 'top' | 'bottom' | 'left' | 'right';

  /** Widget references such as `terminal:git` or `markdown:README.md`. */
  widgets: string[];

  /** Fraction of the main area the region takes, between 0 and 1. */
  size?: number;
}

/** What a named layout does with one sidebar. */
export interface ILayoutSide {
  /** `instructions` for the workshop panel, or a sidebar widget id to show. */
  widget?: string;

  /** Whether the sidebar starts collapsed. */
  collapsed?: boolean;

  /** Fraction of the window width the sidebar takes, between 0 and 1. */
  size?: number;
}

/** A named arrangement of JupyterLab panels. */
export interface ILayoutSpec {
  left?: ILayoutSide;
  right?: ILayoutSide;
  main: ILayoutArea[];
}

/** Gating policy for moving between pages. */
export type GatingPolicy = 'off' | 'soft' | 'strict';

/** The parsed contents of a `workshop.yaml` manifest. */
export interface IWorkshopManifest {
  apiVersion: string;
  name: string;
  title: string;
  version?: string;
  description?: string;

  /** Markdown shown in the dialog when the learner finishes the workshop. */
  finish?: string;
  duration?: string;

  /** Environment variables exported to the workshop terminals. */
  env: Record<string, string>;
  authors: string[];

  /** Web page for the workshop, such as the repository it lives in. */
  homepage?: string;

  /** Where to report a problem with the workshop. */
  issues?: string;
  tags: string[];
  platforms: string[];
  capabilities: string[];
  requires: IRequirements;
  environment?: IEnvironment;
  analytics?: IAnalytics;
  variables: IVariableDefinition[];
  layout?: string;
  layouts: Record<string, ILayoutSpec>;
  gating: GatingPolicy;
  tracks: ITrack[];
  pages: string[];

  /** Default option values for action directives, keyed by option name. */
  defaults: Record<string, string>;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

const VARIABLE_TYPES: ReadonlySet<string> = new Set([
  'text',
  'number',
  'boolean',
  'select',
  'multiselect',
  'secret',
  'path',
  'url',
  'email'
]);

const LAYOUT_AREAS: ReadonlySet<string> = new Set([
  'top',
  'bottom',
  'left',
  'right'
]);

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

  const gating = optionalString(data, 'gating', path) ?? 'off';

  if (gating !== 'off' && gating !== 'soft' && gating !== 'strict') {
    throw new WorkshopFormatError(
      `Field "gating" must be one of off, soft or strict, not "${gating}"`,
      path
    );
  }

  return {
    apiVersion,
    name,
    title,
    version: optionalString(data, 'version', path),
    description: optionalString(data, 'description', path),
    finish: optionalString(data, 'finish', path),
    duration: optionalString(data, 'duration', path),
    authors: optionalStringList(data, 'authors', path),
    homepage: optionalString(data, 'homepage', path),
    issues: optionalString(data, 'issues', path),
    tags: optionalStringList(data, 'tags', path),
    platforms: optionalStringList(data, 'platforms', path),
    capabilities: parseCapabilities(data.capabilities, path),
    requires: parseRequirements(data.requires, path),
    environment: parseEnvironment(data.environment, path),
    analytics: parseAnalytics(data.analytics, path),
    variables: parseVariables(data.variables, path),
    layout: optionalString(data, 'layout', path),
    layouts: parseLayouts(data.layouts, path),
    gating,
    tracks: parseTracks(data.tracks, path),
    pages,
    defaults: parseDefaults(data.defaults, path),
    env: parseEnv(data.env, path)
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

function parseCapabilities(value: unknown, path: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new WorkshopFormatError('Field "capabilities" must be a list', path);
  }

  // Entries are either `name` or `{ name: [scopes] }`, flattened to
  // `name:scope` strings.
  const capabilities: string[] = [];

  for (const item of value) {
    if (typeof item === 'string') {
      checkCapability(item, [], path);
      capabilities.push(item);
    } else if (isRecord(item) && Object.keys(item).length === 1) {
      const [key, scopes] = Object.entries(item)[0];
      const list = (Array.isArray(scopes) ? scopes : [scopes]).map(String);

      checkCapability(key, list, path);

      for (const scope of list) {
        capabilities.push(`${key}:${scope}`);
      }
    } else {
      throw new WorkshopFormatError(
        'Each capability must be a name or a single-key mapping of name to scopes',
        path
      );
    }
  }

  return capabilities;
}

function checkCapability(name: string, scopes: string[], path: string): void {
  if (!CAPABILITY_NAMES.includes(name)) {
    throw new WorkshopFormatError(
      `Unknown capability "${name}"; expected one of ${CAPABILITY_NAMES.join(', ')}`,
      path
    );
  }

  if (name === 'write-files') {
    for (const scope of scopes) {
      if (!WRITE_SCOPES.includes(scope)) {
        throw new WorkshopFormatError(
          `Unknown write-files scope "${scope}"; expected one of ${WRITE_SCOPES.join(', ')}`,
          path
        );
      }
    }
  }
}

function parseRequirements(value: unknown, path: string): IRequirements {
  if (value === undefined || value === null) {
    return { tools: [] };
  }

  if (!isRecord(value)) {
    throw new WorkshopFormatError('Field "requires" must be a mapping', path);
  }

  const tools: IToolRequirement[] = [];
  const rawTools = value.tools;

  if (rawTools !== undefined && rawTools !== null) {
    if (!Array.isArray(rawTools)) {
      throw new WorkshopFormatError(
        'Field "requires.tools" must be a list',
        path
      );
    }

    for (const item of rawTools) {
      if (!isRecord(item) || typeof item.name !== 'string') {
        throw new WorkshopFormatError(
          'Each entry of "requires.tools" needs a "name"',
          path
        );
      }

      const hint: Record<string, string> = {};

      if (isRecord(item.hint)) {
        for (const [key, text] of Object.entries(item.hint)) {
          hint[key] = String(text);
        }
      } else if (typeof item.hint === 'string') {
        hint.default = item.hint;
      }

      tools.push({
        name: item.name,
        version: typeof item.version === 'string' ? item.version : undefined,
        optional: item.optional === true,
        hint
      });
    }
  }

  return { tools, shell: optionalString(value, 'shell', path) };
}

function parseEnvironment(
  value: unknown,
  path: string
): IEnvironment | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new WorkshopFormatError(
      'Field "environment" must be a mapping',
      path
    );
  }

  const terminals = value.terminals;

  if (terminals !== undefined && typeof terminals !== 'boolean') {
    throw new WorkshopFormatError(
      'Field "environment.terminals" must be true or false',
      path
    );
  }

  return {
    requirements: optionalString(value, 'requirements', path),
    kernel: optionalString(value, 'kernel', path),
    terminals: terminals !== false
  };
}

function parseAnalytics(value: unknown, path: string): IAnalytics | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new WorkshopFormatError('Field "analytics" must be a mapping', path);
  }

  const sink = optionalString(value, 'sink', path);

  if (sink !== undefined && !/^https?:\/\//.test(sink)) {
    throw new WorkshopFormatError(
      'Field "analytics.sink" must be an http or https URL',
      path
    );
  }

  return { sink };
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

    const type = typeof item.type === 'string' ? item.type : 'text';

    if (!VARIABLE_TYPES.has(type)) {
      throw new WorkshopFormatError(
        `Variable "${item.name}" has unknown type "${type}"`,
        path
      );
    }

    return {
      name: item.name,
      type: type as VariableType,
      description:
        typeof item.description === 'string' ? item.description : undefined,
      default:
        item.default === undefined || item.default === null
          ? undefined
          : String(item.default),
      required: item.required === true,
      readonly: item.readonly === true,
      secret: item.secret === true || type === 'secret',
      options: isStringArray(item.options) ? item.options : []
    };
  });
}

function parseLayouts(
  value: unknown,
  path: string
): Record<string, ILayoutSpec> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new WorkshopFormatError('Field "layouts" must be a mapping', path);
  }

  const layouts: Record<string, ILayoutSpec> = {};

  for (const [name, spec] of Object.entries(value)) {
    if (!isRecord(spec)) {
      throw new WorkshopFormatError(`Layout "${name}" must be a mapping`, path);
    }

    const main: ILayoutArea[] = [];
    const rawMain = spec.main;

    if (rawMain !== undefined && rawMain !== null) {
      if (!Array.isArray(rawMain)) {
        throw new WorkshopFormatError(
          `Layout "${name}": "main" must be a list`,
          path
        );
      }

      for (const item of rawMain) {
        if (
          !isRecord(item) ||
          typeof item.area !== 'string' ||
          !LAYOUT_AREAS.has(item.area) ||
          !isStringArray(item.widgets)
        ) {
          throw new WorkshopFormatError(
            `Layout "${name}": each main entry needs an "area" of top, bottom, left or right and a "widgets" list`,
            path
          );
        }

        main.push({
          area: item.area as ILayoutArea['area'],
          widgets: item.widgets,
          size: parseFraction(item.size, `Layout "${name}": "size"`, path)
        });
      }
    }

    layouts[name] = {
      left: parseLayoutSide(spec.left, `Layout "${name}": "left"`, path),
      right: parseLayoutSide(spec.right, `Layout "${name}": "right"`, path),
      main
    };
  }

  return layouts;
}

const LAYOUT_SIDE_FIELDS: ReadonlySet<string> = new Set([
  'widget',
  'collapsed',
  'size'
]);

/**
 * Parse one side of a layout: the word `collapsed`, the name of a widget
 * to show (`instructions` for the workshop panel), or a mapping with
 * `widget`, `collapsed` and `size` fields.
 */
function parseLayoutSide(
  value: unknown,
  label: string,
  path: string
): ILayoutSide | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value === 'collapsed' ? { collapsed: true } : { widget: value };
  }

  if (!isRecord(value)) {
    throw new WorkshopFormatError(
      `${label} must be "collapsed", a widget name or a mapping`,
      path
    );
  }

  for (const key of Object.keys(value)) {
    if (!LAYOUT_SIDE_FIELDS.has(key)) {
      throw new WorkshopFormatError(
        `${label} has unknown field "${key}"`,
        path
      );
    }
  }

  if (value.widget !== undefined && typeof value.widget !== 'string') {
    throw new WorkshopFormatError(`${label}: "widget" must be a string`, path);
  }

  if (value.collapsed !== undefined && typeof value.collapsed !== 'boolean') {
    throw new WorkshopFormatError(
      `${label}: "collapsed" must be true or false`,
      path
    );
  }

  const side: ILayoutSide = {};

  if (typeof value.widget === 'string') {
    side.widget = value.widget;
  }

  if (typeof value.collapsed === 'boolean') {
    side.collapsed = value.collapsed;
  }

  const size = parseFraction(value.size, `${label}: "size"`, path);

  if (size !== undefined) {
    side.size = size;
  }

  return side;
}

/**
 * Parse a size given as a fraction strictly between 0 and 1.
 */
function parseFraction(
  value: unknown,
  label: string,
  path: string
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'number' || !(value > 0 && value < 1)) {
    throw new WorkshopFormatError(
      `${label} must be a number between 0 and 1`,
      path
    );
  }

  return value;
}

function parseTracks(value: unknown, path: string): ITrack[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new WorkshopFormatError('Field "tracks" must be a list', path);
  }

  return value.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string') {
      throw new WorkshopFormatError('Each track needs an "id"', path);
    }

    return {
      id: item.id,
      label: typeof item.label === 'string' ? item.label : item.id
    };
  });
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseEnv(value: unknown, path: string): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new WorkshopFormatError('Field "env" must be a mapping', path);
  }

  const env: Record<string, string> = {};

  for (const [name, entry] of Object.entries(value)) {
    if (!ENV_NAME.test(name)) {
      throw new WorkshopFormatError(
        `Field "env" has an invalid variable name "${name}"`,
        path
      );
    }

    if (
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw new WorkshopFormatError(
        `Field "env.${name}" must be a string, number or boolean`,
        path
      );
    }

    env[name] = String(entry);
  }

  return env;
}

function parseDefaults(value: unknown, path: string): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new WorkshopFormatError('Field "defaults" must be a mapping', path);
  }

  const defaults: Record<string, string> = {};
  const actions = value.actions;

  if (actions !== undefined && actions !== null) {
    if (!isRecord(actions)) {
      throw new WorkshopFormatError(
        'Field "defaults.actions" must be a mapping',
        path
      );
    }

    for (const [key, item] of Object.entries(actions)) {
      defaults[key] = String(item);
    }
  }

  return defaults;
}
