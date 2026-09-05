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

  /** Text written to stderr. */
  stderr: string;

  /** Error name and value when the code raised. */
  error?: string;
}

/**
 * Run code in a kernel and collect its output.
 */
export async function executeInKernel(
  kernel: Kernel.IKernelConnection,
  code: string,
  silent = true
): Promise<IKernelOutput> {
  const output: IKernelOutput = { text: '', stderr: '' };
  const future = kernel.requestExecute({
    code,
    silent,
    store_history: false,
    stop_on_error: true
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
      }
    } else if (type === 'error') {
      const content = message.content as KernelMessage.IErrorMsg['content'];

      output.error = `${content.ename}: ${content.evalue}`;
    }
  };

  await future.done;

  return output;
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

    const existing = this._session;

    if (
      existing &&
      !existing.isDisposed &&
      existing.kernel &&
      workshop.path === this._path
    ) {
      return existing.kernel;
    }

    await this.shutdown();

    const sessions = this._app.serviceManager.sessions;
    const specs = this._app.serviceManager.kernelspecs;

    await specs.ready;

    // The workshop's own environment is used once it exists; before that
    // the server default keeps captures and checks working.
    const name = this._manager.environmentKernel() ?? specs.specs?.default;

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
   * Run code in the workshop kernel.
   */
  async execute(code: string): Promise<IKernelOutput> {
    return executeInKernel(await this.kernel(), code);
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
