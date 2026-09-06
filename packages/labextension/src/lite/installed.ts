import { parseManifest } from '@jupyterlab-workshop/core';
import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';

import { deleteTree, getIfExists, readIfExists } from '../actions/contents';
import { WORKSHOP_STATE_DIR } from '../state';
import { readSourceRecord } from '../trust/summary';
import { IInstalledWorkshop } from '../tokens';

const MANIFEST_FILE = 'workshop.yaml';

/**
 * Describe every workshop directory directly under a directory, reading
 * manifests and progress through the contents API.
 */
export async function listInstalled(
  contents: Contents.IManager,
  directory: string
): Promise<IInstalledWorkshop[]> {
  const parent = await getIfExists(contents, directory, true);

  if (
    !parent ||
    parent.type !== 'directory' ||
    !Array.isArray(parent.content)
  ) {
    return [];
  }

  const records: IInstalledWorkshop[] = [];

  for (const child of parent.content as Contents.IModel[]) {
    if (child.type !== 'directory') {
      continue;
    }

    const record = await describeInstalled(contents, child.path);

    if (record) {
      records.push(record);
    }
  }

  records.sort((a, b) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase())
  );

  return records;
}

/**
 * The record for one workshop directory, or null when it holds no
 * readable manifest.
 */
export async function describeInstalled(
  contents: Contents.IManager,
  path: string
): Promise<IInstalledWorkshop | null> {
  const manifestSource = await readIfExists(
    contents,
    PathExt.join(path, MANIFEST_FILE)
  );

  if (manifestSource === null) {
    return null;
  }

  let manifest;

  try {
    manifest = parseManifest(manifestSource, MANIFEST_FILE);
  } catch {
    return null;
  }

  const source = await readSourceRecord(contents, path);
  const stateText = await readIfExists(
    contents,
    PathExt.join(path, WORKSHOP_STATE_DIR, 'state.json')
  );
  let state: {
    pages?: Record<string, { done?: boolean }>;
    visiblePages?: string[];
    currentPage?: string;
    trust?: string;
  } = {};

  if (stateText !== null) {
    try {
      state = JSON.parse(stateText) as typeof state;
    } catch {
      state = {};
    }
  }

  // Count the pages the learner can see when the state records them.
  const visible = Array.isArray(state.visiblePages) ? state.visiblePages : null;
  const done = visible
    ? visible.filter(id => state.pages?.[id]?.done === true).length
    : Object.values(state.pages ?? {}).filter(page => page?.done === true)
        .length;

  return {
    path,
    name: manifest.name,
    title: manifest.title || manifest.name,
    version: manifest.version ?? '',
    description: manifest.description ?? '',
    tags: manifest.tags,
    platforms: manifest.platforms,
    source: source?.source ?? null,
    sha256: source?.sha256 ?? '',
    pages: visible ? visible.length : manifest.pages.length,
    done,
    currentPage: state.currentPage ?? '',
    trust: state.trust ?? '',
    started: stateText !== null
  };
}

/**
 * Delete a workshop directory, refusing anything without a manifest so a
 * wrong path cannot take out something else.
 */
export async function removeInstalled(
  contents: Contents.IManager,
  path: string
): Promise<void> {
  if (path === '' || path === '.') {
    throw new Error('Refusing to remove the root directory');
  }

  const manifest = await getIfExists(
    contents,
    PathExt.join(path, MANIFEST_FILE),
    false
  );

  if (!manifest) {
    throw new Error(`${path} is not a workshop directory`);
  }

  await deleteTree(contents, path);
}
