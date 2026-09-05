import { load } from 'js-yaml';

import { WorkshopFormatError } from '../errors';
import { isRecord } from '../util';

/** A page split into its YAML front matter and Markdown body. */
export interface IFrontmatter {
  /** The parsed front matter, empty when the page has none. */
  data: Record<string, unknown>;

  /** The Markdown body following the front matter. */
  body: string;

  /** Zero-based line offset of the body within the original source. */
  bodyLine: number;
}

const OPENING = /^---[ \t]*\r?\n/;

const CLOSING = /^---[ \t]*$/;

/**
 * Split a page source into YAML front matter and Markdown body.
 */
export function splitFrontmatter(source: string, path?: string): IFrontmatter {
  if (!OPENING.test(source)) {
    return { data: {}, body: source, bodyLine: 0 };
  }

  // Find the closing fence.
  const lines = source.split(/\r?\n/);
  let end = -1;

  for (let index = 1; index < lines.length; index += 1) {
    if (CLOSING.test(lines[index])) {
      end = index;
      break;
    }
  }

  if (end < 0) {
    throw new WorkshopFormatError('Unterminated front matter', path, 1);
  }

  // Parse the YAML between the fences.
  const yamlText = lines.slice(1, end).join('\n');
  const data: unknown = yamlText.trim() === '' ? {} : load(yamlText);

  if (!isRecord(data)) {
    throw new WorkshopFormatError('Front matter must be a mapping', path, 1);
  }

  return { data, body: lines.slice(end + 1).join('\n'), bodyLine: end + 1 };
}
