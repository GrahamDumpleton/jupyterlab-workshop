import {
  IDirectiveNode,
  IPage,
  PageNode,
  Variables,
  evaluateExpression
} from '@jupyterlab-workshop/core';

/** Milliseconds in each unit a duration may name. */
const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000
};

/**
 * Parse a duration such as `1500ms`, `2s`, `5m`, `1h` or `3` (seconds)
 * into milliseconds.
 */
export function parseDuration(
  value: string | undefined,
  fallbackMs: number
): number {
  if (value === undefined || value.trim() === '') {
    return fallbackMs;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(value.trim());

  if (!match) {
    return fallbackMs;
  }

  return Number(match[1]) * DURATION_UNITS[match[2] ?? 's'];
}

/**
 * Evaluate a `when` condition, treating malformed expressions as false.
 */
export function conditionHolds(
  condition: string | undefined,
  variables: Variables
): boolean {
  if (condition === undefined || condition.trim() === '') {
    return true;
  }

  try {
    return evaluateExpression(condition, variables).value;
  } catch (error) {
    console.warn(`Invalid condition "${condition}"`, error);

    return false;
  }
}

/**
 * The directives of a page that are shown given the variables, in
 * document order, descending into `when` blocks whose condition holds.
 */
export function visibleDirectives(
  page: IPage,
  variables: Variables
): IDirectiveNode[] {
  const directives: IDirectiveNode[] = [];

  const walk = (nodes: PageNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'directive') {
        if (conditionHolds(node.options.when, variables)) {
          directives.push(node);
        }
      } else if (
        node.kind === 'when' &&
        conditionHolds(node.condition, variables)
      ) {
        walk(node.nodes);
      }
    }
  };

  walk(page.nodes);

  return directives;
}

/**
 * Wait for a number of milliseconds, resolving early to false if aborted.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);

    const onAbort = (): void => {
      window.clearTimeout(timer);
      resolve(false);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
