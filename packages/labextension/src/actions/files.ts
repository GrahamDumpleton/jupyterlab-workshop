import { JupyterFrontEnd } from '@jupyterlab/application';
import { PathExt } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentRegistry, IDocumentWidget } from '@jupyterlab/docregistry';
import { FileEditor, IEditorTracker } from '@jupyterlab/fileeditor';
import { Contents, ServerConnection } from '@jupyterlab/services';

import {
  IActionImplementation,
  IActionRequest,
  IActionResult,
  IWorkshopManager
} from '../tokens';
import { TerminalSessions } from './terminal';

/** Widget factory name of the JupyterLab text editor. */
const EDITOR_FACTORY = 'Editor';

/** Services the file actions need. */
export interface IFileActionContext {
  app: JupyterFrontEnd;
  docManager: IDocumentManager;
  editorTracker: IEditorTracker;
  manager: IWorkshopManager;
  terminals: TerminalSessions;
}

/**
 * The `file-write` action: write the body to a file inside the workshop.
 */
export class FileWriteAction implements IActionImplementation {
  readonly type = 'file-write';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    const mode = request.options.mode ?? 'overwrite';
    const verb = mode === 'append' ? 'Append to' : 'Write';

    return `${verb} ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');
    const serverPath = this._context.manager.resolvePath(path);
    const mode = request.options.mode ?? 'overwrite';
    const contents = this._context.app.serviceManager.contents;
    let content = withTrailingNewline(request.body);

    // Honour the write mode against what is already on disk.
    const existing = await getIfExists(contents, serverPath, mode === 'append');

    if (existing && existing.type === 'directory') {
      return { status: 'error', message: `${path} is a directory` };
    }

    if (mode === 'create' && existing) {
      return { status: 'error', message: `${path} already exists` };
    }

    if (mode === 'append' && existing && typeof existing.content === 'string') {
      content = withTrailingNewline(existing.content) + content;
    }

    await ensureDirectory(contents, PathExt.dirname(serverPath));

    // Write through an open editor so it does not later report a conflict.
    const widget = findEditor(this._context.docManager, serverPath);

    if (widget) {
      widget.content.model.sharedModel.setSource(content);
      await widget.context.save();
    } else {
      await contents.save(serverPath, {
        type: 'file',
        format: 'text',
        content
      });
    }

    if (request.options.open === 'true') {
      await openEditor(this._context, serverPath);
    }

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `file-open` action: open a file in the editor, optionally at a line.
 */
export class FileOpenAction implements IActionImplementation {
  readonly type = 'file-open';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    const line = request.options.line ? ` at line ${request.options.line}` : '';

    return `Open ${request.options.path ?? '(no path)'}${line}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');
    const widget = await openEditor(
      this._context,
      this._context.manager.resolvePath(path)
    );

    if (request.options.line) {
      const line = parseLine(request.options.line);

      if (line === undefined) {
        return {
          status: 'error',
          message: `Invalid line "${request.options.line}"`
        };
      }

      revealLine(widget, line - 1);
    }

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `editor-insert` action: insert the body into a file at a line, or at
 * the end, through the editor, and save.
 */
export class EditorInsertAction implements IActionImplementation {
  readonly type = 'editor-insert';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    const where =
      request.options.line && request.options.line !== 'end'
        ? `at line ${request.options.line}`
        : 'at the end';

    return `Insert into ${request.options.path ?? '(no path)'} ${where}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');
    const widget = await openEditor(
      this._context,
      this._context.manager.resolvePath(path)
    );

    const editor = widget.content.editor;
    const sharedModel = widget.content.model.sharedModel;
    const source = sharedModel.getSource();
    const text = withTrailingNewline(request.body.replace(/\r\n/g, '\n'));
    const lineOption = request.options.line ?? 'end';

    // Work out the zero-based line the text is inserted before.
    let lineIndex: number;

    if (lineOption === 'end') {
      lineIndex = editor.lineCount;
    } else {
      const line = parseLine(lineOption);

      if (line === undefined) {
        return { status: 'error', message: `Invalid line "${lineOption}"` };
      }

      lineIndex = Math.min(line - 1, editor.lineCount);
    }

    if (lineIndex >= editor.lineCount) {
      const separator = source.length > 0 && !source.endsWith('\n') ? '\n' : '';

      sharedModel.updateSource(source.length, source.length, separator + text);
      lineIndex = editor.lineCount - 1 - countLines(text) + 1;
    } else {
      const offset = editor.getOffsetAt({ line: lineIndex, column: 0 });

      sharedModel.updateSource(offset, offset, text);
    }

    if (request.options.save !== 'false') {
      await widget.context.save();
    }

    revealLine(widget, Math.max(0, lineIndex));

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * Open a file in the text editor, placing it sensibly relative to the
 * workshop terminals, and wait until it is ready.
 *
 * If the file is already open and unmodified it is reloaded from disk so
 * that changes made by terminal commands are visible.
 */
export async function openEditor(
  context: IFileActionContext,
  serverPath: string
): Promise<IDocumentWidget<FileEditor>> {
  const existing = findEditor(context.docManager, serverPath);
  const options = existing ? undefined : placementFor(context);
  const widget = context.docManager.openOrReveal(
    serverPath,
    EDITOR_FACTORY,
    undefined,
    options
  );

  if (!widget) {
    throw new Error(`Unable to open ${serverPath}`);
  }

  await widget.context.ready;

  if (!isFileEditor(widget)) {
    throw new Error(`${serverPath} did not open in the text editor`);
  }

  if (existing && !widget.context.model.dirty) {
    await widget.context.revert();
  }

  return widget;
}

function placementFor(
  context: IFileActionContext
): DocumentRegistry.IOpenOptions | undefined {
  // Keep documents together as tabs, above the first workshop terminal.
  const editor = context.editorTracker.currentWidget;

  if (editor && !editor.isDisposed) {
    return { mode: 'tab-after', ref: editor.id };
  }

  const terminal = context.terminals.first;

  if (terminal) {
    return { mode: 'split-top', ref: terminal.id };
  }

  return undefined;
}

function findEditor(
  docManager: IDocumentManager,
  serverPath: string
): IDocumentWidget<FileEditor> | undefined {
  const widget = docManager.findWidget(serverPath, EDITOR_FACTORY);

  return widget && isFileEditor(widget) ? widget : undefined;
}

function isFileEditor(
  widget: IDocumentWidget
): widget is IDocumentWidget<FileEditor> {
  return widget.content instanceof FileEditor;
}

function revealLine(
  widget: IDocumentWidget<FileEditor>,
  lineIndex: number
): void {
  const editor = widget.content.editor;
  const line = Math.max(0, Math.min(lineIndex, editor.lineCount - 1));

  editor.setCursorPosition({ line, column: 0 });
  editor.revealPosition({ line, column: 0 });
}

async function getIfExists(
  contents: Contents.IManager,
  path: string,
  withContent: boolean
): Promise<Contents.IModel | null> {
  try {
    return await contents.get(path, { content: withContent });
  } catch (error) {
    if (
      error instanceof ServerConnection.ResponseError &&
      error.response.status === 404
    ) {
      return null;
    }

    throw error;
  }
}

/**
 * Create a directory and any missing parents through the contents API.
 */
export async function ensureDirectory(
  contents: Contents.IManager,
  path: string
): Promise<void> {
  if (path === '' || path === '.') {
    return;
  }

  const existing = await getIfExists(contents, path, false);

  if (existing) {
    if (existing.type !== 'directory') {
      throw new Error(`${path} exists and is not a directory`);
    }

    return;
  }

  const parent = PathExt.dirname(path);

  await ensureDirectory(contents, parent);

  // The contents API only creates untitled directories, so rename one.
  const created = await contents.newUntitled({
    type: 'directory',
    path: parent
  });

  await contents.rename(created.path, path);
}

function requireOption(request: IActionRequest, name: string): string {
  const value = request.options[name];

  if (!value) {
    throw new Error(`The ${request.type} action needs a "${name}" option`);
  }

  return value;
}

function parseLine(value: string): number | undefined {
  const line = Number(value);

  return Number.isInteger(line) && line >= 1 ? line : undefined;
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function countLines(text: string): number {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
