import { createRenderEnv, getMarkdownParser } from '@jupyterlab-workshop/core';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { PageConfig, PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';
import { Widget } from '@lumino/widgets';

import { readIfExists } from '../actions/contents';

/** Prefix of the localStorage keys remembering a welcome message was shown. */
const SHOWN_KEY = '@jupyterlab-workshop/labextension:welcome:';

/** The dialog title when the file does not start with a heading. */
const DEFAULT_TITLE = 'Welcome';

/** A welcome message read from its Markdown file. */
export interface IWelcomeMessage {
  /** The dialog title: the file's leading level-one heading, or "Welcome". */
  title: string;

  /** The Markdown shown in the dialog, without the heading taken as the title. */
  body: string;
}

/**
 * Split a welcome file into the dialog's title and body. A level-one
 * heading on the first non-blank line is the title; otherwise the title
 * is "Welcome" and the whole file is the body.
 */
export function parseWelcome(text: string): IWelcomeMessage {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;

  while (index < lines.length && lines[index].trim() === '') {
    index += 1;
  }

  const heading = /^#\s+(.+?)\s*#*\s*$/.exec(lines[index] ?? '');

  if (!heading) {
    return { title: DEFAULT_TITLE, body: text.trim() };
  }

  return {
    title: heading[1],
    body: lines
      .slice(index + 1)
      .join('\n')
      .trim()
  };
}

/**
 * Read a welcome message from a Markdown file in the contents, or return
 * null when there is no file at the path.
 */
export async function readWelcome(
  contents: Contents.IManager,
  path: string
): Promise<IWelcomeMessage | null> {
  const text = await readIfExists(contents, PathExt.normalize(path));

  return text === null ? null : parseWelcome(text);
}

/**
 * Whether the welcome file at this path has been shown in this browser
 * for this server.
 */
export function wasWelcomeShown(path: string): boolean {
  try {
    return window.localStorage.getItem(shownKey(path)) !== null;
  } catch {
    return false;
  }
}

/**
 * Remember that the welcome file at this path has been shown in this
 * browser for this server.
 */
export function markWelcomeShown(path: string): void {
  try {
    window.localStorage.setItem(shownKey(path), '1');
  } catch {
    // Storage that is unavailable means the message shows again next time.
  }
}

/**
 * Show a welcome message in a dialog, rendered as the workshop pages are.
 */
export async function showWelcomeDialog(
  message: IWelcomeMessage
): Promise<void> {
  await showDialog({
    title: message.title,
    body: new WelcomeBody(message.body),
    buttons: [Dialog.okButton({ label: 'Close' })]
  });
}

// The key names the server too, since one browser may visit several,
// such as one Binder session after another, each with its own message.
function shownKey(path: string): string {
  return `${SHOWN_KEY}${PageConfig.getBaseUrl()}:${path}`;
}

class WelcomeBody extends Widget {
  constructor(body: string) {
    super();

    this.addClass('jp-WorkshopWelcome');

    const message = document.createElement('div');

    message.className = 'jp-WorkshopWelcome-message';
    message.innerHTML = getMarkdownParser().render(
      body,
      createRenderEnv('welcome', {})
    );
    this.node.appendChild(message);
  }
}
