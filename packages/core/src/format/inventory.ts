/**
 * The inventory of a page's directives, as the page list on a start or
 * resume event carries it: every directive that can produce an event,
 * in document order, with how it is expected to start and whether a
 * condition decides if the learner sees it. A service compares it with
 * the events that name each id and reports what nobody ran.
 */

import { STRUCTURE_DIRECTIVES } from '../actions/catalog';
import { parseTriggers } from '../checks/verify';
import { IDirectiveNode, IPage, PageNode } from './page';

/** How a directive is expected to start, in the words the events use. */
export type DirectiveTrigger = 'click' | 'auto' | 'cascade' | 'trigger';

/** One directive of a page as the page list carries it. */
export interface IDirectiveEntry {
  /** The directive id, as every event about the directive reports it. */
  id: string;

  /** The directive name: an action type, or verify, quiz, form or hint. */
  type: string;

  /** How the directive is expected to start. */
  trigger: DirectiveTrigger;

  /** Set when a `when` block or option decides whether it is shown. */
  conditional?: true;
}

interface IFound {
  node: IDirectiveNode;
  conditional: boolean;
}

/**
 * The inventory of a page: its directives with ids, in document order,
 * `when` blocks included. `defaults` are the manifest's `defaults.actions`,
 * applied under each directive's own options as the panel applies them.
 * A directive is `auto` when it carries the `auto` option, `cascade` when
 * another directive's `cascade` names it or falls through to it, `trigger`
 * when its `trigger` option lists anything beyond a click, and `click`
 * otherwise, the first of those winning where more than one applies.
 */
export function pageInventory(
  page: IPage,
  defaults: Record<string, string> = {}
): IDirectiveEntry[] {
  // Every directive with an id, and whether a condition stands between
  // it and the learner.
  const found: IFound[] = [];

  const walk = (nodes: PageNode[], inside: boolean): void => {
    for (const node of nodes) {
      if (node.kind === 'when') {
        walk(node.nodes, true);
      } else if (
        node.kind === 'directive' &&
        !STRUCTURE_DIRECTIVES.has(node.name)
      ) {
        found.push({
          node,
          conditional: inside || Boolean(node.options.when)
        });
      }
    }
  };

  walk(page.nodes, false);

  // The targets of cascades: `true` names the next directive on the
  // page, anything else names an id, optionally followed by a delay.
  const targets = new Set<string>();

  found.forEach(({ node }, index) => {
    const cascade = optionOf(node, defaults, 'cascade');

    if (!cascade || cascade === 'false') {
      return;
    }

    if (cascade === 'true') {
      const next = found[index + 1];

      if (next) {
        targets.add(next.node.id);
      }

      return;
    }

    const link = /^(\S+)(?:\s+after\s+\S+)?$/.exec(cascade.trim());

    if (link) {
      targets.add(link[1]);
    }
  });

  return found.map(({ node, conditional }) => {
    const entry: IDirectiveEntry = {
      id: node.id,
      type: node.name,
      trigger: triggerOf(node, defaults, targets)
    };

    if (conditional) {
      entry.conditional = true;
    }

    return entry;
  });
}

function optionOf(
  node: IDirectiveNode,
  defaults: Record<string, string>,
  name: string
): string | undefined {
  const value = node.options[name] ?? defaults[name];

  return value === undefined || value === '' ? undefined : value;
}

function triggerOf(
  node: IDirectiveNode,
  defaults: Record<string, string>,
  targets: ReadonlySet<string>
): DirectiveTrigger {
  const auto = optionOf(node, defaults, 'auto');

  if (auto && auto !== 'false') {
    return 'auto';
  }

  if (targets.has(node.id)) {
    return 'cascade';
  }

  const trigger = optionOf(node, defaults, 'trigger');

  if (
    trigger &&
    parseTriggers(trigger).triggers.some(item => item.kind !== 'click')
  ) {
    return 'trigger';
  }

  return 'click';
}
