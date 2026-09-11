import { ILabShell } from '@jupyterlab/application';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { FileBrowser } from '@jupyterlab/filebrowser';

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
 * Move a file browser out of a directory that is about to be deleted.
 * A browser left inside would find its own directory gone on its next
 * refresh and report "Directory not found" before falling back to the
 * root. A browser at the destination already, or outside the directory,
 * is left alone; a failure to move is only logged, since the deletion
 * is what the learner asked for.
 */
export async function leaveDirectory(
  fileBrowser: FileBrowser | null | undefined,
  directory: string,
  destination: string
): Promise<void> {
  if (!fileBrowser) {
    return;
  }

  const current = fileBrowser.model.path;

  if (current === destination || !isUnder(current, directory)) {
    return;
  }

  // The model resolves a path against its current one, so the
  // destination is given from the root.
  try {
    await fileBrowser.model.cd(`/${destination}`);
  } catch (error) {
    console.warn(`Unable to move the file browser out of ${directory}`, error);
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
