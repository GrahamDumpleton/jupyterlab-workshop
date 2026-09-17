import { load } from 'js-yaml';

import { WorkshopFormatError } from '../errors';
import { isRecord, isStringArray } from '../util';
import { IAnalyticsBlock, parseAnalyticsBlock } from './analytics';
import { FRONTEND_NAMES, MARKER_NAMES, PLATFORM_NAMES } from './variants';

/** Capability names a manifest may declare, each gating an action type. */
const CAPABILITY_NAMES: readonly string[] = [
  'terminal',
  'write-files',
  'install-packages',
  'kernel-exec',
  'auto-run',
  'ui-settings'
];

/**
 * Directory of a workshop whose contents are copied into the workspace
 * when it is first created: starter code, data and templates.
 */
export const WORKSHOP_FILES_DIR = 'files';

/**
 * The learner's working directory inside every workshop. Write actions
 * are confined to it, Restart empties and refills it, and checkpoints
 * archive it alone.
 */
export const WORKSPACE_DIR = 'work';

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

  /**
   * Platforms the tool is looked for on; every platform when empty. A
   * tool that goes by another name elsewhere is a second entry with a
   * disjoint list.
   */
  platforms: string[];

  /** Frontends the tool is looked for under; every frontend when empty. */
  frontends: string[];
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

/** Where a workshop asks to report progress events; see `IAnalyticsBlock`. */
export type IAnalytics = IAnalyticsBlock;

/**
 * One area of a layout's main-area tree: a set of tabs, or a split into
 * child areas. `tabs` and `areas` are exclusive; lint reports an area
 * with both or neither.
 */
export interface ILayoutArea {
  /** Name an action's `area` option can target; unique within a layout. */
  name?: string;

  /**
   * Widget references opened as tabs, the first of them active, such as
   * `terminal:git` or `markdown:README.md`. An empty list is the
   * placeholder that holds whatever else is open.
   */
  tabs?: string[];

  /** Direction the child areas are laid out in; rows unless said. */
  split?: 'rows' | 'columns';

  /** Child areas of a split. */
  areas?: ILayoutArea[];

  /** Fraction of the parent split the area takes, between 0 and 1. */
  size?: number;
}

/** Where the instructions panel sits and how wide its sidebar is. */
export interface IInstructionsPlacement {
  /** Sidebar the panel lives in for the whole workshop. */
  side?: 'left' | 'right';

  /** Fraction of the window width its sidebar takes, between 0 and 1. */
  width?: number;
}

/** A named arrangement of the JupyterLab window. */
export interface ILayoutSpec {
  /**
   * The sidebar the instructions are not in: `hidden` to collapse it, or
   * the id of a sidebar widget such as `filebrowser` to bring forward.
   */
  sidebar?: string;

  /** Width of the instructions sidebar while this layout is applied. */
  instructions?: { width?: number };

  /** The main area, when the layout arranges it. */
  main?: ILayoutArea;
}

/** Gating policy for moving between pages. */
export type GatingPolicy = 'off' | 'soft' | 'strict';

/**
 * The settings a `variants` entry overrides for one platform or
 * frontend. Only settings whose whole value can differ by marker are
 * here; whether one item of a list applies is said on the item, as a
 * tool's `platforms` does.
 */
export interface IManifestVariant {
  /** Environment variables merged over the manifest's `env`. */
  env: Record<string, string>;

  /** Action option defaults merged over the manifest's `defaults.actions`. */
  defaults: Record<string, string>;
}

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

  /** Operating systems the workshop is written for: linux, macos, windows. */
  platforms: string[];

  /**
   * Frontends the workshop is written for: `jupyterlab` and
   * `jupyterlite`. A manifest that lists none supports JupyterLab only.
   */
  frontends: string[];

  /** The capability names declared; see `CAPABILITY_NAMES`. */
  capabilities: string[];
  requires: IRequirements;
  environment?: IEnvironment;
  analytics?: IAnalytics;

  /**
   * Whether the workshop can be continued after the JupyterLab it ran
   * under has restarted, losing terminals, running programs and kernel
   * state; false unless the manifest says so, in which case a reopen
   * under a new instance asks whether to restart or continue.
   */
  resumable: boolean;
  variables: IVariableDefinition[];

  /** Where the instructions panel sits, for the whole workshop. */
  instructions?: IInstructionsPlacement;

  /**
   * The other sidebar when the workshop opens: `hidden`, the default, or
   * a sidebar widget id to bring forward.
   */
  sidebar?: string;
  layout?: string;
  layouts: Record<string, ILayoutSpec>;
  gating: GatingPolicy;
  tracks: ITrack[];
  pages: string[];

  /** Default option values for action directives, keyed by option name. */
  defaults: Record<string, string>;

  /**
   * Overrides of `env` and `defaults` keyed by platform or frontend
   * name, as written. `resolveManifest` merges the entries that apply.
   */
  variants: Record<string, IManifestVariant>;
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

const LAYOUT_AREA_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'tabs',
  'split',
  'areas',
  'size'
]);

const LAYOUT_FIELDS: ReadonlySet<string> = new Set([
  'sidebar',
  'instructions',
  'main'
]);

const LAYOUT_SPLITS: ReadonlySet<string> = new Set(['rows', 'columns']);

const SIDES: ReadonlySet<string> = new Set(['left', 'right']);

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

  // The learner's directory is always `work`; the field that once named
  // it is refused rather than ignored, so the author learns why.
  if (data.workspace !== undefined) {
    throw new WorkshopFormatError(
      `Field "workspace" is no longer supported; the learner's directory is always "${WORKSPACE_DIR}"`,
      path
    );
  }

  const sidebar = optionalString(data, 'sidebar', path);

  if (sidebar === '') {
    throw new WorkshopFormatError(
      'Field "sidebar" must be "hidden" or a sidebar widget id',
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
    platforms: parseNames(data, 'platforms', PLATFORM_NAMES, path),
    frontends: parseNames(data, 'frontends', FRONTEND_NAMES, path),
    capabilities: parseCapabilities(data.capabilities, path),
    requires: parseRequirements(data.requires, path),
    environment: parseEnvironment(data.environment, path),
    analytics: parseAnalytics(data.analytics, path),
    resumable: parseFlag(data, 'resumable', path),
    variables: parseVariables(data.variables, path),
    instructions: parseInstructions(data.instructions, path),
    sidebar,
    layout: optionalString(data, 'layout', path),
    layouts: parseLayouts(data.layouts, path),
    gating,
    tracks: parseTracks(data.tracks, path),
    pages,
    defaults: parseDefaults(data.defaults, path),
    env: parseEnv(data.env, path),
    variants: parseVariants(data.variants, path)
  };
}

/**
 * Whether a required tool is looked for on a platform and frontend: it
 * is unless the entry lists platforms or frontends that leave them out.
 */
export function toolApplies(
  tool: IToolRequirement,
  platform: string,
  frontend: string
): boolean {
  return (
    (tool.platforms.length === 0 || tool.platforms.includes(platform)) &&
    (tool.frontends.length === 0 || tool.frontends.includes(frontend))
  );
}

/**
 * The manifest as it applies on one platform and frontend: the `env`
 * and `defaults` of the matching `variants` entries merged over the
 * base, the frontend entry over the platform entry over the base, which
 * is the order body markers are chosen in. Everything else is returned
 * as it was, and a manifest with no applicable entry is returned as is.
 */
export function resolveManifest(
  manifest: IWorkshopManifest,
  platform?: string,
  frontend?: string
): IWorkshopManifest {
  const layers: IManifestVariant[] = [];

  for (const name of [platform, frontend]) {
    const layer = name === undefined ? undefined : manifest.variants[name];

    if (layer) {
      layers.push(layer);
    }
  }

  if (layers.length === 0) {
    return manifest;
  }

  let env = { ...manifest.env };
  let defaults = { ...manifest.defaults };

  for (const layer of layers) {
    env = { ...env, ...layer.env };
    defaults = { ...defaults, ...layer.defaults };
  }

  return { ...manifest, env, defaults };
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

  if (typeof value !== 'string') {
    throw new WorkshopFormatError(
      `Field "${field}" must be a string${quotingAdvice(value)}`,
      path
    );
  }

  return value;
}

/**
 * Why a value that should be a string is not, when YAML is the reason:
 * an unquoted `1.10` is read as the number 1.1 and an unquoted `true` as
 * a boolean, so the fix is to quote it.
 */
function quotingAdvice(value: unknown): string {
  if (typeof value === 'number') {
    return '; quote a number such as "1.10" so YAML keeps it as written';
  }

  if (typeof value === 'boolean') {
    return '; quote a true or false so YAML keeps it as text';
  }

  return '';
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

/**
 * A list of names drawn from a known set, such as `platforms` or
 * `frontends`. The old `lite` platform is named in its error so a
 * manifest written before the frontend axis existed says what to change.
 */
function parseNames(
  data: Record<string, unknown>,
  field: string,
  known: readonly string[],
  path: string
): string[] {
  const names = optionalStringList(data, field, path);

  for (const name of names) {
    if (!known.includes(name)) {
      const hint =
        field === 'platforms' && name === 'lite'
          ? '; JupyterLite is declared with "frontends: [jupyterlab, jupyterlite]"'
          : '';

      throw new WorkshopFormatError(
        `Unknown ${field.replace(/s$/, '')} "${name}" in "${field}"; expected one of ${known.join(', ')}${hint}`,
        path
      );
    }
  }

  return names;
}

function parseFlag(
  data: Record<string, unknown>,
  field: string,
  path: string
): boolean {
  const value = data[field];

  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value !== 'boolean') {
    throw new WorkshopFormatError(
      `Field "${field}" must be true or false`,
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

  // Entries are names only. A mapping is what a scoped capability used
  // to look like, so it gets its own message.
  const capabilities: string[] = [];

  for (const item of value) {
    if (isRecord(item)) {
      const name = Object.keys(item)[0] ?? '';

      throw new WorkshopFormatError(
        `Capability "${name}" carries scopes, which are no longer declared; write-files always means the workspace, so write it as "- ${name}"`,
        path
      );
    }

    if (typeof item !== 'string') {
      throw new WorkshopFormatError('Each capability must be a name', path);
    }

    if (!CAPABILITY_NAMES.includes(item)) {
      const hint =
        item === 'network'
          ? '; network is no longer a capability, since terminal commands reach the network anyway'
          : '';

      throw new WorkshopFormatError(
        `Unknown capability "${item}"; expected one of ${CAPABILITY_NAMES.join(', ')}${hint}`,
        path
      );
    }

    if (!capabilities.includes(item)) {
      capabilities.push(item);
    }
  }

  return capabilities;
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

      // Install advice used to be a hint on the entry; it is prose on the
      // first page now, shown when the tool is in missing_tools.
      if ('hint' in item) {
        throw new WorkshopFormatError(
          `Tool "${item.name}" in "requires.tools" has a "hint", which is no longer a field; put the install advice on the first page under a when block testing "${item.name}" in missing_tools`,
          path
        );
      }

      tools.push({
        name: item.name,
        version: typeof item.version === 'string' ? item.version : undefined,
        optional: item.optional === true,
        platforms: parseNames(item, 'platforms', PLATFORM_NAMES, path),
        frontends: parseNames(item, 'frontends', FRONTEND_NAMES, path)
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
  try {
    return parseAnalyticsBlock(value);
  } catch (error) {
    throw new WorkshopFormatError(
      error instanceof Error ? error.message : String(error),
      path
    );
  }
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

    for (const key of Object.keys(spec)) {
      if (!LAYOUT_FIELDS.has(key)) {
        throw new WorkshopFormatError(
          `Layout "${name}" has unknown field "${key}"`,
          path
        );
      }
    }

    const layout: ILayoutSpec = {};
    const label = `Layout "${name}"`;

    if (spec.sidebar !== undefined && spec.sidebar !== null) {
      if (typeof spec.sidebar !== 'string' || spec.sidebar === '') {
        throw new WorkshopFormatError(
          `${label}: "sidebar" must be "hidden" or a sidebar widget id`,
          path
        );
      }

      layout.sidebar = spec.sidebar;
    }

    if (spec.instructions !== undefined && spec.instructions !== null) {
      const placement = parseInstructions(spec.instructions, path, label);

      if (placement?.side !== undefined) {
        throw new WorkshopFormatError(
          `${label}: "instructions" may set only "width"; the side is set once, at the top level`,
          path
        );
      }

      layout.instructions = { width: placement?.width };
    }

    if (spec.main !== undefined && spec.main !== null) {
      layout.main = parseLayoutArea(spec.main, `${label}: "main"`, path);
    }

    layouts[name] = layout;
  }

  return layouts;
}

/**
 * Parse one area of a layout tree: `tabs`, or `split` and `areas`, with
 * an optional `name` and `size`. Whether the area has exactly one of
 * `tabs` and `areas` is left to lint, so the whole manifest still loads.
 */
function parseLayoutArea(
  value: unknown,
  label: string,
  path: string
): ILayoutArea {
  if (!isRecord(value)) {
    throw new WorkshopFormatError(`${label} must be a mapping`, path);
  }

  for (const key of Object.keys(value)) {
    if (!LAYOUT_AREA_FIELDS.has(key)) {
      throw new WorkshopFormatError(
        `${label} has unknown field "${key}"`,
        path
      );
    }
  }

  const area: ILayoutArea = {};

  if (value.name !== undefined && value.name !== null) {
    if (typeof value.name !== 'string' || !NAME.test(value.name)) {
      throw new WorkshopFormatError(
        `${label}: "name" must be lower case letters, digits and hyphens`,
        path
      );
    }

    area.name = value.name;
  }

  if (value.tabs !== undefined && value.tabs !== null) {
    if (!isStringArray(value.tabs)) {
      throw new WorkshopFormatError(
        `${label}: "tabs" must be a list of widget references`,
        path
      );
    }

    area.tabs = value.tabs;
  }

  if (value.split !== undefined && value.split !== null) {
    if (typeof value.split !== 'string' || !LAYOUT_SPLITS.has(value.split)) {
      throw new WorkshopFormatError(
        `${label}: "split" must be rows or columns`,
        path
      );
    }

    area.split = value.split as ILayoutArea['split'];
  }

  if (value.areas !== undefined && value.areas !== null) {
    if (!Array.isArray(value.areas)) {
      throw new WorkshopFormatError(`${label}: "areas" must be a list`, path);
    }

    area.areas = value.areas.map((item: unknown, index: number) =>
      parseLayoutArea(item, `${label}: area ${index + 1}`, path)
    );
  }

  const size = parseFraction(value.size, `${label}: "size"`, path);

  if (size !== undefined) {
    area.size = size;
  }

  return area;
}

const INSTRUCTIONS_FIELDS: ReadonlySet<string> = new Set(['side', 'width']);

/**
 * Parse an `instructions` placement: the sidebar the panel sits in and
 * the fraction of the window its sidebar takes.
 */
function parseInstructions(
  value: unknown,
  path: string,
  owner = 'Field'
): IInstructionsPlacement | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const label = `${owner} "instructions"`;

  if (!isRecord(value)) {
    throw new WorkshopFormatError(`${label} must be a mapping`, path);
  }

  for (const key of Object.keys(value)) {
    if (!INSTRUCTIONS_FIELDS.has(key)) {
      throw new WorkshopFormatError(
        `${label} has unknown field "${key}"`,
        path
      );
    }
  }

  const placement: IInstructionsPlacement = {};

  if (value.side !== undefined && value.side !== null) {
    if (typeof value.side !== 'string' || !SIDES.has(value.side)) {
      throw new WorkshopFormatError(
        `${label}: "side" must be left or right`,
        path
      );
    }

    placement.side = value.side as IInstructionsPlacement['side'];
  }

  const width = parseFraction(value.width, `${label}: "width"`, path);

  if (width !== undefined) {
    placement.width = width;
  }

  return placement;
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

/**
 * An `env` mapping: environment variable names to string values. Values
 * are strings only, as the environment itself holds, so a number or a
 * true/false that YAML would read as something else has to be quoted.
 */
function parseEnv(
  value: unknown,
  path: string,
  field = 'env'
): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new WorkshopFormatError(`Field "${field}" must be a mapping`, path);
  }

  const env: Record<string, string> = {};

  for (const [name, entry] of Object.entries(value)) {
    if (!ENV_NAME.test(name)) {
      throw new WorkshopFormatError(
        `Field "${field}" has an invalid variable name "${name}"`,
        path
      );
    }

    if (typeof entry !== 'string') {
      throw new WorkshopFormatError(
        `Field "${field}.${name}" must be a string${quotingAdvice(entry)}`,
        path
      );
    }

    env[name] = entry;
  }

  return env;
}

/**
 * A `defaults` mapping, whose `actions` entry holds option defaults for
 * every directive. Directive options are the text of `:name: value`
 * lines, so the defaults are strings only too.
 */
function parseDefaults(
  value: unknown,
  path: string,
  field = 'defaults'
): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new WorkshopFormatError(`Field "${field}" must be a mapping`, path);
  }

  const defaults: Record<string, string> = {};
  const actions = value.actions;

  if (actions !== undefined && actions !== null) {
    if (!isRecord(actions)) {
      throw new WorkshopFormatError(
        `Field "${field}.actions" must be a mapping`,
        path
      );
    }

    for (const [key, item] of Object.entries(actions)) {
      if (typeof item !== 'string') {
        throw new WorkshopFormatError(
          `Field "${field}.actions.${key}" must be a string${quotingAdvice(item)}`,
          path
        );
      }

      defaults[key] = item;
    }
  }

  return defaults;
}

/** The settings a `variants` entry may hold. */
const VARIANT_FIELDS: readonly string[] = ['env', 'defaults'];

/**
 * The `variants` mapping: marker names (platforms and frontends) to the
 * settings that differ there. Each entry holds only `env` and
 * `defaults`, in the same shape as the top level, so every field keeps
 * one type; anything else under an entry is an error rather than a
 * setting that would silently never apply.
 */
function parseVariants(
  value: unknown,
  path: string
): Record<string, IManifestVariant> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new WorkshopFormatError('Field "variants" must be a mapping', path);
  }

  const variants: Record<string, IManifestVariant> = {};

  for (const [name, entry] of Object.entries(value)) {
    if (!MARKER_NAMES.includes(name)) {
      throw new WorkshopFormatError(
        `Unknown variant "${name}" in "variants"; expected a platform or frontend: ${MARKER_NAMES.join(', ')}`,
        path
      );
    }

    if (!isRecord(entry)) {
      throw new WorkshopFormatError(
        `Field "variants.${name}" must be a mapping`,
        path
      );
    }

    for (const field of Object.keys(entry)) {
      if (!VARIANT_FIELDS.includes(field)) {
        throw new WorkshopFormatError(
          `Field "variants.${name}.${field}" is not a setting a variant can override; only ${VARIANT_FIELDS.join(' and ')} differ by platform or frontend`,
          path
        );
      }
    }

    variants[name] = {
      env: parseEnv(entry.env, path, `variants.${name}.env`),
      defaults: parseDefaults(entry.defaults, path, `variants.${name}.defaults`)
    };
  }

  return variants;
}
