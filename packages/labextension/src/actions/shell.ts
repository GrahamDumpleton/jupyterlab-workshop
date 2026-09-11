import { environmentVariables } from '@jupyterlab-workshop/core';
import { CommandRegistry } from '@lumino/commands';

import { IShellResult, IWorkshopManager } from '../tokens';
import { REPLY_GRACE_MS, WorkshopKernel } from './kernel';

/** The JupyterLite terminal command that runs a command headlessly. */
export const LITE_EXECUTE_SHELL = '@jupyterlite/terminal:execute-shell';

/**
 * Runs a shell command without showing a terminal and collects its
 * output, for `execute-capture` and the `shell` verify substrate.
 */
export interface IShellRunner {
  /**
   * Run a command in a directory, given as an absolute path on the
   * platform, and stop waiting after the timeout. The environment
   * variables are added to the command's environment where the runner
   * can set one.
   */
  run(
    command: string,
    cwd: string,
    timeoutMs: number,
    environment?: Readonly<Record<string, string>>
  ): Promise<IShellResult>;
}

/**
 * The environment variables a command run for the workshop sees beyond
 * the server's own: the workshop variables under their exported names,
 * then the manifest's `env` mapping, the same as a workshop terminal
 * loads from its environment file.
 */
export function commandEnvironment(
  manager: IWorkshopManager
): Record<string, string> {
  return {
    ...environmentVariables(manager.variables.values),
    ...(manager.workshop?.manifest.env ?? {})
  };
}

/**
 * Runs commands as subprocesses of the hidden workshop kernel, which is
 * how the JupyterLab server reaches the operating system's shell.
 */
export class KernelShell implements IShellRunner {
  constructor(kernel: WorkshopKernel) {
    this._kernel = kernel;
  }

  async run(
    command: string,
    cwd: string,
    timeoutMs: number,
    environment: Readonly<Record<string, string>> = {}
  ): Promise<IShellResult> {
    const code = [
      'import json, os, subprocess',
      `_r = subprocess.run(${JSON.stringify(command)}, shell=True, capture_output=True, text=True, cwd=${JSON.stringify(cwd)}, timeout=${timeoutMs / 1000}, env={**os.environ, **${JSON.stringify(environment)}})`,
      'print(json.dumps({"code": _r.returncode, "out": _r.stdout, "err": _r.stderr}))'
    ].join('\n');
    const output = await this._kernel.execute(code, timeoutMs + REPLY_GRACE_MS);

    if (output.error) {
      return { code: 1, output: '', error: output.error };
    }

    const parsed = JSON.parse(output.text.trim()) as {
      code: number;
      out: string;
      err: string;
    };

    return {
      code: parsed.code,
      output: parsed.out,
      error: parsed.code === 0 ? '' : parsed.err.trim()
    };
  }

  private _kernel: WorkshopKernel;
}

/** What the JupyterLite terminal's headless command returns. */
interface ILiteShellOutput {
  status: 'ok' | 'error' | 'timeout';
  output: string;
  exitCode: number | null;
  message: string;
}

/**
 * Runs commands in a headless cockle shell through the JupyterLite
 * terminal extension, inside the browser. The shell has no environment
 * of its own to extend, so the environment passed to `run` is ignored.
 */
export class LiteShell implements IShellRunner {
  constructor(commands: CommandRegistry) {
    this._commands = commands;
  }

  async run(
    command: string,
    cwd: string,
    timeoutMs: number
  ): Promise<IShellResult> {
    if (!this._commands.hasCommand(LITE_EXECUTE_SHELL)) {
      throw new Error(
        'The JupyterLite terminal extension is not installed, so commands cannot run'
      );
    }

    const result = (await this._commands.execute(LITE_EXECUTE_SHELL, {
      code: command,
      cwd,
      timeout: timeoutMs
    })) as unknown as ILiteShellOutput;
    const output = stripAnsi(result.output ?? '');

    if (result.status === 'timeout') {
      return { code: 124, output, error: result.message };
    }

    const code = result.exitCode ?? (result.status === 'ok' ? 0 : 1);

    return { code, output, error: code === 0 ? '' : output.trim() };
  }

  private _commands: CommandRegistry;
}

/**
 * Remove terminal colour codes from text.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
