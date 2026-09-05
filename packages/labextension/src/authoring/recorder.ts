import { IRecording, RecordedEvent } from '@educates/workshop-core';
import { JupyterFrontEnd } from '@jupyterlab/application';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { NotebookActions } from '@jupyterlab/notebook';
import { Contents, Terminal as TerminalService } from '@jupyterlab/services';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { ISignal, Signal } from '@lumino/signaling';

import { DEFAULT_SESSION, TerminalSessions } from '../actions/terminal';
import { WORKSHOP_STATE_DIR } from '../state';
import { IWorkshopManager } from '../tokens';

/** How many events are kept for "capture from session" when not recording. */
const RECENT_LIMIT = 25;

/** Files larger than this are not captured as file writes. */
const CONTENT_LIMIT = 200_000;

/** What has been typed into one terminal since the last Enter. */
interface ILineState {
  text: string;
  uncertain: boolean;
  pasting: boolean;
}

const MANIFEST_FILE = 'workshop.yaml';

/**
 * Watches what the author does in the session, terminal commands, file
 * saves, cell runs and files opened, and keeps the events for drafting
 * pages. The recorder listens while author mode is on so the last few
 * events can be captured into a page, and keeps everything while a
 * recording is in progress.
 */
export class Recorder {
  constructor(options: Recorder.IOptions) {
    this._app = options.app;
    this._manager = options.manager;
    this._terminals = options.terminals;
    this._docManager = options.docManager;
    this._tracker = options.terminalTracker;
  }

  /** Emitted when recording starts or stops or an event is added. */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /** Whether a recording is in progress. */
  get recording(): boolean {
    return this._recording;
  }

  /** Whether the recorder is watching the session at all. */
  get listening(): boolean {
    return this._listening;
  }

  /** Events of the recording in progress. */
  get events(): readonly RecordedEvent[] {
    return this._events;
  }

  /** The most recent events, newest last, for capturing into a page. */
  get recent(): readonly RecordedEvent[] {
    return this._recent;
  }

  /**
   * Start watching the session.
   */
  enable(): void {
    if (this._listening) {
      return;
    }

    this._listening = true;
    this._terminals.input.connect(this._onInput, this);
    this._app.serviceManager.contents.fileChanged.connect(
      this._onFileChanged,
      this
    );
    NotebookActions.executed.connect(this._onCellExecuted, this);
    this._docManager.activateRequested.connect(this._onActivated, this);

    // Terminals the author opened from the launcher are watched too, by
    // wrapping the public send method of their connections as the
    // workshop's own terminals do.
    if (this._tracker) {
      this._tracker.forEach(widget =>
        this._watchTerminal(widget.content.session)
      );
      this._tracker.widgetAdded.connect(this._onTerminalAdded, this);
    }
  }

  /**
   * Stop watching the session.
   */
  disable(): void {
    if (!this._listening) {
      return;
    }

    this._listening = false;
    this._terminals.input.disconnect(this._onInput, this);
    this._app.serviceManager.contents.fileChanged.disconnect(
      this._onFileChanged,
      this
    );
    NotebookActions.executed.disconnect(this._onCellExecuted, this);
    this._docManager.activateRequested.disconnect(this._onActivated, this);
    this._tracker?.widgetAdded.disconnect(this._onTerminalAdded, this);

    for (const restore of this._unwatch) {
      restore();
    }

    this._unwatch = [];
  }

  /**
   * Begin a recording, forgetting any earlier one.
   */
  start(): void {
    this._events = [];
    this._recording = true;
    this._started = new Date().toISOString();
    this.enable();
    this._changed.emit();
  }

  /**
   * End the recording and return it.
   */
  stop(): IRecording {
    this._recording = false;
    this._changed.emit();

    return { version: 1, started: this._started, events: [...this._events] };
  }

  /**
   * Mark the start of a new page in the recording.
   */
  pageBreak(title: string): void {
    this._push({ kind: 'page-break', ts: now(), title });
  }

  private _onTerminalAdded(
    _: ITerminalTracker,
    widget: { content: { session: TerminalService.ITerminalConnection } }
  ): void {
    this._watchTerminal(widget.content.session);
  }

  private _watchTerminal(session: TerminalService.ITerminalConnection): void {
    const send = session.send.bind(session);

    session.send = (message: TerminalService.IMessage): void => {
      if (message.type === 'stdin' && message.content) {
        this._onInput(this._terminals, {
          name: DEFAULT_SESSION,
          text: message.content.map(String).join('')
        });
      }

      send(message);
    };

    this._unwatch.push(() => {
      session.send = send;
    });
  }

  private _onInput(
    _: TerminalSessions,
    args: { name: string; text: string }
  ): void {
    // Keystrokes arrive one at a time or as pasted runs; assemble them
    // into the line the shell will see, as far as that can be known.
    const state = this._line(args.name);
    const text = args.text;
    let index = 0;

    while (index < text.length) {
      const char = text[index];

      if (char === '\x1b') {
        if (text.startsWith('\x1b[200~', index)) {
          state.pasting = true;
          index += 6;
          continue;
        }

        if (text.startsWith('\x1b[201~', index)) {
          state.pasting = false;
          index += 6;
          continue;
        }

        const sequence =
          // eslint-disable-next-line no-control-regex
          /^\x1b(\[[0-9;?]*[A-Za-z~]|O[A-Za-z]|.)/s.exec(
            text.slice(index)
          )?.[0] ?? '\x1b';

        // Arrow up and down recall history, so the typed text is not the
        // command that ran.
        // eslint-disable-next-line no-control-regex
        if (/^\x1b(\[|O)[AB]$/.test(sequence)) {
          state.uncertain = true;
        }

        index += sequence.length;
        continue;
      }

      if (char === '\r' || char === '\n') {
        if (state.pasting) {
          state.text += '\n';
        } else {
          this._submit(args.name, state);
        }
      } else if (char === '\x7f' || char === '\b') {
        state.text = state.text.slice(0, -1);
      } else if (char === '\x03' || char === '\x15') {
        state.text = '';
        state.uncertain = false;
      } else if (char === '\x17') {
        state.text = state.text.replace(/\S+\s*$/, '');
      } else if (char === '\t') {
        state.uncertain = true;
      } else if (char >= ' ') {
        state.text += char;
      }

      index += 1;
    }
  }

  private _submit(name: string, state: ILineState): void {
    const command = state.text.trim();
    const uncertain = state.uncertain;

    state.text = '';
    state.uncertain = false;

    // The extension's own housekeeping lines are not the author's steps.
    if (
      command === '' ||
      command.includes('SHOP_DONE') ||
      command.includes(`${WORKSHOP_STATE_DIR}/env.`) ||
      command.includes(`${WORKSHOP_STATE_DIR}\\env.`)
    ) {
      return;
    }

    this._push({
      kind: 'terminal',
      ts: now(),
      session: name,
      command,
      ...(uncertain ? { uncertain: true } : {})
    });
  }

  private _onFileChanged(
    _: Contents.IManager,
    change: Contents.IChangedArgs
  ): void {
    const path = change.newValue?.path;

    if (change.type !== 'save' || !path || this._ignored(path)) {
      return;
    }

    if (path.endsWith('.ipynb')) {
      return;
    }

    void this._captureFile(path);
  }

  private async _captureFile(path: string): Promise<void> {
    let content: string;

    try {
      const model = await this._app.serviceManager.contents.get(path, {
        content: true,
        type: 'file',
        format: 'text'
      });

      if (typeof model.content !== 'string') {
        return;
      }

      content = model.content;
    } catch {
      return;
    }

    if (content.length > CONTENT_LIMIT) {
      return;
    }

    const previous = this._previous.get(path) ?? null;

    this._previous.set(path, content);
    this._push({
      kind: 'file-saved',
      ts: now(),
      path: this._relative(path),
      content,
      previous
    });
  }

  private _onCellExecuted(
    _: unknown,
    args: {
      notebook: { parent: unknown };
      cell: { model: { sharedModel: { getSource(): string } } };
    }
  ): void {
    const panel = args.notebook.parent as {
      context?: { path?: string };
    } | null;
    const path = panel?.context?.path;

    if (!path || this._ignored(path)) {
      return;
    }

    this._push({
      kind: 'cell-executed',
      ts: now(),
      path: this._relative(path),
      source: args.cell.model.sharedModel.getSource()
    });
  }

  private _onActivated(_: IDocumentManager, path: string): void {
    if (this._ignored(path)) {
      return;
    }

    // Repeated activations of the same file are one opening.
    const last = this._recent[this._recent.length - 1];

    if (last?.kind === 'file-opened' && last.path === this._relative(path)) {
      return;
    }

    this._push({ kind: 'file-opened', ts: now(), path: this._relative(path) });
  }

  private _ignored(path: string): boolean {
    // The workshop's own files are being edited, not demonstrated.
    const workshop = this._manager.workshop;

    if (!workshop) {
      return false;
    }

    const prefix = workshop.path === '' ? '' : `${workshop.path}/`;

    if (!path.startsWith(prefix)) {
      return false;
    }

    const relative = path.slice(prefix.length);

    return (
      relative === MANIFEST_FILE ||
      relative.startsWith(`${WORKSHOP_STATE_DIR}/`) ||
      workshop.manifest.pages.includes(relative)
    );
  }

  private _relative(path: string): string {
    const workshop = this._manager.workshop;
    const prefix = workshop && workshop.path !== '' ? `${workshop.path}/` : '';

    return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  private _line(name: string): ILineState {
    let state = this._lines.get(name);

    if (!state) {
      state = { text: '', uncertain: false, pasting: false };
      this._lines.set(name, state);
    }

    return state;
  }

  private _push(event: RecordedEvent): void {
    if (this._recording) {
      this._events.push(event);
    }

    if (event.kind !== 'page-break') {
      this._recent.push(event);

      if (this._recent.length > RECENT_LIMIT) {
        this._recent.splice(0, this._recent.length - RECENT_LIMIT);
      }
    }

    this._changed.emit();
  }

  private _app: JupyterFrontEnd;
  private _manager: IWorkshopManager;
  private _terminals: TerminalSessions;
  private _docManager: IDocumentManager;
  private _tracker: ITerminalTracker | null;
  private _changed = new Signal<this, void>(this);
  private _listening = false;
  private _recording = false;
  private _started = '';
  private _events: RecordedEvent[] = [];
  private _recent: RecordedEvent[] = [];
  private _previous = new Map<string, string>();
  private _lines = new Map<string, ILineState>();
  private _unwatch: (() => void)[] = [];
}

export namespace Recorder {
  export interface IOptions {
    app: JupyterFrontEnd;
    manager: IWorkshopManager;
    terminals: TerminalSessions;
    docManager: IDocumentManager;
    terminalTracker: ITerminalTracker | null;
  }
}

function now(): string {
  return new Date().toISOString();
}
