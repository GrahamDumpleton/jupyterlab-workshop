/**
 * Scroll the panel so that content which has just grown in place, a hint
 * opened, an action's output, a quiz's feedback, is in view, without
 * losing what introduced it.
 */

/** The panel's scroll container, found from an element inside it. */
const BODY_SELECTOR = '.jp-WorkshopPanel-body';

/**
 * How far down the viewport the anchor may be pushed by a reveal, as a
 * fraction of the viewport height measured from its top. A third keeps
 * the paragraph or action above the anchor on screen.
 */
export const REVEAL_CAP = 1 / 3;

/**
 * Scroll the panel body just enough that the bottom of `element` is in
 * view, but never so far that `anchor`, the element's header, rises
 * above the top third of the viewport. Nothing moves when the element
 * already fits, and content taller than the space below the cap is left
 * for the learner to scroll.
 */
export function revealBelow(
  element: HTMLElement,
  anchor: HTMLElement = element
): void {
  const container = element.closest<HTMLElement>(BODY_SELECTOR);

  if (!container) {
    return;
  }

  const viewport = container.getBoundingClientRect();
  const overflow = element.getBoundingClientRect().bottom - viewport.bottom;

  if (overflow <= 0) {
    return;
  }

  // The anchor may only move up as far as the cap line.
  const room =
    anchor.getBoundingClientRect().top -
    (viewport.top + viewport.height * REVEAL_CAP);
  const delta = Math.min(overflow, room);

  if (delta <= 0) {
    return;
  }

  container.scrollBy({ top: delta, behavior: 'smooth' });
}
