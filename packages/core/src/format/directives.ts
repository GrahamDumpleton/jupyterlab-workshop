/**
 * Parsing of MyST directive blocks.
 *
 * A directive is a fenced block whose info string is the directive name in
 * braces, optionally followed by an argument, for example
 * ```` ```{when} track == "pip" ````. The first lines of the block may be
 * options of the form `:key: value`; the remainder is the body.
 */

/** The name and argument from a directive fence info string. */
export interface IDirectiveInfo {
  name: string;
  argument: string;
}

/** The options and body of a directive block. */
export interface IDirectiveContent {
  /** Option values keyed by option name. Flag options have an empty value. */
  options: Record<string, string>;

  /** The body text following the options, without a trailing newline. */
  body: string;
}

const INFO = /^\{([a-z][a-z0-9-]*)\}(?:[ \t]+(.*?))?[ \t]*$/;

const OPTION_LINE = /^:([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;

/**
 * Extract the directive name and argument from a fence info string, or
 * return null when the info string does not denote a directive.
 */
export function parseDirectiveInfo(info: string): IDirectiveInfo | null {
  const match = INFO.exec(info.trim());

  return match ? { name: match[1], argument: match[2] ?? '' } : null;
}

/**
 * Split the content of a directive block into its options and body.
 */
export function parseDirectiveContent(content: string): IDirectiveContent {
  const lines = content.replace(/\n$/, '').split('\n');
  const options: Record<string, string> = {};

  // Consume leading option lines.
  let index = 0;

  while (index < lines.length) {
    const match = OPTION_LINE.exec(lines[index]);

    if (!match) {
      break;
    }

    options[match[1]] = (match[2] ?? '').trim();
    index += 1;
  }

  // A single blank line may separate the options from the body.
  if (index > 0 && index < lines.length && lines[index].trim() === '') {
    index += 1;
  }

  return { options, body: lines.slice(index).join('\n') };
}
