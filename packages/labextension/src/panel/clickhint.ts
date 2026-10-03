import {
  collectDirectives,
  isActionType,
  isAutomatic
} from '@jupyterlab-workshop/core';
import React, { useEffect, useState } from 'react';

import { IWorkshopManager } from '../tokens';
import { visibleDirectives } from '../util';

/**
 * How long the first action is in view, with nothing clicked, before the
 * hint that it can be clicked appears.
 */
const HINT_DELAY_MS = 4000;

/**
 * How much of the action's header has to be in view for the action to
 * count as seen. The header is what is watched, not the whole block, so
 * an action with a body taller than the panel still counts.
 */
const HINT_VISIBLE_RATIO = 0.9;

/**
 * The id of the action the hint is showing on, or null when it is showing
 * on none. Provided by the page body and read by the action blocks.
 */
export const ClickHintContext = React.createContext<string | null>(null);

/**
 * The action a learner who has clicked nothing yet is shown they can
 * click: the first action block of the whole workshop, in page order,
 * that waits for a click and that the trust level lets run. Null once
 * the learner has clicked any action, since the hint has then done its
 * job, and null when the workshop has no such action.
 *
 * Only the one action is ever the target. Later pages often depend on
 * the actions of earlier ones, so the hint does not move on to a later
 * action when the learner skips ahead.
 */
export function clickHintTarget(manager: IWorkshopManager): string | null {
  if (manager.authoring || manager.log.some(item => item.trigger === 'click')) {
    return null;
  }

  for (const page of manager.visiblePages) {
    // A hint is not an action to click, and what it holds is out of
    // sight until it is opened, so neither can carry the pointer.
    const inHint = new Set<string>();

    for (const node of visibleDirectives(page, manager.conditionValues)) {
      if (node.name === 'hint') {
        for (const held of collectDirectives(node.nodes ?? [])) {
          inHint.add(held.id);
        }

        continue;
      }

      if (
        inHint.has(node.id) ||
        !isActionType(node.name) ||
        isAutomatic(node)
      ) {
        continue;
      }

      const disposition = manager.disposition(node).kind;

      if (disposition === 'skip' || disposition === 'reject') {
        continue;
      }

      // An action that has run already, by a cascade or in an earlier
      // session whose log has since rolled over, needs no hint.
      const status = manager.actionStatus(node.id);

      return status.status === 'idle' && status.runs === 0 ? node.id : null;
    }
  }

  return null;
}

/**
 * Whether the hint is showing on the target. It appears once the target
 * has been in view for a few seconds, and stays until the target changes,
 * which it does when the learner clicks an action. The wait starts again
 * if the target scrolls out of view, or a dialog is up when it ends.
 */
export function useClickHint(
  container: React.RefObject<HTMLElement | null>,
  target: string | null
): boolean {
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (target === null || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const element = container.current?.querySelector<HTMLElement>(
      `[data-action-id="${CSS.escape(target)}"]`
    );

    if (!element) {
      return;
    }

    let timer: number | null = null;

    const stop = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const start = (): void => {
      stop();

      timer = window.setTimeout(() => {
        timer = null;

        // The learner is reading a dialog, such as the welcome message,
        // not the page under it.
        if (document.querySelector('.jp-Dialog')) {
          start();

          return;
        }

        setShown(target);
        observer.disconnect();
      }, HINT_DELAY_MS);
    };

    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[entries.length - 1];

        if (entry.intersectionRatio >= HINT_VISIBLE_RATIO) {
          if (timer === null) {
            start();
          }
        } else {
          stop();
        }
      },
      { threshold: HINT_VISIBLE_RATIO }
    );

    observer.observe(
      element.querySelector('.jp-WorkshopPanel-actionHeader') ?? element
    );

    return () => {
      stop();
      observer.disconnect();
    };
  }, [container, target]);

  return target !== null && shown === target;
}
