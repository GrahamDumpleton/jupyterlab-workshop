/**
 * Platform variants of a directive body.
 *
 * A body may carry alternatives for particular platforms, introduced by a
 * marker line naming the platform:
 *
 * ```
 * python3 -m venv .venv && source .venv/bin/activate
 * :windows:
 * py -m venv .venv; .\.venv\Scripts\Activate.ps1
 * :lite:
 * ```
 *
 * The text before the first marker is the default, used on any platform
 * without a variant of its own. A variant may be empty, which means there
 * is nothing to do on that platform.
 */

/** The platforms a manifest may list and a body may have variants for. */
export const PLATFORM_NAMES: readonly string[] = [
  'linux',
  'macos',
  'windows',
  'lite'
];

/** Key under which the text before the first marker is kept. */
export const DEFAULT_VARIANT = 'default';

/** A body split into its default text and platform variants. */
export interface ISplitBody {
  /** The text before the first marker, or null when the body starts with a marker. */
  defaultText: string | null;

  /** Variant text keyed by platform name, in the order they appeared. */
  variants: Record<string, string>;
}

const MARKER = /^:([a-z]+):[ \t]*$/;

/**
 * Whether a body contains any platform marker line.
 */
export function hasVariants(body: string): boolean {
  return body.split('\n').some(line => isMarker(line));
}

/**
 * Split a body at its platform marker lines.
 */
export function splitVariants(body: string): ISplitBody {
  const variants: Record<string, string> = {};
  let current: string | null = null;
  let defaultLines: string[] | null = [];
  let lines: string[] = [];

  const finish = (): void => {
    if (current === null) {
      defaultLines = lines;
    } else {
      variants[current] = lines.join('\n').replace(/\n+$/, '');
    }

    lines = [];
  };

  for (const line of body.split('\n')) {
    const marker = isMarker(line);

    if (marker) {
      finish();
      current = marker;
    } else {
      lines.push(line);
    }
  }

  finish();

  // A default made only of blank lines counts as absent, so a body that
  // starts with a marker after a blank line still has no default.
  const defaultText =
    defaultLines === null ? null : defaultLines.join('\n').replace(/\n+$/, '');

  return {
    defaultText:
      defaultText !== null && defaultText.trim() !== '' ? defaultText : null,
    variants
  };
}

/**
 * Pick the text for a platform: its variant, else the default, else an
 * empty string. Returns which variant was chosen alongside.
 */
export function selectVariant(
  split: ISplitBody,
  platform: string | undefined
): { body: string; variant: string } {
  if (platform !== undefined && platform in split.variants) {
    return { body: split.variants[platform], variant: platform };
  }

  return { body: split.defaultText ?? '', variant: DEFAULT_VARIANT };
}

/**
 * The full set of alternatives of a split body keyed by platform, with
 * the default under `default` when there is one.
 */
export function allVariants(split: ISplitBody): Record<string, string> {
  const all: Record<string, string> = {};

  if (split.defaultText !== null) {
    all[DEFAULT_VARIANT] = split.defaultText;
  }

  return { ...all, ...split.variants };
}

function isMarker(line: string): string | null {
  const match = MARKER.exec(line);

  return match && PLATFORM_NAMES.includes(match[1]) ? match[1] : null;
}
