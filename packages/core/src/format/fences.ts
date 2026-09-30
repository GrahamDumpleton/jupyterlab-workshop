/**
 * Fenced blocks as CommonMark sees them, for finding a directive that was
 * closed by the fence of a block inside it.
 *
 * A fence closes at the first line holding only a run of the same
 * character at least as long as the one that opened it. A directive
 * fenced with three backticks that holds a three-backtick block therefore
 * ends at that block, not at its own closing line, while the source reads
 * as the author meant it. The scanners here find what that leaves behind.
 *
 * Indentation is ignored, since a fence inside a list item is indented
 * with the item.
 */

/** A line that opens or could close a fence. */
export interface IFenceLine {
  /** The run of backticks or tildes. */
  marker: string;

  /** What follows the run, trimmed; empty on a line that can close. */
  info: string;
}

/** A fence opened inside a run of text and never closed within it. */
export interface IUnclosedFence {
  /** Zero-based line of the opener within the text. */
  line: number;

  marker: string;
  info: string;
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Read a line as a fence opener or closer, or return null when it is
 * neither. A backtick run followed by text holding a backtick is a code
 * span, not a fence.
 */
export function fenceLine(line: string): IFenceLine | null {
  const match = FENCE_LINE.exec(line);

  if (!match) {
    return null;
  }

  const marker = match[1];
  const info = match[2].trim();

  if (marker[0] === '`' && info.includes('`')) {
    return null;
  }

  return { marker, info };
}

/**
 * Whether a line closes the fence a marker opened: the same character,
 * at least as many of it, and nothing else.
 */
export function closesFence(line: IFenceLine, marker: string): boolean {
  return (
    line.info === '' &&
    line.marker[0] === marker[0] &&
    line.marker.length >= marker.length
  );
}

/**
 * Find the fence left open at the end of a text, following the lines as
 * CommonMark does: a fence opener starts a block, and only a closer for
 * that block ends it. Returns null when every fence is closed.
 */
export function unclosedFence(text: string): IUnclosedFence | null {
  const lines = text.split('\n');
  let open: IUnclosedFence | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const fence = fenceLine(lines[index]);

    if (!fence) {
      continue;
    }

    if (open === null) {
      open = { line: index, marker: fence.marker, info: fence.info };
    } else if (closesFence(fence, open.marker)) {
      open = null;
    }
  }

  return open;
}
