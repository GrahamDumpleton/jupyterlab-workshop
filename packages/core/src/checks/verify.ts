/**
 * The `verify` directive: how a check is triggered and where it runs.
 */

/** Where a verify runs. */
export type VerifySubstrate =
  'kernel' | 'script' | 'shell' | 'contents' | 'ui' | 'learner-kernel';

/** Substrates in the order the documentation lists them. */
export const VERIFY_SUBSTRATES: readonly VerifySubstrate[] = [
  'kernel',
  'script',
  'shell',
  'contents',
  'ui',
  'learner-kernel'
];

/** Substrates that run code and therefore need the kernel capability. */
export const CODE_SUBSTRATES: readonly VerifySubstrate[] = [
  'kernel',
  'script',
  'shell',
  'learner-kernel'
];

/** An event that makes a verify run again. */
export type VerifyTrigger =
  | { kind: 'click' }
  | { kind: 'page-enter' }
  | { kind: 'action'; id?: string }
  | { kind: 'terminal-output'; pattern: string; regex: boolean }
  | { kind: 'file-saved'; path: string }
  | { kind: 'cell-executed'; tag: string }
  | { kind: 'interval'; ms: number };

/** The parsed triggers of a verify with any problems found. */
export interface IParsedTriggers {
  triggers: VerifyTrigger[];
  errors: string[];
}

/**
 * Parse a `:trigger:` option. Several triggers are separated by
 * semicolons; a click always works whether listed or not.
 */
export function parseTriggers(spec: string | undefined): IParsedTriggers {
  const triggers: VerifyTrigger[] = [];
  const errors: string[] = [];

  for (const raw of (spec ?? '').split(';')) {
    const text = raw.trim();

    if (text === '') {
      continue;
    }

    const trigger = parseTrigger(text);

    if (typeof trigger === 'string') {
      errors.push(trigger);
    } else {
      triggers.push(trigger);
    }
  }

  return { triggers, errors };
}

function parseTrigger(text: string): VerifyTrigger | string {
  const [head, ...rest] = text.split(/\s+/);
  const tail = text.slice(head.length).trim();

  switch (head) {
    case 'click':
      return { kind: 'click' };

    case 'page-enter':
      return { kind: 'page-enter' };

    case 'action':
      return { kind: 'action' };

    case 'terminal-output': {
      const pattern = unquote(tail);

      if (!pattern) {
        return 'terminal-output needs the text to wait for';
      }

      return { kind: 'terminal-output', ...pattern };
    }

    case 'file-saved':
      return rest.length > 0
        ? { kind: 'file-saved', path: tail }
        : 'file-saved needs a path';

    case 'cell-executed':
      return rest.length > 0
        ? { kind: 'cell-executed', tag: tail }
        : 'cell-executed needs a cell tag';

    case 'interval': {
      const ms = parseSeconds(tail);

      return ms === null || ms < 1000
        ? 'interval needs a duration of at least 1s'
        : { kind: 'interval', ms };
    }

    default:
      if (head.startsWith('after:') && head.length > 'after:'.length) {
        return { kind: 'action', id: head.slice('after:'.length) };
      }

      return `Unknown trigger "${head}"`;
  }
}

function unquote(text: string): { pattern: string; regex: boolean } | null {
  if (text === '') {
    return null;
  }

  if (text.length >= 2 && text.startsWith('/') && text.endsWith('/')) {
    return { pattern: text.slice(1, -1), regex: true };
  }

  const quoted = /^(["'])(.*)\1$/.exec(text);

  return { pattern: quoted ? quoted[2] : text, regex: false };
}

/**
 * Parse `5s`, `500ms` or a bare number of seconds into milliseconds.
 */
export function parseSeconds(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(text.trim());

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);

  switch (match[2]) {
    case 'ms':
      return amount;
    case 'm':
      return amount * 60000;
    default:
      return amount * 1000;
  }
}

/** A predicate checked by the `contents` and `ui` substrates. */
export interface IPredicate {
  name: string;
  args: string[];
}

/** Predicates the `contents` substrate understands, with argument counts. */
export const CONTENTS_PREDICATES: Readonly<Record<string, number>> = {
  exists: 1,
  missing: 1,
  contains: 2,
  matches: 2,
  'cell-executed': 2
};

/** Predicates the `ui` substrate understands, with argument counts. */
export const UI_PREDICATES: Readonly<Record<string, number>> = {
  'terminal-open': 1,
  'file-open': 1,
  'notebook-open': 1,
  'panel-open': 1,
  'kernel-idle': 1
};

/** Parsed predicates with any problems found. */
export interface IParsedPredicates {
  predicates: IPredicate[];
  errors: string[];
}

/**
 * Parse the body of a `contents` or `ui` verify: one predicate per line,
 * the name first, then its arguments, the last of which takes the rest
 * of the line so paths and text may contain spaces.
 */
export function parsePredicates(
  body: string,
  known: Readonly<Record<string, number>>
): IParsedPredicates {
  const predicates: IPredicate[] = [];
  const errors: string[] = [];

  for (const raw of body.split('\n')) {
    const line = raw.trim();

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const parts = line.split(/\s+/);
    const name = parts[0];
    const count = known[name];

    if (count === undefined) {
      errors.push(`Unknown predicate "${name}"`);

      continue;
    }

    if (parts.length - 1 < count) {
      errors.push(`Predicate "${name}" needs ${count} arguments`);

      continue;
    }

    // All but the last argument are single words.
    const args = parts.slice(1, count);
    const rest = parts.slice(count).join(' ');

    args.push(rest);
    predicates.push({ name, args });
  }

  if (predicates.length === 0 && errors.length === 0) {
    errors.push('No predicates given');
  }

  return { predicates, errors };
}

/**
 * The substrate of a verify from its options, defaulting to `kernel`, or
 * to `script` when a script is named.
 */
export function verifySubstrate(
  options: Record<string, string>
): VerifySubstrate | null {
  const value = options.substrate ?? (options.script ? 'script' : 'kernel');

  return (VERIFY_SUBSTRATES as string[]).includes(value)
    ? (value as VerifySubstrate)
    : null;
}
