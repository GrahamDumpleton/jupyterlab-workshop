/**
 * Variable substitution for workshop text.
 *
 * References take the form `{{ name }}` with optional filters, for example
 * `{{ repo_dir | path }}` or `{{ token | default("none") }}`. A reference
 * preceded by a backslash, `\{{ name }}`, is left in the text with the
 * backslash removed, which is how a literal `{{` is written. References
 * whose name does not start with a letter or underscore, such as the
 * `{{ .Values }}` of Go templates, are never treated as variables.
 */

/** Variable values keyed by variable name. */
export type Variables = Record<string, string>;

/** Options controlling how filters render values. */
export interface ISubstituteOptions {
  /** Path separator used by the `path` filter. Defaults to `/`. */
  pathSep?: string;
}

/** Result of substituting variables into a piece of text. */
export interface ISubstituteResult {
  /** The text with references replaced. */
  text: string;

  /** Problems found, such as unknown variables or filters. */
  warnings: string[];
}

interface IFilterCall {
  name: string;
  arg: string | undefined;
}

const REFERENCE =
  /(\\?)\{\{\s*([A-Za-z_][A-Za-z0-9_]*)((?:\s*\|\s*[a-z_]+(?:\([^)]*\))?)*)\s*\}\}/g;

const FILTER = /\|\s*([a-z_]+)(?:\(([^)]*)\))?/g;

/**
 * Replace variable references in text with their values.
 */
export function substitute(
  text: string,
  variables: Variables,
  options: ISubstituteOptions = {}
): ISubstituteResult {
  const warnings: string[] = [];
  const pathSep = options.pathSep ?? '/';

  const result = text.replace(
    REFERENCE,
    (match: string, escaped: string, name: string, filters: string) => {
      // A backslash before the reference asks for the literal text.
      if (escaped) {
        return match.slice(1);
      }

      if (!(name in variables)) {
        warnings.push(`Unknown variable "${name}"`);
        return match;
      }

      // Apply the filters left to right, giving up on the first unknown one.
      let value = variables[name];

      for (const filter of parseFilters(filters)) {
        const applied = applyFilter(filter, value, pathSep);

        if (applied === undefined) {
          warnings.push(`Unknown filter "${filter.name}"`);
          return match;
        }

        value = applied;
      }

      return value;
    }
  );

  return { text: result, warnings };
}

/**
 * Quote a value for safe use as a single word in a POSIX shell command.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/.:=@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseFilters(spec: string): IFilterCall[] {
  const calls: IFilterCall[] = [];
  const pattern = new RegExp(FILTER.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(spec)) !== null) {
    const arg = match[2] === undefined ? undefined : unquote(match[2].trim());
    calls.push({ name: match[1], arg });
  }

  return calls;
}

function unquote(text: string): string {
  const quoted =
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"));

  return quoted && text.length >= 2 ? text.slice(1, -1) : text;
}

function applyFilter(
  filter: IFilterCall,
  value: string,
  pathSep: string
): string | undefined {
  switch (filter.name) {
    case 'lower':
      return value.toLowerCase();
    case 'upper':
      return value.toUpperCase();
    case 'slug':
      return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    case 'default':
      return value === '' ? (filter.arg ?? '') : value;
    case 'shell':
      return shellQuote(value);
    case 'path':
      return value.split('/').join(pathSep);
    default:
      return undefined;
  }
}
