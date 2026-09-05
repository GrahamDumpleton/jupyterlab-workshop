import { Dialog, Notification, showDialog } from '@jupyterlab/apputils';
import { load } from 'js-yaml';

import {
  IActionImplementation,
  IActionRequest,
  IActionResult
} from '../tokens';
import { parseDuration } from '../util';
import { requireBody } from './registry';

const HIGHLIGHT_CLASS = 'jp-Workshop-highlight';

const CALLOUT_CLASS = 'jp-Workshop-callout';

const TOAST_TYPES: ReadonlySet<string> = new Set([
  'info',
  'success',
  'warning',
  'error',
  'default'
]);

interface ITourStep {
  selector: string;
  text: string;
}

/**
 * Find an element by CSS selector, or by `widget:<id>` for JupyterLab
 * widgets.
 */
export function findElement(selector: string): HTMLElement | null {
  if (selector.startsWith('widget:')) {
    return document.getElementById(selector.slice('widget:'.length));
  }

  try {
    return document.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

/**
 * Pin a callout beneath an element. Returns the callout and a function
 * that removes it.
 */
export function showCallout(
  target: HTMLElement,
  text: string,
  options: { button?: string; onButton?: () => void; closable?: boolean } = {}
): { element: HTMLElement; dismiss: () => void } {
  const callout = document.createElement('div');
  const rect = target.getBoundingClientRect();
  const message = document.createElement('span');

  callout.className = CALLOUT_CLASS;
  message.textContent = text;
  callout.appendChild(message);
  callout.style.left = `${Math.max(8, rect.left)}px`;
  callout.style.top = `${Math.max(8, rect.top + 8)}px`;

  const dismiss = (): void => {
    target.classList.remove(HIGHLIGHT_CLASS);
    target.removeEventListener('click', dismiss);
    callout.remove();
  };

  if (options.button) {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'jp-Workshop-calloutButton';
    button.textContent = options.button;
    button.addEventListener('click', () => {
      dismiss();
      options.onButton?.();
    });
    callout.appendChild(button);
    callout.classList.add('jp-mod-interactive');
  }

  if (options.closable) {
    const close = document.createElement('button');

    close.type = 'button';
    close.className = 'jp-Workshop-calloutButton';
    close.textContent = '×';
    close.title = 'Dismiss';
    close.addEventListener('click', dismiss);
    callout.appendChild(close);
    callout.classList.add('jp-mod-interactive');
  }

  target.classList.add(HIGHLIGHT_CLASS);
  target.addEventListener('click', dismiss);
  document.body.appendChild(callout);

  return { element: callout, dismiss };
}

/**
 * The `highlight` action: outline an element for a while, with an
 * optional callout showing the body text.
 */
export class HighlightAction implements IActionImplementation {
  readonly type = 'highlight';

  describe(request: IActionRequest): string {
    return `Highlight ${request.options.selector || request.argument || '(no selector)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const selector = request.options.selector || request.argument;

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

    element.scrollIntoView({ block: 'nearest' });

    const text = request.body.trim();
    let dismiss: () => void;

    if (text) {
      dismiss = showCallout(element, text).dismiss;
    } else {
      element.classList.add(HIGHLIGHT_CLASS);
      dismiss = (): void => element.classList.remove(HIGHLIGHT_CLASS);
    }

    window.setTimeout(dismiss, parseDuration(request.options.duration, 4000));

    return { status: 'ok' };
  }
}

/**
 * The `tooltip` action: pin a note to an element until dismissed.
 */
export class TooltipAction implements IActionImplementation {
  readonly type = 'tooltip';

  describe(request: IActionRequest): string {
    return `Note on ${request.options.selector || request.argument || '(no selector)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const selector = request.options.selector || request.argument;

    if (!selector) {
      return {
        status: 'error',
        message: 'The tooltip action needs a "selector" option'
      };
    }

    const element = findElement(selector);

    if (!element) {
      return {
        status: 'error',
        message: `Nothing on screen matches "${selector}"`
      };
    }

    showCallout(element, requireBody(request, 'text').trim(), {
      closable: true
    });

    return { status: 'ok' };
  }
}

/**
 * The `tour` action: step through elements listed in the body as YAML.
 */
export class TourAction implements IActionImplementation {
  readonly type = 'tour';

  describe(): string {
    return 'Take a tour';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const steps = parseSteps(requireBody(request, 'a list of steps'));

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const element = findElement(step.selector);

      if (!element) {
        return {
          status: 'error',
          message: `Nothing on screen matches "${step.selector}"`
        };
      }

      element.scrollIntoView({ block: 'nearest' });

      const last = index === steps.length - 1;

      await new Promise<void>(resolve => {
        showCallout(element, step.text, {
          button: last ? 'Done' : `Next (${index + 1}/${steps.length})`,
          onButton: resolve
        });
      });
    }

    return { status: 'ok' };
  }
}

/**
 * The `toast` action: show a notification.
 */
export class ToastAction implements IActionImplementation {
  readonly type = 'toast';

  describe(): string {
    return 'Show a message';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const message = requireBody(request, 'a message').trim();
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
 * The `dialog` action: ask a question and capture the chosen button.
 */
export class DialogAction implements IActionImplementation {
  readonly type = 'dialog';

  describe(request: IActionRequest): string {
    return request.options.title
      ? `Ask "${request.options.title}"`
      : 'Ask a question';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const labels = (request.options.buttons ?? 'OK')
      .split(',')
      .map(label => label.trim())
      .filter(label => label !== '');

    const result = await showDialog({
      title: request.options.title ?? 'Workshop',
      body: requireBody(request, 'a message').trim(),
      buttons: labels.map((label, index) =>
        index === labels.length - 1
          ? Dialog.okButton({ label })
          : Dialog.createButton({ label })
      )
    });

    const chosen =
      result.button.accept || result.button.label ? result.button.label : '';

    if (!chosen) {
      return { status: 'skipped', message: 'Dismissed' };
    }

    return {
      status: 'ok',
      message: chosen,
      captured: request.options.capture
        ? { [request.options.capture]: chosen }
        : undefined
    };
  }
}

/**
 * The `copy` action: copy the body to the clipboard.
 */
export class CopyAction implements IActionImplementation {
  readonly type = 'copy';

  describe(): string {
    return 'Copy to clipboard';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    await navigator.clipboard.writeText(request.body);

    Notification.success('Copied to clipboard', { autoClose: 1500 });

    return { status: 'ok' };
  }
}

function parseSteps(body: string): ITourStep[] {
  const data: unknown = load(body);

  if (!Array.isArray(data)) {
    throw new Error('The tour body must be a YAML list of steps');
  }

  return data.map((item: unknown, index: number) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(
        `Step ${index + 1} must be a mapping with selector and text`
      );
    }

    const record = item as Record<string, unknown>;

    if (typeof record.selector !== 'string') {
      throw new Error(`Step ${index + 1} needs a "selector"`);
    }

    return {
      selector: record.selector,
      text: typeof record.text === 'string' ? record.text : ''
    };
  });
}
