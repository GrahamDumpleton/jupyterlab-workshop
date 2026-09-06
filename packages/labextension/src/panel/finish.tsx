import { createRenderEnv, getMarkdownParser } from '@jupyterlab-workshop/core';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';

import { IFeaturePolicy, IWorkshopManager } from '../tokens';

/** JupyterLab's own shut down command, the one File then Shut Down runs. */
const SHUTDOWN_COMMAND = 'filemenu:shutdown';

/** What the finish dialog needs. */
export interface IFinishDialogOptions {
  manager: IWorkshopManager;
  features: IFeaturePolicy;
  commands: CommandRegistry;

  /** Close the workshop, taking its documents and terminals with it. */
  close: () => Promise<void>;

  /** Close the workshop and open the browser. */
  browse: () => Promise<void>;
}

/**
 * Tell the learner the workshop is complete and offer what to do next:
 * browse other workshops, close this one, or on Binder end the session.
 * Which buttons appear depends on the disabled features and the host.
 */
export async function showFinishDialog(
  options: IFinishDialogOptions
): Promise<void> {
  const { manager, features, commands } = options;
  const workshop = manager.workshop;

  if (!workshop) {
    return;
  }

  // Every path leads somewhere except "Keep reading", which is the
  // cancel button so Escape does the same.
  const canClose = features.enabled('close');
  const canBrowse = canClose && features.enabled('browse');
  const canShutDown =
    manager.platform?.host === 'binder' &&
    commands.hasCommand(SHUTDOWN_COMMAND);
  const buttons: Dialog.IButton[] = [
    Dialog.cancelButton({ label: 'Keep reading' })
  ];

  if (canShutDown) {
    buttons.push(Dialog.warnButton({ label: 'Shut down', accept: true }));
  }

  if (canBrowse) {
    buttons.push(Dialog.okButton({ label: 'Browse workshops' }));
  } else if (canClose) {
    buttons.push(Dialog.okButton({ label: 'Close workshop' }));
  }

  const result = await showDialog({
    title: `Finished: ${workshop.manifest.title}`,
    body: new FinishBody(workshop.manifest.finish),
    buttons,
    defaultButton: buttons.length - 1
  });

  if (!result.button.accept) {
    return;
  }

  switch (result.button.label) {
    case 'Shut down':
      await commands.execute(SHUTDOWN_COMMAND);
      break;
    case 'Browse workshops':
      await options.browse();
      break;
    case 'Close workshop':
      await options.close();
      break;
    default:
      break;
  }
}

/**
 * The dialog body: a completion line, then the author's `finish`
 * Markdown from the manifest when there is one.
 */
class FinishBody extends Widget {
  constructor(finish: string | undefined) {
    super();

    this.addClass('jp-WorkshopFinish');

    const lead = document.createElement('p');

    lead.textContent = 'You have completed every page of this workshop.';
    this.node.appendChild(lead);

    if (finish) {
      const message = document.createElement('div');

      message.className = 'jp-WorkshopFinish-message';
      message.innerHTML = getMarkdownParser().render(
        finish,
        createRenderEnv('finish', {})
      );
      this.node.appendChild(message);
    }
  }
}
