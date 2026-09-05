import {
  CAPABILITY_NAMES,
  IPage,
  IWorkshopManifest,
  capabilityUses,
  countAutomatic,
  declaredCapabilities,
  hashFiles,
  lintWorkshop
} from '@jupyterlab-workshop/core';
import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';

import { readIfExists } from '../actions/contents';
import { WORKSHOP_STATE_DIR } from '../state';
import { ICapabilitySummary, ITrustSummary, IWorkshopSource } from '../tokens';

/** Name of the record the server writes when it downloads a workshop. */
export const SOURCE_FILE = 'source.json';

/** What the server recorded about a download. */
export interface ISourceRecord {
  source: IWorkshopSource;
  sha256: string;
}

/**
 * Read the download record of a workshop, or null for a local one.
 */
export async function readSourceRecord(
  contents: Contents.IManager,
  workshopPath: string
): Promise<ISourceRecord | null> {
  const path = PathExt.join(workshopPath, WORKSHOP_STATE_DIR, SOURCE_FILE);
  const text = await readIfExists(contents, path);

  if (text === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as {
      source?: Partial<IWorkshopSource>;
      sha256?: unknown;
    };
    const source = parsed.source ?? {};

    if (
      (source.kind === 'git' || source.kind === 'archive') &&
      typeof source.url === 'string' &&
      typeof parsed.sha256 === 'string'
    ) {
      return {
        source: {
          kind: source.kind,
          url: source.url,
          ref: typeof source.ref === 'string' ? source.ref : undefined,
          subdir: typeof source.subdir === 'string' ? source.subdir : undefined
        },
        sha256: parsed.sha256
      };
    }
  } catch (error) {
    console.warn(`Ignoring unreadable ${path}`, error);
  }

  return null;
}

/**
 * The key under which decisions about a source are stored. It matches the
 * form the server uses so registries can pre-trust sources later.
 */
export function sourceKey(source: IWorkshopSource): string {
  if (source.kind === 'git') {
    const ref = source.ref ? `@${source.ref}` : '';
    const subdir = source.subdir ? `/${source.subdir}` : '';

    return `git:${source.url}${ref}${subdir}`;
  }

  return `${source.kind}:${source.url}`;
}

/**
 * A short human readable description of a source.
 */
export function describeSource(source: IWorkshopSource): string {
  switch (source.kind) {
    case 'local':
      return `Local directory ${source.url || '(JupyterLab root)'}`;
    case 'git':
      return `${source.url}${source.ref ? ` at ${source.ref}` : ''}${
        source.subdir ? ` (${source.subdir})` : ''
      }`;
    case 'archive':
      return source.url;
  }
}

/**
 * Build what the trust dialog shows for a workshop.
 */
export function buildTrustSummary(options: {
  manifest: IWorkshopManifest;
  manifestSource: string;
  pages: IPage[];
  sources: Record<string, string>;
  source: IWorkshopSource;
  hash?: string;
}): ITrustSummary {
  const { manifest, pages, source } = options;
  const declared = declaredCapabilities(manifest);
  const uses = new Map(
    capabilityUses(manifest, pages).map(use => [use.capability, use])
  );

  // List declared capabilities first, in catalogue order, then anything
  // the pages use without declaring.
  const capabilities: ICapabilitySummary[] = [];

  for (const name of CAPABILITY_NAMES) {
    const use = uses.get(name);
    const scopes = declared.get(name);

    if (scopes !== undefined || use) {
      capabilities.push({
        capability: name,
        scopes: scopes ?? [],
        count: use?.count ?? 0,
        declared: scopes !== undefined
      });
    }
  }

  const hash =
    options.hash ??
    hashFiles({ 'workshop.yaml': options.manifestSource, ...options.sources });

  return {
    name: manifest.name,
    title: manifest.title,
    version: manifest.version ?? '',
    source,
    sourceKey: sourceKey(source),
    hash,
    capabilities,
    automatic: countAutomatic(pages),
    lint: lintWorkshop({ manifest, pages }),
    analyticsSink: manifest.analytics?.sink
  };
}
