import { environmentVariables } from '@educates/workshop-core';
import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { Terminal as TerminalService } from '@jupyterlab/services';
import { Terminal } from '@jupyterlab/terminal';
import { terminalIcon } from '@jupyterlab/ui-components';
import { Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import { WORKSHOP_STATE_DIR } from '../state';
import {
  IActionImplementation,
  IActionRequest,
  IActionResult,
  IWorkshopManager
} from '../tokens';
import { parseDuration, sleep } from '../util';
import { requireBody, requireOption } from './registry';
import { IShellRunner } from './shell';

/** Name of the terminal used when an action does not name one. */
export const DEFAULT_SESSION = 'workshop';

/** Where a new terminal is placed relative to the main area. */
export type TerminalArea = 'bottom' | 'right' | 'main';

/** Longest wait for a new terminal's shell to print its prompt. */
const PROMPT_WAIT_MS = 15000;

/** Quiet time after the last output that counts as the prompt being up. */
const PROMPT_QUIET_MS = 500;

const PROMPT_POLL_MS = 100;

/** How much recent terminal output is kept for matching. */
export const OUTPUT_WINDOW = 4096;

const KEY_NAMES: Readonly<Record<string, string>> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-l': '\x0c',
  'ctrl-z': '\x1a'
};

/**
 * Terminals opened by the workshop, keyed by the session name used in
 * workshop pages.
 *
 * The first terminal opens in a split beneath the main area; later ones
 * open beside it. New terminals source the workshop environment file so
 * that variables are available as environment variables.
 */
export class TerminalSessions {
  constructor(options: TerminalSessions.IOptions) {
    this._app = options.app;
    this._shell = options.shell;
    this._manager = options.manager;
  }

  /** The first terminal opened, used as the anchor for layout. */
  get first(): MainAreaWidget<Terminal> | null {
    return this._first && !this._first.isDisposed ? this._first : null;
  }

  /** Emitted with text a workshop terminal printed. */
  get output(): ISignal<this, { name: string; text: string }> {
    return this._output;
  }

  /** Emitted with text sent to a workshop terminal, typed or by an action. */
  get input(): ISignal<this, { name: string; text: string }> {
    return this._input;
  }

  /** The names of the terminals that are open. */
  names(): string[] {
    return [...this._widgets.entries()]
      .filter(([, widget]) => !widget.isDisposed)
      .map(([name]) => name);
  }

  /**
   * Whether a terminal with the session name is open.
   */
  has(name: string): boolean {
    const widget = this._widgets.get(name);

    return widget !== undefined && !widget.isDisposed;
  }

  /**
   * Return the terminal for a session name, starting it if necessary.
   */
  async get(
    name: string,
    options: { cwd?: string; area?: TerminalArea } = {}
  ): Promise<MainAreaWidget<Terminal>> {
    const existing = this._widgets.get(name);

    if (existing && !existing.isDisposed) {
      return existing;
    }

    // Concurrent requests for the same name share one start-up.
    let pending = this._pending.get(name);

    if (!pending) {
      pending = this._start(name, options).finally(() =>
        this._pending.delete(name)
      );
      this._pending.set(name, pending);
    }

    return pending;
  }

  private async _start(
    name: string,
    options: { cwd?: string; area?: TerminalArea }
  ): Promise<MainAreaWidget<Terminal>> {
    // Start a new terminal session on the server and wrap it in a widget.
    const session = await this._app.serviceManager.terminals.startNew({
      cwd: options.cwd
    });
    const terminal = new Terminal(session, {});
    const widget = new MainAreaWidget({ content: terminal });

    widget.id = `educates-workshop-terminal-${name}`;
    widget.title.label = name;
    widget.title.caption = `Workshop terminal "${name}"`;
    widget.title.icon = terminalIcon;
    widget.title.closable = true;

    // Place the first terminal under the main area and later ones beside it.
    const anchor = this.first;
    const area = options.area ?? (anchor ? 'right' : 'bottom');

    this._shell.add(
      widget,
      'main',
      area === 'main'
        ? { activate: false }
        : anchor
          ? { mode: `split-${area}`, ref: anchor.id, activate: false }
          : { mode: `split-${area}`, activate: false }
    );

    if (!anchor) {
      this._first = widget;
    }

    this._widgets.set(name, widget);

    // Relay what the terminal prints so verifies can react to it, and
    // note when it last printed anything, to tell when the shell is up.
    let lastOutputAt = 0;
    const onMessage = (
      _: TerminalService.ITerminalConnection,
      message: TerminalService.IMessage
    ): void => {
      if (message.type === 'stdout' && message.content) {
        lastOutputAt = Date.now();
        this._output.emit({ name, text: message.content.map(String).join('') });
      }
    };

    session.messageReceived.connect(onMessage);

    // Everything sent to the terminal passes through the connection's
    // public send method, so wrapping it is how typed input is observed
    // for the recorder; the original is put back when the widget goes.
    const send = session.send.bind(session);

    session.send = (message: TerminalService.IMessage): void => {
      if (message.type === 'stdin' && message.content) {
        this._input.emit({ name, text: message.content.map(String).join('') });
      }

      send(message);
    };

    widget.disposed.connect(() => {
      session.send = send;
      session.messageReceived.disconnect(onMessage);

      if (this._widgets.get(name) === widget) {
        this._widgets.delete(name);
      }

      if (this._first === widget) {
        this._first = null;
      }
    });

    await terminal.ready;

    // Wait for the shell to print its prompt and go quiet before typing
    // anything. The JupyterLite shell starts by asking the terminal for
    // its colours, and input sent while that exchange is in flight gets
    // mixed up with the reply.
    const started = Date.now();

    while (Date.now() - started < PROMPT_WAIT_MS) {
      await sleep(PROMPT_POLL_MS);

      if (lastOutputAt > 0 && Date.now() - lastOutputAt >= PROMPT_QUIET_MS) {
        break;
      }
    }

    // Expose the workshop variables to the shell.
    const source = envSourceCommand(this._manager);

    if (source) {
      this._write(session, `${source}\n`);
    }

    return widget;
  }

  /**
   * Send text to a terminal connection. The JupyterLite terminal's shell
   * takes a carriage return as Enter, as a keyboard sends, where a pty
   * accepts a newline as well.
   */
  private _write(
    session: TerminalService.ITerminalConnection,
    text: string
  ): void {
    const content =
      this._manager.platform?.shell === 'cockle'
        ? text.replace(/\r?\n/g, '\r')
        : text;

    session.send({ type: 'stdin', content: [content] });
  }

  /**
   * Send text to the terminal for a session name, starting it if needed,
   * and bring the terminal into view.
   */
  async send(name: string, text: string, cwd?: string): Promise<void> {
    const widget = await this.get(name, { cwd });

    this._shell.activateById(widget.id);
    this._write(widget.content.session, text);
  }

  /**
   * Resolve to true when a terminal prints the text, or false after the
   * timeout. Call before sending the command that produces the text.
   * Output is matched across messages, since a terminal may deliver a
   * line in pieces (the JupyterLite terminal sends one character at a
   * time).
   */
  waitForOutput(
    name: string,
    text: string,
    timeoutMs: number
  ): Promise<boolean> {
    return new Promise(resolve => {
      let recent = '';
      const onOutput = (
        _: this,
        args: { name: string; text: string }
      ): void => {
        if (args.name !== name) {
          return;
        }

        recent = (recent + args.text).slice(-OUTPUT_WINDOW);

        if (recent.includes(text)) {
          finish(true);
        }
      };
      const timer = window.setTimeout(() => finish(false), timeoutMs);
      const finish = (result: boolean): void => {
        window.clearTimeout(timer);
        this._output.disconnect(onOutput);
        resolve(result);
      };

      this._output.connect(onOutput);
    });
  }

  /**
   * Re-source the environment file in every open terminal.
   */
  refreshEnvironment(): void {
    const source = envSourceCommand(this._manager);

    if (!source) {
      return;
    }

    for (const widget of this._widgets.values()) {
      if (!widget.isDisposed) {
        this._write(widget.content.session, `${source}\n`);
      }
    }
  }

  private _app: JupyterFrontEnd;
  private _shell: ILabShell;
  private _manager: IWorkshopManager;
  private _widgets = new Map<string, MainAreaWidget<Terminal>>();
  private _pending = new Map<string, Promise<MainAreaWidget<Terminal>>>();
  private _first: MainAreaWidget<Terminal> | null = null;
  private _output = new Signal<this, { name: string; text: string }>(this);
  private _input = new Signal<this, { name: string; text: string }>(this);
}

export namespace TerminalSessions {
  export interface IOptions {
    app: JupyterFrontEnd;
    shell: ILabShell;
    manager: IWorkshopManager;
  }
}

/** The workshop terminals, shared by the actions and the recorder. */
export const ITerminalSessions = new Token<TerminalSessions>(
  '@educates/jupyterlab-workshop:ITerminalSessions',
  'Terminals opened by the workshop, keyed by session name.'
);

/**
 * The command that loads the workshop environment file in the platform's
 * shell, or null when the shell is not supported.
 */
export function envSourceCommand(manager: IWorkshopManager): string | null {
  const platform = manager.platform;

  if (!platform || !manager.workshop) {
    return null;
  }

  switch (platform.shell) {
    case 'bash':
    case 'zsh':
    case 'sh': {
      const path = manager.absolutePath(`${WORKSHOP_STATE_DIR}/env.sh`);

      return `source '${path.replace(/'/g, "'\\''")}'`;
    }
    case 'powershell': {
      const path = manager.absolutePath(`${WORKSHOP_STATE_DIR}/env.ps1`);

      return `. '${path.replace(/'/g, "''")}'`;
    }
    case 'cmd': {
      const path = manager.absolutePath(`${WORKSHOP_STATE_DIR}/env.cmd`);

      return `call "${path}"`;
    }
    case 'cockle':
      return cockleExports(manager.variables.values);
    default:
      return null;
  }
}

/**
 * One line of `export` commands setting the variables, for the JupyterLite
 * terminal, whose cockle shell cannot source a file. Values are quoted
 * with whichever quote they do not contain; a value with both is left
 * out.
 */
export function cockleExports(
  variables: Record<string, string>
): string | null {
  const parts: string[] = [];

  for (const [name, value] of Object.entries(environmentVariables(variables))) {
    if (!value.includes("'")) {
      parts.push(`export ${name}='${value}'`);
    } else if (!value.includes('"')) {
      parts.push(`export ${name}="${value}"`);
    }
  }

  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * A command that prints the marker without the typed line itself
 * containing it, so the echo of the input cannot be mistaken for output.
 */
export function markerCommand(
  manager: IWorkshopManager,
  marker: string
): string | null {
  const split = `${marker.slice(0, 6)}""${marker.slice(6)}`;

  switch (manager.platform?.shell) {
    case 'bash':
    case 'zsh':
    case 'sh':
    case 'fish':
      return `echo ${split}`;
    case 'powershell':
      return `Write-Output ("${marker.slice(0, 6)}" + "${marker.slice(6)}")`;
    case 'cmd':
      // The caret is cmd's escape character and vanishes from the output,
      // so the typed line never contains the marker itself.
      return `echo ${marker.slice(0, 6)}^${marker.slice(6)}`;
    case 'cockle':
      // Two echoes, the first without a newline, print the marker in one
      // piece while the typed line shows it split.
      return `echo -n ${marker.slice(0, 6)}; echo ${marker.slice(6)}`;
    default:
      return null;
  }
}

/**
 * Translate key names such as `enter` or `ctrl-c` into terminal input.
 */
export function translateKeys(spec: string): string {
  return spec
    .split(/[\s,]+/)
    .filter(part => part !== '')
    .map(part => KEY_NAMES[part.toLowerCase()] ?? part)
    .join('');
}

function sessionName(request: IActionRequest): string {
  return request.options.session || DEFAULT_SESSION;
}

function terminalCwd(
  request: IActionRequest,
  manager: IWorkshopManager
): string | undefined {
  return request.options.cwd
    ? manager.resolvePath(request.options.cwd)
    : manager.workshop?.path;
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
    const command = requireBody(request, 'a command').replace(/\r\n/g, '\n');
    const name = sessionName(request);
    const wait = request.options.wait;

    // `wait: prompt` follows the command with a marker command and waits
    // for the marker to be printed, which happens once the shell is back
    // at its prompt. Any other value is a duration to pause for.
    if (wait === 'prompt') {
      const marker = `__WORKSHOP_DONE_${Date.now().toString(36)}__`;
      const echo = markerCommand(this._manager, marker);

      if (!echo) {
        return {
          status: 'error',
          message: 'Waiting for the prompt is not supported by this shell'
        };
      }

      const timeout = parseDuration(request.options.timeout, 120000);
      const seen = this._terminals.waitForOutput(name, marker, timeout);

      await this._terminals.send(
        name,
        `${command.replace(/\n+$/, '')}\n${echo}\n`,
        terminalCwd(request, this._manager)
      );

      if (!(await seen)) {
        return {
          status: 'error',
          message: `The command did not finish within ${Math.round(timeout / 1000)}s`
        };
      }

      return { status: 'ok' };
    }

    await this._terminals.send(
      name,
      command.endsWith('\n') ? command : `${command}\n`,
      terminalCwd(request, this._manager)
    );

    if (wait && wait !== 'none') {
      await sleep(parseDuration(wait, 0));
    }

    return { status: 'ok' };
  }

  private _terminals: TerminalSessions;
  private _manager: IWorkshopManager;
}

/**
 * The `execute-capture` action: run a command without a terminal and
 * capture its output into a variable. The command goes through the
 * workshop kernel on a server and through the headless terminal shell in
 * JupyterLite.
 */
export class ExecuteCaptureAction implements IActionImplementation {
  readonly type = 'execute-capture';

  constructor(shell: IShellRunner, manager: IWorkshopManager) {
    this._shell = shell;
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return request.options.capture
      ? `Capture into ${request.options.capture}`
      : 'Run in the background';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const command = requireBody(request, 'a command');
    const cwd = this._manager.absolutePath(request.options.cwd ?? '');
    const timeout = parseDuration(request.options.timeout, 60000);
    const result = await this._shell.run(command, cwd, timeout);

    if (result.code !== 0) {
      return {
        status: 'error',
        message: `Exit code ${result.code}: ${(result.error || result.output).trim()}`
      };
    }

    const captured = request.options.capture
      ? { [request.options.capture]: result.output.trim() }
      : undefined;

    return { status: 'ok', message: result.output.trim(), captured };
  }

  private _shell: IShellRunner;
  private _manager: IWorkshopManager;
}

/**
 * The `terminal-open` action: open or reveal a named terminal.
 */
export class TerminalOpenAction implements IActionImplementation {
  readonly type = 'terminal-open';

  constructor(
    terminals: TerminalSessions,
    shell: ILabShell,
    manager: IWorkshopManager
  ) {
    this._terminals = terminals;
    this._shell = shell;
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return `Open terminal "${sessionName(request)}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const area = request.options.area;
    const widget = await this._terminals.get(sessionName(request), {
      cwd: terminalCwd(request, this._manager),
      area:
        area === 'bottom' || area === 'right' || area === 'main'
          ? area
          : undefined
    });

    this._shell.activateById(widget.id);

    return { status: 'ok' };
  }

  private _terminals: TerminalSessions;
  private _shell: ILabShell;
  private _manager: IWorkshopManager;
}

/**
 * The `terminal-clear` action: clear the screen of a terminal.
 */
export class TerminalClearAction implements IActionImplementation {
  readonly type = 'terminal-clear';

  constructor(terminals: TerminalSessions, manager: IWorkshopManager) {
    this._terminals = terminals;
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return `Clear terminal "${sessionName(request)}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    await this._terminals.send(
      sessionName(request),
      'clear\n',
      terminalCwd(request, this._manager)
    );

    return { status: 'ok' };
  }

  private _terminals: TerminalSessions;
  private _manager: IWorkshopManager;
}

/**
 * The `terminal-type` action: type text without pressing Enter.
 */
export class TerminalTypeAction implements IActionImplementation {
  readonly type = 'terminal-type';

  constructor(terminals: TerminalSessions, manager: IWorkshopManager) {
    this._terminals = terminals;
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return `Type into terminal "${sessionName(request)}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    await this._terminals.send(
      sessionName(request),
      requireBody(request, 'text').replace(/\n$/, ''),
      terminalCwd(request, this._manager)
    );

    return { status: 'ok' };
  }

  private _terminals: TerminalSessions;
  private _manager: IWorkshopManager;
}

/**
 * The `send-key` action: send key strokes such as `ctrl-c` or `q`.
 */
export class SendKeyAction implements IActionImplementation {
  readonly type = 'send-key';

  constructor(terminals: TerminalSessions, manager: IWorkshopManager) {
    this._terminals = terminals;
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return `Send ${request.options.keys ?? 'keys'} to terminal "${sessionName(request)}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const keys = translateKeys(requireOption(request, 'keys'));

    await this._terminals.send(
      sessionName(request),
      keys,
      terminalCwd(request, this._manager)
    );

    return { status: 'ok' };
  }

  private _terminals: TerminalSessions;
  private _manager: IWorkshopManager;
}

/**
 * The `interrupt` action: send Ctrl-C to a terminal.
 */
export class InterruptAction implements IActionImplementation {
  readonly type = 'interrupt';

  constructor(terminals: TerminalSessions, manager: IWorkshopManager) {
    this._terminals = terminals;
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return `Interrupt terminal "${sessionName(request)}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    await this._terminals.send(
      sessionName(request),
      '\x03',
      terminalCwd(request, this._manager)
    );

    return { status: 'ok' };
  }

  private _terminals: TerminalSessions;
  private _manager: IWorkshopManager;
}
