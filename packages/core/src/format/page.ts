import type MarkdownIt from 'markdown-it';

import { WorkshopFormatError } from '../errors';
import {
  DIRECTIVE_TOKEN,
  IDirectiveMeta,
  createRenderEnv,
  getMarkdownParser
} from '../markdown/parser';
import { pathStem } from '../util';
import { Variables } from '../variables/substitute';
import { splitFrontmatter } from './frontmatter';

/** Recognised page front matter fields. Other fields are preserved. */
export interface IPageFrontmatter {
  title?: string;
  id?: string;
  optional?: boolean;
  [key: string]: unknown;
}

/** A run of rendered prose between directives. */
export interface IProseNode {
  kind: 'prose';
  html: string;
}

/** A directive block, such as an action. */
export interface IDirectiveNode {
  kind: 'directive';
  name: string;
  id: string;
  options: Record<string, string>;
  body: string;

  /** One-based line of the directive within the page source. */
  line: number;
}

/** The top-level content of a page in document order. */
export type PageNode = IProseNode | IDirectiveNode;

/** A parsed and rendered page. */
export interface IPage {
  /** Path of the page within the workshop directory. */
  path: string;

  /** Stable page id, from front matter or the file name. */
  id: string;

  title: string;
  frontmatter: IPageFrontmatter;
  nodes: PageNode[];
  warnings: string[];
}

/** Inputs to page parsing. */
export interface IParsePageOptions {
  /** Path of the page within the workshop directory. */
  path: string;

  /** Variables substituted into the page. */
  variables?: Variables;

  /** Path separator for the `path` filter. */
  pathSep?: string;
}

/**
 * Parse a page source into rendered prose and directive nodes.
 */
export function parsePage(source: string, options: IParsePageOptions): IPage {
  const { path } = options;
  const { data, body, bodyLine } = splitFrontmatter(source, path);
  const frontmatter = data as IPageFrontmatter;

  if (
    frontmatter.title !== undefined &&
    typeof frontmatter.title !== 'string'
  ) {
    throw new WorkshopFormatError(
      'Front matter "title" must be a string',
      path
    );
  }

  if (frontmatter.id !== undefined && typeof frontmatter.id !== 'string') {
    throw new WorkshopFormatError('Front matter "id" must be a string', path);
  }

  const id = frontmatter.id ?? pathStem(path);
  const md = getMarkdownParser();
  const env = createRenderEnv(id, options.variables ?? {}, options.pathSep);
  const tokens = md.parse(body, env);

  // Split the token stream at top-level directives, rendering the prose
  // between them to HTML.
  const nodes: PageNode[] = [];
  let segment: MarkdownIt.Token[] = [];

  const flush = (): void => {
    if (segment.length > 0) {
      nodes.push({
        kind: 'prose',
        html: md.renderer.render(segment, md.options, env)
      });
      segment = [];
    }
  };

  for (const token of tokens) {
    if (token.type === DIRECTIVE_TOKEN) {
      flush();

      const meta = token.meta as IDirectiveMeta;

      nodes.push({
        kind: 'directive',
        name: meta.name,
        id: meta.id,
        options: meta.options,
        body: meta.body,
        line: (token.map ? token.map[0] : 0) + bodyLine + 1
      });
    } else {
      segment.push(token);
    }
  }

  flush();

  return {
    path,
    id,
    title: frontmatter.title ?? firstHeading(tokens) ?? pathStem(path),
    frontmatter,
    nodes,
    warnings: env.warnings
  };
}

function firstHeading(tokens: MarkdownIt.Token[]): string | undefined {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];

    if (token.type === 'heading_open' && token.tag === 'h1') {
      return tokens[index + 1].content;
    }
  }

  return undefined;
}
