import { JupyterFrontEnd } from '@jupyterlab/application';
import { PathExt } from '@jupyterlab/coreutils';
import { Kernel, KernelMessage, Session } from '@jupyterlab/services';

import { WORKSHOP_STATE_DIR } from '../state';
import { IWorkshopManager } from '../tokens';
import { ensureDirectory } from './contents';

/** Output collected from running code in a kernel. */
export interface IKernelOutput {
  /** Text written to stdout plus the text form of any result. */
  text: string;

  /**
   * The text form of the value of the last expression, when the code
   * ended in one and the run was not silent.
   */
  result?: string;

  /** Text written to stderr. */
  stderr: string;

  /** Error name and value when the code raised. */
  error?: string;
}

/** How long the workshop kernel may take to reply before it is given up on. */
export const DEFAULT_EXECUTE_TIMEOUT_MS = 120000;

/**
 * Time allowed beyond a command's own limit for the kernel to start and
 * report the outcome.
 */
export const REPLY_GRACE_MS = 15000;

/**
 * Python run ahead of code that is not silent, to keep the kernel's
 * record of results as it was. IPython stores the value of a closing
 * expression in `Out`, `_` and the like even when history is off, and
 * with history off it stores it under the number of the last cell that
 * ran, over that cell's own result. This notes what is there and puts it
 * back once the code has run, whether or not it raised. It runs in a
 * namespace of its own, so it leaves no names behind, and does nothing
 * in a Python kernel that is not IPython.
 */
const KEEP_RESULTS = `
def arm():
    import re
    from IPython import get_ipython

    shell = get_ipython()

    if shell is None:
        return

    names = shell.user_ns
    hidden = getattr(shell, "user_ns_hidden", None)
    hook = shell.displayhook
    result_name = re.compile(r"^(_+|_\\d+)$")

    out = names.get("_oh")
    kept_out = dict(out) if isinstance(out, dict) else None
    kept_names = {k: v for k, v in names.items() if result_name.match(k)}
    kept_hidden = (
        {k: v for k, v in hidden.items() if result_name.match(k)}
        if isinstance(hidden, dict)
        else None
    )
    kept_hook = {k: getattr(hook, k) for k in ("_", "__", "___") if hasattr(hook, k)}

    def restore(*args):
        try:
            shell.events.unregister("post_run_cell", restore)
        except ValueError:
            pass

        now = names.get("_oh")

        if kept_out is not None and isinstance(now, dict):
            now.clear()
            now.update(kept_out)

        for k in [k for k in names if result_name.match(k) and k not in kept_names]:
            del names[k]

        names.update(kept_names)

        if kept_hidden is not None:
            for k in [k for k in hidden if result_name.match(k) and k not in kept_hidden]:
                del hidden[k]

            hidden.update(kept_hidden)

        for k, v in kept_hook.items():
            setattr(hook, k, v)

    shell.events.register("post_run_cell", restore)

try:
    arm()
except Exception:
    pass
`;

/**
 * The line put ahead of code so that it leaves the kernel's record of
 * results alone. One line exactly: `shiftedLines` relies on that.
 */
const KEEP_RESULTS_LINE = `__import__("builtins").exec(${JSON.stringify(KEEP_RESULTS)}, {})\n`;

/**
 * Errors raised on compiling code, which name a line of it. Matched
 * anywhere in the name, since the Pyodide kernel gives the name as
 * `<class 'SyntaxError'>`.
 */
const COMPILE_ERROR = /\b(SyntaxError|IndentationError|TabError)\b/;

/**
 * The value of a compile error with its line number brought back by one,
 * for code that had `KEEP_RESULTS_LINE` put ahead of it. Other errors
 * carry no line number in their value and are returned as they are.
 */
export function shiftedLines(name: string, value: string): string {
  if (!COMPILE_ERROR.test(name)) {
    return value;
  }

  return value.replace(
    /, line (\d+)\)$/,
    (whole: string, line: string): string =>
      Number(line) > 1 ? `, line ${Number(line) - 1})` : whole
  );
}

/**
 * Run code in a kernel and collect its output.
 *
 * Code that is not silent can end in an expression, whose value comes
 * back as `result`. In a Python kernel the value is kept out of the
 * kernel's own record of results, `Out` and `_`, which stay as the
 * cells of the notebook left them.
 */
export async function executeInKernel(
  kernel: Kernel.IKernelConnection,
  code: string,
  silent = true
): Promise<IKernelOutput> {
  const output: IKernelOutput = { text: '', stderr: '' };
  const keeping = !silent && (await isPython(kernel));

  if (keeping) {
    code = KEEP_RESULTS_LINE + code;
  }

  // Not stop_on_error: with it, code that raises makes the kernel abort
  // every execute request queued behind it. In a notebook's kernel that
  // is the learner's next cell, dropped because a check ran too early;
  // in the hidden kernel it is another check or capture.
  const future = kernel.requestExecute({
    code,
    silent,
    store_history: false,
    stop_on_error: false
  });

  future.onIOPub = (message: KernelMessage.IIOPubMessage): void => {
    const type = message.header.msg_type;

    if (type === 'stream') {
      const content = message.content as KernelMessage.IStreamMsg['content'];

      if (content.name === 'stderr') {
        output.stderr += content.text;
      } else {
        output.text += content.text;
      }
    } else if (type === 'execute_result' || type === 'display_data') {
      const content =
        message.content as KernelMessage.IExecuteResultMsg['content'];
      const text = content.data['text/plain'];

      if (typeof text === 'string') {
        output.text += text;

        if (type === 'execute_result') {
          output.result = text;
        }
      }
    } else if (type === 'error') {
      const content = message.content as KernelMessage.IErrorMsg['content'];

      const value = keeping
        ? shiftedLines(content.ename, content.evalue)
        : content.evalue;

      output.error = `${content.ename}: ${value}`;
    }
  };

  await future.done;

  return output;
}

async function isPython(kernel: Kernel.IKernelConnection): Promise<boolean> {
  try {
    return (await kernel.info).language_info.name === 'python';
  } catch {
    return false;
  }
}

/**
 * A hidden kernel session owned by the workshop, used for actions that run
 * code without a notebook, such as `execute-capture`.
 */
export class WorkshopKernel {
  constructor(app: JupyterFrontEnd, manager: IWorkshopManager) {
    this._app = app;
    this._manager = manager;
  }

  /**
   * Return the kernel connection, starting the session if needed.
   */
  async kernel(): Promise<Kernel.IKernelConnection> {
    const workshop = this._manager.workshop;

    if (!workshop) {
      throw new Error('No workshop is open');
    }

    const sessions = this._app.serviceManager.sessions;
    const specs = this._app.serviceManager.kernelspecs;

    await specs.ready;

    // The workshop's own environment is used once it exists; before that
    // the server default keeps captures and checks working.
    const name = this._manager.environmentKernel() ?? specs.specs?.default;
    const existing = this._session;

    // A session started on the server default before the environment
    // existed is replaced the first time the environment's kernel is
    // wanted, so captures and checks move onto it as well.
    if (
      existing &&
      !existing.isDisposed &&
      existing.kernel &&
      workshop.path === this._path &&
      existing.kernel.name === name
    ) {
      return existing.kernel;
    }

    await this.shutdown();

    if (!name) {
      throw new Error('No kernel is available');
    }

    // The session's directory must exist: the Pyodide kernel of JupyterLite
    // starts in it and never becomes ready when it is missing.
    const directory = PathExt.join(workshop.path, WORKSHOP_STATE_DIR);

    await ensureDirectory(this._app.serviceManager.contents, directory);

    const session = await sessions.startNew({
      path: PathExt.join(directory, 'kernel'),
      name: `workshop-${workshop.manifest.name}`,
      type: 'workshop',
      kernel: { name }
    });

    if (!session.kernel) {
      throw new Error('The workshop kernel failed to start');
    }

    this._session = session;
    this._path = workshop.path;

    return session.kernel;
  }

  /**
   * Run code in the workshop kernel, starting it if needed.
   *
   * A reply that does not arrive within the limit, because the kernel
   * never connected or has stopped answering, is not waited for again on
   * that kernel: an interrupt does not bring a reply back, and every
   * later request would time out the same way. The session is shut down
   * and a fresh one asked once more, so a single hang costs one wait
   * rather than every check after it. Python state kept in the kernel
   * goes with the restart, which checks are not meant to rely on; the
   * kernel is also replaced when the workshop environment appears.
   */
  async execute(
    code: string,
    timeoutMs: number = DEFAULT_EXECUTE_TIMEOUT_MS
  ): Promise<IKernelOutput> {
    const seconds = Math.round(timeoutMs / 1000);
    const first = await this._attempt(code, timeoutMs);

    if (first) {
      return first;
    }

    console.warn(
      `The workshop kernel gave no reply within ${seconds}s; restarting it`
    );
    await this.shutdown();

    const second = await this._attempt(code, timeoutMs);

    if (second) {
      return second;
    }

    // Two kernels in a row gave nothing; the next request starts afresh
    // rather than queueing behind this one.
    await this.shutdown();

    return {
      text: '',
      stderr: '',
      error: `The workshop kernel gave no reply within ${seconds}s, nor within another ${seconds}s after being restarted`
    };
  }

  /**
   * One try at running the code: the output, or null when no reply came
   * within the limit. A failure to start the kernel at all is thrown.
   */
  private async _attempt(
    code: string,
    timeoutMs: number
  ): Promise<IKernelOutput | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const expired = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });

    try {
      return await Promise.race([this._run(code), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async _run(code: string): Promise<IKernelOutput> {
    const kernel = await this.kernel();

    // A session just started may not have its connection up yet, and a
    // request sent before it is can go unanswered. The kernel info reply
    // confirms the connection is live; a connected kernel has it already.
    await kernel.info;

    return executeInKernel(kernel, code);
  }

  /**
   * Shut the hidden session down, if it is running.
   */
  async shutdown(): Promise<void> {
    const session = this._session;

    this._session = null;

    if (session && !session.isDisposed) {
      try {
        await session.shutdown();
      } catch (error) {
        console.warn('Unable to shut down the workshop kernel', error);
      }

      session.dispose();
    }
  }

  private _app: JupyterFrontEnd;
  private _manager: IWorkshopManager;
  private _session: Session.ISessionConnection | null = null;
  private _path = '';
}
