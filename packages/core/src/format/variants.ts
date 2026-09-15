/**
 * Platform and frontend variants of a directive body.
 *
 * A body may carry alternatives for particular platforms or frontends,
 * introduced by a marker line naming one of them:
 *
 * ```
 * python3 -m venv .venv && source .venv/bin/activate
 * :windows:
 * py -m venv .venv; .\.venv\Scripts\Activate.ps1
 * :jupyterlite:
 * ```
 *
 * The text before the first marker is the default, used wherever no
 * variant of its own applies. A variant may be empty, which means there
 * is nothing to do there. A frontend variant is the more specific of the
 * two, so it is chosen before a platform variant; a body that needs to
 * say "this frontend on that platform" uses a `when` condition instead,
 * since markers do not nest.
 */

/** The operating systems a manifest may list and a body may have variants for. */
export const PLATFORM_NAMES: readonly string[] = ['linux', 'macos', 'windows'];

/** The frontends a manifest may list and a body may have variants for. */
export const FRONTEND_NAMES: readonly string[] = ['jupyterlab', 'jupyterlite'];

/** Every name a marker line may carry: the frontends and the platforms. */
export const MARKER_NAMES: readonly string[] = [
  ...FRONTEND_NAMES,
  ...PLATFORM_NAMES
];

/** Key under which the text before the first marker is kept. */
export const DEFAULT_VARIANT = 'default';

/** A body split into its default text and variants. */
export interface ISplitBody {
  /** The text before the first marker, or null when the body starts with a marker. */
  defaultText: string | null;

  /** Variant text keyed by marker name, in the order they appeared. */
  variants: Record<string, string>;
}

const MARKER = /^:([a-z]+):[ \t]*$/;

/**
 * Whether a body contains any marker line.
 */
export function hasVariants(body: string): boolean {
  return body.split('\n').some(line => isMarker(line));
}

/**
 * Split a body at its marker lines.
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
 * Pick the text for a frontend and platform: the frontend's variant,
 * else the platform's, else the default, else an empty string. Returns
 * which variant was chosen alongside.
 */
export function selectVariant(
  split: ISplitBody,
  platform: string | undefined,
  frontend?: string
): { body: string; variant: string } {
  if (frontend !== undefined && frontend in split.variants) {
    return { body: split.variants[frontend], variant: frontend };
  }

  if (platform !== undefined && platform in split.variants) {
    return { body: split.variants[platform], variant: platform };
  }

  return { body: split.defaultText ?? '', variant: DEFAULT_VARIANT };
}

/**
 * The full set of alternatives of a split body keyed by marker name, with
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

  return match && MARKER_NAMES.includes(match[1]) ? match[1] : null;
}
