import { Notification } from '@jupyterlab/apputils';

import {
  IActionImplementation,
  IActionRequest,
  IActionResult
} from '../tokens';
import { parseDuration } from './registry';

const HIGHLIGHT_CLASS = 'jp-Workshop-highlight';

const CALLOUT_CLASS = 'jp-Workshop-callout';

const TOAST_TYPES: ReadonlySet<string> = new Set([
  'info',
  'success',
  'warning',
  'error',
  'default'
]);

/**
 * The `highlight` action: outline an element for a while, with an
 * optional callout showing the body text.
 */
export class HighlightAction implements IActionImplementation {
  readonly type = 'highlight';

  describe(request: IActionRequest): string {
    return `Highlight ${request.options.selector ?? '(no selector)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const selector = request.options.selector;

    if (!selector) {
      return {
        status: 'error',
        message: 'The highlight action needs a "selector" option'
      };
    }

    const element = findElement(selector);

    if (!element) {
      return {
        status: 'error',
        message: `Nothing on screen matches "${selector}"`
      };
    }

    // Outline the element and optionally pin a callout beneath it.
    const duration = parseDuration(request.options.duration, 4000);
    const callout = request.body.trim()
      ? createCallout(element, request.body.trim())
      : null;

    element.classList.add(HIGHLIGHT_CLASS);
    element.scrollIntoView({ block: 'nearest' });

    const dismiss = (): void => {
      element.classList.remove(HIGHLIGHT_CLASS);
      callout?.remove();
      element.removeEventListener('click', dismiss);
    };

    element.addEventListener('click', dismiss);
    window.setTimeout(dismiss, duration);

    return { status: 'ok' };
  }
}

/**
 * The `toast` action: show a notification.
 */
export class ToastAction implements IActionImplementation {
  readonly type = 'toast';

  describe(request: IActionRequest): string {
    return 'Show a message';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const message = request.body.trim();

    if (!message) {
      return { status: 'error', message: 'The toast action needs a message' };
    }

    const type = request.options.type ?? 'info';

    if (!TOAST_TYPES.has(type)) {
      return { status: 'error', message: `Unknown toast type "${type}"` };
    }

    Notification.emit(message, type as Notification.TypeOptions, {
      autoClose: parseDuration(request.options.duration, 5000)
    });

    return { status: 'ok' };
  }
}

/**
 * The `copy` action: copy the body to the clipboard.
 */
export class CopyAction implements IActionImplementation {
  readonly type = 'copy';

  describe(request: IActionRequest): string {
    return 'Copy to clipboard';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    await navigator.clipboard.writeText(request.body);

    Notification.success('Copied to clipboard', { autoClose: 1500 });

    return { status: 'ok' };
  }
}

function findElement(selector: string): HTMLElement | null {
  // Allow `widget:<id>` for JupyterLab widgets as well as CSS selectors.
  if (selector.startsWith('widget:')) {
    return document.getElementById(selector.slice('widget:'.length));
  }

  try {
    return document.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

function createCallout(target: HTMLElement, text: string): HTMLElement {
  const callout = document.createElement('div');
  const rect = target.getBoundingClientRect();

  callout.className = CALLOUT_CLASS;
  callout.textContent = text;
  callout.style.left = `${Math.max(8, rect.left)}px`;
  callout.style.top = `${Math.max(8, rect.top + 8)}px`;
  document.body.appendChild(callout);

  return callout;
}
