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
 * The capability names the manifest lists. A mapping entry, the shape a
 * scoped capability once had, counts by its name, so a fix rewrites it
 * to the plain form.
 */
export function manifestCapabilities(source: string): string[] {
  const names: string[] = [];

  for (const item of manifestList(source, 'capabilities')) {
    const name =
      typeof item === 'string'
        ? item
        : isRecord(item)
          ? Object.keys(item)[0]
          : undefined;

    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }

  return names;
}

/**
 * Add a capability such as `terminal` to the manifest, unless it is
 * already declared.
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
 * Remove a capability from the manifest.
 */
export function removeManifestCapability(
  source: string,
  capability: string
): string {
  const remaining = manifestCapabilities(source).filter(
    item => item !== capability
  );

  return setManifestCapabilities(source, remaining);
}

/**
 * Write the capabilities list, one name per line.
 */
export function setManifestCapabilities(
  source: string,
  capabilities: string[]
): string {
  const block =
    capabilities.length > 0
      ? ['capabilities:', ...capabilities.map(name => `  - ${name}`)]
      : ['capabilities: []'];

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
