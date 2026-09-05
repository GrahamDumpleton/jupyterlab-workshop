import { JupyterFrontEnd } from '@jupyterlab/application';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { Cell } from '@jupyterlab/cells';
import { NotebookActions, NotebookPanel } from '@jupyterlab/notebook';
import { load } from 'js-yaml';

import {
  IActionImplementation,
  IActionRequest,
  IActionResult,
  IWorkshopManager
} from '../tokens';
import { parseDuration } from '../util';
import { ensureDirectory } from './contents';
import { WorkshopKernel, executeInKernel } from './kernel';
import { requireBody, requireOption } from './registry';
import { TerminalSessions } from './terminal';

/** Widget factory name of the notebook editor. */
const NOTEBOOK_FACTORY = 'Notebook';

/** Services the notebook actions need. */
export interface INotebookActionContext {
  app: JupyterFrontEnd;
  docManager: IDocumentManager;
  manager: IWorkshopManager;
  terminals: TerminalSessions;
  kernel: WorkshopKernel;
}

interface ICellSpec {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string;
  metadata: { tags?: string[] };
}

/**
 * Open a notebook, placing it above the workshop terminal when it is new,
 * and wait until it is ready.
 */
export async function openNotebook(
  context: INotebookActionContext,
  serverPath: string,
  kernel?: string,
  split?: string
): Promise<NotebookPanel> {
  const existing = context.docManager.findWidget(serverPath, NOTEBOOK_FACTORY);
  const current = context.app.shell.currentWidget;
  const terminal = context.terminals.first;
  const options = existing
    ? undefined
    : (split === 'right' || split === 'bottom') && current
      ? { mode: `split-${split}` as const, ref: current.id }
      : terminal
        ? { mode: 'split-top' as const, ref: terminal.id }
        : undefined;

  const widget = context.docManager.openOrReveal(
    serverPath,
    NOTEBOOK_FACTORY,
    kernel ? { name: kernel } : undefined,
    options
  );

  if (!widget || !(widget instanceof NotebookPanel)) {
    throw new Error(`Unable to open ${serverPath} as a notebook`);
  }

  await widget.context.ready;
  await widget.revealed;

  return widget;
}

/**
 * Find a cell by one-based index or by tag.
 */
export function findCell(
  panel: NotebookPanel,
  reference: string
): { cell: Cell; index: number } {
  const cells = panel.content.widgets;
  const index = Number(reference);

  if (Number.isInteger(index) && index >= 1) {
    if (index > cells.length) {
      throw new Error(`The notebook has only ${cells.length} cells`);
    }

    return { cell: cells[index - 1], index: index - 1 };
  }

  for (let position = 0; position < cells.length; position += 1) {
    const tags = cells[position].model.getMetadata('tags') as unknown;

    if (Array.isArray(tags) && tags.includes(reference)) {
      return { cell: cells[position], index: position };
    }
  }

  throw new Error(`No cell has the tag "${reference}"`);
}

/**
 * The kernel new notebooks use: the workshop's environment once it is
 * ready, else the server's default kernel, if any.
 */
async function defaultKernel(
  context: INotebookActionContext
): Promise<string | undefined> {
  const specs = context.app.serviceManager.kernelspecs;

  await specs.ready;

  return context.manager.environmentKernel() ?? specs.specs?.default;
}

/**
 * Notebook kernelspec metadata for a kernel name, so that opening the
 * notebook does not prompt for a kernel.
 */
async function kernelspecMetadata(
  app: JupyterFrontEnd,
  name: string
): Promise<{ name: string; display_name: string; language: string }> {
  const specs = app.serviceManager.kernelspecs;

  await specs.ready;

  const spec = specs.specs?.kernelspecs[name];

  return {
    name,
    display_name: spec?.display_name ?? name,
    language: spec?.language ?? ''
  };
}

function notebookPath(
  context: INotebookActionContext,
  request: IActionRequest
): string {
  return context.manager.resolvePath(requireOption(request, 'path'));
}

function parseCells(body: string): ICellSpec[] {
  const data: unknown = load(body);

  if (!Array.isArray(data)) {
    throw new Error('The body must be a YAML list of cells');
  }

  return data.map((item: unknown, position: number): ICellSpec => {
    // Each item is `code: ...`, `markdown: ...` or a mapping with `kind`.
    if (typeof item === 'string') {
      return { cell_type: 'code', source: item, metadata: {} };
    }

    if (typeof item !== 'object' || item === null) {
      throw new Error(`Cell ${position + 1} must be a string or a mapping`);
    }

    const record = item as Record<string, unknown>;

    for (const kind of ['code', 'markdown', 'raw'] as const) {
      if (typeof record[kind] === 'string') {
        return {
          cell_type: kind,
          source: record[kind] as string,
          metadata: Array.isArray(record.tags)
            ? { tags: record.tags.map(String) }
            : {}
        };
      }
    }

    const kind =
      record.kind === 'markdown' || record.kind === 'raw'
        ? record.kind
        : 'code';

    return {
      cell_type: kind,
      source: typeof record.source === 'string' ? record.source : '',
      metadata: Array.isArray(record.tags)
        ? { tags: record.tags.map(String) }
        : {}
    };
  });
}

/**
 * The `notebook-open` action.
 */
export class NotebookOpenAction implements IActionImplementation {
  readonly type = 'notebook-open';

  constructor(context: INotebookActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Open notebook ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const panel = await openNotebook(
      this._context,
      notebookPath(this._context, request),
      undefined,
      request.options.split
    );

    if (request.options.cell) {
      const { cell, index } = findCell(panel, request.options.cell);

      panel.content.activeCellIndex = index;
      await panel.content.scrollToCell(cell);
    }

    return { status: 'ok' };
  }

  private _context: INotebookActionContext;
}

/**
 * The `notebook-create` action: create a notebook from a YAML list of
 * cells in the body and open it.
 */
export class NotebookCreateAction implements IActionImplementation {
  readonly type = 'notebook-create';

  constructor(context: INotebookActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Create notebook ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const serverPath = notebookPath(this._context, request);
    const cells = request.body.trim() ? parseCells(request.body) : [];
    const contents = this._context.app.serviceManager.contents;
    const kernel =
      request.options.kernel || (await defaultKernel(this._context));

    // Close any open view so it reloads with the new content.
    const existing = this._context.docManager.findWidget(
      serverPath,
      NOTEBOOK_FACTORY
    );

    if (existing) {
      await this._context.docManager.closeFile(serverPath);
    }

    await ensureDirectory(
      contents,
      serverPath.split('/').slice(0, -1).join('/')
    );
    await contents.save(serverPath, {
      type: 'notebook',
      format: 'json',
      content: {
        cells: cells.map(cell => ({
          ...cell,
          ...(cell.cell_type === 'code'
            ? { outputs: [], execution_count: null }
            : {})
        })),
        metadata: kernel
          ? { kernelspec: await kernelspecMetadata(this._context.app, kernel) }
          : {},
        nbformat: 4,
        nbformat_minor: 5
      }
    });

    if (request.options.open !== 'false') {
      await openNotebook(this._context, serverPath, kernel);
    }

    return { status: 'ok' };
  }

  private _context: INotebookActionContext;
}

/**
 * The `cell-insert` action: insert a cell into a notebook.
 */
export class CellInsertAction implements IActionImplementation {
  readonly type = 'cell-insert';

  constructor(context: INotebookActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Insert a ${request.options.kind ?? 'code'} cell into ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const panel = await openNotebook(
      this._context,
      notebookPath(this._context, request)
    );
    const model = panel.content.model;

    if (!model) {
      return { status: 'error', message: 'The notebook has no model' };
    }

    // Resolve `at`: end, start, a one-based index, or after:/before: a cell.
    const at = request.options.at ?? 'end';
    const count = panel.content.widgets.length;
    let index: number;

    if (at === 'end') {
      index = count;
    } else if (at === 'start') {
      index = 0;
    } else if (at.startsWith('after:')) {
      index = findCell(panel, at.slice('after:'.length)).index + 1;
    } else if (at.startsWith('before:')) {
      index = findCell(panel, at.slice('before:'.length)).index;
    } else {
      const position = Number(at);

      if (!Number.isInteger(position) || position < 1) {
        return { status: 'error', message: `Invalid "at" value "${at}"` };
      }

      index = Math.min(position - 1, count);
    }

    const kind = request.options.kind === 'markdown' ? 'markdown' : 'code';
    const tags = request.options.tags
      ? request.options.tags
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map(tag => tag.trim())
          .filter(tag => tag !== '')
      : [];

    model.sharedModel.insertCell(index, {
      cell_type: kind,
      source: requireBody(request).replace(/\n$/, ''),
      metadata: tags.length > 0 ? { tags } : {}
    });

    panel.content.activeCellIndex = index;
    await panel.context.save();

    if (request.options.run === 'true') {
      await NotebookActions.run(panel.content, panel.sessionContext);
    }

    return { status: 'ok' };
  }

  private _context: INotebookActionContext;
}

/**
 * Actions that run cells: `cell-run`, `cell-run-all` and `cell-run-to`.
 */
export class CellRunAction implements IActionImplementation {
  constructor(context: INotebookActionContext, mode: 'one' | 'all' | 'to') {
    this._context = context;
    this._mode = mode;
    this.type =
      mode === 'one'
        ? 'cell-run'
        : mode === 'all'
          ? 'cell-run-all'
          : 'cell-run-to';
  }

  readonly type: string;

  describe(request: IActionRequest): string {
    const path = request.options.path ?? '(no path)';

    switch (this._mode) {
      case 'all':
        return `Run all cells of ${path}`;
      case 'to':
        return `Run ${path} up to cell ${request.options.cell ?? '?'}`;
      default:
        return `Run cell ${request.options.cell ?? '?'} of ${path}`;
    }
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const panel = await openNotebook(
      this._context,
      notebookPath(this._context, request)
    );
    const notebook = panel.content;

    await panel.sessionContext.ready;

    let ok: boolean;

    if (this._mode === 'all') {
      ok = await NotebookActions.runAll(notebook, panel.sessionContext);
    } else {
      const { index } = findCell(panel, requireOption(request, 'cell'));

      notebook.activeCellIndex = index;

      if (this._mode === 'to' && index > 0) {
        ok = await NotebookActions.runAllAbove(notebook, panel.sessionContext);
        notebook.activeCellIndex = index;
        ok = ok && (await NotebookActions.run(notebook, panel.sessionContext));
      } else {
        ok = await NotebookActions.run(notebook, panel.sessionContext);
      }
    }

    return ok
      ? { status: 'ok' }
      : { status: 'error', message: 'A cell raised an error' };
  }

  private _context: INotebookActionContext;
  private _mode: 'one' | 'all' | 'to';
}

/**
 * The `cell-select` and `cell-highlight` actions.
 */
export class CellSelectAction implements IActionImplementation {
  constructor(context: INotebookActionContext, highlight: boolean) {
    this._context = context;
    this._highlight = highlight;
    this.type = highlight ? 'cell-highlight' : 'cell-select';
  }

  readonly type: string;

  describe(request: IActionRequest): string {
    return `${this._highlight ? 'Highlight' : 'Select'} cell ${request.options.cell ?? '?'} of ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const panel = await openNotebook(
      this._context,
      notebookPath(this._context, request)
    );
    const { cell, index } = findCell(panel, requireOption(request, 'cell'));

    panel.content.activeCellIndex = index;
    await panel.content.scrollToCell(cell);

    if (this._highlight) {
      cell.addClass('jp-Workshop-highlight');
      window.setTimeout(
        () => cell.removeClass('jp-Workshop-highlight'),
        parseDuration(request.options.duration, 3000)
      );
    }

    return { status: 'ok' };
  }

  private _context: INotebookActionContext;
  private _highlight: boolean;
}

/**
 * Kernel actions on a notebook: `kernel-restart`, `kernel-interrupt` and
 * `kernel-select`.
 */
export class KernelControlAction implements IActionImplementation {
  constructor(
    context: INotebookActionContext,
    mode: 'restart' | 'interrupt' | 'select'
  ) {
    this._context = context;
    this._mode = mode;
    this.type = `kernel-${mode}`;
  }

  readonly type: string;

  describe(request: IActionRequest): string {
    const path = request.options.path ?? '(no path)';

    switch (this._mode) {
      case 'restart':
        return `Restart the kernel of ${path}`;
      case 'interrupt':
        return `Interrupt the kernel of ${path}`;
      default:
        return `Use kernel ${request.options.kernel ?? '?'} for ${path}`;
    }
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const panel = await openNotebook(
      this._context,
      notebookPath(this._context, request)
    );
    const sessionContext = panel.sessionContext;

    await sessionContext.ready;

    switch (this._mode) {
      case 'restart':
        await sessionContext.restartKernel();
        break;
      case 'interrupt':
        await sessionContext.session?.kernel?.interrupt();
        break;
      default:
        await sessionContext.changeKernel({
          name: requireOption(request, 'kernel')
        });
    }

    return { status: 'ok' };
  }

  private _context: INotebookActionContext;
  private _mode: 'restart' | 'interrupt' | 'select';
}

/**
 * The `kernel-execute` action: run code in a notebook's kernel, or in the
 * hidden workshop kernel, optionally capturing the output.
 */
export class KernelExecuteAction implements IActionImplementation {
  readonly type = 'kernel-execute';

  constructor(context: INotebookActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    const target = request.options.path
      ? `the kernel of ${request.options.path}`
      : 'the workshop kernel';
    const capture = request.options.capture
      ? `, capturing ${request.options.capture}`
      : '';

    return `Run code in ${target}${capture}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const code = requireBody(request, 'code');
    let output;

    if (request.options.path) {
      const panel = await openNotebook(
        this._context,
        notebookPath(this._context, request)
      );

      await panel.sessionContext.ready;

      const kernel = panel.sessionContext.session?.kernel;

      if (!kernel) {
        return { status: 'error', message: 'The notebook has no kernel' };
      }

      output = await executeInKernel(
        kernel,
        code,
        request.options.silent !== 'false'
      );
    } else {
      output = await this._context.kernel.execute(code);
    }

    if (output.error) {
      return { status: 'error', message: output.error };
    }

    const text = output.text.trim();
    const captured = request.options.capture
      ? { [request.options.capture]: text }
      : undefined;

    return { status: 'ok', message: text, captured };
  }

  private _context: INotebookActionContext;
}

/**
 * The `console-open` action: open a console attached to a notebook's kernel.
 */
export class ConsoleOpenAction implements IActionImplementation {
  readonly type = 'console-open';

  constructor(context: INotebookActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Open a console for ${request.options.path ?? 'a new kernel'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const args: Record<string, string> = {};

    if (request.options.path) {
      const panel = await openNotebook(
        this._context,
        notebookPath(this._context, request)
      );

      args.path = panel.context.path;
    }

    await this._context.app.commands.execute('console:create', args);

    return { status: 'ok' };
  }

  private _context: INotebookActionContext;
}

/**
 * The `output-clear` action: clear all outputs of a notebook.
 */
export class OutputClearAction implements IActionImplementation {
  readonly type = 'output-clear';

  constructor(context: INotebookActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Clear the outputs of ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const panel = await openNotebook(
      this._context,
      notebookPath(this._context, request)
    );

    NotebookActions.clearAllOutputs(panel.content);

    return { status: 'ok' };
  }

  private _context: INotebookActionContext;
}
