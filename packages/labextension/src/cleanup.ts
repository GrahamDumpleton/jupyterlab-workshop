import { ILabShell } from '@jupyterlab/application';
import { IDocumentManager } from '@jupyterlab/docmanager';

import { TerminalSessions } from './actions/terminal';

/** What closing a workshop's widgets needs. */
export interface ICleanupContext {
  shell: ILabShell;
  docManager: IDocumentManager;
  terminals: TerminalSessions;
}

/**
 * Take a workshop off the screen: close every main-area document whose
 * file lives under the workshop directory (the README preview and
 * editors a layout or an action opened, notebooks it created) and shut
 * down every workshop terminal. A document with unsaved changes asks
 * first, as closing its tab would. Files opened from elsewhere stay.
 */
export async function closeWorkshopWidgets(
  context: ICleanupContext,
  workshopPath: string
): Promise<void> {
  const paths = new Set<string>();

  for (const widget of context.shell.widgets('main')) {
    const documentContext = context.docManager.contextForWidget(widget);

    if (
      documentContext &&
      !widget.isDisposed &&
      isUnder(documentContext.path, workshopPath)
    ) {
      paths.add(documentContext.path);
    }
  }

  for (const path of paths) {
    await context.docManager.closeFile(path);
  }

  for (const name of context.terminals.names()) {
    await context.terminals.close(name);
  }
}

/**
 * Whether a path is the workshop directory or inside it. The JupyterLab
 * root as the workshop directory owns everything.
 */
function isUnder(path: string, workshopPath: string): boolean {
  if (workshopPath === '') {
    return true;
  }

  return path === workshopPath || path.startsWith(`${workshopPath}/`);
}
