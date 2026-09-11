import {
  IPromptMarker,
  PromptScanner,
  terminalEnvironment
} from '@jupyterlab-workshop/core';
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
import { IShellRunner, commandEnvironment } from './shell';

/** Name of the terminal used when an action does not name one. */
export const DEFAULT_SESSION = 'workshop';

/** Where a new terminal is placed relative to the main area. */
export type TerminalArea = 'bottom' | 'right' | 'main';

/** Longest wait for a new terminal's shell to print its prompt. */
const PROMPT_WAIT_MS = 15000;

/** Quiet time after the last output that counts as the prompt being up. */
const PROMPT_QUIET_MS = 500;

const PROMPT_POLL_MS = 100;

/**
 * Longest wait for the first marked prompt after a terminal loads the
 * environment file, before deciding the marker does not get through.
 */
const PROMPT_PROBE_MS = 5000;

/**
 * How long a terminal is given to draw its prompt again after the
 * environment file is loaded into it a second time. A shell busy with a
 * command of the learner's reads the line once that is done.
 */
const PROMPT_RELOAD_MS = 60000;

/** Shells whose environment file installs the marked prompt. */
const PROMPT_HOOK_SHELLS: ReadonlySet<string> = new Set([
  'bash',
  'zsh',
  'sh',
  'fish',
  'powershell',
  'cmd'
]);

/** Shells that take Enter only as a carriage return, never as a newline. */
const CARRIAGE_RETURN_SHELLS: ReadonlySet<string> = new Set([
  'powershell',
  'cmd',
  'cockle'
]);

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
 * that variables are available as environment variables and the workshop
 * prompt, with its marker, is installed.
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

  /** The names of the terminals that are open or still starting. */
  names(): string[] {
    const open = [...this._widgets.entries()]
      .filter(([, widget]) => !widget.isDisposed)
      .map(([name]) => name);

    return [...new Set([...open, ...this._pending.keys()])];
  }

  /**
   * Whether a terminal with the session name is open.
   */
  has(name: string): boolean {
    const widget = this._widgets.get(name);

    return widget !== undefined && !widget.isDisposed;
  }

  /**
   * Close the terminal for a session name and end its session. Nothing
   * happens when no such terminal is open.
   */
  async close(name: string): Promise<void> {
    // A terminal still starting is waited for, so that it cannot appear
    // after everything else has been cleared away.
    const pending = this._pending.get(name);
    const widget = pending ? await pending : this._widgets.get(name);

    if (!widget || widget.isDisposed) {
      return;
    }

    try {
      await widget.content.session.shutdown();
    } catch (error) {
      console.warn(`Unable to shut down terminal "${name}"`, error);
    }

    widget.dispose();
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

    widget.id = `jupyterlab-workshop-terminal-${name}`;
    widget.title.label = name;
    widget.title.caption = `Workshop terminal "${name}"`;
    widget.title.icon = terminalIcon;
    widget.title.closable = true;

    // The shell rewrites the title with every prompt, through the escape
    // sequence terminals honour, and JupyterLab copies it onto the tab.
    // A workshop names its terminals, so the name stays on the tab and
    // the shell's text goes into the hover caption instead.
    terminal.title.changed.connect(() => {
      if (terminal.title.label === name) {
        return;
      }

      const fromShell = terminal.title.label;

      terminal.title.label = name;
      terminal.title.caption = fromShell
        ? `Workshop terminal "${name}": ${fromShell}`
        : `Workshop terminal "${name}"`;
    });

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

    // Relay what the terminal prints so verifies can react to it, note
    // when it last printed anything, to tell when the shell is up, and
    // pick out the prompts it draws. The scanner lives as long as the
    // terminal so that a prompt drawn again, as on a resize, is known
    // for one already counted whether or not anything was waiting.
    let lastOutputAt = 0;
    const scanner = new PromptScanner();
    const onMessage = (
      _: TerminalService.ITerminalConnection,
      message: TerminalService.IMessage
    ): void => {
      if (message.type === 'stdout' && message.content) {
        const text = message.content.map(String).join('');

        lastOutputAt = Date.now();
        this._output.emit({ name, text });

        for (const marker of scanner.feed(text)) {
          this._prompts.emit({ name, marker });
        }
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
        this._hooked.delete(name);
        this._queue.delete(name);
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

    // Expose the workshop variables to the shell. Where the file also
    // installs the marked prompt, the prompt drawn once the file has
    // loaded shows whether the marker gets through; a shell without the
    // hook, or a terminal that strips the marker on the way, leaves
    // `wait: prompt` to its echoed marker instead.
    const source = envSourceCommand(this._manager);
    const shell = this._manager.platform?.shell ?? '';

    if (source && PROMPT_HOOK_SHELLS.has(shell)) {
      const probe = this.waitForPrompts(name, 1, PROMPT_PROBE_MS);

      this._hooked.set(
        name,
        probe.then(marker => marker !== null)
      );
    } else {
      this._hooked.set(name, Promise.resolve(false));
    }

    if (source) {
      this._write(session, `${source}\n`);
    }

    return widget;
  }

  /**
   * Send text to a terminal connection. A Unix pty turns a newline into
   * Enter, but a Windows console and the JupyterLite terminal's shell act
   * only on a carriage return, which is what a keyboard sends, so those
   * shells get their line endings converted.
   */
  private _write(
    session: TerminalService.ITerminalConnection,
    text: string
  ): void {
    const content = CARRIAGE_RETURN_SHELLS.has(
      this._manager.platform?.shell ?? ''
    )
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
   * Whether the terminal for a session name draws the marked prompt, so
   * that `wait: prompt` can watch for it rather than echo a marker. The
   * answer is settled once the terminal's first prompt after loading the
   * environment file has been seen, or given up on.
   */
  async promptHooked(name: string): Promise<boolean> {
    return (await this._hooked.get(name)) ?? false;
  }

  /**
   * Resolve with the last of the next `count` prompts the terminal
   * draws, or null when they have not all appeared within the timeout.
   * Every line sent to the shell draws one prompt, continuation prompts
   * included, so a command of several lines waits for as many.
   */
  waitForPrompts(
    name: string,
    count: number,
    timeoutMs: number
  ): Promise<IPromptMarker | null> {
    return new Promise(resolve => {
      let seen = 0;
      const onPrompt = (
        _: this,
        args: { name: string; marker: IPromptMarker }
      ): void => {
        if (args.name !== name) {
          return;
        }

        seen += 1;

        if (seen >= count) {
          finish(args.marker);
        }
      };
      const timer = window.setTimeout(() => finish(null), timeoutMs);
      const finish = (result: IPromptMarker | null): void => {
        window.clearTimeout(timer);
        this._prompts.disconnect(onPrompt);
        resolve(result);
      };

      this._prompts.connect(onPrompt);
    });
  }

  /**
   * Send lines to a terminal with the marked prompt and resolve with the
   * marker of the prompt drawn after the last of them, or null when it
   * has not appeared within the timeout. Exchanges with one terminal run
   * one after another, so the prompts one draws are never taken for
   * another's: an environment file loaded again while a command runs
   * waits its turn, and so does the next command.
   */
  exchange(
    name: string,
    text: string,
    timeoutMs: number,
    options: { cwd?: string; activate?: boolean } = {}
  ): Promise<IPromptMarker | null> {
    const previous = this._queue.get(name) ?? Promise.resolve();
    const run = previous.then(async () => {
      const widget = await this.get(name, { cwd: options.cwd });
      const lines = text.split('\n').length - 1;
      const done = this.waitForPrompts(name, lines, timeoutMs);

      if (options.activate) {
        this._shell.activateById(widget.id);
      }

      this._write(widget.content.session, text);

      return done;
    });
    const settled = run.then(
      () => undefined,
      () => undefined
    );

    this._queue.set(name, settled);
    void settled.then(() => {
      if (this._queue.get(name) === settled) {
        this._queue.delete(name);
      }
    });

    return run;
  }

  /**
   * Load the environment file again in every open terminal. A terminal
   * still starting is left alone, since it loads the file itself once
   * its shell is up. Resolves once every terminal has drawn its prompt
   * again, or given up waiting, so a caller can hold an action until
   * the values are in place.
   */
  async refreshEnvironment(): Promise<void> {
    const source = envSourceCommand(this._manager);

    if (!source) {
      return;
    }

    const reloads: Promise<void>[] = [];

    for (const [name, widget] of this._widgets) {
      if (!widget.isDisposed && this._hooked.has(name)) {
        reloads.push(
          this._reload(name, `${source}\n`).catch(error => {
            console.warn(
              `Unable to reload the environment in terminal ${name}`,
              error
            );
          })
        );
      }
    }

    await Promise.all(reloads);
  }

  /**
   * Load the environment file again in one terminal: as an exchange where
   * the prompt is marked, so the prompt it draws is not mistaken for the
   * end of a command, and as plain input otherwise.
   */
  private async _reload(name: string, text: string): Promise<void> {
    if (await this.promptHooked(name)) {
      await this.exchange(name, text, PROMPT_RELOAD_MS);

      return;
    }

    const widget = this._widgets.get(name);

    if (widget && !widget.isDisposed) {
      this._write(widget.content.session, text);
    }
  }

  private _app: JupyterFrontEnd;
  private _shell: ILabShell;
  private _manager: IWorkshopManager;
  private _widgets = new Map<string, MainAreaWidget<Terminal>>();
  private _pending = new Map<string, Promise<MainAreaWidget<Terminal>>>();
  private _first: MainAreaWidget<Terminal> | null = null;
  private _hooked = new Map<string, Promise<boolean>>();
  private _queue = new Map<string, Promise<void>>();
  private _prompts = new Signal<this, { name: string; marker: IPromptMarker }>(
    this
  );
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
  '@jupyterlab-workshop/labextension:ITerminalSessions',
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

  // The dot command is the POSIX form; plain sh, dash in particular, has
  // no `source`.
  switch (platform.shell) {
    case 'bash':
    case 'zsh':
    case 'sh': {
      const path = manager.absolutePath(
        `${WORKSHOP_STATE_DIR}/env.sh`,
        'workshop'
      );

      return `. '${path.replace(/'/g, "'\\''")}'`;
    }
    case 'fish': {
      const path = manager.absolutePath(
        `${WORKSHOP_STATE_DIR}/env.fish`,
        'workshop'
      );

      return `source '${path.replace(/'/g, "\\'")}'`;
    }
    case 'powershell': {
      const path = manager.absolutePath(
        `${WORKSHOP_STATE_DIR}/env.ps1`,
        'workshop'
      );

      return `. '${path.replace(/'/g, "''")}'`;
    }
    case 'cmd': {
      const path = manager.absolutePath(
        `${WORKSHOP_STATE_DIR}/env.cmd`,
        'workshop'
      );

      return `call "${path}"`;
    }
    case 'cockle':
      return cockleExports(
        manager.variables.values,
        manager.workshop.manifest.env
      );
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
  variables: Record<string, string>,
  env: Readonly<Record<string, string>> = {}
): string | null {
  const parts: string[] = [];

  for (const [name, value] of Object.entries(
    terminalEnvironment(variables, env)
  )) {
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
  return manager.resolvePath(request.options.cwd ?? '.');
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

    // `wait: prompt` waits for the shell to be back at its prompt. With
    // the workshop prompt installed, the prompt itself carries a marker,
    // one per line sent; otherwise the command is followed by a marker
    // command whose output is waited for. Any other value is a duration
    // to pause for.
    if (wait === 'prompt') {
      const cwd = terminalCwd(request, this._manager);
      const timeout = parseDuration(request.options.timeout, 120000);
      const text = `${command.replace(/\n+$/, '')}\n`;
      const timedOut: IActionResult = {
        status: 'error',
        message: `The command did not finish within ${Math.round(timeout / 1000)}s`
      };

      await this._terminals.get(name, { cwd });

      if (await this._terminals.promptHooked(name)) {
        const marker = await this._terminals.exchange(name, text, timeout, {
          cwd,
          activate: true
        });

        if (!marker) {
          return timedOut;
        }

        return marker.status === 0
          ? { status: 'ok' }
          : {
              status: 'ok',
              message: `The command exited with status ${marker.status}`
            };
      }

      const marker = `__WORKSHOP_DONE_${Date.now().toString(36)}__`;
      const echo = markerCommand(this._manager, marker);

      if (!echo) {
        return {
          status: 'error',
          message: 'Waiting for the prompt is not supported by this shell'
        };
      }

      const seen = this._terminals.waitForOutput(name, marker, timeout);

      await this._terminals.send(name, `${text}${echo}\n`, cwd);

      if (!(await seen)) {
        return timedOut;
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
    const result = await this._shell.run(
      command,
      cwd,
      timeout,
      commandEnvironment(this._manager)
    );

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
 * The `terminal-close` action.
 */
export class TerminalCloseAction implements IActionImplementation {
  readonly type = 'terminal-close';

  constructor(terminals: TerminalSessions) {
    this._terminals = terminals;
  }

  describe(request: IActionRequest): string {
    return `Close terminal "${sessionName(request)}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    await this._terminals.close(sessionName(request));

    return { status: 'ok' };
  }

  private _terminals: TerminalSessions;
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
