import MarkdownIt from 'markdown-it';

import { ACTION_TYPES, STRUCTURE_DIRECTIVES } from '../actions/catalog';
import {
  parseDirectiveContent,
  parseDirectiveInfo
} from '../format/directives';
import {
  allVariants,
  hasVariants,
  selectVariant,
  splitVariants
} from '../format/variants';
import { escapeHtml } from '../util';
import { substitute, Variables } from '../variables/substitute';

/** Token type used for directive blocks. */
export const DIRECTIVE_TOKEN = 'workshop_directive';

/** Token type used for inline roles. */
export const ROLE_TOKEN = 'workshop_role';

/** CSS class applied to rendered inline roles. */
export const ROLE_CLASS = 'jp-Workshop-role';

/** Per-page state passed through markdown-it as the render environment. */
export interface IRenderEnv {
  /** Stable id of the page, used to derive directive ids. */
  pageId: string;

  /** Variables substituted into text and directives. */
  variables: Variables;

  /** Path separator used by the `path` filter. */
  pathSep: string;

  /** Names the workshop can set later; see `ISubstituteOptions.declared`. */
  declared: ReadonlySet<string>;

  /** Platform whose body variants are selected, when known. */
  platform?: string;

  /** Problems found while parsing, in page order. */
  warnings: string[];

  /** Number of directives seen so far on the page. */
  directiveCount: number;
}

/** Metadata attached to a directive token. */
export interface IDirectiveMeta {
  name: string;
  argument: string;
  id: string;
  options: Record<string, string>;
  body: string;

  /** Every platform alternative of the body, when it has any. */
  variants?: Record<string, string>;

  /** Which alternative `body` holds: a platform name or `default`. */
  variant?: string;
}

let parser: MarkdownIt | undefined;

/**
 * Return the shared markdown-it instance configured for workshop pages.
 */
export function getMarkdownParser(): MarkdownIt {
  if (!parser) {
    parser = createMarkdownParser();
  }

  return parser;
}

/**
 * Create a markdown-it instance configured for workshop pages.
 *
 * Raw HTML is disabled so that pages cannot inject markup. Directive fences
 * become directive tokens, `{role}` code spans become role tokens, and
 * variables are substituted into text, code and directives.
 */
export function createMarkdownParser(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

  md.core.ruler.after('block', 'workshop_directive', directiveRule);
  md.inline.ruler.before('backticks', 'workshop_role', roleRule);
  md.core.ruler.before('text_join', 'workshop_substitute', substituteRule);
  md.renderer.rules[ROLE_TOKEN] = renderRole;

  return md;
}

/**
 * Create a fresh render environment for a page.
 */
export function createRenderEnv(
  pageId: string,
  variables: Variables,
  pathSep = '/',
  declared: ReadonlySet<string> = new Set(),
  platform?: string
): IRenderEnv {
  return {
    pageId,
    variables,
    pathSep,
    declared,
    platform,
    warnings: [],
    directiveCount: 0
  };
}

function directiveRule(state: MarkdownIt.StateCore): void {
  const env = state.env as IRenderEnv;

  for (const token of state.tokens) {
    if (token.type !== 'fence') {
      continue;
    }

    const info = parseDirectiveInfo(token.info);

    if (info === null) {
      continue;
    }

    // Directives nested inside lists or quotes are left as code blocks.
    if (token.level !== 0) {
      env.warnings.push(
        `Line ${lineOf(token)}: directive "${info.name}" is nested inside other content and was not recognised`
      );
      continue;
    }

    const { options, body } = parseDirectiveContent(token.content);

    // Ids are assigned later, in document order, once nested content has
    // been parsed; see `assignDirectiveId`.
    const meta: IDirectiveMeta = {
      name: info.name,
      argument: info.argument,
      id: options.id ?? '',
      options,
      body
    };

    // Command and text bodies may carry platform variants; the one for
    // the rendering platform becomes the body and the rest are kept for
    // lint and for showing which was chosen.
    const bodyKind = ACTION_TYPES[info.name]?.body;

    if (
      (bodyKind === 'required' || bodyKind === 'optional') &&
      hasVariants(body)
    ) {
      const split = splitVariants(body);
      const chosen = selectVariant(split, env.platform);

      meta.body = chosen.body;
      meta.variant = chosen.variant;
      meta.variants = allVariants(split);
    }

    token.type = DIRECTIVE_TOKEN;
    token.meta = meta;
  }
}

/**
 * Give a directive its stable id: the explicit `:id:` option, or the page
 * id followed by the directive's position on the page. Structural
 * directives such as `when` do not consume positions.
 */
export function assignDirectiveId(
  meta: IDirectiveMeta,
  env: IRenderEnv
): string {
  if (meta.id === '' && !STRUCTURE_DIRECTIVES.has(meta.name)) {
    env.directiveCount += 1;
    meta.id = `${env.pageId}-${env.directiveCount}`;
  }

  return meta.id;
}

function roleRule(state: MarkdownIt.StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;

  if (src.charCodeAt(start) !== 0x7b) {
    return false;
  }

  // Match `{name}` followed by a run of backticks.
  const head = /^\{([a-z][a-z0-9-]*)\}(`+)/.exec(
    src.slice(start, state.posMax)
  );

  if (!head) {
    return false;
  }

  const ticks = head[2];
  const contentStart = start + head[0].length;

  // Find a closing run of exactly the same length before the end of the inline.
  let end = src.indexOf(ticks, contentStart);

  while (end >= 0 && end + ticks.length <= state.posMax) {
    if (src.charCodeAt(end + ticks.length) !== 0x60) {
      break;
    }

    end = src.indexOf(ticks, end + ticks.length + 1);
  }

  if (end < 0 || end + ticks.length > state.posMax) {
    return false;
  }

  if (!silent) {
    const token = state.push(ROLE_TOKEN, '', 0);

    token.meta = { name: head[1] };
    token.content = src.slice(contentStart, end).trim();
  }

  state.pos = end + ticks.length;

  return true;
}

function substituteRule(state: MarkdownIt.StateCore): void {
  const env = state.env as IRenderEnv;

  const apply = (text: string): string => {
    const result = substitute(text, env.variables, {
      pathSep: env.pathSep,
      declared: env.declared
    });

    env.warnings.push(...result.warnings);

    return result.text;
  };

  for (const token of state.tokens) {
    if (token.type === 'inline' && token.children) {
      for (const child of token.children) {
        if (child.type === ROLE_TOKEN && child.meta.name === 'var') {
          // The var role shows a variable's value rather than its name. A
          // declared variable with no value yet shows its name, muted.
          const name = child.content;

          if (!(name in env.variables) && env.declared.has(name)) {
            child.meta = { name: 'var', unset: true };
          } else {
            child.content = apply(`{{ ${name} }}`);
          }
        } else if (
          child.type === 'text' ||
          child.type === 'code_inline' ||
          child.type === ROLE_TOKEN
        ) {
          child.content = apply(child.content);
        }
      }
    } else if (token.type === 'fence' || token.type === 'code_block') {
      token.content = apply(token.content);
    } else if (token.type === DIRECTIVE_TOKEN) {
      const meta = token.meta as IDirectiveMeta;

      if (meta.options.substitute === 'false') {
        continue;
      }

      for (const key of Object.keys(meta.options)) {
        meta.options[key] = apply(meta.options[key]);
      }

      // Markdown bodies are substituted when they are rendered.
      if (ACTION_TYPES[meta.name]?.body !== 'markdown') {
        meta.body = apply(meta.body);
      }

      if (meta.variants) {
        for (const key of Object.keys(meta.variants)) {
          meta.variants[key] = apply(meta.variants[key]);
        }
      }
    }
  }
}

const renderRole: MarkdownIt.Renderer.RenderRule = (tokens, idx) => {
  const token = tokens[idx];
  const name = escapeHtml(String((token.meta as { name: string }).name));
  const value = escapeHtml(token.content);

  if (name === 'var') {
    const unset = (token.meta as { unset?: boolean }).unset === true;
    const modifier = unset ? ' jp-mod-unset" title="Not set yet' : '';

    return `<code class="${ROLE_CLASS} ${ROLE_CLASS}-var${modifier}">${value}</code>`;
  }

  return (
    `<button type="button" class="${ROLE_CLASS} ${ROLE_CLASS}-${name}" ` +
    `data-role="${name}" data-value="${value}"><code>${value}</code></button>`
  );
};

function lineOf(token: MarkdownIt.Token): number {
  return token.map ? token.map[0] + 1 : 0;
}
