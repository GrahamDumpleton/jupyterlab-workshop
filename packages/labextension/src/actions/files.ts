import { JupyterFrontEnd } from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import { EditorView } from '@codemirror/view';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { PathExt } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentRegistry, IDocumentWidget } from '@jupyterlab/docregistry';
import { FileEditor, IEditorTracker } from '@jupyterlab/fileeditor';
import {
  EDITOR_FACTORY,
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
import {
  IChangedSpan,
  editorView,
  markChanged,
  markPointed
} from '../editormarks';
import { parseDuration } from '../util';
import {
  deleteTree,
  ensureDirectory,
  getIfExists,
  readTextFile
} from './contents';
import { LayoutManager } from '../layout';
import { requireOption } from './registry';
import { TerminalSessions } from './terminal';

/** Services the file actions need. */
export interface IFileActionContext {
  app: JupyterFrontEnd;
  docManager: IDocumentManager;
  editorTracker: IEditorTracker | null;
  manager: IWorkshopManager;
  terminals: TerminalSessions;
  layouts: LayoutManager;
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
        this._context.manager.resolvePath(request.options.from, 'workshop')
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

    // An editor showing the file goes to the start of what was written:
    // the line after the existing content for an append, the top
    // otherwise.
    let firstLine = 0;
    let writtenLines = 0;

    if (
      mode === 'append' &&
      existing &&
      typeof existing.content === 'string' &&
      existing.content !== ''
    ) {
      const kept = withTrailingNewline(existing.content);

      writtenLines = countLines(content);
      content = kept + content;
      firstLine = countLines(kept);
    }

    await ensureDirectory(contents, PathExt.dirname(serverPath));

    // Write through an open editor so it does not later report a conflict.
    const widget = findEditor(this._context.docManager, serverPath);

    let shown = widget;

    if (widget) {
      // The editor saves only over the file it last loaded, and asks the
      // learner which to keep when the file has since changed on disk,
      // as it has when code in a kernel wrote it. The action replaces
      // the file whatever it holds, so the editor is brought up to date
      // with the disk first and there is nothing to ask.

      if (existing) {
        await widget.context.revert();
      }

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
      shown = await openEditor(this._context, serverPath, request.options.area);
    }

    // Appended text is marked as what changed; a file written whole has
    // nothing to tell apart, so it is only shown from the top.
    if (shown && writtenLines > 0) {
      showChange(shown, [
        lineBlockSpan(shown.content.editor, firstLine, writtenLines)
      ]);
    } else if (shown) {
      revealLine(shown, firstLine, 'upper');
    }

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `file-open` action: open a file in the editor, optionally at a
 * line, or in the viewer whose widget factory `factory` names.
 */
export class FileOpenAction implements IActionImplementation {
  readonly type = 'file-open';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    const line = request.options.line ? ` at line ${request.options.line}` : '';
    const factory = request.options.factory
      ? ` in the ${request.options.factory}`
      : '';

    return `Open ${request.options.path ?? '(no path)'}${line}${factory}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');
    const widget = await openDocument(
      this._context,
      this._context.manager.resolvePath(path),
      request.options.factory ?? EDITOR_FACTORY,
      request.options.area
    );

    if (request.options.line) {
      const line = parseLine(request.options.line);

      if (line === undefined) {
        return {
          status: 'error',
          message: `Invalid line "${request.options.line}"`
        };
      }

      if (!isFileEditor(widget)) {
        return {
          status: 'error',
          message: `A line can only be opened in the text editor, not with factory "${request.options.factory}"`
        };
      }

      revealLine(widget, line - 1, 'center');
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

    const blockLines = countLines(text);
    const firstLines: number[] = [];

    for (const [order, lineIndex] of [...lineIndexes.entries()].reverse()) {
      if (lineIndex >= editor.lineCount) {
        const current = sharedModel.getSource();
        const separator =
          current.length > 0 && !current.endsWith('\n') ? '\n' : '';

        sharedModel.updateSource(
          current.length,
          current.length,
          separator + text
        );

        // The text ends in a newline, so the editor counts one empty
        // line after the block.
        firstLines[order] = editor.lineCount - 1 - blockLines;
      } else {
        const offset = editor.getOffsetAt({ line: lineIndex, column: 0 });

        sharedModel.updateSource(offset, offset, text);
        firstLines[order] = lineIndex;
      }
    }

    await saveIfWanted(widget, request);

    // Each block sits below the ones inserted before it in the file.
    showChange(
      widget,
      firstLines.map((firstLine, order) =>
        lineBlockSpan(editor, firstLine + order * blockLines, blockLines)
      )
    );

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `editor-replace` action: replace the matches of a pattern, or a
 * range of lines, with the body, through the editor, and save. The new
 * text is marked so the learner sees what changed.
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

    // Where each replacement ended up, once the ones before it in the
    // file have changed length.
    let shift = 0;

    const spans = edits.map((edit): IChangedSpan => {
      const start = edit.start + shift;

      shift += edit.text.length - (edit.end - edit.start);

      return {
        start,
        end: start + edit.text.length,
        wholeLines: isWholeLines(source, edit)
      };
    });

    showChange(widget, spans);

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

    showSpan(widget, span, 'center');
    widget.content.editor.focus();

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `editor-highlight` action: tint matching text or a range of
 * lines briefly, without selecting it.
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

    const editor = widget.content.editor;
    const start = editor.getPositionAt(span.start);

    if (start) {
      revealAt(editor, start, 'center');
      editor.setCursorPosition(start, { scroll: false });
    }

    markPointed(editor, span, parseDuration(request.options.duration, 3000));

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

    // The file browser is brought forward on the side the instructions
    // are not, so the two do not take turns covering each other.
    this._context.layouts.showSidebarWidget('filebrowser');
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

    // A link with the download attribute saves the file without asking
    // the browser to open anything, which is what JupyterLab's own file
    // browser does. Opening a window instead was blocked as a popup
    // once the click was too far in the past, as after JupyterLite's
    // asynchronous lookup, and would show rather than save the blob
    // URLs JupyterLite hands out. Those carry no name, so the link
    // supplies the file's own.
    const link = document.createElement('a');

    link.href = url;
    link.download = PathExt.basename(path);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

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
 * The `file-delete` action: delete a file, or with `recursive` a directory
 * and everything in it, closing any tabs showing it first. A missing path
 * is nothing to do unless `missing` is `error`. The workshop directory
 * and its state directory are refused, whatever the options say.
 */
export class FileDeleteAction implements IActionImplementation {
  readonly type = 'file-delete';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Delete ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');
    const serverPath = this._context.manager.resolvePath(path);
    const contents = this._context.app.serviceManager.contents;

    // The pages and the learner's progress are never deletable, however
    // the path is spelt.
    const root = this._context.manager.workshop?.path ?? '';
    const stateDir = PathExt.join(root, '_workshop');

    if (
      serverPath === root ||
      serverPath === stateDir ||
      serverPath.startsWith(`${stateDir}/`)
    ) {
      return {
        status: 'error',
        message: `Refusing to delete ${path}: it holds the workshop itself`
      };
    }

    const existing = await getIfExists(contents, serverPath, false);

    if (!existing) {
      return request.options.missing === 'error'
        ? { status: 'error', message: `${path} does not exist` }
        : { status: 'ok', message: `${path} was already gone` };
    }

    if (existing.type === 'directory') {
      if (!isTrue(request.options.recursive)) {
        return {
          status: 'error',
          message: `${path} is a directory; set recursive to delete it and its contents`
        };
      }

      await closeUnder(this._context, serverPath);
      await deleteTree(contents, serverPath);

      return { status: 'ok' };
    }

    // The document manager closes the file's tabs and shuts down a
    // kernel session that only it was using.
    await this._context.docManager.deleteFile(serverPath);

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `file-rename` action: rename or move a file or directory. Open tabs
 * follow the file to its new name. The destination's directory is
 * created when missing, and an existing destination is refused.
 */
export class FileRenameAction implements IActionImplementation {
  readonly type = 'file-rename';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Rename ${request.options.path ?? '(no path)'} to ${request.options.to ?? '(no destination)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');
    const to = requireOption(request, 'to');
    const from = this._context.manager.resolvePath(path);
    const target = this._context.manager.resolvePath(to);
    const contents = this._context.app.serviceManager.contents;

    if (from === target) {
      return { status: 'ok', message: 'Already named that' };
    }

    if (!(await getIfExists(contents, from, false))) {
      return { status: 'error', message: `${path} does not exist` };
    }

    if (await getIfExists(contents, target, false)) {
      return { status: 'error', message: `${to} exists already` };
    }

    await ensureDirectory(contents, PathExt.dirname(target));
    await this._context.docManager.rename(from, target);

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `file-copy` action: copy a file to a new path, creating the
 * destination's directory when missing. An existing destination is
 * refused, so a copy never silently replaces the learner's work.
 */
export class FileCopyAction implements IActionImplementation {
  readonly type = 'file-copy';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Copy ${request.options.path ?? '(no path)'} to ${request.options.to ?? '(no destination)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');
    const to = requireOption(request, 'to');
    const from = this._context.manager.resolvePath(path);
    const target = this._context.manager.resolvePath(to);
    const contents = this._context.app.serviceManager.contents;
    const source = await getIfExists(contents, from, false);

    if (!source) {
      return { status: 'error', message: `${path} does not exist` };
    }

    if (source.type === 'directory') {
      return {
        status: 'error',
        message: `${path} is a directory; only files can be copied`
      };
    }

    if (await getIfExists(contents, target, false)) {
      return { status: 'error', message: `${to} exists already` };
    }

    // The contents API copies into a directory and picks the name, so
    // the copy is renamed to the one asked for.
    const directory = PathExt.dirname(target);

    await ensureDirectory(contents, directory);

    const copied = await contents.copy(from, directory);

    await contents.rename(copied.path, target);

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/**
 * The `directory-create` action: create a directory and any missing
 * parents. An existing directory is nothing to do.
 */
export class DirectoryCreateAction implements IActionImplementation {
  readonly type = 'directory-create';

  constructor(context: IFileActionContext) {
    this._context = context;
  }

  describe(request: IActionRequest): string {
    return `Create directory ${request.options.path ?? '(no path)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const path = requireOption(request, 'path');

    await ensureDirectory(
      this._context.app.serviceManager.contents,
      this._context.manager.resolvePath(path)
    );

    return { status: 'ok' };
  }

  private _context: IFileActionContext;
}

/** Whether a directive option is set on: present with no value, true or yes. */
function isTrue(value: string | undefined): boolean {
  return (
    value !== undefined && ['', 'true', 'yes', 'on'].includes(value.trim())
  );
}

/**
 * Close every document open under a directory, so a delete does not
 * leave tabs pointing at files that are gone.
 */
async function closeUnder(
  context: IFileActionContext,
  directory: string
): Promise<void> {
  const open: string[] = [];

  for (const widget of context.app.shell.widgets('main')) {
    const path = context.docManager.contextForWidget(widget)?.path;

    if (path && (path === directory || path.startsWith(`${directory}/`))) {
      open.push(path);
    }
  }

  for (const path of new Set(open)) {
    await context.docManager.closeFile(path);
  }
}

/**
 * Open a file in the text editor where its `area`, or the workshop's
 * layout, says, and wait until it is ready.
 *
 * If the file is already open and unmodified it is reloaded from disk so
 * that changes made by terminal commands are visible; it is moved only
 * when an area is asked for.
 */
export async function openEditor(
  context: IFileActionContext,
  serverPath: string,
  area?: string
): Promise<IDocumentWidget<FileEditor>> {
  const widget = await openDocument(context, serverPath, EDITOR_FACTORY, area);

  return asFileEditor(widget, serverPath);
}

/**
 * Open a file with the widget factory named, the text editor or a
 * viewer, where its `area`, or the workshop's layout, says, and wait
 * until it is ready. A file already open with that factory is revealed
 * and, when unmodified, reloaded from disk; it is moved only when an
 * area is asked for.
 */
export async function openDocument(
  context: IFileActionContext,
  serverPath: string,
  factory: string,
  area?: string
): Promise<IDocumentWidget> {
  const name = factoryName(context.app, factory);
  const existing =
    context.docManager.findWidget(serverPath, name) !== undefined;
  const options = existing
    ? undefined
    : context.layouts.placement('document', area);
  const widget = await openDocumentWidget(context, serverPath, name, options);

  await context.layouts.place(widget, 'document', area, {
    existed: existing,
    placed: !existing
  });

  return widget;
}

/**
 * Open a file in the text editor with the shell options given, or where
 * JupyterLab puts it, and wait until it is ready. A file already open and
 * unmodified is reloaded from disk.
 */
export async function openEditorWidget(
  context: {
    app: JupyterFrontEnd;
    docManager: IDocumentManager;
  },
  serverPath: string,
  options?: DocumentRegistry.IOpenOptions
): Promise<IDocumentWidget<FileEditor>> {
  const widget = await openDocumentWidget(
    context,
    serverPath,
    EDITOR_FACTORY,
    options
  );

  return asFileEditor(widget, serverPath);
}

/**
 * Open a file with a widget factory and the shell options given, or
 * where JupyterLab puts it, and wait until it is ready. A file already
 * open with that factory is revealed where it is and, when unmodified,
 * reloaded from disk, so a viewer shows what a command has since
 * written; the shell options apply only to a widget being opened.
 */
export async function openDocumentWidget(
  context: {
    app: JupyterFrontEnd;
    docManager: IDocumentManager;
  },
  serverPath: string,
  factory: string,
  options?: DocumentRegistry.IOpenOptions
): Promise<IDocumentWidget> {
  const name = factoryName(context.app, factory);
  const existing = context.docManager.findWidget(serverPath, name);
  const widget = context.docManager.openOrReveal(
    serverPath,
    name,
    undefined,
    existing ? undefined : options
  );

  if (!widget) {
    throw new Error(`Unable to open ${serverPath}`);
  }

  await widget.context.ready;

  if (existing && !widget.context.model.dirty) {
    await widget.context.revert();
  }

  return widget;
}

/**
 * The registered name of a widget factory, however the author spelt its
 * case: the document manager opens a factory by its lowercased name but
 * finds an open widget only by the exact one, so a name written in the
 * wrong case would open a second widget every time.
 */
function factoryName(app: JupyterFrontEnd, factory: string): string {
  const registered = app.docRegistry.getWidgetFactory(factory.trim());

  if (!registered) {
    throw new Error(`Unknown widget factory "${factory}"`);
  }

  return registered.name;
}

function findEditor(
  docManager: IDocumentManager,
  serverPath: string
): IDocumentWidget<FileEditor> | undefined {
  const widget = docManager.findWidget(serverPath, EDITOR_FACTORY);

  return widget && isFileEditor(widget) ? widget : undefined;
}

function asFileEditor(
  widget: IDocumentWidget,
  serverPath: string
): IDocumentWidget<FileEditor> {
  if (!isFileEditor(widget)) {
    throw new Error(`${serverPath} did not open in the text editor`);
  }

  return widget;
}

function isFileEditor(
  widget: IDocumentWidget
): widget is IDocumentWidget<FileEditor> {
  return widget.content instanceof FileEditor;
}

/**
 * Where a revealed position goes in the view: new text sits a quarter of
 * the way down, so it reads downward with a few lines of what came
 * before it above; existing text is centred so it has context on both
 * sides. Either is clamped by the ends of the file, so a match near the
 * top sits as far down as the lines before it allow.
 */
type RevealPlacement = 'upper' | 'center';

/** How far down the view the `upper` placement puts a position. */
const UPPER_FRACTION = 0.25;

/** The lines new text needs above it to be left where it already is. */
const UPPER_CONTEXT_LINES = 3;

/**
 * Scroll a position into view at the given placement, unless it is
 * already somewhere that serves, in which case nothing moves: anywhere
 * in view for the centre, and the upper half of the view for new text,
 * which would otherwise be left running off the bottom, though not so
 * near the top that nothing of what comes before it shows.
 */
function revealAt(
  editor: CodeEditor.IEditor,
  position: CodeEditor.IPosition,
  placement: RevealPlacement
): void {
  const coordinate = editor.getCoordinateForPosition(position);
  const viewport = editor.host.getBoundingClientRect();
  const upper = placement === 'upper';
  const lowest = upper ? viewport.top + viewport.height / 2 : viewport.bottom;

  // New text at the very top of the view would show nothing of what
  // comes before it, so it counts as placed only with lines above it,
  // or when it is so near the start of the file that there are none.
  const highest =
    upper && position.line >= UPPER_CONTEXT_LINES
      ? viewport.top + UPPER_CONTEXT_LINES * editor.lineHeight
      : viewport.top;

  if (coordinate && coordinate.top >= highest && coordinate.bottom <= lowest) {
    return;
  }

  // The abstract editor reveals a position only where it chooses, so the
  // placement is asked of CodeMirror itself.
  const view = editorView(editor);

  if (!view) {
    editor.revealPosition(position);

    return;
  }

  view.dispatch({
    effects: EditorView.scrollIntoView(
      editor.getOffsetAt(position),
      placement === 'upper'
        ? {
            y: 'start',
            yMargin: Math.round(view.scrollDOM.clientHeight * UPPER_FRACTION)
          }
        : { y: 'center' }
    )
  });
}

function revealLine(
  widget: IDocumentWidget<FileEditor>,
  lineIndex: number,
  placement: RevealPlacement
): void {
  const editor = widget.content.editor;
  const line = Math.max(0, Math.min(lineIndex, editor.lineCount - 1));

  // Setting the cursor scrolls minimally on its own, which would put the
  // line at the edge of the view and count as already in view; the
  // placement below decides where it goes.
  editor.setCursorPosition({ line, column: 0 }, { scroll: false });
  revealAt(editor, { line, column: 0 }, placement);
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
 * Whether a span of a file is whole lines: it starts at the start of a
 * line and takes the newline of its last.
 */
function isWholeLines(source: string, span: IOffsetSpan): boolean {
  return (
    span.end > span.start &&
    (span.start === 0 || source[span.start - 1] === '\n') &&
    source[span.end - 1] === '\n'
  );
}

/**
 * The span of a block of whole lines, from the start of its first line
 * to the start of the line after its last, or the end of the file.
 */
function lineBlockSpan(
  editor: CodeEditor.IEditor,
  firstLine: number,
  lines: number
): IOffsetSpan {
  const offsetOfLine = (line: number): number =>
    line < editor.lineCount
      ? editor.getOffsetAt({ line, column: 0 })
      : editor.model.sharedModel.getSource().length;

  return {
    start: offsetOfLine(Math.max(0, firstLine)),
    end: offsetOfLine(firstLine + lines)
  };
}

/**
 * Show what an edit changed: mark the new text, in file order, and put
 * the cursor at the start of the first of it, scrolled to where new
 * text goes. The text is marked rather than selected so a stray key
 * press cannot replace it. An empty span, as a deletion leaves, marks
 * the place the text was.
 */
function showChange(
  widget: IDocumentWidget<FileEditor>,
  spans: IChangedSpan[]
): void {
  const editor = widget.content.editor;
  const start = editor.getPositionAt(spans[0].start);

  if (!start) {
    return;
  }

  editor.setCursorPosition(start, { scroll: false });
  revealAt(editor, start, 'upper');
  markChanged(editor, spans);
}

/**
 * Select a span of the file and scroll to its start, returning the range
 * selected. An empty span just places the cursor.
 */
function showSpan(
  widget: IDocumentWidget<FileEditor>,
  span: IOffsetSpan,
  placement: RevealPlacement
): CodeEditor.IRange | undefined {
  const editor = widget.content.editor;
  const start = editor.getPositionAt(span.start);
  const end = editor.getPositionAt(span.end);

  if (!start || !end) {
    return undefined;
  }

  // The placement decides the scroll, so the cursor is set without one;
  // a selection is placed after the scroll for the same reason.
  revealAt(editor, start, placement);

  if (span.end > span.start) {
    editor.setSelection({ start, end });
  } else {
    editor.setCursorPosition(start, { scroll: false });
  }

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
