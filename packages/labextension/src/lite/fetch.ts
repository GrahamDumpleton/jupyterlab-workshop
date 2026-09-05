import {
  hashFiles,
  parseForgeUrl,
  parseManifest,
  parsePage,
  rawBaseUrl,
  referencedFiles
} from '@educates/workshop-core';
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

/**
 * Download a workshop file by file from a git forge into the browser's
 * contents, the way JupyterLite has to do it without a server: the
 * manifest first, then every page, then the files the pages refer to.
 * The trust hash is computed over the text files, as for a local
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

  const base = rawBaseUrl(source);
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

  // The directory is named after the workshop, like a server download.
  const target = PathExt.join(request.directory, manifest.name);
  const existing = await getIfExists(contents, target, false);

  if (existing) {
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

  // The source record is what the trust summary reads on open.
  const sha256 = hashFiles(texts);
  const record = {
    source: {
      kind: 'git',
      url: `https://${source.host}/${source.owner}/${source.repo}`,
      ref: source.ref,
      subdir: source.subdir
    },
    sha256
  };

  await writeTextFile(
    contents,
    PathExt.join(target, WORKSHOP_STATE_DIR, SOURCE_FILE),
    JSON.stringify(record, null, 2)
  );

  return { path: target, name: manifest.name, sha256 };
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
