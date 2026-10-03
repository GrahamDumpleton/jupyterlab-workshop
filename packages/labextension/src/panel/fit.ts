import { Dialog } from '@jupyterlab/apputils';

/** Host class of a dialog that widens before it scrolls. */
export const FIT_DIALOG_CLASS = 'jp-WorkshopFitDialog';

/** The widths tried in turn, narrowest first, as classes on the dialog. */
const STEPS: readonly string[] = ['jp-mod-wide', 'jp-mod-widest'];

/**
 * Show a dialog whose body is prose, such as a welcome or finish message,
 * letting it grow wider before it scrolls. JupyterLab gives a dialog a
 * fixed ceiling on its height and leaves the width to its body, so a
 * long message in a narrow body scrolls while the window beside it is
 * empty. Once shown, the body is widened a step at a time, as far as the
 * window allows, until nothing overflows or the steps run out.
 */
export async function showFittedDialog<T>(
  options: Partial<Dialog.IOptions<T>>
): Promise<Dialog.IResult<T>> {
  const dialog = new Dialog<T>(options);

  dialog.addClass(FIT_DIALOG_CLASS);

  const result = dialog.launch();

  // The body widget is the element JupyterLab marks as the body.
  // Measuring needs the dialog laid out, so each step waits a frame.
  const body = dialog.node.querySelector('.jp-Dialog-body');
  let step = 0;

  const widen = (): void => {
    if (!body || dialog.isDisposed || step >= STEPS.length) {
      return;
    }

    if (body.scrollHeight <= body.clientHeight + 1) {
      return;
    }

    dialog.addClass(STEPS[step]);
    step += 1;
    requestAnimationFrame(widen);
  };

  requestAnimationFrame(widen);

  return result;
}
