/**
 * Wait for the panel to show a page.
 *
 * The panel draws a page a moment after the manager moves to it, so
 * something that runs actions straight after opening a workshop or
 * changing page, as the self-test does, would otherwise find the panel
 * still showing what it had before: an action that points at part of the
 * panel would match nothing, although it does for a learner.
 */

import { sleep } from '../util';
import { PANEL_ID } from './widget';

/** Attribute the panel body is given, naming the page it shows. */
const PAGE_ATTRIBUTE = 'data-page-id';

/** How often the panel is looked at while waiting for it to draw. */
const DRAW_POLL_MS = 20;

/** How long to wait for the panel to draw a page before going on. */
export const DRAW_LIMIT_MS = 5000;

/**
 * Wait until the panel shows the page with the given id, and say whether
 * it does. Returns at once when the panel is not in the document, as
 * when the sidebar it lives in was never opened, and gives up at the
 * limit, since a panel that is slow to draw is no reason to stop a run.
 */
export async function pageDrawn(
  pageId: string,
  limitMs: number = DRAW_LIMIT_MS
): Promise<boolean> {
  const deadline = Date.now() + limitMs;

  for (;;) {
    const panel = document.getElementById(PANEL_ID);

    if (!panel) {
      return false;
    }

    const body = panel.querySelector<HTMLElement>(`[${PAGE_ATTRIBUTE}]`);

    if (body?.getAttribute(PAGE_ATTRIBUTE) === pageId) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await sleep(DRAW_POLL_MS);
  }
}
