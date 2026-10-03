/**
 * What an action box shows of its body.
 *
 * The body of most actions is what the learner should read: a command,
 * code, the text of a file. The body of `tour` and `notebook-create` is
 * YAML, written for the action and not for the learner, so the box shows
 * a readable form of it in its place: what each step of the tour says,
 * and the content of each cell of the notebook. The reading lives here,
 * free of JupyterLab, so anything that presents a page can share it.
 */

import { load } from 'js-yaml';

/** The kinds of cell a `notebook-create` body can name. */
const CELL_KINDS: readonly string[] = ['code', 'markdown', 'raw'];

/**
 * The readable form of an action's body, as the blocks of text to show
 * in order, one for each step or cell that has something to show.
 *
 * Returns null when the body is to be shown as written: for every action
 * type whose body is already what the learner should read, and for a
 * body that cannot be read as the YAML the action expects, so that an
 * author sees their mistake rather than an empty box.
 */
export function actionDisplay(type: string, body: string): string[] | null {
  if (type !== 'tour' && type !== 'notebook-create') {
    return null;
  }

  if (body.trim() === '') {
    return [];
  }

  let data: unknown;

  try {
    data = load(body);
  } catch {
    return null;
  }

  if (!Array.isArray(data)) {
    return null;
  }

  const parts = type === 'tour' ? data.map(stepText) : data.map(cellSource);

  if (parts.some(part => part === null)) {
    return null;
  }

  const shown = parts.map(part => (part ?? '').trim());

  // The steps of a tour are numbered, as the button of each callout
  // counts them, and a step that says nothing keeps its number.
  if (type === 'tour') {
    return shown
      .map((text, index) => (text ? `${index + 1}. ${text}` : ''))
      .filter(text => text !== '');
  }

  return shown.filter(text => text !== '');
}

/** The text of one tour step, or null when it is not a step. */
function stepText(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }

  const record = item as Record<string, unknown>;

  if (typeof record.selector !== 'string') {
    return null;
  }

  return typeof record.text === 'string' ? record.text : '';
}

/** The source of one notebook cell, or null when it is not a cell. */
function cellSource(item: unknown): string | null {
  if (typeof item === 'string') {
    return item;
  }

  if (typeof item !== 'object' || item === null) {
    return null;
  }

  const record = item as Record<string, unknown>;

  for (const kind of CELL_KINDS) {
    if (typeof record[kind] === 'string') {
      return record[kind] as string;
    }
  }

  return typeof record.source === 'string' ? record.source : '';
}
