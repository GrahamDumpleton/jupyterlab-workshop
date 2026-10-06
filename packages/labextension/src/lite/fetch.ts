import {
  cleanBase64,
  hashFiles,
  IDownloadSource,
  IWorkshopManifest,
  mayReplaceDownload,
  parseForgeUrl,
  parseManifest,
  parsePage,
  parseWorkshopTree,
  rawBaseUrl,
  referencedFiles,
  standaloneDirectory,
  TREE_FILE
} from '@jupyterlab-workshop/core';
import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';

import {
  deleteTree,
  ensureDirectory,
  getIfExists,
  writeTextFile
} from '../actions/contents';
import { WORKSHOP_STATE_DIR } from '../state';
import { SOURCE_FILE } from '../trust/summary';
import { ConflictError, IFetchRequest, IFetchResult } from '../tokens';

const ARCHIVE_SUFFIXES: readonly string[] = ['.zip', '.tar.gz', '.tgz', '.tar'];

/** Largest file the browser will download for a workshop. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** A downloaded file, as text or as base64 for binary content. */
interface IDownloaded {
  text?: string;
  base64?: string;
}

/** A downloaded workshop: its manifest and files by workshop path. */
interface IDownloadedWorkshop {
  manifest: IWorkshopManifest;

  /** Text files, the manifest and pages included. */
  texts: Record<string, string>;

  /** Other files, as base64. */
  binaries: Record<string, string>;
}

/**
 * Download a workshop file by file from a git forge into the browser's
 * contents, the way JupyterLite has to do it without a server: the
 * manifest first, then every page, then the files the pages refer to.
 * A gist holding a tree file is downloaded by the tree instead, every
 * file it lists put back at its path. The trust hash is computed over the text files, as for a local
 * workshop.
 */
export async function fetchWorkshopFiles(
  contents: Contents.IManager,
  request: IFetchRequest
): Promise<IFetchResult> {
  const url = request.url.trim();

  if (
    request.archive ||
    ARCHIVE_SUFFIXES.some(suffix => url.toLowerCase().endsWith(suffix))
  ) {
    throw new Error(
      'Archive downloads need the JupyterLab server; in JupyterLite open a repository URL instead'
    );
  }

  const source = parseForgeUrl(url, request.ref, request.subdir);

  if (!source) {
    throw new Error(`Cannot work out the repository from ${url}`);
  }

  // A gist published by `jupyter workshop gist` holds its files flat,
  // with a tree file saying where each one goes back.
  const base = rawBaseUrl(source);
  const downloaded =
    (source.host === 'gist.github.com' ? await downloadTree(base) : null) ??
    (await downloadReferenced(base));
  const { manifest, texts, binaries } = downloaded;

  const recorded: IDownloadSource = {
    kind: 'git',
    url: `https://${source.host}/${source.owner}/${source.repo}`,
    subdir: source.subdir
  };

  // The directory is named after the workshop, like a server download,
  // unless the request names one, and for a library's standalone/ is
  // followed by a short hash of the source, as the server names it.
  const named = request.name || manifest.name;
  const name = request.standalone
    ? standaloneDirectory(named, recorded)
    : named;
  const target = PathExt.join(request.directory, name);
  const existing = await getIfExists(contents, target, false);

  // Only a download of the same workshop is ever replaced.
  if (existing) {
    const record = await readJson(
      contents,
      PathExt.join(target, WORKSHOP_STATE_DIR, SOURCE_FILE)
    );

    if (!mayReplaceDownload(record, recorded, request.collection)) {
      throw new Error(
        `${target} is in the way and is not a download of this workshop, so it is left as it is`
      );
    }

    if (!request.overwrite) {
      throw new ConflictError(`${target} already exists`);
    }

    await deleteTree(contents, target);
  }

  await ensureDirectory(contents, target);

  for (const [path, text] of Object.entries(texts)) {
    await writeTextFile(contents, PathExt.join(target, path), text);
  }

  for (const [path, base64] of Object.entries(binaries)) {
    const full = PathExt.join(target, path);

    await ensureDirectory(contents, PathExt.dirname(full));
    await contents.save(full, {
      type: 'file',
      format: 'base64',
      content: base64
    });
  }

  // The source record is what the trust summary reads on open, and the
  // browser reads the collection from it to match installed workshops.
  const sha256 = hashFiles(texts);
  const record: Record<string, unknown> = {
    source: { ...recorded, ref: source.ref },
    sha256
  };

  if (request.collection) {
    record.collection = request.collection;
  }

  await writeTextFile(
    contents,
    PathExt.join(target, WORKSHOP_STATE_DIR, SOURCE_FILE),
    JSON.stringify(record, null, 2)
  );

  return { path: target, name, sha256 };
}

/** A JSON file's value, or null when it is missing or unreadable. */
async function readJson(
  contents: Contents.IManager,
  path: string
): Promise<unknown> {
  try {
    const model = await getIfExists(contents, path, true);

    // The contents API hands a .json file back parsed, and other servers
    // as text.
    if (!model) {
      return null;
    }

    return typeof model.content === 'string'
      ? (JSON.parse(model.content) as unknown)
      : (model.content as unknown);
  } catch {
    return null;
  }
}

/**
 * Download the manifest, every page, and the files the pages refer to
 * that exist, which is all a file-by-file download can find without a
 * listing of the repository.
 */
async function downloadReferenced(base: string): Promise<IDownloadedWorkshop> {
  const manifestSource = await fetchText(`${base}workshop.yaml`);
  const manifest = parseManifest(manifestSource, 'workshop.yaml');
  const texts: Record<string, string> = { 'workshop.yaml': manifestSource };

  // Pages are required; files they mention are fetched when present.
  for (const pagePath of manifest.pages) {
    texts[pagePath] = await fetchText(`${base}${pagePath}`);
  }

  const pages = manifest.pages.map(pagePath =>
    parsePage(texts[pagePath], { path: pagePath, variables: {} })
  );
  const binaries: Record<string, string> = {};

  for (const path of referencedFiles(pages)) {
    if (path in texts) {
      continue;
    }

    const downloaded = await fetchOptional(`${base}${path}`);

    if (downloaded?.text !== undefined) {
      texts[path] = downloaded.text;
    } else if (downloaded?.base64 !== undefined) {
      binaries[path] = downloaded.base64;
    }
  }

  return { manifest, texts, binaries };
}

/**
 * Download the files a gist's tree file lists, each keyed by the path it
 * goes back to, or return null when the gist has no tree file. The tree
 * is validated first, so a path outside the workshop is refused before
 * anything is downloaded, and gist files it does not list are left out.
 */
async function downloadTree(base: string): Promise<IDownloadedWorkshop | null> {
  const listed = await fetchOptional(`${base}${TREE_FILE}`);

  if (!listed) {
    return null;
  }

  let data: unknown;

  try {
    data = JSON.parse(listed.text ?? '') as unknown;
  } catch {
    throw new Error(`${TREE_FILE} is not valid JSON`);
  }

  const tree = parseWorkshopTree(data);
  const texts: Record<string, string> = {};
  const binaries: Record<string, string> = {};

  for (const entry of tree.files) {
    if (entry.empty || entry.name === undefined) {
      texts[entry.path] = '';

      continue;
    }

    const content = await fetchText(`${base}${encodeURIComponent(entry.name)}`);

    if (entry.encoding === 'base64') {
      try {
        binaries[entry.path] = cleanBase64(content);
      } catch {
        throw new Error(
          `${entry.name}, holding ${entry.path}, is not valid base64`
        );
      }
    } else {
      texts[entry.path] = content;
    }
  }

  const manifest = parseManifest(texts['workshop.yaml'], 'workshop.yaml');

  for (const pagePath of manifest.pages) {
    if (!(pagePath in texts)) {
      throw new Error(
        `Page ${pagePath} is not among the files ${TREE_FILE} lists`
      );
    }
  }

  return { manifest, texts, binaries };
}

/**
 * Read a JSON document from a URL the browser can reach.
 */
export async function fetchJson(url: string): Promise<unknown> {
  const text = await fetchText(url);

  return JSON.parse(text) as unknown;
}

async function fetchText(url: string): Promise<string> {
  const downloaded = await fetchOptional(url);

  if (!downloaded) {
    throw new Error(`${url} was not found`);
  }

  if (downloaded.text === undefined) {
    throw new Error(`${url} is not a text file`);
  }

  return downloaded.text;
}

async function fetchOptional(url: string): Promise<IDownloaded | null> {
  let response: Response;

  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (error) {
    throw new Error(
      `Unable to download ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`${url} is larger than the download limit`);
  }

  // Text is stored as text so it can be hashed and edited; anything that
  // is not valid UTF-8 is kept as base64.
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { base64: toBase64(bytes) };
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
