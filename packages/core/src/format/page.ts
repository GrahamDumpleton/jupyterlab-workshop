import type MarkdownIt from 'markdown-it';

import { ACTION_TYPES } from '../actions/catalog';
import { WorkshopFormatError } from '../errors';
import {
  DIRECTIVE_TOKEN,
  IDirectiveMeta,
  IPageProblem,
  IRenderEnv,
  assignDirectiveId,
  createRenderEnv,
  getMarkdownParser
} from '../markdown/parser';
import { pathStem } from '../util';
import { Variables } from '../variables/substitute';
import { parseDirectiveInfo } from './directives';
import { closesFence, fenceLine, unclosedFence } from './fences';
import { splitFrontmatter } from './frontmatter';

/** Recognised page front matter fields. */
export interface IPageFrontmatter {
  title?: string;
  id?: string;
  optional: boolean;
  when?: string;
  requires: string[];
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

  /** Every platform and frontend alternative of the body, when the body has variants. */
  variants?: Record<string, string>;

  /** Which alternative `body` holds: a platform or frontend name, or `default`. */
  variant?: string;

  /**
   * Declared variables the options or body referenced that had no value
   * when the page was rendered, each once.
   */
  unset?: string[];

  /** One-based line of the directive within the page source. */
  line: number;

  /** One-based line of the directive's closing fence, when known. */
  endLine?: number;
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

  /** Mistakes in the source that lint reports as errors; see `IPageProblem`. */
  problems: IPageProblem[];
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

  /** Platform whose body variants are selected: linux, macos or windows. */
  platform?: string;

  /** Frontend whose body variants are selected: jupyterlab or jupyterlite. */
  frontend?: string;
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
    new Set(options.declared ?? []),
    options.platform,
    options.frontend
  );
  const tokens = md.parse(body, env);
  const nodes = tokensToNodes(tokens, md, env, body, bodyLine);

  return {
    path,
    id,
    title: frontmatter.title ?? firstHeading(tokens) ?? pathStem(path),
    frontmatter,
    nodes,
    warnings: env.warnings,
    problems: env.problems
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
    estimated:
      typeof data.estimated === 'string' || typeof data.estimated === 'number'
        ? String(data.estimated)
        : undefined
  };
}

/**
 * Split a token stream at its top-level directives, rendering the prose
 * between them to HTML. The tokens were parsed from `source`, whose first
 * line is line `lineOffset + 1` of the page; a `when` body is parsed on
 * its own, so its tokens come through here with the body as the source
 * and `nested` set.
 */
function tokensToNodes(
  tokens: MarkdownIt.Token[],
  md: MarkdownIt,
  env: IRenderEnv,
  source: string,
  lineOffset: number,
  nested = false
): PageNode[] {
  const lines = source.split('\n');
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
    if (token.type === 'fence' || token.type === DIRECTIVE_TOKEN) {
      checkFences(token, lines, lineOffset, nested, env);
    }

    if (token.type !== DIRECTIVE_TOKEN) {
      segment.push(token);
      continue;
    }

    flush();

    const meta = token.meta as IDirectiveMeta;
    const line = (token.map ? token.map[0] : 0) + lineOffset + 1;
    const endLine = token.map ? token.map[1] + lineOffset : undefined;

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
      line,
      endLine
    };

    if (meta.variants) {
      node.variants = meta.variants;
      node.variant = meta.variant;
    }

    if (meta.unset) {
      node.unset = meta.unset;
    }

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
  // top-level fences within it and parse normally. Its first line is the
  // one after the opening fence and the options.
  const tokens = md.parse(meta.body, env);

  return {
    kind: 'when',
    condition,
    nodes: tokensToNodes(
      tokens,
      md,
      env,
      meta.body,
      line + meta.bodyStart,
      true
    ),
    line
  };
}

/**
 * The advice every fence problem ends with.
 */
const FENCE_ADVICE =
  'A directive that holds a fenced block needs a longer fence: four backticks for the directive, three for the block.';

/**
 * Record what a directive closed early by the fence of a block inside it
 * leaves behind, since the source reads correctly and only the rendered
 * page shows the damage.
 *
 * The directive's content then ends with a fence that is never closed,
 * which is certain. The directive's own closing fence then opens a code
 * block, which may swallow the next directive, also certain, or be empty,
 * which is probable. A fence still open at the end of the page is
 * reported as well; a body parsed on its own is skipped there, since its
 * open fence was already reported on the directive holding it.
 */
function checkFences(
  token: MarkdownIt.Token,
  lines: string[],
  lineOffset: number,
  nested: boolean,
  env: IRenderEnv
): void {
  if (!token.map) {
    return;
  }

  const start = token.map[0] + lineOffset + 1;
  const end = token.map[1] + lineOffset;
  const meta =
    token.type === DIRECTIVE_TOKEN ? (token.meta as IDirectiveMeta) : null;
  const what = meta ? `"${meta.name}" directive` : 'code block';

  const report = (rule: string, line: number, message: string): void => {
    env.problems.push({ rule, line, message });
  };

  // A fence with no closing line runs to the end of the source.
  const last = fenceLine(lines[token.map[1] - 1] ?? '');

  if (!nested && !(last && closesFence(last, token.markup))) {
    report(
      'unclosed-fence',
      start,
      `The ${what} at line ${start} has no closing fence`
    );
  }

  if (meta) {
    const inner = unclosedFence(token.content);

    if (!inner) {
      return;
    }

    const innerLine = start + 1 + inner.line;

    if (
      inner.marker[0] === token.markup[0] &&
      inner.marker.length >= token.markup.length
    ) {
      report(
        'nested-fence',
        start,
        `The ${what} at line ${start} ends at line ${end}, at the fence meant to close the block opened at line ${innerLine}. ${FENCE_ADVICE}`
      );
    } else {
      report(
        'unclosed-fence',
        innerLine,
        `The block opened at line ${innerLine} inside the ${what} at line ${start} has no closing fence`
      );
    }

    return;
  }

  // The remains of a directive's closing fence are a plain backtick block.
  if (token.markup[0] !== '`' || token.info.trim() !== '') {
    return;
  }

  const content = token.content.split('\n');

  for (let index = 0; index < content.length; index += 1) {
    const fence = fenceLine(content[index]);

    if (
      !fence ||
      fence.marker[0] !== '`' ||
      fence.marker.length < token.markup.length
    ) {
      continue;
    }

    const info = parseDirectiveInfo(fence.info);

    if (info) {
      const line = start + 1 + index;

      report(
        'nested-fence',
        line,
        `The "${info.name}" directive at line ${line} is inside the code block opened at line ${start}, so it is shown as text. The block is probably the closing fence of a directive that ended early. ${FENCE_ADVICE}`
      );

      return;
    }
  }

  if (token.content.trim() === '') {
    report(
      'nested-fence',
      start,
      `The empty code block at line ${start} is probably the closing fence of a directive that ended at the fence of a block inside it. ${FENCE_ADVICE} Remove the block if it is meant to be empty.`
    );
  }
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
