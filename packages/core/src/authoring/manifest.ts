/**
 * Small text-level edits to `workshop.yaml` and page front matter. The
 * manifest is rewritten block by block rather than re-emitted whole, so
 * comments and ordering elsewhere in the file survive an edit made from
 * the authoring tools.
 */

import { dump, load } from 'js-yaml';

import { splitFrontmatter } from '../format/frontmatter';
import { isRecord } from '../util';

const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):/;

/**
 * Replace the block of a top-level key with new lines (the key line
 * included), or append it when the manifest has no such key.
 */
export function replaceManifestBlock(
  source: string,
  key: string,
  block: string[]
): string {
  const lines = source.replace(/\n$/, '').split('\n');
  const start = lines.findIndex(line => TOP_LEVEL_KEY.exec(line)?.[1] === key);

  if (start < 0) {
    const trimmed = lines.filter(
      (line, index) => index < lines.length - 1 || line.trim() !== ''
    );

    return `${[...trimmed, ...block].join('\n')}\n`;
  }

  // The block runs until the next top-level key; blank lines and
  // comments directly before that key stay with it.
  let end = start + 1;

  while (end < lines.length && !TOP_LEVEL_KEY.test(lines[end])) {
    end += 1;
  }

  while (
    end > start + 1 &&
    (lines[end - 1].trim() === '' || lines[end - 1].trimStart().startsWith('#'))
  ) {
    end -= 1;
  }

  lines.splice(start, end - start, ...block);

  return `${lines.join('\n')}\n`;
}

/**
 * Read a list-valued top-level key of the manifest, or an empty list.
 */
export function manifestList(source: string, key: string): unknown[] {
  const data: unknown = load(source);
  const value = isRecord(data) ? data[key] : undefined;

  return Array.isArray(value) ? value : [];
}

/**
 * Set the `pages` list of the manifest.
 */
export function setManifestPages(source: string, pages: string[]): string {
  return replaceManifestBlock(source, 'pages', [
    'pages:',
    ...pages.map(page => `  - ${page}`)
  ]);
}

/**
 * The manifest's capabilities flattened to `name` or `name:scope` strings.
 */
export function manifestCapabilities(source: string): string[] {
  const flattened: string[] = [];

  for (const item of manifestList(source, 'capabilities')) {
    if (typeof item === 'string') {
      flattened.push(item);
    } else if (isRecord(item)) {
      for (const [name, scopes] of Object.entries(item)) {
        const list = Array.isArray(scopes) ? scopes : [scopes];

        for (const scope of list) {
          flattened.push(`${name}:${String(scope)}`);
        }
      }
    }
  }

  return flattened;
}

/**
 * Add a capability such as `terminal` or `write-files:workspace` to the
 * manifest, merging scopes into an existing entry of the same name.
 */
export function addManifestCapability(
  source: string,
  capability: string
): string {
  const current = manifestCapabilities(source);

  if (current.includes(capability)) {
    return source;
  }

  return setManifestCapabilities(source, [...current, capability]);
}

/**
 * Remove every entry of a capability name from the manifest.
 */
export function removeManifestCapability(
  source: string,
  capability: string
): string {
  const name = capability.split(':')[0];
  const remaining = manifestCapabilities(source).filter(
    item => item.split(':')[0] !== name
  );

  return setManifestCapabilities(source, remaining);
}

/**
 * Write the capabilities list, grouping scopes under their name as
 * `- write-files: [workspace]`.
 */
export function setManifestCapabilities(
  source: string,
  capabilities: string[]
): string {
  const grouped = new Map<string, string[]>();

  for (const item of capabilities) {
    const colon = item.indexOf(':');
    const name = colon < 0 ? item : item.slice(0, colon);
    const scope = colon < 0 ? '' : item.slice(colon + 1);
    const scopes = grouped.get(name) ?? [];

    if (scope !== '' && !scopes.includes(scope)) {
      scopes.push(scope);
    }

    grouped.set(name, scopes);
  }

  const block = ['capabilities:'];

  for (const [name, scopes] of grouped) {
    block.push(
      scopes.length > 0 ? `  - ${name}: [${scopes.join(', ')}]` : `  - ${name}`
    );
  }

  if (grouped.size === 0) {
    block[0] = 'capabilities: []';
  }

  return replaceManifestBlock(source, 'capabilities', block);
}

/**
 * Update fields of a page's front matter, removing those set to
 * undefined, and return the new page source.
 */
export function setFrontmatter(
  source: string,
  updates: Record<string, unknown>
): string {
  const { data, body } = splitFrontmatter(source);
  const next: Record<string, unknown> = { ...data };

  for (const [key, value] of Object.entries(updates)) {
    const empty = Array.isArray(value) && value.length === 0;

    if (value === undefined || value === false || value === '' || empty) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  const content = body.replace(/^\n+/, '');

  if (Object.keys(next).length === 0) {
    return content;
  }

  const yaml = dump(next, { flowLevel: 1, lineWidth: -1 }).replace(/\n$/, '');

  return `---\n${yaml}\n---\n\n${content}`;
}

/**
 * Turn a title into a file name slug.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug === '' ? 'page' : slug;
}

/**
 * Choose a path for a new page after the existing ones, numbered so the
 * files list in order.
 */
export function newPagePath(title: string, existing: string[]): string {
  const number = String(existing.length + 1).padStart(2, '0');
  const base = `pages/${number}-${slugify(title)}`;
  let path = `${base}.md`;
  let suffix = 2;

  while (existing.includes(path)) {
    path = `${base}-${suffix}.md`;
    suffix += 1;
  }

  return path;
}

/**
 * The source of a new, empty page.
 */
export function newPageSource(title: string): string {
  return `---\ntitle: ${yamlScalar(title)}\n---\n\n# ${title}\n\nDescribe what the learner does on this page.\n`;
}

function yamlScalar(text: string): string {
  return dump(text, { lineWidth: -1 }).replace(/\n$/, '');
}
