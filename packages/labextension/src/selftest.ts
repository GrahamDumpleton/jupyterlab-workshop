import {
  IDirectiveNode,
  parseForm,
  parseQuiz
} from '@jupyterlab-workshop/core';

import { IActionResult, IWorkshopManager } from './tokens';
import { visibleDirectives } from './util';

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
  /** Longest one action may take before the run stops, in milliseconds. */
  actionTimeoutMs?: number;
  /** Called after every action, and when an action starts. */
  onProgress?: (progress: ISelfTestProgress) => void;
}

/** Default per-action limit: long enough for an environment to be created. */
export const DEFAULT_ACTION_TIMEOUT_MS = 300000;

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

  while (index < manager.visiblePages.length) {
    manager.goTo(index, true);

    const pageId = manager.currentPage?.id;

    if (!pageId) {
      break;
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
  const limit = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

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

/**
 * Run one directive as the self-test does, or, for a verify that a trigger
 * has already started, wait for that run instead of starting a second.
 *
 * A verify with `after:<action>` is fired by the trigger bus the moment
 * the action before it completes, so by the time the self-test reaches it
 * the check is usually already running, and settling. Taking that run's
 * outcome is what the learner sees, and it keeps two runs of the same
 * check from racing each other. A verify whose trigger has not fired is
 * run with the settle time a trigger would give it, while a verify with
 * no trigger gets the single attempt a click gives it.
 */
function runStep(
  manager: IWorkshopManager,
  node: IDirectiveNode
): Promise<IActionResult> {
  const triggered = node.name === 'verify' && Boolean(node.options.trigger);

  if (triggered && manager.actionStatus(node.id).status === 'running') {
    return outcomeOf(manager, node.id);
  }

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
