/**
 * Lint rules for a parsed workshop. The rules that need no JupyterLab are
 * here so the extension, the trust dialog and the CLI agree on findings.
 */

import {
  ACTION_TYPES,
  STRUCTURE_DIRECTIVES,
  allowedOptions,
  actionSupportsFrontend,
  isActionType
} from '../actions/catalog';
import { EDITOR_ACTIONS, editorTargetProblems } from '../actions/editor';
import { parseForm } from '../checks/form';
import { parseRequirement } from '../checks/gating';
import { parseQuiz } from '../checks/quiz';
import {
  CONTENTS_PREDICATES,
  UI_PREDICATES,
  parsePredicates,
  parseTriggers,
  verifySubstrate
} from '../checks/verify';
import {
  findLayout,
  isLayoutPlaceholder,
  LAYOUT_AREA_KEYWORDS,
  LAYOUT_WIDGET_KINDS,
  LAYOUT_WIDGET_PATH_KINDS,
  layoutAreaNames,
  parseLayoutWidget,
  walkLayoutAreas
} from '../format/layouts';
import {
  IWorkshopManifest,
  WORKSPACE_DIR,
  toolApplies
} from '../format/manifest';
import { IDirectiveNode, IPage, PageNode } from '../format/page';
import { PLATFORM_NAMES } from '../format/variants';
import { liteShellProblems, usesSubprocess } from '../lite';
import {
  IMembershipTest,
  evaluateExpression,
  expressionNames,
  membershipTests
} from '../variables/expressions';
import {
  actionCapability,
  allDirectives,
  capabilityUses,
  cascades,
  declaredCapabilities,
  isAutomatic
} from '../trust/capabilities';
import { dangerWarnings, mentionsAbsolutePath } from './danger';
import { writeTargetProblem } from '../trust/paths';
import { isWebLink } from '../util';
import { ILintMessage } from './types';

/** What the linter looks at. */
export interface ILintInput {
  manifest: IWorkshopManifest;
  pages: IPage[];
  manifestPath?: string;
}

/** Action types whose body is a shell command or code worth scanning. */
const SCANNED_BODIES: ReadonlySet<string> = new Set([
  'execute',
  'execute-capture',
  'terminal-type',
  'kernel-execute',
  'cell-insert',
  'command'
]);

/** Option names holding a path that must stay inside the workshop. */
const PATH_OPTIONS: readonly string[] = ['path', 'from', 'to', 'cwd'];

/**
 * Lint a workshop, returning findings in page order.
 */
export function lintWorkshop(input: ILintInput): ILintMessage[] {
  const messages: ILintMessage[] = [];
  const manifestPath = input.manifestPath ?? 'workshop.yaml';

  // Warnings the parser itself produced while rendering pages.
  for (const page of input.pages) {
    for (const warning of page.warnings) {
      messages.push({
        level: 'warning',
        rule: 'page-warning',
        message: warning,
        path: page.path
      });
    }
  }

  lintDirectives(input, messages);
  lintChecks(input, messages);
  lintRequirements(input, messages);
  lintTools(input, manifestPath, messages);
  lintFormOrder(input, messages);
  lintLayouts(input, manifestPath, messages);
  lintLayoutTerminals(input, manifestPath, messages);
  lintResumable(input, manifestPath, messages);
  lintCapabilities(input, manifestPath, messages);
  lintLinks(input, manifestPath, messages);
  lintUrlOpen(input, messages);

  return messages;
}

/**
 * The manifest's `homepage` and `issues` are opened in the learner's
 * browser from the About dialog, so each must be an http or https URL.
 */
function lintLinks(
  input: ILintInput,
  manifestPath: string,
  messages: ILintMessage[]
): void {
  const links: [string, string | undefined][] = [
    ['homepage', input.manifest.homepage],
    ['issues', input.manifest.issues]
  ];

  for (const [field, value] of links) {
    if (value !== undefined && !isWebLink(value)) {
      messages.push({
        level: 'error',
        rule: 'invalid-link',
        message: `Field "${field}" must be an http or https URL, not "${value}"`,
        path: manifestPath
      });
    }
  }
}

/**
 * A `url-open` needs a web URL, and a page served over https cannot show
 * an http page in a pane, so that goes to a new tab instead. A new tab
 * is only allowed by the browser on a click, so an automatic run with no
 * pane to open in has nothing it can do.
 */
function lintUrlOpen(input: ILintInput, messages: ILintMessage[]): void {
  for (const page of input.pages) {
    for (const node of allDirectives([page])) {
      if (node.name !== 'url-open') {
        continue;
      }

      const where = { path: page.path, line: node.line };
      const url = node.options.url;

      if (url === undefined || url.trim() === '') {
        messages.push({
          level: 'error',
          rule: 'invalid-url-open',
          message: 'The url-open action needs a "url" option',
          ...where
        });
      } else if (!url.startsWith('{{') && !isWebLink(url)) {
        messages.push({
          level: 'error',
          rule: 'invalid-url-open',
          message: `The url-open action needs an http or https URL, not "${url}"`,
          ...where
        });
      } else if (/^http:/i.test(url)) {
        messages.push({
          level: 'warning',
          rule: 'insecure-url',
          message: `"${url}" is an http URL, which a JupyterLab served over https cannot show in a pane; it opens in a new tab there`,
          ...where
        });
      }

      if (node.options.auto !== undefined && node.options.pane === undefined) {
        messages.push({
          level: 'warning',
          rule: 'auto-new-tab',
          message: `"${node.id}" opens a new browser tab, which the browser only allows on a click, so it cannot run automatically; give it a pane`,
          ...where
        });
      }
    }
  }
}

function lintChecks(input: ILintInput, messages: ILintMessage[]): void {
  for (const page of input.pages) {
    for (const node of allDirectives([page])) {
      const where = { path: page.path, line: node.line };
      const problems: string[] = [];

      switch (node.name) {
        case 'verify':
          problems.push(...verifyProblems(node));
          break;

        case 'quiz':
          problems.push(...parseQuiz(node.body, node.options).errors);
          break;

        case 'form':
          problems.push(...parseForm(node.body).errors);
          break;

        case 'file-delete':
          problems.push(...fileDeleteProblems(node.options));
          break;

        case 'notebook-create':
          problems.push(...notebookCreateProblems(node.options));

          // Run on its own, the action runs again on every visit to the
          // page, and replacing the notebook then discards every cell the
          // learner has added or run since.
          if (isAutomatic(node) && node.options.existing !== 'keep') {
            messages.push({
              level: 'warning',
              rule: 'notebook-overwrite',
              message: `notebook-create "${node.id}" runs on its own and replaces the notebook each time, discarding the learner's work on a return to the page; add ":existing: keep"`,
              ...where
            });
          }

          break;

        default:
          if (!EDITOR_ACTIONS.includes(node.name)) {
            continue;
          }

          problems.push(...editorTargetProblems(node.name, node.options));
          break;
      }

      for (const problem of problems) {
        messages.push({
          level: 'error',
          rule: `invalid-${node.name}`,
          message: `${problem} in ${node.name} "${node.id}"`,
          ...where
        });
      }
    }
  }
}

function verifyProblems(node: IDirectiveNode): string[] {
  const problems = parseTriggers(node.options.trigger).errors;
  const substrate = verifySubstrate(node.options);

  if (substrate === null) {
    problems.push(`Unknown substrate "${node.options.substrate}"`);

    return problems;
  }

  switch (substrate) {
    case 'script':
      if (!node.options.script) {
        problems.push('A script substrate needs a "script" option');
      }

      break;

    case 'contents':
      problems.push(...parsePredicates(node.body, CONTENTS_PREDICATES).errors);
      break;

    case 'ui':
      problems.push(...parsePredicates(node.body, UI_PREDICATES).errors);
      break;

    case 'learner-kernel':
      if (!node.options.path) {
        problems.push('A learner-kernel substrate needs a notebook "path"');
      }

      if (node.body.trim() === '') {
        problems.push('The verify needs code in its body');
      }

      break;

    default:
      if (node.body.trim() === '') {
        problems.push('The verify needs code in its body');
      }

      break;
  }

  return problems;
}

function lintRequirements(input: ILintInput, messages: ILintMessage[]): void {
  const ids = new Map<string, string>();

  for (const node of allDirectives(input.pages)) {
    if (['verify', 'quiz', 'form'].includes(node.name)) {
      ids.set(node.id, node.name);
    }
  }

  for (const page of input.pages) {
    for (const text of page.frontmatter.requires) {
      const requirement = parseRequirement(text);

      if (!requirement) {
        messages.push({
          level: 'error',
          rule: 'invalid-requirement',
          message: `Requirement "${text}" should look like verify:<id>, quiz:<id> or form:<id>`,
          path: page.path
        });
      } else if (ids.get(requirement.id) !== requirement.kind) {
        messages.push({
          level: 'error',
          rule: 'unknown-requirement',
          message: `Requirement "${text}" names no ${requirement.kind} directive`,
          path: page.path
        });
      }
    }
  }
}

/**
 * The tools a manifest requires: an entry whose `platforms` and
 * `frontends` leave out every combination the manifest supports is
 * never looked for, and a page that tests a name against
 * `missing_tools` which no entry declares can never see it missing.
 */
function lintTools(
  input: ILintInput,
  manifestPath: string,
  messages: ILintMessage[]
): void {
  const manifest = input.manifest;
  const frontends =
    manifest.frontends.length > 0 ? manifest.frontends : DEFAULT_FRONTENDS;
  const platforms =
    manifest.platforms.length > 0 ? manifest.platforms : PLATFORM_NAMES;

  for (const tool of manifest.requires.tools) {
    // JupyterLite runs on Pyodide, whose platform is emscripten whatever
    // the manifest lists, so a platform list never matches there.
    const reachable = frontends.some(frontend =>
      (frontend === 'jupyterlite' ? ['emscripten'] : platforms).some(platform =>
        toolApplies(tool, platform, frontend)
      )
    );

    if (!reachable) {
      messages.push({
        level: 'warning',
        rule: 'unreachable-tool',
        message: `Tool "${tool.name}" is never looked for: its platforms and frontends leave out every combination the manifest supports`,
        path: manifestPath
      });
    }
  }

  const names = new Set(manifest.requires.tools.map(tool => tool.name));

  const check = (
    condition: string | undefined,
    path: string,
    line?: number
  ): void => {
    if (!condition) {
      return;
    }

    let tests: IMembershipTest[];

    try {
      tests = membershipTests(condition);
    } catch {
      return;
    }

    for (const test of tests) {
      if (test.container === 'missing_tools' && !names.has(test.item)) {
        messages.push({
          level: 'warning',
          rule: 'unknown-tool',
          message: `"${test.item}" is tested against missing_tools but is not in requires.tools, so it is never reported missing`,
          path,
          ...(line === undefined ? {} : { line })
        });
      }
    }
  };

  const walk = (nodes: PageNode[], path: string): void => {
    for (const node of nodes) {
      if (node.kind === 'when') {
        check(node.condition, path, node.line);
        walk(node.nodes, path);
      } else if (node.kind === 'directive') {
        check(node.options.when, path, node.line);
      }
    }
  };

  for (const page of input.pages) {
    check(page.frontmatter.when, page.path);
    walk(page.nodes, page.path);
  }
}

function lintFormOrder(input: ILintInput, messages: ILintMessage[]): void {
  // A variable a form sets must not be used on an earlier page, since the
  // learner has had no chance to fill it in yet.
  const definedAt = new Map<string, number>();
  const manifestNames = new Set(
    input.manifest.variables
      .filter(definition => definition.default !== undefined)
      .map(definition => definition.name)
  );

  input.pages.forEach((page, index) => {
    for (const node of allDirectives([page])) {
      if (node.name !== 'form') {
        continue;
      }

      const parsed = parseForm(node.body);

      for (const field of parsed.form?.fields ?? []) {
        if (!definedAt.has(field.name)) {
          definedAt.set(field.name, index);
        }
      }
    }
  });

  input.pages.forEach((page, index) => {
    for (const name of usedVariables(page)) {
      const defined = definedAt.get(name);

      if (
        defined !== undefined &&
        defined > index &&
        !manifestNames.has(name)
      ) {
        messages.push({
          level: 'error',
          rule: 'use-before-form',
          message: `Variable "${name}" is used before the form on page ${defined + 1} sets it`,
          path: page.path
        });
      }
    }
  });
}

function usedVariables(page: IPage): Set<string> {
  const names = new Set<string>();
  const pattern = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/g;

  const scan = (text: string): void => {
    for (const match of text.matchAll(pattern)) {
      names.add(match[1]);
    }
  };

  for (const node of allDirectives([page])) {
    scan(node.body);

    for (const value of Object.values(node.options)) {
      scan(value);
    }
  }

  return names;
}

function lintDirectives(input: ILintInput, messages: ILintMessage[]): void {
  const declared = declaredCapabilities(input.manifest);

  for (const page of input.pages) {
    for (const node of allDirectives([page])) {
      const where = { path: page.path, line: node.line };

      if (STRUCTURE_DIRECTIVES.has(node.name)) {
        continue;
      }

      if (!isActionType(node.name)) {
        messages.push({
          level: 'error',
          rule: 'unknown-directive',
          message: `Unknown directive "${node.name}"`,
          ...where
        });

        continue;
      }

      lintOptions(node, where, messages);
      lintBody(node, where, messages);
      lintPaths(node, input.manifest, where, messages);
      lintVariants(
        node,
        input.manifest.platforms,
        input.manifest.frontends,
        where,
        messages
      );
    }
  }

  // An isolated environment installs packages, so it needs the capability
  // whether or not a page carries an explicit environment-create action.
  if (
    input.manifest.environment?.requirements &&
    !declared.has('install-packages')
  ) {
    messages.push({
      level: 'error',
      rule: 'undeclared-capability',
      message:
        'The manifest declares an environment with requirements but not the "install-packages" capability it needs',
      path: input.manifestPath ?? 'workshop.yaml',
      fix: { kind: 'add-capability', capability: 'install-packages' }
    });
  }
}

/** The frontend a manifest supports when it lists none. */
const DEFAULT_FRONTENDS: readonly string[] = ['jupyterlab'];

/** Action types whose body the JupyterLite terminal runs as a command. */
const LITE_SHELL_BODIES: ReadonlySet<string> = new Set([
  'execute',
  'execute-capture',
  'terminal-type'
]);

/** Action types whose body Pyodide runs as Python. */
const LITE_PYTHON_BODIES: ReadonlySet<string> = new Set([
  'kernel-execute',
  'cell-insert'
]);

function lintVariants(
  node: IDirectiveNode,
  platforms: readonly string[],
  frontends: readonly string[],
  where: { path: string; line: number },
  messages: ILintMessage[]
): void {
  const variants = node.variants;
  const listed = frontends.length > 0 ? frontends : DEFAULT_FRONTENDS;

  // A body with variants but no default must cover every declared
  // platform, or the action has nothing to run on the ones it misses. A
  // frontend variant covers its frontend on every platform, so the
  // platforms only matter for the frontends that have no variant.
  if (variants && !('default' in variants)) {
    const uncovered = listed.filter(frontend => !(frontend in variants));

    if (uncovered.length > 0) {
      for (const platform of platforms) {
        if (!(platform in variants)) {
          messages.push({
            level: 'error',
            rule: 'missing-variant',
            message: `${node.name} "${node.id}" has no body for ${platform}, which the manifest lists, and no default`,
            ...where
          });
        }
      }

      if (platforms.length === 0 && frontends.length > 0) {
        for (const frontend of uncovered) {
          messages.push({
            level: 'error',
            rule: 'missing-variant',
            message: `${node.name} "${node.id}" has no body for ${frontend}, which the manifest lists, and no default`,
            ...where
          });
        }
      }
    }
  }

  // An action a frontend cannot run is reported for every listed frontend
  // that lacks it, unless the author already excluded it there.
  for (const frontend of listed) {
    if (
      !actionSupportsFrontend(node.name, frontend) &&
      !excludedOn(node, frontend, 'emscripten')
    ) {
      messages.push({
        level: 'warning',
        rule: 'unsupported-frontend',
        message: `${node.name} "${node.id}" is not available in ${frontend}, which the manifest lists; add a when condition or an empty :${frontend}: variant`,
        ...where
      });
    }
  }

  if (listed.includes('jupyterlite')) {
    lintLite(node, where, messages);
  }
}

/**
 * Whether the author has already said an action does not apply on a
 * frontend: its `when` condition tests the frontend or the platform and
 * is false there, or it has an empty variant for that frontend. The
 * condition is evaluated with the frontend and its platform bound and
 * every other name unknown, so `frontend != "jupyterlite"` and
 * `not (frontend == "jupyterlite")` both count; a condition that never
 * mentions either axis is about something else and does not.
 */
function excludedOn(
  node: IDirectiveNode,
  frontend: string,
  platform: string
): boolean {
  const variants = node.variants;

  if (
    variants !== undefined &&
    frontend in variants &&
    variants[frontend].trim() === ''
  ) {
    return true;
  }

  const condition = node.options.when;

  if (!condition || condition.trim() === '') {
    return false;
  }

  try {
    const names = expressionNames(condition);

    if (!names.includes('frontend') && !names.includes('platform')) {
      return false;
    }

    return !evaluateExpression(condition, { frontend, platform }).value;
  } catch {
    return false;
  }
}

function lintLite(
  node: IDirectiveNode,
  where: { path: string; line: number },
  messages: ILintMessage[]
): void {
  const variants = node.variants;
  const liteBody = variants
    ? (variants.jupyterlite ?? variants.default ?? '')
    : node.body;

  if (excludedOn(node, 'jupyterlite', 'emscripten')) {
    return;
  }

  const substrate =
    node.name === 'verify' ? verifySubstrate(node.options) : null;

  if (substrate === 'script') {
    messages.push({
      level: 'warning',
      rule: 'lite-unsupported',
      message: `verify "${node.id}" uses the script substrate, which needs the server; in JupyterLite use kernel, shell, contents or ui, or add a when condition`,
      ...where
    });
  }

  if (LITE_SHELL_BODIES.has(node.name) || substrate === 'shell') {
    const problems = liteShellProblems(liteBody);

    if (problems.length > 0) {
      messages.push({
        level: 'warning',
        rule: 'lite-shell-syntax',
        message: `${node.name} "${node.id}" uses ${problems.join(', ')}, which the JupyterLite terminal does not support; add a :jupyterlite: variant`,
        ...where
      });
    }
  }

  if (
    (LITE_PYTHON_BODIES.has(node.name) || substrate === 'kernel') &&
    usesSubprocess(liteBody)
  ) {
    messages.push({
      level: 'warning',
      rule: 'lite-unsupported',
      message: `${node.name} "${node.id}" starts a process, which Pyodide cannot do in JupyterLite; add a :jupyterlite: variant or a when condition`,
      ...where
    });
  }
}

function lintOptions(
  node: IDirectiveNode,
  where: { path: string; line: number },
  messages: ILintMessage[]
): void {
  const allowed = allowedOptions(node.name);

  for (const option of Object.keys(node.options)) {
    if (!allowed.includes(option)) {
      messages.push({
        level: 'warning',
        rule: 'unknown-option',
        message: `Option "${option}" is not used by the ${node.name} directive`,
        fix: { kind: 'remove-option', option },
        ...where
      });
    }
  }

  const spec = ACTION_TYPES[node.name];

  // An empty body chosen from variants means there is nothing to do on
  // this platform or frontend, which is deliberate; see lintVariants.
  if (spec.body === 'required' && node.body.trim() === '' && !node.variants) {
    messages.push({
      level: 'error',
      rule: 'missing-body',
      message: `The ${node.name} directive needs a body`,
      ...where
    });
  }
}

function lintBody(
  node: IDirectiveNode,
  where: { path: string; line: number },
  messages: ILintMessage[]
): void {
  if (!SCANNED_BODIES.has(node.name)) {
    return;
  }

  for (const warning of dangerWarnings(node.body)) {
    messages.push({
      level: 'warning',
      rule: warning.rule,
      message: `${warning.message} in ${node.name} "${node.id}"`,
      ...where
    });
  }
}

/**
 * Paths a `file-delete` must never aim at: the workshop directory itself
 * and its state directory, which hold the pages and the learner's
 * progress. Anything else is the author's call, with `recursive` saying
 * a directory is meant.
 */
export function fileDeleteProblems(options: Record<string, string>): string[] {
  const path = (options.path ?? '').trim().replace(/\/+$/, '');
  const normalized = path.replace(/^\.\//, '');

  if (normalized === '' || normalized === '.') {
    return ['A path is required and cannot be the workshop directory'];
  }

  if (normalized === '_workshop' || normalized.startsWith('_workshop/')) {
    return ['The _workshop state directory cannot be deleted'];
  }

  if (
    options.missing !== undefined &&
    !['ignore', 'error'].includes(options.missing)
  ) {
    return [`Unknown missing "${options.missing}", expected ignore or error`];
  }

  return [];
}

/**
 * Problems with the options of a `notebook-create` action.
 */
export function notebookCreateProblems(
  options: Record<string, string>
): string[] {
  if (
    options.existing !== undefined &&
    !['keep', 'replace'].includes(options.existing)
  ) {
    return [`Unknown existing "${options.existing}", expected keep or replace`];
  }

  return [];
}

function lintPaths(
  node: IDirectiveNode,
  manifest: IWorkshopManifest,
  where: { path: string; line: number },
  messages: ILintMessage[]
): void {
  const capability = actionCapability(node.name);

  if (capability !== 'write-files') {
    return;
  }

  // What the trust policy would refuse outright is an error here.
  const refused = writeTargetProblem(node.name, node.options, {
    requirements: manifest.environment?.requirements
  });

  if (refused) {
    messages.push({
      level: 'error',
      rule: 'write-refused',
      message: `${refused} (${node.name} "${node.id}")`,
      ...where
    });

    return;
  }

  // Paths stay inside the workshop. From the workspace, `..` on a read
  // such as `from` may climb as far as the workshop directory, which
  // holds the shipped files.
  for (const option of PATH_OPTIONS) {
    const value = node.options[option];

    if (value === undefined) {
      continue;
    }

    const start = option === 'from' ? undefined : WORKSPACE_DIR;
    const escapes =
      value.startsWith('/') ||
      value.startsWith('~') ||
      climbsOut(value, start) ||
      mentionsAbsolutePath(value);

    if (escapes) {
      messages.push({
        level: 'warning',
        rule: 'path-outside-workspace',
        message: `Path "${value}" in ${node.name} "${node.id}" is outside the workshop directory`,
        ...where
      });
    }
  }
}

/**
 * Whether a relative path leaves the workshop directory: from the
 * workshop itself any `..` does, from a workspace inside it `..` may
 * climb as many levels as the workspace is deep.
 */
function climbsOut(value: string, workspace: string | undefined): boolean {
  let depth = workspace ? workspace.split('/').filter(Boolean).length : 0;

  for (const part of value.split('/')) {
    if (part === '..') {
      depth -= 1;

      if (depth < 0) {
        return true;
      }
    } else if (part !== '' && part !== '.') {
      depth += 1;
    }
  }

  return false;
}

function lintLayouts(
  input: ILintInput,
  manifestPath: string,
  messages: ILintMessage[]
): void {
  const { manifest } = input;

  // Every layout named, by the manifest or a layout directive, must be
  // declared or built in.
  if (manifest.layout && !findLayout(manifest.layouts, manifest.layout)) {
    messages.push({
      level: 'error',
      rule: 'unknown-layout',
      message: `The manifest names layout "${manifest.layout}" which is not declared or built in`,
      path: manifestPath
    });
  }

  for (const page of input.pages) {
    for (const node of allDirectives([page])) {
      if (node.name !== 'layout') {
        continue;
      }

      const name = node.options.name || node.argument || 'default';

      if (!findLayout(manifest.layouts, name)) {
        messages.push({
          level: 'error',
          rule: 'unknown-layout',
          message: `The layout directive names layout "${name}" which is not declared or built in`,
          path: page.path,
          line: node.line
        });
      }
    }
  }

  // Every area is tabs or a split, names are unique within a layout,
  // and at most one area is the placeholder; widget references must name
  // a known kind, and file kinds need a path.
  for (const [name, spec] of Object.entries(manifest.layouts)) {
    if (!spec.main) {
      continue;
    }

    const names = new Set<string>();
    let placeholders = 0;

    for (const area of walkLayoutAreas(spec.main)) {
      const tabs = area.tabs !== undefined;
      const areas = area.areas !== undefined;

      if (tabs === areas) {
        messages.push({
          level: 'error',
          rule: 'layout-area',
          message: `Layout "${name}" has an area with ${tabs ? 'both' : 'neither'} "tabs" ${tabs ? 'and' : 'nor'} "areas"; give it one of the two`,
          path: manifestPath
        });
      }

      if (area.name !== undefined) {
        if (names.has(area.name)) {
          messages.push({
            level: 'error',
            rule: 'layout-area',
            message: `Layout "${name}" names two areas "${area.name}"; names are unique within a layout`,
            path: manifestPath
          });
        }

        names.add(area.name);
      }

      if (isLayoutPlaceholder(area)) {
        placeholders += 1;
      }

      for (const reference of area.tabs ?? []) {
        const { kind, target } = parseLayoutWidget(reference);

        if (!LAYOUT_WIDGET_KINDS.has(kind)) {
          messages.push({
            level: 'error',
            rule: 'unknown-layout-widget',
            message: `Layout "${name}" names widget "${reference}" of unknown kind "${kind}"; use ${[...LAYOUT_WIDGET_KINDS].join(', ')}`,
            path: manifestPath
          });
        } else if (LAYOUT_WIDGET_PATH_KINDS.has(kind) && target === '') {
          messages.push({
            level: 'error',
            rule: 'unknown-layout-widget',
            message: `Layout "${name}" names widget "${reference}" without the path it needs, such as "${kind}:README.md"`,
            path: manifestPath
          });
        }
      }
    }

    if (placeholders > 1) {
      messages.push({
        level: 'error',
        rule: 'layout-area',
        message: `Layout "${name}" has ${placeholders} empty "tabs" areas; only one can hold whatever else is open`,
        path: manifestPath
      });
    }
  }

  // An action's area option names a keyword or an area some layout
  // declares. A substituted value is checked when the page runs.
  const areaNames = layoutAreaNames(manifest.layouts);

  for (const page of input.pages) {
    for (const node of allDirectives([page])) {
      const area = node.options.area;

      if (
        area === undefined ||
        !ACTION_TYPES[node.name]?.options.includes('area') ||
        area.includes('{{') ||
        LAYOUT_AREA_KEYWORDS.has(area) ||
        areaNames.has(area)
      ) {
        continue;
      }

      messages.push({
        level: 'error',
        rule: 'unknown-layout-area',
        message: `The ${node.name} action names area "${area}", which no layout declares; use ${[...LAYOUT_AREA_KEYWORDS].join(', ')} or a declared area name`,
        path: page.path,
        line: node.line
      });
    }
  }
}

/**
 * A layout the workshop applies that opens a terminal, when the manifest
 * does not declare the `terminal` capability, leaves the learner looking
 * at a terminal no page can use. The built-in layouts both open one, so
 * this is what a notebook workshop scaffolded with `layout: default` gets.
 */
function lintLayoutTerminals(
  input: ILintInput,
  manifestPath: string,
  messages: ILintMessage[]
): void {
  const { manifest } = input;

  if (declaredCapabilities(manifest).has('terminal')) {
    return;
  }

  // Only layouts something applies count: the one the manifest opens
  // with, and those a layout directive names.
  const applied: { name: string; path: string; line?: number }[] = [];

  if (manifest.layout) {
    applied.push({ name: manifest.layout, path: manifestPath });
  }

  for (const page of input.pages) {
    for (const node of allDirectives([page])) {
      if (node.name === 'layout' && node.options.name) {
        applied.push({
          name: node.options.name,
          path: page.path,
          line: node.line
        });
      }
    }
  }

  const reported = new Set<string>();

  for (const { name, path, line } of applied) {
    const spec = findLayout(manifest.layouts, name);

    if (!spec?.main || reported.has(name)) {
      continue;
    }

    const opensTerminal = [...walkLayoutAreas(spec.main)].some(area =>
      (area.tabs ?? []).some(
        reference => parseLayoutWidget(reference).kind === 'terminal'
      )
    );

    if (opensTerminal) {
      reported.add(name);

      messages.push({
        level: 'warning',
        rule: 'layout-terminal',
        message: `Layout "${name}" opens a terminal but the manifest does not declare the "terminal" capability, so no page can use it; name a layout without a terminal, or none`,
        path,
        line
      });
    }
  }
}

/** Directives that leave state in, or read it from, a notebook's kernel. */
const KERNEL_STATE_ACTIONS: readonly string[] = [
  'cell-run',
  'cell-run-all',
  'cell-run-to',
  'kernel-execute'
];

/**
 * Whether a directive runs code in, or checks, the kernel of the
 * notebook its `path` names.
 */
function touchesNotebookKernel(node: IDirectiveNode): boolean {
  if (!node.options.path) {
    return false;
  }

  if (node.name === 'cell-insert') {
    return node.options.run === 'true';
  }

  if (node.name === 'verify') {
    return verifySubstrate(node.options) === 'learner-kernel';
  }

  return KERNEL_STATE_ACTIONS.includes(node.name);
}

/**
 * A workshop marked `resumable` is continued without a question after
 * JupyterLab restarts, which is only sound when its pages leave nothing
 * live behind. Pages that work in the kernel of one notebook across
 * several pages do: what earlier pages defined is gone after a restart,
 * and the later pages fail on it.
 */
function lintResumable(
  input: ILintInput,
  manifestPath: string,
  messages: ILintMessage[]
): void {
  if (!input.manifest.resumable) {
    return;
  }

  const pagesByNotebook = new Map<string, Set<string>>();

  for (const page of input.pages) {
    for (const node of allDirectives([page])) {
      if (!touchesNotebookKernel(node)) {
        continue;
      }

      const notebook = node.options.path.trim();
      const pages = pagesByNotebook.get(notebook) ?? new Set<string>();

      pages.add(page.path);
      pagesByNotebook.set(notebook, pages);
    }
  }

  for (const [notebook, pages] of pagesByNotebook) {
    if (pages.size > 1) {
      messages.push({
        level: 'warning',
        rule: 'resumable-kernel-state',
        message: `The manifest sets "resumable: true" but ${pages.size} pages run or check code in the kernel of "${notebook}", whose state does not survive a restart; a workshop whose later pages rely on what earlier pages ran is not resumable`,
        path: manifestPath
      });
    }
  }
}

function lintCapabilities(
  input: ILintInput,
  manifestPath: string,
  messages: ILintMessage[]
): void {
  const uses = capabilityUses(input.manifest, input.pages);

  for (const use of uses) {
    if (!use.declared) {
      messages.push({
        level: 'error',
        rule: 'undeclared-capability',
        message: `Pages use the "${use.capability}" capability (${use.count} ${use.count === 1 ? 'action' : 'actions'}) but the manifest does not declare it`,
        path: manifestPath,
        fix: { kind: 'add-capability', capability: use.capability }
      });
    }
  }

  // Declared but unused capabilities are worth a note: they widen what the
  // learner is asked to trust for nothing.
  const used = new Set(uses.map(use => use.capability));

  if (input.manifest.environment?.requirements) {
    used.add('install-packages');
  }

  for (const name of declaredCapabilities(input.manifest)) {
    if (!used.has(name as never)) {
      messages.push({
        level: 'warning',
        rule: 'unused-capability',
        message: `The manifest declares the "${name}" capability but no page uses it`,
        path: manifestPath,
        fix: { kind: 'remove-capability', capability: name }
      });
    }
  }

  // An auto-run declaration with nothing automatic, or the reverse, is
  // covered above; here flag chains that never get to run.
  const directives = allDirectives(input.pages);
  const ids = new Set(directives.map(node => node.id));

  for (const page of input.pages) {
    for (const node of allDirectives([page])) {
      const auto = node.options.auto;

      if (auto?.startsWith('after:') && !ids.has(auto.slice('after:'.length))) {
        messages.push({
          level: 'error',
          rule: 'unknown-action-id',
          message: `"${node.id}" waits for unknown action "${auto.slice('after:'.length)}"`,
          path: page.path,
          line: node.line
        });
      }

      const cascade = node.options.cascade;

      if (cascades(node) && cascade !== 'true') {
        const target = (cascade ?? '').trim().split(/\s+/)[0];

        if (!ids.has(target)) {
          messages.push({
            level: 'error',
            rule: 'unknown-action-id',
            message: `"${node.id}" cascades to unknown action "${target}"`,
            path: page.path,
            line: node.line
          });
        }
      }

      // A verify triggered after an action that no page carries would
      // only ever run when clicked, which the author did not intend.
      if (node.name === 'verify') {
        for (const trigger of parseTriggers(node.options.trigger).triggers) {
          if (trigger.kind === 'action' && trigger.id && !ids.has(trigger.id)) {
            messages.push({
              level: 'error',
              rule: 'unknown-action-id',
              message: `"${node.id}" is triggered by unknown action "${trigger.id}"`,
              path: page.path,
              line: node.line
            });
          }
        }
      }

      if (
        isAutomatic(node) &&
        auto !== 'page-enter' &&
        !auto?.startsWith('after:')
      ) {
        messages.push({
          level: 'warning',
          rule: 'unknown-auto',
          message: `"${node.id}" has an unrecognised auto value "${auto}"`,
          path: page.path,
          line: node.line
        });
      }
    }
  }
}
