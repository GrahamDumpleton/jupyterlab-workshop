import {
  CONTENTS_PREDICATES,
  IPredicate,
  UI_PREDICATES,
  environmentVariables,
  gradeQuiz,
  parseForm,
  parsePredicates,
  parseQuiz,
  validateForm,
  verifySubstrate
} from '@jupyterlab-workshop/core';
import { JupyterFrontEnd } from '@jupyterlab/application';
import { ICodeCellModel } from '@jupyterlab/cells';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { NotebookPanel } from '@jupyterlab/notebook';

import {
  IActionImplementation,
  IActionRequest,
  IActionResult,
  IWorkshopManager
} from '../tokens';
import { parseDuration } from '../util';
import { getIfExists, readTextFile } from './contents';
import { WorkshopKernel, executeInKernel } from './kernel';
import { INotebookActionContext, openNotebook } from './notebook';
import { IShellRunner } from './shell';
import { TerminalSessions } from './terminal';

/** Services the check actions need. */
export interface ICheckActionContext {
  app: JupyterFrontEnd;
  docManager: IDocumentManager;
  manager: IWorkshopManager;
  terminals: TerminalSessions;
  kernel: WorkshopKernel;
  notebooks: INotebookActionContext;

  /** Runs commands for the `shell` substrate. */
  shell: IShellRunner;
}

/**
 * The `verify` action: check learner progress on one of the substrates
 * and report pass (ok) or fail (error) with a message.
 */
export class VerifyAction implements IActionImplementation {
  readonly type = 'verify';

  constructor(context: ICheckActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return request.options.label ?? request.options.title ?? 'Check progress';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const substrate = verifySubstrate(request.options);

    switch (substrate) {
      case 'kernel':
        return this._kernel(request);
      case 'script':
        return this._script(request);
      case 'shell':
        return this._shell(request);
      case 'contents':
        return this._contents(request);
      case 'ui':
        return this._ui(request);
      case 'learner-kernel':
        return this._learnerKernel(request);
      default:
        return {
          status: 'error',
          message: `Unknown substrate "${request.options.substrate}"`
        };
    }
  }

  private async _kernel(request: IActionRequest): Promise<IActionResult> {
    if (request.body.trim() === '') {
      return { status: 'error', message: 'The check has no code' };
    }

    // Run inside the workshop directory with the variables in the
    // environment, so checks can use subprocess and os.environ freely.
    const manager = this._context.manager;
    const preamble = [
      'import os as _os',
      `_os.chdir(${JSON.stringify(manager.absolutePath())})`,
      `_os.environ.update(${JSON.stringify(
        environmentVariables(manager.variables.values)
      )})`
    ].join('\n');
    const output = await this._context.kernel.execute(
      `${preamble}\n${request.body}`
    );

    if (output.error) {
      return { status: 'error', message: failureMessage(output.error) };
    }

    return { status: 'ok', message: output.text.trim() };
  }

  private async _script(request: IActionRequest): Promise<IActionResult> {
    const manager = this._context.manager;
    const script = request.options.script;

    if (!script) {
      return { status: 'error', message: 'The check names no script' };
    }

    const result = await manager.backend.runScript({
      workshop: manager.workshop?.path ?? '',
      script,
      timeout: parseDuration(request.options.timeout, 60000) / 1000,
      environment: environmentVariables(manager.variables.values)
    });

    const text = `${result.stdout}${result.stderr}`.trim();

    return result.code === 0
      ? { status: 'ok', message: text }
      : { status: 'error', message: text || `Exit code ${result.code}` };
  }

  private async _shell(request: IActionRequest): Promise<IActionResult> {
    const command = request.body.trim();

    if (command === '') {
      return { status: 'error', message: 'The check has no command' };
    }

    // The command runs in the workshop directory; exit code 0 passes.
    const manager = this._context.manager;
    const result = await this._context.shell.run(
      command,
      manager.absolutePath(),
      parseDuration(request.options.timeout, 60000)
    );
    const text = result.output.trim();

    return result.code === 0
      ? { status: 'ok', message: text }
      : {
          status: 'error',
          message: (result.error || text).trim() || `Exit code ${result.code}`
        };
  }

  private async _contents(request: IActionRequest): Promise<IActionResult> {
    const parsed = parsePredicates(request.body, CONTENTS_PREDICATES);

    if (parsed.errors.length > 0) {
      return { status: 'error', message: parsed.errors.join('; ') };
    }

    for (const predicate of parsed.predicates) {
      const failure = await this._contentsPredicate(predicate);

      if (failure) {
        return { status: 'error', message: failure };
      }
    }

    return { status: 'ok' };
  }

  private async _contentsPredicate(
    predicate: IPredicate
  ): Promise<string | null> {
    const manager = this._context.manager;
    const contents = this._context.app.serviceManager.contents;
    const [first, second] = predicate.args;
    const path = manager.resolvePath(first);

    switch (predicate.name) {
      case 'exists':
        return (await getIfExists(contents, path, false))
          ? null
          : `${first} does not exist yet`;

      case 'missing':
        return (await getIfExists(contents, path, false))
          ? `${first} still exists`
          : null;

      case 'contains': {
        const text = await readIfText(contents, path);

        if (text === null) {
          return `${first} does not exist yet`;
        }

        return text.includes(second)
          ? null
          : `${first} does not contain "${second}"`;
      }

      case 'matches': {
        const text = await readIfText(contents, path);

        if (text === null) {
          return `${first} does not exist yet`;
        }

        return new RegExp(second, 'm').test(text)
          ? null
          : `${first} does not match ${second}`;
      }

      case 'cell-executed': {
        // An open notebook knows what has run even before it is saved.
        const widget = this._context.docManager.findWidget(path);

        if (widget instanceof NotebookPanel) {
          return openCellExecuted(widget, second)
            ? null
            : `Cell "${second}" of ${first} has not been run`;
        }

        const text = await readIfText(contents, path);

        if (text === null) {
          return `${first} does not exist yet`;
        }

        return cellExecuted(text, second)
          ? null
          : `Cell "${second}" of ${first} has not been run (checked the saved file)`;
      }

      default:
        return `Unknown predicate "${predicate.name}"`;
    }
  }

  private async _ui(request: IActionRequest): Promise<IActionResult> {
    const parsed = parsePredicates(request.body, UI_PREDICATES);

    if (parsed.errors.length > 0) {
      return { status: 'error', message: parsed.errors.join('; ') };
    }

    for (const predicate of parsed.predicates) {
      const failure = await this._uiPredicate(predicate);

      if (failure) {
        return { status: 'error', message: failure };
      }
    }

    return { status: 'ok' };
  }

  private async _uiPredicate(predicate: IPredicate): Promise<string | null> {
    const { manager, docManager, terminals, app } = this._context;
    const [argument] = predicate.args;

    switch (predicate.name) {
      case 'terminal-open':
        return terminals.has(argument)
          ? null
          : `Terminal "${argument}" is not open`;

      case 'file-open':
      case 'notebook-open': {
        const path = manager.resolvePath(argument);
        const open = docManager.findWidget(path) !== undefined;

        return open ? null : `${argument} is not open`;
      }

      case 'panel-open': {
        for (const area of ['left', 'right', 'main', 'bottom'] as const) {
          for (const widget of app.shell.widgets(area)) {
            if (widget.id === argument && widget.isVisible) {
              return null;
            }
          }
        }

        return `Panel "${argument}" is not showing`;
      }

      case 'kernel-idle': {
        const path = manager.resolvePath(argument);
        const widget = docManager.findWidget(path);

        if (!(widget instanceof NotebookPanel)) {
          return `${argument} is not open`;
        }

        const status = widget.sessionContext.session?.kernel?.status;

        return status === 'idle'
          ? null
          : `The kernel of ${argument} is ${status ?? 'not running'}`;
      }

      default:
        return `Unknown predicate "${predicate.name}"`;
    }
  }

  private async _learnerKernel(
    request: IActionRequest
  ): Promise<IActionResult> {
    const path = request.options.path;

    if (!path) {
      return { status: 'error', message: 'The check names no notebook' };
    }

    if (request.body.trim() === '') {
      return { status: 'error', message: 'The check has no code' };
    }

    const panel = await openNotebook(
      this._context.notebooks,
      this._context.manager.resolvePath(path)
    );

    await panel.sessionContext.ready;

    const kernel = panel.sessionContext.session?.kernel;

    if (!kernel) {
      return { status: 'error', message: 'The notebook has no kernel' };
    }

    const output = await executeInKernel(kernel, request.body, true);

    if (output.error) {
      return { status: 'error', message: failureMessage(output.error) };
    }

    // The last expression's value, or printed text, decides the result.
    const text = output.text.trim();
    const falsy = ['', 'False', 'None', '0', 'false'];

    return falsy.includes(text)
      ? {
          status: 'error',
          message: text ? `Got ${text}` : 'The check produced no result'
        }
      : { status: 'ok', message: text };
  }

  private _context: ICheckActionContext;
}

/**
 * The `quiz` action: grade the picked options, given as a JSON array of
 * indexes in the argument.
 */
export class QuizAction implements IActionImplementation {
  readonly type = 'quiz';

  describe(request: IActionRequest): string {
    return request.options.title ?? 'Answer the quiz';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const parsed = parseQuiz(request.body, request.options);

    if (!parsed.quiz) {
      return { status: 'error', message: parsed.errors.join('; ') };
    }

    let picked: number[];

    try {
      const value: unknown = JSON.parse(request.argument || '[]');

      picked = Array.isArray(value)
        ? value.filter((item): item is number => Number.isInteger(item))
        : [];
    } catch {
      picked = [];
    }

    if (picked.length === 0) {
      return { status: 'error', message: 'Pick an answer first' };
    }

    const quiz = parsed.quiz;

    if (gradeQuiz(quiz, picked)) {
      return { status: 'ok', message: quiz.explanation ?? 'Correct' };
    }

    // Explain the wrong picks when the author gave reasons.
    const reasons = picked
      .map(index => quiz.options[index])
      .filter(option => option && !option.correct && option.explanation)
      .map(option => option.explanation as string);

    return {
      status: 'error',
      message: reasons.length > 0 ? reasons.join(' ') : 'Not quite, try again'
    };
  }
}

/**
 * The `form` action: validate submitted values, given as a JSON object in
 * the argument, and store them as variables.
 */
export class FormAction implements IActionImplementation {
  readonly type = 'form';

  describe(request: IActionRequest): string {
    return request.options.title ?? request.options.label ?? 'Fill in the form';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const parsed = parseForm(request.body);

    if (!parsed.form) {
      return { status: 'error', message: parsed.errors.join('; ') };
    }

    let values: Record<string, string> = {};

    try {
      const value: unknown = JSON.parse(request.argument || '{}');

      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        for (const [name, item] of Object.entries(value)) {
          values[name] = String(item ?? '');
        }
      }
    } catch {
      values = {};
    }

    const problems = validateForm(parsed.form, values);
    const names = Object.keys(problems);

    if (names.length > 0) {
      return {
        status: 'error',
        message: names.map(name => `${name}: ${problems[name]}`).join('; ')
      };
    }

    const captured: Record<string, string> = {};

    for (const field of parsed.form.fields) {
      const value = (values[field.name] ?? field.default ?? '').trim();

      if (value !== '' || field.required) {
        captured[field.name] = value;
      }

      if (field.setTrack && value !== '') {
        captured.track = value;
      }
    }

    return { status: 'ok', captured, captureSource: 'form' };
  }
}

/**
 * The `checkpoint` action: snapshot the workshop under a name.
 */
export class CheckpointAction implements IActionImplementation {
  readonly type = 'checkpoint';

  constructor(manager: IWorkshopManager) {
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return `Save checkpoint "${checkpointName(request, this._manager)}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const name = checkpointName(request, this._manager);

    await this._manager.checkpoint(name);

    return { status: 'ok', message: `Saved checkpoint "${name}"` };
  }

  private _manager: IWorkshopManager;
}

/**
 * The `restore` action: put a checkpoint's files and variables back.
 */
export class RestoreAction implements IActionImplementation {
  readonly type = 'restore';

  constructor(manager: IWorkshopManager) {
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return `Restore checkpoint "${checkpointName(request, this._manager)}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const name = checkpointName(request, this._manager);

    await this._manager.restoreCheckpoint(name);

    return { status: 'ok', message: `Restored checkpoint "${name}"` };
  }

  private _manager: IWorkshopManager;
}

function checkpointName(
  request: IActionRequest,
  manager: IWorkshopManager
): string {
  return (
    request.options.name ||
    request.page ||
    manager.currentPage?.id ||
    'checkpoint'
  );
}

async function readIfText(
  contents: JupyterFrontEnd['serviceManager']['contents'],
  path: string
): Promise<string | null> {
  const model = await getIfExists(contents, path, false);

  if (!model || model.type === 'directory') {
    return null;
  }

  return readTextFile(contents, path);
}

function openCellExecuted(panel: NotebookPanel, reference: string): boolean {
  const cells = panel.content.widgets;
  const index = Number(reference);

  return cells.some((cell, position) => {
    const model = cell.model;
    const matches =
      Number.isInteger(index) && index >= 1
        ? position === index - 1
        : (() => {
            const tags = model.getMetadata('tags') as unknown;

            return Array.isArray(tags) && tags.includes(reference);
          })();

    if (!matches || model.type !== 'code') {
      return false;
    }

    return (model as ICodeCellModel).executionCount !== null;
  });
}

function cellExecuted(notebookJson: string, reference: string): boolean {
  let notebook: { cells?: unknown[] };

  try {
    notebook = JSON.parse(notebookJson) as { cells?: unknown[] };
  } catch {
    return false;
  }

  const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
  const index = Number(reference);

  const matches = (cell: unknown, position: number): boolean => {
    if (Number.isInteger(index) && index >= 1) {
      return position === index - 1;
    }

    const tags = (cell as { metadata?: { tags?: unknown } }).metadata?.tags;

    return Array.isArray(tags) && tags.includes(reference);
  };

  return cells.some((cell, position) => {
    const count = (cell as { execution_count?: unknown }).execution_count;

    return matches(cell, position) && typeof count === 'number';
  });
}

function failureMessage(error: string): string {
  // AssertionError messages are what authors write for learners; show the
  // message alone. Other errors keep their type.
  const match = /^AssertionError:\s*(.*)$/s.exec(error);

  return match && match[1].trim() ? match[1].trim() : error;
}
