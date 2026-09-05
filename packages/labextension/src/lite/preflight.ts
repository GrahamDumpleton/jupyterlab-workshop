import { CommandRegistry } from '@lumino/commands';

import { LITE_EXECUTE_SHELL, LiteShell } from '../actions/shell';
import { IPreflightResult, IToolRequest } from '../tokens';

/** Tools the Pyodide kernel stands in for. */
const PYTHON_NAMES: ReadonlySet<string> = new Set(['python', 'python3']);

/**
 * Look for required tools in JupyterLite: Python is the Pyodide kernel,
 * and anything else has to be a command of the terminal's cockle shell.
 * Versions are not checked.
 */
export async function litePreflight(
  commands: CommandRegistry,
  tools: IToolRequest[]
): Promise<IPreflightResult[]> {
  const shell = commands.hasCommand(LITE_EXECUTE_SHELL)
    ? new LiteShell(commands)
    : null;
  const results: IPreflightResult[] = [];

  for (const tool of tools) {
    if (PYTHON_NAMES.has(tool.name)) {
      results.push({
        name: tool.name,
        found: true,
        path: 'pyodide',
        satisfied: true,
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
