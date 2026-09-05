/**
 * Capabilities: what a workshop declares it needs, and what its pages
 * actually use. The trust dialog compares the two and the runtime refuses
 * actions whose capability the manifest does not declare.
 */

import { ACTION_TYPES, Capability, ROLE_TYPES } from '../actions/catalog';
import { CODE_SUBSTRATES, verifySubstrate } from '../checks/verify';
import { IWorkshopManifest } from '../format/manifest';
import { IDirectiveNode, IPage, PageNode } from '../format/page';

/** The capability names a manifest may declare. */
export const CAPABILITY_NAMES: readonly Capability[] = [
  'terminal',
  'write-files',
  'network',
  'install-packages',
  'kernel-exec',
  'auto-run',
  'ui-settings'
];

/** Scopes accepted by `write-files`. */
export const WRITE_SCOPES: readonly string[] = ['workspace', 'home', 'any'];

/** One-line explanations shown in the trust dialog. */
export const CAPABILITY_DESCRIPTIONS: Readonly<Record<Capability, string>> = {
  none: 'No special access.',
  terminal: 'Run commands in terminals.',
  'write-files': 'Create and change files.',
  network: 'Download from the network.',
  'install-packages': 'Install packages.',
  'kernel-exec': 'Run code in kernels, including in the background.',
  'auto-run': 'Run actions automatically without a click.',
  'ui-settings': 'Change JupyterLab settings.'
};

/** A capability the pages use, with how often. */
export interface ICapabilityUse {
  capability: Capability;

  /** Number of directives needing the capability. */
  count: number;

  /** Whether the manifest declares the capability. */
  declared: boolean;
}

/**
 * Return the name part of a declared capability such as
 * `write-files:workspace`.
 */
export function capabilityName(declared: string): string {
  const colon = declared.indexOf(':');

  return colon < 0 ? declared : declared.slice(0, colon);
}

/**
 * Return the scope part of a declared capability, or an empty string.
 */
export function capabilityScope(declared: string): string {
  const colon = declared.indexOf(':');

  return colon < 0 ? '' : declared.slice(colon + 1);
}

/**
 * Group the manifest's capabilities by name, mapping each to its scopes.
 */
export function declaredCapabilities(
  manifest: IWorkshopManifest
): Map<string, string[]> {
  const declared = new Map<string, string[]>();

  for (const item of manifest.capabilities) {
    const name = capabilityName(item);
    const scope = capabilityScope(item);
    const scopes = declared.get(name) ?? [];

    if (scope !== '' && !scopes.includes(scope)) {
      scopes.push(scope);
    }

    declared.set(name, scopes);
  }

  return declared;
}

/**
 * Return the capability an action type or role needs, or null when the
 * type is unknown.
 */
export function actionCapability(type: string): Capability | null {
  return ACTION_TYPES[type]?.capability ?? ROLE_TYPES[type]?.capability ?? null;
}

/**
 * The capability a particular directive needs, taking its options into
 * account: a verify that runs code needs the kernel, one that only looks
 * at files or the interface needs nothing.
 */
export function effectiveCapability(
  type: string,
  options: Record<string, string>
): Capability | null {
  if (type === 'verify') {
    const substrate = verifySubstrate(options);

    return substrate && (CODE_SUBSTRATES as string[]).includes(substrate)
      ? 'kernel-exec'
      : 'none';
  }

  return actionCapability(type);
}

/**
 * Whether a directive runs without a click: on page entry, after another
 * action, or as the target of a cascade from a previous action.
 */
export function isAutomatic(node: IDirectiveNode): boolean {
  const auto = node.options.auto;

  return auto !== undefined && auto !== '' && auto !== 'false';
}

/**
 * Whether a directive starts a cascade into the next action.
 */
export function cascades(node: IDirectiveNode): boolean {
  const cascade = node.options.cascade;

  return cascade !== undefined && cascade !== '' && cascade !== 'false';
}

/**
 * Every action directive in the pages, descending into `when` blocks.
 */
export function allDirectives(pages: IPage[]): IDirectiveNode[] {
  const directives: IDirectiveNode[] = [];

  const walk = (nodes: PageNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'directive') {
        directives.push(node);
      } else if (node.kind === 'when') {
        walk(node.nodes);
      }
    }
  };

  for (const page of pages) {
    walk(page.nodes);
  }

  return directives;
}

/**
 * Count the directives that run automatically, either from an `auto`
 * option or because another action cascades into them.
 */
export function countAutomatic(pages: IPage[]): number {
  const directives = allDirectives(pages);
  let count = 0;

  for (const node of directives) {
    if (isAutomatic(node) || cascades(node)) {
      count += 1;
    }
  }

  return count;
}

/**
 * The capabilities the pages use, compared with what the manifest
 * declares. Automatic runs count as the `auto-run` capability.
 */
export function capabilityUses(
  manifest: IWorkshopManifest,
  pages: IPage[]
): ICapabilityUse[] {
  const declared = declaredCapabilities(manifest);
  const counts = new Map<Capability, number>();

  for (const node of allDirectives(pages)) {
    const capability = effectiveCapability(node.name, node.options);

    if (capability && capability !== 'none') {
      counts.set(capability, (counts.get(capability) ?? 0) + 1);
    }

    if (isAutomatic(node) || cascades(node)) {
      counts.set('auto-run', (counts.get('auto-run') ?? 0) + 1);
    }
  }

  return CAPABILITY_NAMES.filter(name => counts.has(name)).map(name => ({
    capability: name,
    count: counts.get(name) ?? 0,
    declared: declared.has(name)
  }));
}

/**
 * The capabilities the pages use that the manifest does not declare.
 */
export function undeclaredCapabilities(
  manifest: IWorkshopManifest,
  pages: IPage[]
): Capability[] {
  return capabilityUses(manifest, pages)
    .filter(use => !use.declared)
    .map(use => use.capability);
}
