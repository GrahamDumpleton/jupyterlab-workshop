/**
 * Launch links: the query parameters that open a workshop, add
 * collections and catalogs, or show a welcome message when JupyterLab
 * starts. The extension reads them from the address; the CLI and the
 * documentation build them. Parsing lives here, away from JupyterLab,
 * so it can be tested on its own.
 */

/** Query parameters a launch link uses. */
export const LAUNCH_PARAMS: ReadonlySet<string> = new Set([
  'workshop',
  'ref',
  'subdir',
  'sha256',
  'collection',
  'catalog',
  'restart',
  'welcome'
]);

/** A bare workshop name, as a link gives one alongside a collection. */
const WORKSHOP_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The sources a launch link adds, each in the order the link gives. */
export interface ISourceLink {
  collections: string[];
  catalogs: string[];
}

/** What a launch link's `workshop` parameter and its companions ask for. */
export interface ILaunchRequest {
  /** A local directory to open, when the workshop parameter is not a URL. */
  path?: string;

  /**
   * The collections to look a bare name up in, in the link's order, when
   * the workshop parameter is a bare name and the link also names
   * collections; `url` then holds the name.
   */
  collections?: string[];
  url: string;
  ref?: string;
  subdir?: string;
  sha256?: string;
  variables: Record<string, string>;

  /**
   * Whether to restart a workshop that is already present before opening
   * it: `ask` confirms first when it has recorded progress, `force` never
   * asks. Only a directory can be restarted; a download replaces its
   * files anyway.
   */
  restart?: 'ask' | 'force';
}

/**
 * Every value of a parameter, in order, trimmed, without empties, and
 * without a location given twice.
 */
function listParameter(params: URLSearchParams, name: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];

  for (const raw of params.getAll(name)) {
    const value = raw.trim();

    if (value === '' || seen.has(value)) {
      continue;
    }

    seen.add(value);
    values.push(value);
  }

  return values;
}

/**
 * The collections and catalogs a launch link names, from every
 * `collection` and `catalog` parameter, in the order given.
 */
export function parseSourceLink(search: string): ISourceLink {
  const params = new URLSearchParams(search);

  return {
    collections: listParameter(params, 'collection'),
    catalogs: listParameter(params, 'catalog')
  };
}

/**
 * The welcome file a launch link names with its `welcome` parameter, a
 * path relative to the JupyterLab root, or undefined when it names none.
 */
export function parseWelcomeLink(search: string): string | undefined {
  const welcome = new URLSearchParams(search).get('welcome')?.trim() ?? '';

  return welcome === '' ? undefined : welcome;
}

/**
 * Parse the query string of a launch link, or return null when it has no
 * `workshop` parameter.
 */
export function parseLaunchLink(search: string): ILaunchRequest | null {
  const params = new URLSearchParams(search);
  const workshop = params.get('workshop')?.trim() ?? '';

  if (workshop === '') {
    return null;
  }

  const variables: Record<string, string> = {};

  params.forEach((value, key) => {
    if (key.startsWith('var.') && key.length > 4) {
      variables[key.slice(4)] = value;
    }
  });

  // A bare name alongside collections is one of their workshops rather
  // than a directory.
  const isUrl = /^https?:\/\//i.test(workshop);
  const collections = listParameter(params, 'collection');
  const fromCollection =
    !isUrl && collections.length > 0 && WORKSHOP_NAME.test(workshop);

  // A bare `restart` asks when there is progress; `restart=force` never
  // does. The key is looked for in the raw string, since a bare key has
  // no value for the parser to keep.
  const restart = /(\?|&)restart(=|&|$)/.test(search)
    ? params.get('restart') === 'force'
      ? 'force'
      : 'ask'
    : undefined;

  return {
    path: isUrl || fromCollection ? undefined : workshop,
    collections: fromCollection ? collections : undefined,
    url: workshop,
    ref: params.get('ref') || undefined,
    subdir: params.get('subdir') || undefined,
    sha256: params.get('sha256') || undefined,
    variables,
    restart
  };
}

/**
 * The query string with the launch parameters taken out, keeping every
 * value of whatever else it carried, or an empty string when nothing is
 * left.
 */
export function stripLaunchParams(search: string): string {
  const kept = new URLSearchParams();

  new URLSearchParams(search).forEach((value, key) => {
    if (!LAUNCH_PARAMS.has(key) && !key.startsWith('var.')) {
      kept.append(key, value);
    }
  });

  const remaining = kept.toString();

  return remaining === '' ? '' : `?${remaining}`;
}
