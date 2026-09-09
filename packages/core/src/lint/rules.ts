/**
 * Lint rules for a parsed workshop. The rules that need no JupyterLab are
 * here so the extension, the trust dialog and the CLI agree on findings.
 */

import {
  ACTION_TYPES,
  STRUCTURE_DIRECTIVES,
  allowedOptions,
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
  LAYOUT_WIDGET_KINDS,
  LAYOUT_WIDGET_PATH_KINDS,
  parseLayoutWidget
} from '../format/layouts';
import { IWorkshopManifest } from '../format/manifest';
import { IDirectiveNode, IPage } from '../format/page';
import { liteShellProblems, usesSubprocess } from '../lite';
import {
  actionCapability,
  allDirectives,
  capabilityUses,
  cascades,
  declaredCapabilities,
  isAutomatic
} from '../trust/capabilities';
import {
  dangerWarnings,
  hostAllowed,
  mentionsAbsolutePath,
  urlHosts
} from './danger';
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

/** Option names holding a path that a write-files scope constrains. */
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
  lintFormOrder(input, messages);
  lintLayouts(input, manifestPath, messages);
  lintCapabilities(input, manifestPath, messages);
  lintLinks(input, manifestPath, messages);

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
  const networkScopes = declared.get('network') ?? [];
  const writeScopes = declared.get('write-files') ?? [];
  const workspaceOnly =
    writeScopes.length === 0 ||
    writeScopes.every(scope => scope === 'workspace');

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
      lintPaths(node, workspaceOnly, input.manifest, where, messages);
      lintHosts(node, declared.has('network'), networkScopes, where, messages);
      lintVariants(node, input.manifest.platforms, where, messages);
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

/**
 * The checkpoint the extension takes on first open is reserved: a
 * workshop that named its own checkpoint the same way would overwrite
 * the files "Restart" puts back.
 */
/** Action types that need the server and so cannot run in JupyterLite. */
const LITE_UNSUPPORTED: ReadonlySet<string> = new Set(['environment-create']);

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
  where: { path: string; line: number },
  messages: ILintMessage[]
): void {
  const variants = node.variants;

  // A body with variants but no default must cover every declared
  // platform, or the action has nothing to run on the ones it misses.
  if (variants && !('default' in variants)) {
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
  }

  if (platforms.includes('lite')) {
    lintLite(node, where, messages);
  }
}

function lintLite(
  node: IDirectiveNode,
  where: { path: string; line: number },
  messages: ILintMessage[]
): void {
  const variants = node.variants;
  const liteBody = variants
    ? (variants.lite ?? variants.default ?? '')
    : node.body;

  // An action a when condition hides on Lite, or an empty :lite: variant,
  // is the author saying it does not apply there.
  const skipped =
    /\blite\b/.test(node.options.when ?? '') ||
    (variants !== undefined && 'lite' in variants && liteBody.trim() === '');

  if (skipped) {
    return;
  }

  const substrate =
    node.name === 'verify' ? verifySubstrate(node.options) : null;

  if (LITE_UNSUPPORTED.has(node.name) || substrate === 'script') {
    messages.push({
      level: 'warning',
      rule: 'lite-unsupported',
      message:
        substrate === 'script'
          ? `verify "${node.id}" uses the script substrate, which needs the server; in JupyterLite use kernel, shell, contents or ui, or add a when condition`
          : `${node.name} "${node.id}" needs the server, which JupyterLite lacks; add a when condition`,
      ...where
    });
  }

  if (LITE_SHELL_BODIES.has(node.name) || substrate === 'shell') {
    const problems = liteShellProblems(liteBody);

    if (problems.length > 0) {
      messages.push({
        level: 'warning',
        rule: 'lite-shell-syntax',
        message: `${node.name} "${node.id}" uses ${problems.join(', ')}, which the JupyterLite terminal does not support; add a :lite: variant`,
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
      message: `${node.name} "${node.id}" starts a process, which Pyodide cannot do in JupyterLite; add a :lite: variant or a when condition`,
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

  // An empty body chosen from platform variants means there is nothing to
  // do on this platform, which is deliberate; see lintVariants.
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

function lintPaths(
  node: IDirectiveNode,
  workspaceOnly: boolean,
  manifest: IWorkshopManifest,
  where: { path: string; line: number },
  messages: ILintMessage[]
): void {
  const capability = actionCapability(node.name);

  if (capability !== 'write-files') {
    return;
  }

  // What the trust policy would refuse outright is an error here.
  const refused = writeTargetProblem(
    node.name,
    node.options,
    manifest.capabilities,
    {
      workspace: manifest.workspace,
      requirements: manifest.environment?.requirements
    }
  );

  if (refused) {
    messages.push({
      level: 'error',
      rule: 'write-refused',
      message: `${refused} (${node.name} "${node.id}")`,
      ...where
    });

    return;
  }

  if (!workspaceOnly) {
    return;
  }

  // Paths in a workspace-scoped workshop stay inside the workshop. From
  // a declared workspace, `..` on a read such as `from` may climb as far
  // as the workshop directory, which holds the shipped files.
  const workspace = manifest.workspace;

  for (const option of PATH_OPTIONS) {
    const value = node.options[option];

    if (value === undefined) {
      continue;
    }

    const start = option === 'from' ? undefined : workspace;
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

function lintHosts(
  node: IDirectiveNode,
  networkDeclared: boolean,
  scopes: readonly string[],
  where: { path: string; line: number },
  messages: ILintMessage[]
): void {
  if (!SCANNED_BODIES.has(node.name)) {
    return;
  }

  for (const host of urlHosts(node.body)) {
    if (!networkDeclared) {
      messages.push({
        level: 'warning',
        rule: 'undeclared-host',
        message: `Uses host ${host} in ${node.name} "${node.id}" but the manifest declares no network capability`,
        ...where
      });
    } else if (scopes.length > 0 && !hostAllowed(host, scopes)) {
      messages.push({
        level: 'warning',
        rule: 'undeclared-host',
        message: `Uses host ${host} in ${node.name} "${node.id}" which is not in the declared network hosts`,
        ...where
      });
    }
  }
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

  // Widget references must name a known kind, and file kinds need a path.
  for (const [name, spec] of Object.entries(manifest.layouts)) {
    for (const area of spec.main) {
      for (const reference of area.widgets) {
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
        fix: {
          kind: 'add-capability',
          capability:
            use.capability === 'write-files'
              ? 'write-files:workspace'
              : use.capability
        }
      });
    }
  }

  // Declared but unused capabilities are worth a note: they widen what the
  // learner is asked to trust for nothing.
  const used = new Set(uses.map(use => use.capability));

  if (input.manifest.environment?.requirements) {
    used.add('install-packages');
  }

  for (const [name] of declaredCapabilities(input.manifest)) {
    if (name === 'network') {
      continue;
    }

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
