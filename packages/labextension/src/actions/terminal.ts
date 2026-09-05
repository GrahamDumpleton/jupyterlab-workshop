import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { Terminal } from '@jupyterlab/terminal';
import { terminalIcon } from '@jupyterlab/ui-components';

import {
  IActionImplementation,
  IActionRequest,
  IActionResult,
  IWorkshopManager
} from '../tokens';

/** Name of the terminal used when an action does not name one. */
export const DEFAULT_SESSION = 'workshop';

/**
 * Terminals opened by the workshop, keyed by the session name used in
 * workshop pages.
 *
 * The first terminal opens in a split beneath the main area; later ones
 * open beside it.
 */
export class TerminalSessions {
  constructor(options: TerminalSessions.IOptions) {
    this._app = options.app;
    this._shell = options.shell;
  }

  /** The first terminal opened, used as the anchor for layout. */
  get first(): MainAreaWidget<Terminal> | null {
    return this._first && !this._first.isDisposed ? this._first : null;
  }

  /**
   * Return the terminal for a session name, starting it if necessary.
   */
  async get(name: string, cwd?: string): Promise<MainAreaWidget<Terminal>> {
    const existing = this._widgets.get(name);

    if (existing && !existing.isDisposed) {
      return existing;
    }

    // Start a new terminal session on the server and wrap it in a widget.
    const session = await this._app.serviceManager.terminals.startNew({ cwd });
    const terminal = new Terminal(session, {});
    const widget = new MainAreaWidget({ content: terminal });

    widget.id = `educates-workshop-terminal-${name}`;
    widget.title.label = name;
    widget.title.caption = `Workshop terminal "${name}"`;
    widget.title.icon = terminalIcon;
    widget.title.closable = true;

    // Place the first terminal under the main area and later ones beside it.
    const anchor = this.first;

    this._shell.add(
      widget,
      'main',
      anchor
        ? { mode: 'split-right', ref: anchor.id, activate: false }
        : { mode: 'split-bottom', activate: false }
    );

    if (!anchor) {
      this._first = widget;
    }

    this._widgets.set(name, widget);

    widget.disposed.connect(() => {
      if (this._widgets.get(name) === widget) {
        this._widgets.delete(name);
      }

      if (this._first === widget) {
        this._first = null;
      }
    });

    await terminal.ready;

    return widget;
  }

  /**
   * Send text to the terminal for a session name, starting it if needed,
   * and bring the terminal into view.
   */
  async send(name: string, text: string, cwd?: string): Promise<void> {
    const widget = await this.get(name, cwd);

    this._shell.activateById(widget.id);
    widget.content.session.send({ type: 'stdin', content: [text] });
  }

  private _app: JupyterFrontEnd;
  private _shell: ILabShell;
  private _widgets = new Map<string, MainAreaWidget<Terminal>>();
  private _first: MainAreaWidget<Terminal> | null = null;
}

export namespace TerminalSessions {
  export interface IOptions {
    app: JupyterFrontEnd;
    shell: ILabShell;
  }
}

/**
 * The `execute` action: run a command in a named terminal.
 */
export class ExecuteAction implements IActionImplementation {
  readonly type = 'execute';

  constructor(terminals: TerminalSessions, manager: IWorkshopManager) {
    this._terminals = terminals;
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return `Run in terminal "${sessionName(request)}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const command = request.body.replace(/\r\n/g, '\n');

    if (command.trim() === '') {
      return { status: 'error', message: 'The execute action needs a command' };
    }

    // New terminals start in the workshop directory unless told otherwise.
    const cwd = request.options.cwd
      ? this._manager.resolvePath(request.options.cwd)
      : this._manager.workshop?.path;

    await this._terminals.send(
      sessionName(request),
      command.endsWith('\n') ? command : `${command}\n`,
      cwd
    );

    return { status: 'ok' };
  }

  private _terminals: TerminalSessions;
  private _manager: IWorkshopManager;
}

function sessionName(request: IActionRequest): string {
  return request.options.session || DEFAULT_SESSION;
}
