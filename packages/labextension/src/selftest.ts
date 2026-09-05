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
  manager: IWorkshopManager
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

    results.push(...(await runCurrentPage(manager, 'all')));
    manager.markDone(pageId, true);
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
  filter: RunFilter
): Promise<ISelfTestResult[]> {
  const pageId = manager.currentPage?.id;
  const results: ISelfTestResult[] = [];

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
    const result = await manager.runAction(
      prepared(node),
      'click',
      argumentFor(node, manager)
    );

    results.push({
      page: pageId,
      id: node.id,
      type: node.name,
      status: result.status,
      message: result.message ?? '',
      seconds: (Date.now() - started) / 1000
    });
  }

  return results;
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
