import { JupyterFrontEnd } from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { PathExt } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentRegistry, IDocumentWidget } from '@jupyterlab/docregistry';
import { FileEditor, IEditorTracker } from '@jupyterlab/fileeditor';
import {
  EditorTarget,
  IOffsetSpan,
  expandReplacement,
  findEditorMatches,
  lineAt,
  lineCount,
  lineSpan,
  lineTextSpan,
  parseEditorTarget,
  substitute
} from '@jupyterlab-workshop/core';

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

      // A shipped file is copied as it is, since it may legitimately
      // contain braces, unless the directive asks for substitution.
      if (request.options.substitute === 'true') {
        content = substitute(content, this._context.manager.variables.values, {
          pathSep: this._context.manager.platform?.path_sep
        }).text;
      }
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
 * The `editor-insert` action: insert the body into a file before a line
 * or a match (or after it), or at the end, through the editor, and save.
 */
export class EditorInsertAction implements IActionImplementation {
  readonly type = 'editor-insert';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    const { line, match, position } = request.options;
    const relation = position === 'after' ? 'after' : 'at';
    let where = 'at the end';

    if (match !== undefined) {
      where = `${position === 'after' ? 'after' : 'before'} "${match}"`;
    } else if (line !== undefined && line !== 'end') {
      where = `${relation} line ${line}`;
    }

    return `Insert into ${request.options.path ?? '(no path)'} ${where}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');
    const target = targetFor(request);
    const widget = await openEditor(
      this._context,
      this._context.manager.resolvePath(path)
    );
    const editor = widget.content.editor;
    const sharedModel = widget.content.model.sharedModel;
    const source = sharedModel.getSource();
    const text = withTrailingNewline(request.body.replace(/\r\n/g, '\n'));

    // Work out the zero-based lines the text is inserted before, last
    // first so earlier lines keep their numbers while inserting.
    const lineIndexes = insertionLines(source, target, editor.lineCount);

    if (lineIndexes.length === 0) {
      return {
        status: 'error',
        message: `"${request.options.match}" was not found in ${path}`
      };
    }

    let firstLine = lineIndexes[0];

    for (const lineIndex of [...lineIndexes].reverse()) {
      if (lineIndex >= editor.lineCount) {
        const current = sharedModel.getSource();
        const separator =
          current.length > 0 && !current.endsWith('\n') ? '\n' : '';

        sharedModel.updateSource(
          current.length,
          current.length,
          separator + text
        );
        firstLine = editor.lineCount - countLines(text);
      } else {
        const offset = editor.getOffsetAt({ line: lineIndex, column: 0 });

        sharedModel.updateSource(offset, offset, text);
      }
    }

    await saveIfWanted(widget, request);
    revealLine(widget, Math.max(0, firstLine));

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `editor-replace` action: replace the matches of a pattern, or a
 * range of lines, with the body, through the editor, and save. The new
 * text is left selected so the learner sees what changed.
 */
export class EditorReplaceAction implements IActionImplementation {
  readonly type = 'editor-replace';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    const { line, match } = request.options;
    const what =
      match !== undefined
        ? `"${match}"`
        : line !== undefined
          ? `line${line.includes('-') ? 's' : ''} ${line}`
          : '(nothing)';

    return `Replace ${what} in ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');
    const target = targetFor(request);
    const widget = await openEditor(
      this._context,
      this._context.manager.resolvePath(path)
    );
    const sharedModel = widget.content.model.sharedModel;
    const source = sharedModel.getSource();
    const body = request.body.replace(/\r\n/g, '\n');
    const edits = replacementEdits(source, target, body);

    if (edits.length === 0) {
      return {
        status: 'error',
        message:
          target.kind === 'line'
            ? `Line ${target.start} is past the end of ${path}`
            : `"${request.options.match}" was not found in ${path}`
      };
    }

    // Apply from the end so earlier offsets stay valid.
    for (const edit of [...edits].reverse()) {
      sharedModel.updateSource(edit.start, edit.end, edit.text);
    }

    await saveIfWanted(widget, request);
    showSpan(widget, {
      start: edits[0].start,
      end: edits[0].start + edits[0].text.length
    });

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `editor-select` action: select matching text or a range of lines.
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
    const target = targetFor(request);
    const widget = await openEditor(
      this._context,
      this._context.manager.resolvePath(requireOption(request, 'path'))
    );
    const span = selectionSpan(
      widget.content.model.sharedModel.getSource(),
      target
    );

    if (!span) {
      return { status: 'error', message: 'Nothing to select was found' };
    }

    showSpan(widget, span);
    widget.content.editor.focus();

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `editor-highlight` action: select matching text or a range of
 * lines briefly.
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
    const target = targetFor(request);
    const widget = await openEditor(
      this._context,
      this._context.manager.resolvePath(requireOption(request, 'path'))
    );
    const span = selectionSpan(
      widget.content.model.sharedModel.getSource(),
      target
    );

    if (!span) {
      return { status: 'error', message: 'Nothing to highlight was found' };
    }

    const range = showSpan(widget, span);

    window.setTimeout(
      () => {
        if (!widget.isDisposed && range) {
          widget.content.editor.setCursorPosition(range.start);
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

async function saveIfWanted(
  widget: IDocumentWidget<FileEditor>,
  request: IActionRequest
): Promise<void> {
  if (request.options.save !== 'false') {
    await widget.context.save();
  }
}

/** One replacement to make in a file. */
interface ITextEdit extends IOffsetSpan {
  text: string;
}

/**
 * Read the targeting options of an editor action, or throw the problems
 * the linter would have reported.
 */
function targetFor(request: IActionRequest): EditorTarget {
  const { target, errors } = parseEditorTarget(request.type, request.options);

  if (!target) {
    throw new Error(errors.join('; '));
  }

  return target;
}

/**
 * The span a select or highlight covers: the chosen matches from the
 * first to the last, or the text of the named lines.
 */
function selectionSpan(
  source: string,
  target: EditorTarget
): IOffsetSpan | undefined {
  if (target.kind === 'match') {
    const matches = findEditorMatches(source, target);

    if (matches.length === 0) {
      return undefined;
    }

    return {
      start: matches[0].spanStart,
      end: matches[matches.length - 1].spanEnd
    };
  }

  if (target.kind === 'line' && target.start <= lineCount(source)) {
    return lineTextSpan(source, target.start, target.end);
  }

  return undefined;
}

/**
 * The edits a replace makes: each chosen match becomes the body, with
 * group references expanded when asked, or the named lines become the
 * body's lines, and no lines at all when the body is empty.
 */
function replacementEdits(
  source: string,
  target: EditorTarget,
  body: string
): ITextEdit[] {
  if (target.kind === 'match') {
    const replacement = body.replace(/\n$/, '');

    return findEditorMatches(source, target).map(match => ({
      start: match.start,
      end: match.end,
      text: target.expand ? expandReplacement(replacement, match) : replacement
    }));
  }

  if (target.kind === 'line' && target.start <= lineCount(source)) {
    const span = lineSpan(source, target.start, target.end);

    return [
      {
        ...span,
        text: body.trim() === '' ? '' : withTrailingNewline(body)
      }
    ];
  }

  return [];
}

/**
 * The zero-based lines an insert goes before, in file order: the end of
 * the file, the named line, or the line of each chosen match, the one
 * after it with `position: after`.
 */
function insertionLines(
  source: string,
  target: EditorTarget,
  editorLines: number
): number[] {
  if (target.kind === 'end') {
    return [editorLines];
  }

  if (target.kind === 'line') {
    const index = target.position === 'after' ? target.start : target.start - 1;

    return [Math.min(index, editorLines)];
  }

  const lines = new Set<number>();

  for (const match of findEditorMatches(source, target)) {
    if (target.position === 'after') {
      lines.add(lineAt(source, Math.max(match.start, match.end - 1)));
    } else {
      lines.add(lineAt(source, match.start) - 1);
    }
  }

  return [...lines].sort((a, b) => a - b);
}

/**
 * Select a span of the file and scroll to its start, returning the range
 * selected. An empty span just places the cursor.
 */
function showSpan(
  widget: IDocumentWidget<FileEditor>,
  span: IOffsetSpan
): CodeEditor.IRange | undefined {
  const editor = widget.content.editor;
  const start = editor.getPositionAt(span.start);
  const end = editor.getPositionAt(span.end);

  if (!start || !end) {
    return undefined;
  }

  if (span.end > span.start) {
    editor.setSelection({ start, end });
  } else {
    editor.setCursorPosition(start);
  }

  editor.revealPosition(start);

  return { start, end };
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
