import {
  IDirectiveNode,
  parseForm,
  parseQuiz
} from '@jupyterlab-workshop/core';
import { ReadonlyPartialJSONObject } from '@lumino/coreutils';

import { IOpeningLayout } from './layout';
import { IActionResult, IWorkshopManager } from './tokens';
import { parseDuration, sleep, visibleDirectives } from './util';

/** Actions that wait for a person and so are skipped by the self-test. */
const INTERACTIVE: ReadonlySet<string> = new Set([
  'dialog',
  'upload-prompt',
  'tour'
]);

/** The outcome of one action during a self-test run. */
export interface ISelfTestResult {
  page: string;
  id: string;
  type: string;
  status: IActionResult['status'];
  message: string;
  seconds: number;
  /** Set when the action was still running at the per-action limit. */
  timedOut?: boolean;
}

/** The action a self-test is currently running. */
export interface ISelfTestCurrent {
  page: string;
  id: string;
  type: string;
  startedAt: number;
}

/** How far a self-test run has got, for a harness that polls from outside. */
export interface ISelfTestProgress {
  results: ISelfTestResult[];
  current: ISelfTestCurrent | null;
}

/** Options for a self-test run. */
export interface ISelfTestOptions {
  /**
   * Longest one action may take before the run stops, in milliseconds.
   * An action whose directive names a longer `timeout` of its own is
   * given that instead, plus a margin, so a workshop that waits on a
   * build or a rollout is not cut short by the flat limit.
   */
  actionTimeoutMs?: number;
  /** Pause before the first action, in milliseconds. */
  startDelayMs?: number;
  /** Pause before each action, once it is scrolled into view. */
  stepDelayMs?: number;
  /** Pause after moving to a new page, before its first action. */
  pageDelayMs?: number;
  /** Called after every action, and when an action starts. */
  onProgress?: (progress: ISelfTestProgress) => void;

  /**
   * What the layout applied as the workshop opened left out, for the
   * report to say: a widget it names that could not be opened.
   */
  openingLayout?: () => Promise<IOpeningLayout | null>;
}

/** Page name of results that belong to the workshop rather than a page. */
export const WORKSHOP_RESULTS_PAGE = '(workshop)';

/** Default per-action limit: long enough for an environment to be created. */
export const DEFAULT_ACTION_TIMEOUT_MS = 300000;

/**
 * Added to a directive's own `timeout` when it is longer than the flat
 * limit: the action's own wait, plus the time a verify spends settling
 * and the terminal takes to report the prompt back.
 */
export const ACTION_TIMEOUT_MARGIN_MS = 30000;

/**
 * Read the pacing and limit a run command was given: `actionTimeout`,
 * `startDelay`, `stepDelay` and `pageDelay`, each in seconds. A value
 * that is missing, not a number or not positive leaves the default.
 */
export function pacingFrom(args: ReadonlyPartialJSONObject): ISelfTestOptions {
  const seconds = (name: string): number | undefined => {
    const value = args[name];

    return typeof value === 'number' && value > 0 ? value * 1000 : undefined;
  };

  return {
    actionTimeoutMs: seconds('actionTimeout'),
    startDelayMs: seconds('startDelay'),
    stepDelayMs: seconds('stepDelay'),
    pageDelayMs: seconds('pageDelay')
  };
}

/** What a self-test run produced. */
export interface ISelfTestReport {
  workshop: string;
  results: ISelfTestResult[];
  passed: number;
  failed: number;
  skipped: number;
}

/** Which directives of a page to run. */
export type RunFilter = 'all' | 'actions' | 'checks';

/** Directives that are checks rather than steps. */
const CHECKS: ReadonlySet<string> = new Set(['verify', 'quiz', 'form']);

/**
 * Run every action of every visible page in order, answering quizzes
 * correctly and submitting form defaults, and report what happened. Used
 * by `jupyter workshop test` through the `workshop:run-all` command.
 */
export async function runAll(
  manager: IWorkshopManager,
  options: ISelfTestOptions = {}
): Promise<ISelfTestReport> {
  const workshop = manager.workshop;

  if (!workshop) {
    throw new Error('No workshop is open');
  }

  const results: ISelfTestResult[] = [];
  let index = 0;

  // The layout the workshop opens with is applied before any page runs,
  // so a widget it could not open is reported by nothing else. It is a
  // note rather than a failure: the file may be one a page creates, and
  // the run says so either way, where a typo would otherwise stay unseen.
  const opening = await options.openingLayout?.();

  if (opening && opening.missing.length > 0) {
    results.push({
      page: WORKSHOP_RESULTS_PAGE,
      id: 'layout',
      type: 'layout',
      status: 'skipped',
      message: `The opening layout "${opening.name}" left out ${opening.missing.join(', ')}: nothing was there to open when the workshop opened`,
      seconds: 0
    });
  }

  // A paced run gives the audience a moment to see the panel before
  // anything happens, and then a moment on each new page before its
  // first action fires.
  if ((options.startDelayMs ?? 0) > 0) {
    await sleep(options.startDelayMs ?? 0);
  }

  while (index < manager.visiblePages.length) {
    manager.goTo(index, true);

    const pageId = manager.currentPage?.id;

    if (!pageId) {
      break;
    }

    if (index > 0 && (options.pageDelayMs ?? 0) > 0) {
      await sleep(options.pageDelayMs ?? 0);
    }

    const pageResults = await runCurrentPage(manager, 'all', {
      ...options,
      onProgress: progress =>
        options.onProgress?.({
          results: [...results, ...progress.results],
          current: progress.current
        })
    });

    results.push(...pageResults);

    // An action that never finished leaves the session in an unknown
    // state, so the run stops there rather than reporting noise after it.
    if (pageResults.some(item => item.timedOut)) {
      break;
    }

    // Moving on marks the page done; the last page is finished instead.
    if (index === manager.visiblePages.length - 1) {
      manager.finish();
    }

    index += 1;
  }

  return summarize(workshop.path, results);
}

/**
 * Run the directives of the current page in order: every one, only the
 * steps, or only the checks. Used by author mode and the bridge.
 */
export async function runCurrentPage(
  manager: IWorkshopManager,
  filter: RunFilter,
  options: ISelfTestOptions = {}
): Promise<ISelfTestResult[]> {
  const pageId = manager.currentPage?.id;
  const results: ISelfTestResult[] = [];
  const flatLimit = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const defaults = manager.workshop?.manifest.defaults ?? {};

  if (!pageId) {
    return results;
  }

  // Actions can set variables, which re-renders the pages, so fetch the
  // current page again before each step and continue from the next id.
  const done = new Set<string>();

  for (;;) {
    const page = manager.currentPage;

    if (!page || page.id !== pageId) {
      break;
    }

    const node = visibleDirectives(page, manager.variables.values).find(
      item => !done.has(item.id)
    );

    if (!node) {
      break;
    }

    done.add(node.id);

    const isCheck = CHECKS.has(node.name);

    if (
      node.name === 'hint' ||
      (filter === 'actions' && isCheck) ||
      (filter === 'checks' && !isCheck)
    ) {
      continue;
    }

    if (INTERACTIVE.has(node.name)) {
      results.push({
        page: pageId,
        id: node.id,
        type: node.name,
        status: 'skipped',
        message: 'Needs a person; skipped by the self-test',
        seconds: 0
      });

      continue;
    }

    const limit = limitFor(node, defaults, flatLimit);

    // An action the page runs on its own (on entering it, by a cascade,
    // or after another action) is what the learner sees once, so a
    // chain in progress is left to finish and the run it made of this
    // directive is recorded rather than repeated. A run still going,
    // such as a triggered verify settling, is waited for instead.
    await settleChain(manager, limit);

    const automatic = await outcomeSoFar(manager, node.id);

    if (automatic) {
      results.push({
        page: pageId,
        id: node.id,
        type: node.name,
        ...automatic
      });

      options.onProgress?.({ results: [...results], current: null });

      continue;
    }

    // A paced run scrolls the directive into view and pulses it before
    // pausing, so whoever is watching sees what is about to happen. The
    // pause is not charged against the action's own limit.
    if ((options.stepDelayMs ?? 0) > 0) {
      manager.focusAction(node.id);
      await sleep(options.stepDelayMs ?? 0);
    }

    const started = Date.now();

    options.onProgress?.({
      results: [...results],
      current: {
        page: pageId,
        id: node.id,
        type: node.name,
        startedAt: started
      }
    });

    const result = await withLimit(runStep(manager, node), limit);

    if (result === null || 'dialog' in result) {
      results.push({
        page: pageId,
        id: node.id,
        type: node.name,
        status: 'error',
        message:
          result === null
            ? `Still running after ${Math.round(limit / 1000)}s; the self-test stopped here`
            : `Blocked by a dialog nobody can answer: "${result.dialog}"; the self-test stopped here`,
        seconds: (Date.now() - started) / 1000,
        timedOut: true
      });

      options.onProgress?.({ results: [...results], current: null });

      break;
    }

    results.push({
      page: pageId,
      id: node.id,
      type: node.name,
      status: result.status,
      message: result.message ?? '',
      seconds: (Date.now() - started) / 1000
    });

    options.onProgress?.({ results: [...results], current: null });
  }

  return results;
}

/** How often a chain in progress is looked at while waiting for it. */
const CHAIN_POLL_MS = 100;

/**
 * Wait for a cascade or automatic run in progress to finish, up to the
 * limit: clicking while it is pending would cancel it, and the learner
 * would have seen it through.
 */
async function settleChain(
  manager: IWorkshopManager,
  limitMs: number
): Promise<void> {
  const deadline = Date.now() + limitMs;

  while (manager.chainRunning && Date.now() < deadline) {
    await sleep(CHAIN_POLL_MS);
  }
}

/**
 * The outcome of a run the page made of a directive on its own since it
 * was entered, or that is still going, in which case it is waited for;
 * null when the self-test has to run the directive itself.
 */
async function outcomeSoFar(
  manager: IWorkshopManager,
  id: string
): Promise<Pick<ISelfTestResult, 'status' | 'message' | 'seconds'> | null> {
  const status = manager.actionStatus(id);

  if (status.status === 'running') {
    const started = Date.now();
    const result = await outcomeOf(manager, id);

    return {
      status: result.status,
      message: result.message ?? '',
      seconds: (Date.now() - started) / 1000
    };
  }

  if (!manager.ranOnItsOwn.has(id) || status.status === 'idle') {
    return null;
  }

  return {
    status: status.status,
    message: status.message || 'Ran on its own',
    seconds: 0
  };
}

/**
 * Run one directive as the self-test does. A verify with a trigger is
 * run with the settle time the trigger would give it, since the trigger
 * may not have fired under test; a verify with no trigger gets the
 * single attempt a click gives it.
 */
function runStep(
  manager: IWorkshopManager,
  node: IDirectiveNode
): Promise<IActionResult> {
  const triggered = node.name === 'verify' && Boolean(node.options.trigger);

  return manager.runAction(
    prepared(node),
    'click',
    argumentFor(node, manager),
    {
      settle: triggered
    }
  );
}

/**
 * Resolve with a running action's outcome once it stops running.
 */
function outcomeOf(
  manager: IWorkshopManager,
  id: string
): Promise<IActionResult> {
  return new Promise(resolve => {
    const onChanged = (_: IWorkshopManager, changed: string): void => {
      if (changed !== id) {
        return;
      }

      const status = manager.actionStatus(id);

      if (status.status === 'running') {
        return;
      }

      manager.actionChanged.disconnect(onChanged);

      resolve(
        status.status === 'idle'
          ? { status: 'error', message: 'No outcome was recorded for the run' }
          : { status: status.status, message: status.message }
      );
    };

    manager.actionChanged.connect(onChanged);
  });
}

/**
 * The limit for one action: the flat limit, unless the directive (or the
 * manifest's action defaults) names a longer `timeout` of its own, in
 * which case that plus a margin. Only the action types that wait on a
 * command or a script read `timeout`, so it is consulted for those alone.
 */
function limitFor(
  node: IDirectiveNode,
  defaults: Readonly<Record<string, string>>,
  flatLimitMs: number
): number {
  if (!TIMED.has(node.name)) {
    return flatLimitMs;
  }

  const own = parseDuration(node.options.timeout ?? defaults.timeout, 0);

  return own > 0
    ? Math.max(flatLimitMs, own + ACTION_TIMEOUT_MARGIN_MS)
    : flatLimitMs;
}

/** Directives whose `timeout` option bounds how long they run. */
const TIMED: ReadonlySet<string> = new Set([
  'execute',
  'execute-capture',
  'verify'
]);

/** How long a dialog may stay open under a running action. */
const DIALOG_GRACE_MS = 10000;

/** An action that stopped at a dialog, named by the dialog's title. */
interface IBlockedByDialog {
  dialog: string;
}

/**
 * Wait for an action, giving up with `null` after the limit, or with
 * the dialog's title when a dialog has been open for a while under it:
 * headless, nothing will ever answer a kernel selection or a
 * confirmation, and naming it beats waiting out the limit.
 */
async function withLimit(
  action: Promise<IActionResult>,
  limitMs: number
): Promise<IActionResult | IBlockedByDialog | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  const expired = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), limitMs);
  });
  const blocked = new Promise<IBlockedByDialog>(resolve => {
    let since: number | null = null;

    poll = setInterval(() => {
      const dialog = document.querySelector('.jp-Dialog');

      if (!dialog) {
        since = null;

        return;
      }

      since = since ?? Date.now();

      if (Date.now() - since >= DIALOG_GRACE_MS) {
        const title = dialog.querySelector('.jp-Dialog-header')?.textContent;

        resolve({ dialog: title?.trim() || 'untitled dialog' });
      }
    }, 1000);
  });

  try {
    return await Promise.race([action, expired, blocked]);
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
  }
}

/**
 * Count the outcomes of a run into a report.
 */
export function summarize(
  workshop: string,
  results: ISelfTestResult[]
): ISelfTestReport {
  return {
    workshop,
    results,
    passed: results.filter(item => item.status === 'ok').length,
    failed: results.filter(item => item.status === 'error').length,
    skipped: results.filter(item => item.status === 'skipped').length
  };
}

function prepared(node: IDirectiveNode): IDirectiveNode {
  // Commands must finish before the next action or check runs.
  if (node.name === 'execute' && !node.options.wait) {
    return { ...node, options: { ...node.options, wait: 'prompt' } };
  }

  return node;
}

function argumentFor(
  node: IDirectiveNode,
  manager: IWorkshopManager
): string | undefined {
  switch (node.name) {
    case 'quiz': {
      const parsed = parseQuiz(node.body, node.options);
      const correct = (parsed.quiz?.options ?? [])
        .map((option, position) => (option.correct ? position : -1))
        .filter(position => position >= 0);

      return JSON.stringify(correct);
    }

    case 'form': {
      const parsed = parseForm(node.body);
      const values: Record<string, string> = {};

      for (const field of parsed.form?.fields ?? []) {
        values[field.name] =
          manager.variables.get(field.name) ??
          field.default ??
          field.options[0] ??
          '';
      }

      return JSON.stringify(values);
    }

    case 'choice': {
      const manifest = manager.workshop?.manifest;
      const listed = (node.options.options ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(item => item !== '');

      if (listed.length > 0) {
        return listed[0];
      }

      if (node.options.track === 'true' && manifest?.tracks[0]) {
        return manifest.tracks[0].id;
      }

      const variable = node.options.variable ?? '';
      const definition = manifest?.variables.find(
        item => item.name === variable
      );

      return definition?.options[0] ?? node.argument;
    }

    default:
      return undefined;
  }
}
