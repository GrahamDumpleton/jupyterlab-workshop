import { PageConfig } from '@jupyterlab/coreutils';
import { satisfiesVersion } from '@jupyterlab-workshop/core';
import { CommandRegistry } from '@lumino/commands';

import { LITE_EXECUTE_SHELL, LiteShell } from '../actions/shell';
import { IPreflightResult, IToolRequest } from '../tokens';

/** Tools the Pyodide kernel stands in for. */
const PYTHON_NAMES: ReadonlySet<string> = new Set(['python', 'python3']);

/**
 * The Python version the site's kernel provides, as `jupyter workshop
 * lite` wrote it into the site's configuration; empty for a site built
 * another way, whose Python is then not checked.
 */
export function sitePythonVersion(): string {
  return PageConfig.getOption('pythonVersion');
}

/**
 * Look for required tools in JupyterLite: Python is the Pyodide kernel,
 * whose version is compared with the requirement when the site says
 * which Python it carries, and anything else has to be a command of the
 * terminal's cockle shell, whose versions are not checked.
 */
export async function litePreflight(
  commands: CommandRegistry,
  tools: IToolRequest[]
): Promise<IPreflightResult[]> {
  const shell = commands.hasCommand(LITE_EXECUTE_SHELL)
    ? new LiteShell(commands)
    : null;
  const python = sitePythonVersion();
  const results: IPreflightResult[] = [];

  for (const tool of tools) {
    if (PYTHON_NAMES.has(tool.name)) {
      const satisfied =
        !tool.version || !python || satisfiesVersion(python, tool.version);

      results.push({
        name: tool.name,
        found: true,
        path: 'pyodide',
        version: python || undefined,
        satisfied,
        requirement: tool.version,
        optional: tool.optional
      });

      continue;
    }

    let found = false;

    if (shell && /^[A-Za-z0-9._-]+$/.test(tool.name)) {
      try {
        const result = await shell.run(`which ${tool.name}`, '/drive', 10000);

        found = result.code === 0;
      } catch (error) {
        console.warn(`Unable to look for ${tool.name}`, error);
      }
    }

    results.push({
      name: tool.name,
      found,
      path: found ? tool.name : undefined,
      satisfied: found,
      requirement: tool.version,
      optional: tool.optional
    });
  }

  return results;
}
