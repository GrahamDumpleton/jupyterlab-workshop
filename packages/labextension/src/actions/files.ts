import { JupyterFrontEnd } from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { PathExt } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentRegistry, IDocumentWidget } from '@jupyterlab/docregistry';
import { FileEditor, IEditorTracker } from '@jupyterlab/fileeditor';

import {
  IActionImplementation,
  IActionRequest,
  IActionResult,
  IWorkshopManager
} from '../tokens';
import { parseDuration } from '../util';
import { ensureDirectory, getIfExists, readTextFile } from './contents';
import { requireOption } from './registry';
import { TerminalSessions } from './terminal';

/** Widget factory name of the JupyterLab text editor. */
const EDITOR_FACTORY = 'Editor';

/** Services the file actions need. */
export interface IFileActionContext {
  app: JupyterFrontEnd;
  docManager: IDocumentManager;
  editorTracker: IEditorTracker | null;
  manager: IWorkshopManager;
  terminals: TerminalSessions;
}

/** A located piece of text in a document. */
interface ITextSpan {
  start: number;
  end: number;
}

/**
 * The `file-write` action: write the body, or a file shipped with the
 * workshop, to a file inside the workshop.
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

    // The content comes from the body or from a file in the workshop.
    let content: string;

    if (request.options.from) {
      content = await readTextFile(
        contents,
        this._context.manager.resolvePath(request.options.from)
      );
    } else {
      content = withTrailingNewline(request.body);
    }

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
      this._context.manager.resolvePath(path),
      request.options.split
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
      lineIndex = editor.lineCount - countLines(text);
    } else {
      const offset = editor.getOffsetAt({ line: lineIndex, column: 0 });

      sharedModel.updateSource(offset, offset, text);
    }

    await saveIfWanted(widget, request);
    revealLine(widget, Math.max(0, lineIndex));

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `editor-replace` action: replace text matching a pattern with the
 * body, through the editor, and save.
 */
export class EditorReplaceAction implements IActionImplementation {
  readonly type = 'editor-replace';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Replace "${request.options.match ?? ''}" in ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');
    const match = requireOption(request, 'match');
    const widget = await openEditor(
      this._context,
      this._context.manager.resolvePath(path)
    );
    const sharedModel = widget.content.model.sharedModel;
    const spans = findSpans(sharedModel.getSource(), match, request.options);

    if (spans.length === 0) {
      return {
        status: 'error',
        message: `"${match}" was not found in ${path}`
      };
    }

    // Replace from the end so earlier offsets stay valid.
    const replacement = request.body.replace(/\r\n/g, '\n').replace(/\n$/, '');
    const targets = request.options.all === 'true' ? spans : spans.slice(0, 1);

    for (const span of [...targets].reverse()) {
      sharedModel.updateSource(span.start, span.end, replacement);
    }

    await saveIfWanted(widget, request);
    revealOffset(widget, targets[0].start);

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `editor-select` action: select matching text or a line.
 */
export class EditorSelectAction implements IActionImplementation {
  readonly type = 'editor-select';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Select in ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const widget = await openEditor(
      this._context,
      this._context.manager.resolvePath(requireOption(request, 'path'))
    );
    const range = findRange(widget, request);

    if (!range) {
      return { status: 'error', message: 'Nothing to select was found' };
    }

    widget.content.editor.setSelection(range);
    widget.content.editor.revealPosition(range.start);
    widget.content.editor.focus();

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `editor-highlight` action: select matching text briefly.
 */
export class EditorHighlightAction implements IActionImplementation {
  readonly type = 'editor-highlight';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Highlight in ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const widget = await openEditor(
      this._context,
      this._context.manager.resolvePath(requireOption(request, 'path'))
    );
    const range = findRange(widget, request);

    if (!range) {
      return { status: 'error', message: 'Nothing to highlight was found' };
    }

    const editor = widget.content.editor;

    editor.setSelection(range);
    editor.revealPosition(range.start);

    window.setTimeout(
      () => {
        if (!widget.isDisposed) {
          editor.setCursorPosition(range.start);
        }
      },
      parseDuration(request.options.duration, 3000)
    );

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `file-browser-reveal` action: show a path in the file browser.
 */
export class FileBrowserRevealAction implements IActionImplementation {
  readonly type = 'file-browser-reveal';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Show ${request.options.path ?? '(no path)'} in the file browser`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = this._context.manager.resolvePath(request.options.path ?? '.');

    await this._context.app.commands.execute('filebrowser:go-to-path', {
      path
    });

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `download` action: download a workshop file to the learner's machine.
 */
export class DownloadAction implements IActionImplementation {
  readonly type = 'download';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Download ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = this._context.manager.resolvePath(
      requireOption(request, 'path')
    );
    const url =
      await this._context.app.serviceManager.contents.getDownloadUrl(path);

    window.open(url, '_blank', 'noopener');

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `upload-prompt` action: show a directory and ask the learner to use
 * the file browser's upload button.
 */
export class UploadPromptAction implements IActionImplementation {
  readonly type = 'upload-prompt';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Ask for an upload into ${request.options.path ?? '.'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = this._context.manager.resolvePath(request.options.path ?? '.');

    await this._context.app.commands.execute('filebrowser:go-to-path', {
      path
    });
    Notification.info(
      `Use the upload button in the file browser to add files to ${path}`,
      {
        autoClose: 6000
      }
    );

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `file-close` action: close every widget showing a file, whether an
 * editor, a preview or a notebook. A file with unsaved changes asks
 * first, as closing its tab would; a file that is not open is nothing
 * to do.
 */
export class FileCloseAction implements IActionImplementation {
  readonly type = 'file-close';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Close ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');

    await this._context.docManager.closeFile(
      this._context.manager.resolvePath(path)
    );

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
  serverPath: string,
  split?: string
): Promise<IDocumentWidget<FileEditor>> {
  const existing = findEditor(context.docManager, serverPath);
  const options = existing ? undefined : placementFor(context, split);
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
  context: IFileActionContext,
  split?: string
): DocumentRegistry.IOpenOptions | undefined {
  const current = context.app.shell.currentWidget;

  if ((split === 'right' || split === 'bottom') && current) {
    return { mode: `split-${split}`, ref: current.id };
  }

  // Keep documents together as tabs: beside the current editor, else
  // beside whatever document is already open (a README preview, a
  // notebook), and only above the first workshop terminal when there is
  // no document at all.
  const editor = context.editorTracker?.currentWidget;

  if (editor && !editor.isDisposed) {
    return { mode: 'tab-after', ref: editor.id };
  }

  return documentPlacement(context);
}

/**
 * Where a new document goes: as a tab after the first document open in
 * the main area, or split above the first workshop terminal, or, with
 * neither, wherever JupyterLab puts it.
 */
export function documentPlacement(context: {
  app: JupyterFrontEnd;
  docManager: IDocumentManager;
  terminals: TerminalSessions;
}): DocumentRegistry.IOpenOptions | undefined {
  for (const widget of context.app.shell.widgets('main')) {
    if (!widget.isDisposed && context.docManager.contextForWidget(widget)) {
      return { mode: 'tab-after', ref: widget.id };
    }
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

function revealOffset(
  widget: IDocumentWidget<FileEditor>,
  offset: number
): void {
  const editor = widget.content.editor;
  const position = editor.getPositionAt(offset);

  if (position) {
    editor.setCursorPosition(position);
    editor.revealPosition(position);
  }
}

async function saveIfWanted(
  widget: IDocumentWidget<FileEditor>,
  request: IActionRequest
): Promise<void> {
  if (request.options.save !== 'false') {
    await widget.context.save();
  }
}

function findSpans(
  source: string,
  match: string,
  options: Record<string, string>
): ITextSpan[] {
  const spans: ITextSpan[] = [];

  if (options.regex === 'true') {
    const pattern = new RegExp(match, 'g');
    let found: RegExpExecArray | null;

    while ((found = pattern.exec(source)) !== null) {
      spans.push({ start: found.index, end: found.index + found[0].length });

      if (found[0].length === 0) {
        pattern.lastIndex += 1;
      }
    }

    return spans;
  }

  let index = source.indexOf(match);

  while (index >= 0) {
    spans.push({ start: index, end: index + match.length });
    index = source.indexOf(match, index + Math.max(match.length, 1));
  }

  return spans;
}

function findRange(
  widget: IDocumentWidget<FileEditor>,
  request: IActionRequest
): CodeEditor.IRange | undefined {
  const editor = widget.content.editor;

  if (request.options.match) {
    const source = widget.content.model.sharedModel.getSource();
    const [span] = findSpans(source, request.options.match, request.options);

    if (!span) {
      return undefined;
    }

    const start = editor.getPositionAt(span.start);
    const end = editor.getPositionAt(span.end);

    return start && end ? { start, end } : undefined;
  }

  const line = parseLine(request.options.line ?? '');

  if (line === undefined || line > editor.lineCount) {
    return undefined;
  }

  const text = editor.getLine(line - 1) ?? '';

  return {
    start: { line: line - 1, column: 0 },
    end: { line: line - 1, column: text.length }
  };
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
