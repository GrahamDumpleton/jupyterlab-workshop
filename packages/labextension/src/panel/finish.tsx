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

  /** The workshop that follows this one in its ordered collection. */
  next?: INextStep;
}

/** What follows the finished workshop in its ordered collection. */
export interface INextStep {
  title: string;

  /** Title of the collection the sequence belongs to. */
  collection: string;

  /** Whether it is installed already, or will be installed first. */
  installed: boolean;

  /** Close this workshop and open the next, installing it if need be. */
  run: () => Promise<void>;
}

/**
 * Tell the learner the workshop is complete and offer what to do next:
 * the next workshop of an ordered collection, browsing other workshops,
 * closing this one, or on Binder ending the session. Which buttons
 * appear depends on the disabled features and the host.
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

  // The next step of a sequence is the default, since it is what a
  // learner following a course wants; it closes this workshop, so it
  // goes with closing being allowed.
  const next = canClose ? options.next : undefined;

  if (next) {
    buttons.push(Dialog.okButton({ label: 'Next workshop' }));
  }

  const result = await showDialog({
    title: `Finished: ${workshop.manifest.title}`,
    body: new FinishBody(workshop.manifest.finish, next),
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
    case 'Next workshop':
      await next?.run();
      break;
    default:
      break;
  }
}

/**
 * The dialog body: a completion line, the author's `finish` Markdown
 * from the manifest when there is one, and the next workshop of the
 * sequence when there is one.
 */
class FinishBody extends Widget {
  constructor(finish: string | undefined, next: INextStep | undefined) {
    super();

    this.addClass('jp-WorkshopFinish');

    const lead = document.createElement('p');

    lead.textContent = 'You have completed every page of this workshop.';
    this.node.appendChild(lead);

    if (next) {
      const step = document.createElement('p');

      step.className = 'jp-WorkshopFinish-next';
      step.textContent = `Next in ${next.collection}: ${next.title}${
        next.installed ? '.' : ', which will be installed first.'
      }`;
      this.node.appendChild(step);
    }

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
