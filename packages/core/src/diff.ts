/**
 * A minimal line diff used to show what a write will change before it is
 * confirmed.
 */

/** One line of a diff. */
export interface IDiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

/**
 * Diff two texts line by line using a longest common subsequence.
 */
export function lineDiff(before: string, after: string): IDiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // Build the LCS table bottom-up so the walk below can read it forwards.
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: IDiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: 'remove', text: a[i] });
      i += 1;
    } else {
      lines.push({ kind: 'add', text: b[j] });
      j += 1;
    }
  }

  for (; i < a.length; i += 1) {
    lines.push({ kind: 'remove', text: a[i] });
  }

  for (; j < b.length; j += 1) {
    lines.push({ kind: 'add', text: b[j] });
  }

  return lines;
}

/**
 * Render a diff in unified style with `+`, `-` and space prefixes.
 */
export function formatDiff(lines: IDiffLine[]): string {
  return lines
    .map(line => {
      const prefix =
        line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';

      return `${prefix} ${line.text}`;
    })
    .join('\n');
}

function splitLines(text: string): string[] {
  if (text === '') {
    return [];
  }

  const lines = text.split('\n');

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}
