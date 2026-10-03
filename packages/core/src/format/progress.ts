/**
 * How far the learner has got, as the list variables conditions read.
 *
 * A condition cannot call anything, so progress reaches it the way the
 * missing tools do: as lists of names it can test with `in`. The lists
 * are worked out here from what each directive last did, free of
 * JupyterLab, so the panel, the self-test and lint agree on which list a
 * directive can appear in.
 */

import { Variables } from '../variables/substitute';
import { IDirectiveNode } from './page';

/** The directives whose result is a pass or a failure. */
const CHECK_DIRECTIVES: ReadonlySet<string> = new Set(['verify', 'quiz']);

/** What a directive last did, as far as progress is concerned. */
export type ProgressStatus = 'ok' | 'error' | string;

/**
 * The progress list a directive of the given type can appear in, apart
 * from `failed_checks`, which holds the same directives as
 * `passed_checks`.
 */
export function progressList(
  type: string
): 'passed_checks' | 'opened_hints' | 'done_actions' {
  if (CHECK_DIRECTIVES.has(type)) {
    return 'passed_checks';
  }

  return type === 'hint' ? 'opened_hints' : 'done_actions';
}

/**
 * The progress variables for a set of directives: `passed_checks` and
 * `failed_checks` hold the checks and quizzes whose last result was a
 * pass or a failure, `opened_hints` the hints in `opened`, and
 * `done_actions` the other directives whose last run succeeded. Each is
 * a comma-separated list of ids, empty when nothing qualifies.
 *
 * `status` gives the last recorded result of a directive, not one still
 * running, so a check being run again stays in the list its last result
 * put it in until the new result is known.
 */
export function progressVariables(
  directives: Iterable<IDirectiveNode>,
  status: (id: string) => ProgressStatus | undefined,
  opened: Iterable<string>
): Variables {
  const lists: Record<string, string[]> = {
    passed_checks: [],
    failed_checks: [],
    opened_hints: [],
    done_actions: []
  };
  const openedIds = new Set(opened);

  for (const node of directives) {
    const list = progressList(node.name);

    if (list === 'opened_hints') {
      if (openedIds.has(node.id)) {
        lists.opened_hints.push(node.id);
      }

      continue;
    }

    const last = status(node.id);

    if (last === 'ok') {
      lists[list].push(node.id);
    } else if (last === 'error' && list === 'passed_checks') {
      lists.failed_checks.push(node.id);
    }
  }

  return Object.fromEntries(
    Object.entries(lists).map(([name, ids]) => [name, ids.join(',')])
  );
}
