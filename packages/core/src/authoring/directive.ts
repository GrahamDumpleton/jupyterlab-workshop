/**
 * Writing directives back to page source: serialising a directive from
 * its parts, and finding, replacing and removing directive blocks by the
 * line they start on. The authoring tools and the recorder use these so
 * that every edit goes through the page files.
 */

/** The parts of a directive to write. */
export interface IDirectiveDraft {
  name: string;

  /** Text after the name on the opening fence, for `when` conditions. */
  argument?: string;

  options: Record<string, string>;
  body: string;
}

/** The lines a directive block occupies, one-based and inclusive. */
export interface IDirectiveExtent {
  start: number;
  end: number;
}

const OPENING_FENCE = /^(`{3,}|~{3,})\s*\{([a-z][a-z0-9-]*)\}/;

/**
 * Serialise a directive as a fenced block. The fence is lengthened when
 * the body itself contains backtick runs, and empty options are written
 * as flags.
 */
export function serializeDirective(draft: IDirectiveDraft): string {
  const fence = fenceFor(draft.body);
  const argument = draft.argument?.trim() ? ` ${draft.argument.trim()}` : '';
  const lines = [`${fence}{${draft.name}}${argument}`];

  // Options come first, `id` and `title` before the rest, and a value on
  // its own line would be read as body, so values are kept to one line.
  const names = Object.keys(draft.options).sort(
    (a, b) => optionRank(a) - optionRank(b)
  );

  for (const name of names) {
    const value = draft.options[name].replace(/\s*\n\s*/g, ' ').trim();

    lines.push(value === '' ? `:${name}:` : `:${name}: ${value}`);
  }

  const body = draft.body.replace(/\n+$/, '');

  if (body !== '') {
    lines.push(body);
  }

  lines.push(fence);

  return lines.join('\n');
}

/**
 * Find the block of the directive whose opening fence is on a line, or
 * return null when the line does not open a directive.
 */
export function directiveExtent(
  source: string,
  line: number
): IDirectiveExtent | null {
  const lines = source.split('\n');
  const opening = OPENING_FENCE.exec(lines[line - 1] ?? '');

  if (!opening) {
    return null;
  }

  // The closing fence uses the same character and is at least as long.
  const marker = opening[1];
  const closing = new RegExp(`^${marker[0]}{${marker.length},}\\s*$`);

  for (let index = line; index < lines.length; index += 1) {
    if (closing.test(lines[index])) {
      return { start: line, end: index + 1 };
    }
  }

  return { start: line, end: lines.length };
}

/**
 * Replace the directive block starting on a line with new text.
 */
export function replaceDirective(
  source: string,
  line: number,
  text: string
): string {
  const extent = directiveExtent(source, line);

  if (!extent) {
    throw new Error(`Line ${line} does not start a directive`);
  }

  return replaceLines(source, extent.start, extent.end, text);
}

/**
 * Remove the directive block starting on a line, along with one blank
 * line that separated it from the content around it.
 */
export function removeDirective(source: string, line: number): string {
  const extent = directiveExtent(source, line);

  if (!extent) {
    throw new Error(`Line ${line} does not start a directive`);
  }

  const lines = source.split('\n');
  const before = lines.slice(0, extent.start - 1);
  const after = lines.slice(extent.end);

  if (after.length > 0 && after[0].trim() === '') {
    after.shift();
  } else if (before.length > 0 && before[before.length - 1].trim() === '') {
    before.pop();
  }

  return [...before, ...after].join('\n');
}

/**
 * Insert a block after a line (0 for the top), keeping a blank line on
 * either side so it renders as its own block.
 */
export function insertBlock(
  source: string,
  line: number,
  text: string
): string {
  const lines = source.split('\n');
  const at = Math.max(0, Math.min(line, lines.length));
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  const block = text.replace(/\n+$/, '').split('\n');

  if (before.length > 0 && before[before.length - 1].trim() !== '') {
    block.unshift('');
  }

  if (after.length > 0 && after[0].trim() !== '') {
    block.push('');
  }

  return [...before, ...block, ...after].join('\n');
}

/**
 * Append a block to the end of a page, separated by a blank line and
 * ending with a newline.
 */
export function appendBlock(source: string, text: string): string {
  const trimmed = source.replace(/\n+$/, '');
  const block = text.replace(/\n+$/, '');

  return trimmed === '' ? `${block}\n` : `${trimmed}\n\n${block}\n`;
}

/**
 * Replace a range of lines, one-based and inclusive, with new text.
 */
export function replaceLines(
  source: string,
  start: number,
  end: number,
  text: string
): string {
  const lines = source.split('\n');
  const replacement = text.replace(/\n$/, '').split('\n');

  lines.splice(start - 1, end - start + 1, ...replacement);

  return lines.join('\n');
}

function fenceFor(body: string): string {
  let longest = 0;

  for (const match of body.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }

  return '`'.repeat(Math.max(3, longest + 1));
}

function optionRank(name: string): number {
  return name === 'id' ? 0 : name === 'title' ? 1 : 2;
}
