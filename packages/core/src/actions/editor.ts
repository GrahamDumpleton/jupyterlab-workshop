/**
 * How the editor actions find the text they work on.
 *
 * `editor-select`, `editor-highlight`, `editor-replace` and `editor-insert`
 * all point at text the same way: with `match` (literal text, or a regular
 * expression with `regex: true`, narrowed by `occurrence` and, for the
 * selecting actions, `group`) or with `line` (a line number or a range).
 * The parsing and matching live here, free of JupyterLab, so the linter
 * and the extension agree on what an option means.
 */

/** The editor actions that share the targeting options. */
export const EDITOR_ACTIONS: readonly string[] = [
  'editor-select',
  'editor-highlight',
  'editor-replace',
  'editor-insert'
];

/** Which matches an action works on, counting from one; `end` null is all. */
export interface IOccurrence {
  start: number;
  end: number | null;
}

/** Text found by `match`. */
export interface IMatchTarget {
  kind: 'match';

  /** The literal text or regular expression source. */
  pattern: string;

  regex: boolean;

  occurrence: IOccurrence;

  /** Capture group whose span is used instead of the whole match. */
  group?: string;

  /** Whether the replacement body expands `$1`-style references. */
  expand: boolean;

  /** Where `editor-insert` puts its body relative to the matched line. */
  position: 'before' | 'after';
}

/** Whole lines named by `line`, one-based and inclusive. */
export interface ILineTarget {
  kind: 'line';
  start: number;
  end: number;
  position: 'before' | 'after';
}

/** The end of the file, which is where `editor-insert` goes by default. */
export interface IEndTarget {
  kind: 'end';
}

export type EditorTarget = IMatchTarget | ILineTarget | IEndTarget;

/** The outcome of reading the targeting options of an editor action. */
export interface IEditorTargetResult {
  target?: EditorTarget;
  errors: string[];
}

/** One place `match` found in a file. */
export interface IEditorMatch {
  /** Offsets of the whole match. */
  start: number;
  end: number;

  /** Offsets of the part the action uses: the group, else the match. */
  spanStart: number;
  spanEnd: number;

  /** The matched text and its captures, for expanding a replacement. */
  text: string;
  captures: (string | undefined)[];
  named: Record<string, string | undefined>;
}

/** A range of offsets in a file. */
export interface IOffsetSpan {
  start: number;
  end: number;
}

/** Match indices, which the ES2020 library the project compiles against lacks. */
type IndexPair = [number, number];

interface IExecWithIndices extends RegExpExecArray {
  indices?: IndexPair[] & { groups?: Record<string, IndexPair> };
}

const LINE_RANGE = /^(\d+)(?:-(\d+))?$/;

const GROUP_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * Read the targeting options of an editor action. Every problem found is
 * reported; a target is returned only when there are none.
 */
export function parseEditorTarget(
  type: string,
  options: Record<string, string>
): IEditorTargetResult {
  const errors: string[] = [];
  const isInsert = type === 'editor-insert';
  const hasMatch = options.match !== undefined;
  const hasLine = options.line !== undefined;

  // Flags that only mean something alongside a match, or a regex.
  const regex = parseFlag('regex', options.regex, errors);
  const expand = parseFlag('expand', options.expand, errors);
  const position = parsePosition(options.position, errors);

  for (const name of ['regex', 'occurrence', 'group', 'expand']) {
    if (options[name] !== undefined && !hasMatch) {
      errors.push(`The "${name}" option needs a "match" option`);
    }
  }

  for (const name of ['group', 'expand']) {
    if (options[name] !== undefined && hasMatch && !regex) {
      errors.push(`The "${name}" option needs "regex: true"`);
    }
  }

  if (hasMatch && hasLine) {
    errors.push('Give either a "match" or a "line" option, not both');
  } else if (!hasMatch && !hasLine && !isInsert) {
    errors.push('A "match" or a "line" option is needed');
  }

  // The match target: a literal, or a regex that must compile and must
  // have any group the options name.
  let target: EditorTarget | undefined;

  if (hasMatch) {
    const occurrence = parseOccurrence(options.occurrence, errors);
    let group: string | undefined;

    if (regex) {
      const groups = patternGroups(options.match);

      if (groups === null) {
        errors.push(
          `The pattern "${options.match}" is not a valid regular expression`
        );
      } else if (options.group !== undefined) {
        group = checkGroup(options.group, groups, errors);
      }
    }

    if (options.match === '') {
      errors.push('The "match" option is empty');
    }

    target = {
      kind: 'match',
      pattern: options.match,
      regex,
      occurrence,
      group,
      expand,
      position
    };
  } else if (hasLine) {
    target = parseLineTarget(options.line, isInsert, position, errors);
  } else if (isInsert) {
    target = { kind: 'end' };
  }

  return errors.length > 0 ? { errors } : { target, errors };
}

/**
 * The problems the linter reports for an editor action's options.
 */
export function editorTargetProblems(
  type: string,
  options: Record<string, string>
): string[] {
  return parseEditorTarget(type, options).errors;
}

/**
 * Find every place a match target refers to in a file, in file order,
 * already narrowed to the wanted occurrences.
 */
export function findEditorMatches(
  source: string,
  target: IMatchTarget
): IEditorMatch[] {
  const matches = target.regex
    ? regexMatches(source, target)
    : literalMatches(source, target.pattern);
  const { start, end } = target.occurrence;

  return matches.slice(start - 1, end === null ? undefined : end);
}

/**
 * Expand `$1`, `$<name>`, `$&` and `$$` in a replacement the way
 * JavaScript's `String.replace` does. A reference to a group the pattern
 * lacks is left as it is.
 */
export function expandReplacement(
  template: string,
  match: IEditorMatch
): string {
  return template.replace(
    /\$(\$|&|<([^>]*)>|\d{1,2})/g,
    (whole: string, token: string, name: string | undefined): string => {
      if (token === '$') {
        return '$';
      }

      if (token === '&') {
        return match.text;
      }

      if (name !== undefined) {
        return name in match.named ? (match.named[name] ?? '') : whole;
      }

      // A two-digit reference falls back to one digit plus a literal
      // digit when the pattern has fewer groups, as in JavaScript.
      const count = match.captures.length;
      const twoDigit = Number(token);

      if (token.length === 2 && twoDigit >= 1 && twoDigit <= count) {
        return match.captures[twoDigit - 1] ?? '';
      }

      const oneDigit = Number(token[0]);

      if (oneDigit >= 1 && oneDigit <= count) {
        return (match.captures[oneDigit - 1] ?? '') + token.slice(1);
      }

      return whole;
    }
  );
}

/**
 * Offsets of a range of whole lines, one-based and inclusive, including
 * the newline that ends the last line. Lines past the end of the file
 * are clipped; a start past the end yields an empty span at the end.
 */
export function lineSpan(
  source: string,
  start: number,
  end: number
): IOffsetSpan {
  const starts = lineStarts(source);
  const first = Math.min(start - 1, starts.length);
  const last = Math.min(end, starts.length);

  return {
    start: first < starts.length ? starts[first] : source.length,
    end: last < starts.length ? starts[last] : source.length
  };
}

/**
 * Offsets of the text of a range of lines, without the final newline,
 * which is what selecting those lines covers.
 */
export function lineTextSpan(
  source: string,
  start: number,
  end: number
): IOffsetSpan {
  const span = lineSpan(source, start, end);
  const trimmed =
    span.end > span.start && source[span.end - 1] === '\n'
      ? span.end - 1
      : span.end;

  return { start: span.start, end: trimmed };
}

/**
 * The one-based line an offset falls on.
 */
export function lineAt(source: string, offset: number): number {
  let line = 1;

  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') {
      line += 1;
    }
  }

  return line;
}

/**
 * The offset at which a one-based line starts; the end of the file for a
 * line past the last one.
 */
export function lineStart(source: string, line: number): number {
  const starts = lineStarts(source);

  return line - 1 < starts.length ? starts[line - 1] : source.length;
}

/**
 * How many lines a file has, counting a final unterminated line.
 */
export function lineCount(source: string): number {
  return lineStarts(source).length;
}

function lineStarts(source: string): number[] {
  const starts = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n' && index + 1 < source.length) {
      starts.push(index + 1);
    }
  }

  return starts;
}

function literalMatches(source: string, pattern: string): IEditorMatch[] {
  const matches: IEditorMatch[] = [];
  let index = source.indexOf(pattern);

  while (index >= 0) {
    matches.push({
      start: index,
      end: index + pattern.length,
      spanStart: index,
      spanEnd: index + pattern.length,
      text: pattern,
      captures: [],
      named: {}
    });
    index = source.indexOf(pattern, index + Math.max(pattern.length, 1));
  }

  return matches;
}

function regexMatches(source: string, target: IMatchTarget): IEditorMatch[] {
  const matches: IEditorMatch[] = [];
  const pattern = compilePattern(target.pattern, target.group !== undefined);
  let found: IExecWithIndices | null;

  while ((found = pattern.exec(source) as IExecWithIndices | null) !== null) {
    const span = groupSpan(found, target.group);

    // A group that took no part in this match has no span to offer.
    if (span) {
      matches.push({
        start: found.index,
        end: found.index + found[0].length,
        spanStart: span[0],
        spanEnd: span[1],
        text: found[0],
        captures: found.slice(1),
        named: found.groups ?? {}
      });
    }

    if (found[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }

  return matches;
}

function groupSpan(
  found: IExecWithIndices,
  group: string | undefined
): IndexPair | undefined {
  if (group === undefined) {
    return [found.index, found.index + found[0].length];
  }

  const indices = found.indices;

  if (!indices) {
    return undefined;
  }

  return /^\d+$/.test(group) ? indices[Number(group)] : indices.groups?.[group];
}

/**
 * Compile a pattern with the flags the editor actions use: global, and
 * multiline so `^` and `$` mark lines, plus match indices when a group
 * span is wanted.
 */
function compilePattern(pattern: string, indices: boolean): RegExp {
  return new RegExp(pattern, indices ? 'gmd' : 'gm');
}

/**
 * The capture groups of a pattern: how many, and the named ones. Null
 * when the pattern does not compile.
 */
function patternGroups(
  pattern: string
): { count: number; names: string[] } | null {
  try {
    // Alternating with the empty pattern makes an empty match that still
    // reports every group.
    const probe = new RegExp(`${pattern}|`, 'm').exec('');

    return {
      count: probe ? probe.length - 1 : 0,
      names: probe?.groups ? Object.keys(probe.groups) : []
    };
  } catch {
    return null;
  }
}

function checkGroup(
  value: string,
  groups: { count: number; names: string[] },
  errors: string[]
): string | undefined {
  if (/^\d+$/.test(value)) {
    const number = Number(value);

    if (number < 1 || number > groups.count) {
      errors.push(
        groups.count === 0
          ? `The pattern has no capture groups, so "group: ${value}" names nothing`
          : `The pattern has ${groups.count} capture group${groups.count === 1 ? '' : 's'}, so "group: ${value}" names nothing`
      );

      return undefined;
    }

    return value;
  }

  if (!GROUP_NAME.test(value)) {
    errors.push(`"${value}" is not a group number or name`);

    return undefined;
  }

  if (!groups.names.includes(value)) {
    errors.push(`The pattern has no group named "${value}"`);

    return undefined;
  }

  return value;
}

function parseFlag(
  name: string,
  value: string | undefined,
  errors: string[]
): boolean {
  if (value === undefined) {
    return false;
  }

  if (value !== 'true' && value !== 'false') {
    errors.push(`The "${name}" option must be true or false`);

    return false;
  }

  return value === 'true';
}

function parsePosition(
  value: string | undefined,
  errors: string[]
): 'before' | 'after' {
  if (value === undefined || value === 'before') {
    return 'before';
  }

  if (value === 'after') {
    return 'after';
  }

  errors.push('The "position" option must be before or after');

  return 'before';
}

function parseOccurrence(
  value: string | undefined,
  errors: string[]
): IOccurrence {
  if (value === undefined) {
    return { start: 1, end: 1 };
  }

  if (value === 'all') {
    return { start: 1, end: null };
  }

  const range = LINE_RANGE.exec(value);
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] !== undefined ? Number(range[2]) : start;

  if (!range || start < 1 || end < start) {
    errors.push(
      `The "occurrence" option must be a number, a range like 2-3, or all, not "${value}"`
    );

    return { start: 1, end: 1 };
  }

  return { start, end };
}

function parseLineTarget(
  value: string,
  isInsert: boolean,
  position: 'before' | 'after',
  errors: string[]
): ILineTarget | IEndTarget | undefined {
  if (value === 'end' && isInsert) {
    return { kind: 'end' };
  }

  const range = LINE_RANGE.exec(value);
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] !== undefined ? Number(range[2]) : start;

  if (!range || start < 1 || end < start) {
    errors.push(
      isInsert
        ? `The "line" option must be a line number or end, not "${value}"`
        : `The "line" option must be a line number or a range like 10-15, not "${value}"`
    );

    return undefined;
  }

  if (isInsert && range[2] !== undefined) {
    errors.push(
      'The "line" option of editor-insert is a single line, not a range'
    );

    return undefined;
  }

  return { kind: 'line', start, end, position };
}
