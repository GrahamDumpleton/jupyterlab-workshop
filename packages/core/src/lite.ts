/**
 * Helpers for running workshops in JupyterLite, where there is no
 * server: resolving repository URLs to a base the browser can fetch raw
 * files from, listing the files a workshop needs downloaded, and spotting
 * shell syntax the JupyterLite terminal (cockle) does not support.
 */

import { IPage } from './format/page';
import { allDirectives } from './trust/capabilities';

/** A repository on a git forge, as far as fetching raw files needs. */
export interface IForgeSource {
  host: string;
  owner: string;
  repo: string;

  /** Branch, tag or commit; empty means the default branch. */
  ref: string;

  /** Directory inside the repository; empty for the root. */
  subdir: string;
}

const FORGE_TREE =
  /^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|src\/branch|-\/tree)\/([^/]+)(?:\/(.+?))?)?\/?$/;

// A gist is a repository too, with the gist id as its name and, on the
// permalink of a revision, the commit after the id instead of `/tree/`.
const GIST_REVISION =
  /^https:\/\/(gist\.github\.com)\/([^/]+)\/([0-9a-f]+)\/([0-9a-f]+)\/?$/i;

/**
 * Parse a repository URL, optionally a forge "tree" URL naming a branch
 * and directory, into its parts. A GitHub gist URL is a repository whose
 * name is the gist id, and a revision permalink names its ref. Explicit
 * `ref` and `subdir` arguments win over anything in the URL. Returns
 * null for anything else.
 */
export function parseForgeUrl(
  url: string,
  ref = '',
  subdir = ''
): IForgeSource | null {
  const match = GIST_REVISION.exec(url.trim()) ?? FORGE_TREE.exec(url.trim());

  if (!match) {
    return null;
  }

  const [, host, owner, repo, urlRef, urlSubdir] = match;

  return {
    host: host.toLowerCase(),
    owner,
    repo,
    ref: ref || urlRef || '',
    subdir: cleanSubdir(subdir || urlSubdir || '')
  };
}

/**
 * The URL, ending in a slash, under which the files of a repository can
 * be fetched from the browser. GitHub content comes through jsDelivr,
 * which serves it with CORS headers; a gist's raw files are served with
 * them by GitHub itself; GitLab, Codeberg and Gitea serve raw files
 * themselves.
 */
export function rawBaseUrl(source: IForgeSource): string {
  const { host, owner, repo, subdir } = source;
  const ref = source.ref || 'main';
  const suffix = subdir ? `${subdir}/` : '';

  // jsDelivr does not serve gists. Their raw endpoint takes a full
  // commit hash before the file name, or nothing for the latest
  // revision; it has no name for the default branch. Gists hold no
  // directories, so a subdirectory is not applied.
  if (host === 'gist.github.com') {
    const version = source.ref ? `${source.ref}/` : '';

    return `https://gist.githubusercontent.com/${owner}/${repo}/raw/${version}`;
  }

  if (host === 'github.com' || host.endsWith('.github.com')) {
    const version = source.ref ? `@${source.ref}` : '';

    return `https://cdn.jsdelivr.net/gh/${owner}/${repo}${version}/${suffix}`;
  }

  if (host === 'gitlab.com' || host.startsWith('gitlab.')) {
    return `https://${host}/${owner}/${repo}/-/raw/${ref}/${suffix}`;
  }

  return `https://${host}/${owner}/${repo}/raw/branch/${ref}/${suffix}`;
}

/** Directive options that name a file shipped with the workshop. */
const FILE_OPTIONS: readonly string[] = ['from', 'script'];

/** Directives whose `path` option usually names a shipped file. */
const OPENERS: ReadonlySet<string> = new Set(['file-open', 'notebook-open']);

/**
 * The workshop-relative paths of files the pages refer to, which a
 * file-by-file download fetches alongside the manifest and pages. Paths
 * that leave the workshop directory are left out.
 */
export function referencedFiles(pages: IPage[]): string[] {
  const paths = new Set<string>();

  for (const node of allDirectives(pages)) {
    for (const option of FILE_OPTIONS) {
      addPath(paths, node.options[option]);
    }

    if (OPENERS.has(node.name)) {
      addPath(paths, node.options.path);
    }
  }

  return [...paths].sort();
}

function addPath(paths: Set<string>, value: string | undefined): void {
  const path = cleanSubdir(value ?? '');

  if (path && !path.startsWith('..') && !path.split('/').includes('..')) {
    paths.add(path);
  }
}

function cleanSubdir(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/** Shell syntax the JupyterLite terminal does not support. */
const SHELL_LIMITS: readonly { pattern: RegExp; description: string }[] = [
  { pattern: /&&|\|\|/, description: 'chaining with && or ||' },
  { pattern: /\$\(|`/, description: 'command substitution' },
  { pattern: /\$\{?[A-Za-z_?]/, description: 'variable expansion ($VAR)' },
  { pattern: /\d>&\d/, description: 'file descriptor redirection (2>&1)' }
];

/**
 * Describe the constructs in a command that the JupyterLite terminal
 * cannot run, or return an empty list when it looks fine.
 */
export function liteShellProblems(command: string): string[] {
  return SHELL_LIMITS.filter(limit => limit.pattern.test(command)).map(
    limit => limit.description
  );
}

/**
 * Whether Python code relies on a process, which Pyodide cannot start.
 */
export function usesSubprocess(code: string): boolean {
  return /\bsubprocess\b|\bos\.system\(|\bos\.popen\(|\bpty\b/.test(code);
}

/**
 * The text a command run in the JupyterLite terminal's headless shell
 * printed, as a terminal would have shown it: colour and cursor codes
 * removed, and with them the spinner the terminal draws into the shell's
 * output while a command's WebAssembly module downloads. The spinner
 * hides the cursor, writes its dots and text, then erases the line and
 * shows the cursor again, so everything between those codes is gone.
 */
export function liteShellOutput(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[\?25l[^]*?\x1b\[K\x1b\[\?25h/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  );
}
