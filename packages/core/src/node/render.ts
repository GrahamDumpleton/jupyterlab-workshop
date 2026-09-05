/**
 * Static HTML rendering of workshop pages for previews and documentation.
 */

import { ACTION_TYPES } from '../actions/catalog';
import { IPage, PageNode } from '../format/page';
import { escapeHtml } from '../util';
import { ILoadedWorkshopFiles } from './workshop';

const STYLE = `
body { font-family: system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
nav ol { padding-left: 1.5rem; }
.workshop-page { border-top: 1px solid #ddd; margin-top: 2rem; padding-top: 1rem; }
.workshop-action { border: 1px solid #ccc; border-left: 4px solid #4b7bec; border-radius: 4px; margin: 1rem 0; padding: 0.5rem 0.75rem; }
.workshop-action-header { font-size: 0.85rem; color: #555; }
.workshop-action pre { margin: 0.5rem 0 0; white-space: pre-wrap; }
.workshop-when { border-left: 4px dashed #aaa; padding-left: 0.75rem; margin: 1rem 0; }
.workshop-when-condition { font-size: 0.85rem; color: #777; }
.jp-Workshop-role { font: inherit; }
`;

/**
 * Render one page to an HTML fragment.
 */
export function renderPageHtml(page: IPage): string {
  const parts: string[] = [];

  parts.push(`<section class="workshop-page" id="${escapeHtml(page.id)}">`);
  parts.push(`<h2>${escapeHtml(page.title)}</h2>`);
  parts.push(renderNodes(page.nodes));
  parts.push('</section>');

  return parts.join('\n');
}

/**
 * Render a whole workshop, or one of its pages, as a standalone HTML
 * document.
 */
export function renderWorkshopHtml(
  workshop: ILoadedWorkshopFiles,
  pageId?: string
): string {
  const pages = pageId
    ? workshop.pages.filter(page => page.id === pageId || page.path === pageId)
    : workshop.pages;

  if (pageId && pages.length === 0) {
    throw new Error(`No page with id or path "${pageId}"`);
  }

  const title = escapeHtml(workshop.manifest.title);
  const toc = pages
    .map(
      page =>
        `<li><a href="#${escapeHtml(page.id)}">${escapeHtml(page.title)}</a></li>`
    )
    .join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<h1>${title}</h1>`,
    workshop.manifest.description
      ? `<p>${escapeHtml(workshop.manifest.description)}</p>`
      : '',
    pages.length > 1 ? `<nav><ol>${toc}</ol></nav>` : '',
    ...pages.map(renderPageHtml),
    '</body>',
    '</html>'
  ].join('\n');
}

function renderNodes(nodes: PageNode[]): string {
  const parts: string[] = [];

  for (const node of nodes) {
    if (node.kind === 'prose') {
      parts.push(node.html);
    } else if (node.kind === 'when') {
      parts.push(
        `<div class="workshop-when"><div class="workshop-when-condition">when ${escapeHtml(node.condition)}</div>${renderNodes(node.nodes)}</div>`
      );
    } else {
      const spec = ACTION_TYPES[node.name];
      const label = spec
        ? spec.description
        : `Unknown directive "${node.name}"`;
      const options = Object.entries(node.options)
        .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`)
        .join(', ');
      const body =
        node.html !== undefined
          ? node.html
          : node.body.trim() !== '' && spec?.body !== 'none'
            ? `<pre>${escapeHtml(node.body)}</pre>`
            : '';

      parts.push(
        `<div class="workshop-action workshop-action-${escapeHtml(node.name)}" id="${escapeHtml(node.id)}">` +
          `<div class="workshop-action-header"><code>${escapeHtml(node.name)}</code> ${escapeHtml(label)}` +
          (options ? ` <span>(${options})</span>` : '') +
          '</div>' +
          body +
          '</div>'
      );
    }
  }

  return parts.join('\n');
}
