/**
 * The trust policy: given the trust level of a workshop and the action
 * about to run, decide whether it runs as written, runs in a degraded
 * form, needs confirmation, is skipped, or is refused outright.
 *
 * This module is pure so the JupyterLab extension and the CLI apply the
 * same rules.
 */

import { Capability } from '../actions/catalog';
import { effectiveCapability } from './capabilities';

/** How far a workshop is trusted. */
export type TrustLevel = 'trusted' | 'restricted' | 'ask';

/** The trust levels in order from most to least permissive. */
export const TRUST_LEVELS: readonly TrustLevel[] = [
  'trusted',
  'restricted',
  'ask'
];

/** Short explanations of the levels for dialogs. */
export const TRUST_LEVEL_DESCRIPTIONS: Readonly<Record<TrustLevel, string>> = {
  trusted: 'Every declared capability is allowed, including automatic runs.',
  restricted:
    'Commands are typed into the terminal for you to run, writes and code need confirmation, and nothing runs automatically.',
  ask: 'Each action that changes something asks for confirmation first.'
};

/** What the runtime should do with an action. */
export type ActionDisposition =
  | { kind: 'run' }
  | { kind: 'confirm'; reason: string }
  | { kind: 'downgrade'; type: string; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'reject'; reason: string };

/** The facts the policy decides on. */
export interface IPolicyInput {
  /** The action type, such as `execute`. */
  type: string;

  /** The directive's options, which can change the capability needed. */
  options?: Record<string, string>;

  level: TrustLevel;

  /** Whether the action runs without a click (auto-run or cascade). */
  automatic: boolean;

  /** Capability names the manifest declares. */
  declared: readonly string[];

  /** Capabilities the learner has allowed for the workshop under `ask`. */
  allowed?: readonly string[];

  /** Capabilities an administrator has disabled. */
  disabled?: readonly string[];
}

/**
 * Whether the declared capability names include a capability.
 */
export function isDeclared(
  capability: Capability,
  declared: readonly string[]
): boolean {
  return declared.some(
    item => item === capability || item.startsWith(`${capability}:`)
  );
}

/** Actions that the restricted level degrades to typing into the terminal. */
const TYPE_ONLY: Readonly<Record<string, string>> = {
  execute: 'terminal-type'
};

/** Actions that are harmless enough to run in restricted mode despite their capability. */
const RESTRICTED_RUNS: ReadonlySet<string> = new Set([
  'terminal-open',
  'terminal-clear',
  'terminal-type',
  'interrupt',
  'kernel-interrupt'
]);

/**
 * Decide what to do with an action under a trust level.
 */
export function decideAction(input: IPolicyInput): ActionDisposition {
  const capability = effectiveCapability(input.type, input.options ?? {});

  // Unknown types fall through to the registry, which reports them.
  if (capability === null) {
    return { kind: 'run' };
  }

  if (capability !== 'none') {
    if (!isDeclared(capability, input.declared)) {
      return {
        kind: 'reject',
        reason: `The workshop does not declare the "${capability}" capability`
      };
    }

    if (input.disabled?.includes(capability)) {
      return {
        kind: 'skip',
        reason: `The "${capability}" capability is disabled by policy`
      };
    }
  }

  if (input.automatic) {
    if (!isDeclared('auto-run', input.declared)) {
      return {
        kind: 'reject',
        reason: 'The workshop does not declare the "auto-run" capability'
      };
    }

    if (input.disabled?.includes('auto-run')) {
      return {
        kind: 'skip',
        reason: 'Automatic runs are disabled by policy'
      };
    }
  }

  switch (input.level) {
    case 'trusted':
      return { kind: 'run' };

    case 'restricted':
      return decideRestricted(input.type, capability, input.automatic);

    case 'ask':
      return decideAsk(capability, input.allowed ?? []);
  }
}

function decideRestricted(
  type: string,
  capability: Capability,
  automatic: boolean
): ActionDisposition {
  if (automatic) {
    return {
      kind: 'skip',
      reason: 'Automatic runs are off while the workshop is restricted'
    };
  }

  if (capability === 'none' || RESTRICTED_RUNS.has(type)) {
    return { kind: 'run' };
  }

  // Checks run over and over on their triggers, so asking each time would
  // be a nuisance; they simply do not run until the workshop is trusted.
  if (type === 'verify') {
    return {
      kind: 'skip',
      reason: 'Checks that run code are off while the workshop is restricted'
    };
  }

  const downgrade = TYPE_ONLY[type];

  if (downgrade) {
    return {
      kind: 'downgrade',
      type: downgrade,
      reason: 'Typed into the terminal without running; press Enter to run it'
    };
  }

  return {
    kind: 'confirm',
    reason: `Needs confirmation while the workshop is restricted (${capability})`
  };
}

function decideAsk(
  capability: Capability,
  allowed: readonly string[]
): ActionDisposition {
  if (capability === 'none' || allowed.includes(capability)) {
    return { kind: 'run' };
  }

  return {
    kind: 'confirm',
    reason: `Asks before using the "${capability}" capability`
  };
}
