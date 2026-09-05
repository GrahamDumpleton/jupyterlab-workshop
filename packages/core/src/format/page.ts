import type MarkdownIt from 'markdown-it';

import { ACTION_TYPES } from '../actions/catalog';
import { WorkshopFormatError } from '../errors';
import {
  DIRECTIVE_TOKEN,
  IDirectiveMeta,
  IRenderEnv,
  assignDirectiveId,
  createRenderEnv,
  getMarkdownParser
} from '../markdown/parser';
import { pathStem } from '../util';
import { Variables } from '../variables/substitute';
import { splitFrontmatter } from './frontmatter';

/** Recognised page front matter fields. */
export interface IPageFrontmatter {
  title?: string;
  id?: string;
  optional: boolean;
  when?: string;
  requires: string[];
  checkpoint: boolean;
  estimated?: string;
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
  argument: string;
  id: string;
  options: Record<string, string>;
  body: string;

  /** Rendered HTML of the body for directives whose body is Markdown. */
  html?: string;

  /** One-based line of the directive within the page source. */
  line: number;
}

/** Content shown only when a condition holds. */
export interface IWhenNode {
  kind: 'when';
  condition: string;
  nodes: PageNode[];
  line: number;
}

/** The top-level content of a page in document order. */
export type PageNode = IProseNode | IDirectiveNode | IWhenNode;

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

  /** Names the workshop can set later, which do not warn when unset. */
  declared?: Iterable<string>;
}

/**
 * Parse a page source into rendered prose and directive nodes.
 */
export function parsePage(source: string, options: IParsePageOptions): IPage {
  const { path } = options;
  const { data, body, bodyLine } = splitFrontmatter(source, path);
  const frontmatter = parseFrontmatter(data, path);
  const id = frontmatter.id ?? pathStem(path);
  const md = getMarkdownParser();
  const env = createRenderEnv(
    id,
    options.variables ?? {},
    options.pathSep,
    new Set(options.declared ?? [])
  );
  const tokens = md.parse(body, env);
  const nodes = tokensToNodes(tokens, md, env, bodyLine);

  return {
    path,
    id,
    title: frontmatter.title ?? firstHeading(tokens) ?? pathStem(path),
    frontmatter,
    nodes,
    warnings: env.warnings
  };
}

/**
 * Collect every directive node on a page, descending into `when` blocks,
 * in document order.
 */
export function collectDirectives(nodes: PageNode[]): IDirectiveNode[] {
  const directives: IDirectiveNode[] = [];

  for (const node of nodes) {
    if (node.kind === 'directive') {
      directives.push(node);
    } else if (node.kind === 'when') {
      directives.push(...collectDirectives(node.nodes));
    }
  }

  return directives;
}

function parseFrontmatter(
  data: Record<string, unknown>,
  path: string
): IPageFrontmatter {
  if (data.title !== undefined && typeof data.title !== 'string') {
    throw new WorkshopFormatError(
      'Front matter "title" must be a string',
      path
    );
  }

  if (data.id !== undefined && typeof data.id !== 'string') {
    throw new WorkshopFormatError('Front matter "id" must be a string', path);
  }

  if (data.when !== undefined && typeof data.when !== 'string') {
    throw new WorkshopFormatError('Front matter "when" must be a string', path);
  }

  const requires = data.requires;

  if (
    requires !== undefined &&
    !(
      Array.isArray(requires) &&
      requires.every(item => typeof item === 'string')
    )
  ) {
    throw new WorkshopFormatError(
      'Front matter "requires" must be a list of strings',
      path
    );
  }

  return {
    title: data.title as string | undefined,
    id: data.id as string | undefined,
    optional: data.optional === true,
    when: data.when as string | undefined,
    requires: (requires as string[] | undefined) ?? [],
    checkpoint: data.checkpoint === true,
    estimated:
      typeof data.estimated === 'string' || typeof data.estimated === 'number'
        ? String(data.estimated)
        : undefined
  };
}

function tokensToNodes(
  tokens: MarkdownIt.Token[],
  md: MarkdownIt,
  env: IRenderEnv,
  lineOffset: number
): PageNode[] {
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
    if (token.type !== DIRECTIVE_TOKEN) {
      segment.push(token);
      continue;
    }

    flush();

    const meta = token.meta as IDirectiveMeta;
    const line = (token.map ? token.map[0] : 0) + lineOffset + 1;

    if (meta.name === 'when') {
      nodes.push(whenNode(meta, md, env, line));
      continue;
    }

    const node: IDirectiveNode = {
      kind: 'directive',
      name: meta.name,
      argument: meta.argument,
      id: assignDirectiveId(meta, env),
      options: meta.options,
      body: meta.body,
      line
    };

    if (ACTION_TYPES[meta.name]?.body === 'markdown') {
      node.html = md.render(meta.body, env);
    }

    nodes.push(node);
  }

  flush();

  return nodes;
}

function whenNode(
  meta: IDirectiveMeta,
  md: MarkdownIt,
  env: IRenderEnv,
  line: number
): IWhenNode {
  const condition = meta.argument || meta.options.condition || '';

  if (condition === '') {
    env.warnings.push(`Line ${line}: "when" directive has no condition`);
  }

  // The body is a Markdown document of its own, so nested directives are
  // top-level fences within it and parse normally.
  const tokens = md.parse(meta.body, env);

  return {
    kind: 'when',
    condition,
    nodes: tokensToNodes(tokens, md, env, line),
    line
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

/**
 * Names of variables the directives of a page can set: capture targets,
 * choice and env-set variables, and the track.
 */
export function declaredVariables(nodes: PageNode[]): string[] {
  const names: string[] = [];

  for (const node of collectDirectives(nodes)) {
    for (const option of ['capture', 'variable', 'name']) {
      const value = node.options[option];

      if (value && (option !== 'name' || node.name === 'env-set')) {
        names.push(value);
      }
    }

    if (node.name === 'choice' && node.options.track === 'true') {
      names.push('track');
    }
  }

  return names;
}
