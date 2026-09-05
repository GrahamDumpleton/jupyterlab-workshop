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
import { IWorkshopManifest } from '../format/manifest';
import { IDirectiveNode, IPage } from '../format/page';
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
const PATH_OPTIONS: readonly string[] = ['path', 'from', 'cwd'];

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
  lintCapabilities(input, manifestPath, messages);

  return messages;
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
      lintPaths(node, workspaceOnly, where, messages);
      lintHosts(node, declared.has('network'), networkScopes, where, messages);
    }
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
        ...where
      });
    }
  }

  const spec = ACTION_TYPES[node.name];

  if (spec.body === 'required' && node.body.trim() === '') {
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

function lintPaths(
  node: IDirectiveNode,
  workspaceOnly: boolean,
  where: { path: string; line: number },
  messages: ILintMessage[]
): void {
  const capability = actionCapability(node.name);

  if (capability !== 'write-files' || !workspaceOnly) {
    return;
  }

  // Paths in a workspace-scoped workshop stay inside the workshop.
  for (const option of PATH_OPTIONS) {
    const value = node.options[option];

    if (value === undefined) {
      continue;
    }

    const escapes =
      value.startsWith('/') ||
      value.startsWith('~') ||
      value === '..' ||
      value.startsWith('../') ||
      value.includes('/../') ||
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
        path: manifestPath
      });
    }
  }

  // Declared but unused capabilities are worth a note: they widen what the
  // learner is asked to trust for nothing.
  const used = new Set(uses.map(use => use.capability));

  for (const [name] of declaredCapabilities(input.manifest)) {
    if (name === 'network' || name === 'install-packages') {
      continue;
    }

    if (!used.has(name as never)) {
      messages.push({
        level: 'warning',
        rule: 'unused-capability',
        message: `The manifest declares the "${name}" capability but no page uses it`,
        path: manifestPath
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
