import { ILayoutArea, ILayoutSpec } from './manifest';

/** Layouts available to every workshop without declaring them. */
export const BUILTIN_LAYOUTS: Readonly<Record<string, ILayoutSpec>> = {
  default: {
    main: {
      areas: [{ tabs: [] }, { size: 0.4, tabs: ['terminal:workshop'] }]
    }
  },
  'terminal-only': {
    main: { tabs: ['terminal:workshop'] }
  }
};

/** The kinds of widget a layout's `tabs` can name. */
export const LAYOUT_WIDGET_KINDS: ReadonlySet<string> = new Set([
  'terminal',
  'file',
  'markdown',
  'notebook',
  'launcher'
]);

/** Widget kinds whose target is a file path that must be given. */
export const LAYOUT_WIDGET_PATH_KINDS: ReadonlySet<string> = new Set([
  'file',
  'markdown',
  'notebook'
]);

/**
 * Values of an action's `area` option that place a widget relative to
 * the current one rather than in a named area: a tab beside it, or a
 * split to its right or below it.
 */
export const LAYOUT_AREA_KEYWORDS: ReadonlySet<string> = new Set([
  'tab',
  'right',
  'bottom'
]);

/** A widget reference split into its kind and target. */
export interface ILayoutWidgetReference {
  /** The kind, such as `terminal` or `markdown`. */
  kind: string;

  /** Everything after the first colon: a name or path, possibly empty. */
  target: string;
}

/**
 * Split a widget reference such as `terminal:git` or `markdown:README.md`
 * into its kind and target. A bare word such as `launcher` has an empty
 * target.
 */
export function parseLayoutWidget(reference: string): ILayoutWidgetReference {
  const [kind, ...rest] = reference.split(':');

  return { kind, target: rest.join(':') };
}

/**
 * Find a layout by name among those a manifest declares, then the
 * built-in ones.
 */
export function findLayout(
  layouts: Record<string, ILayoutSpec>,
  name: string
): ILayoutSpec | undefined {
  return layouts[name] ?? BUILTIN_LAYOUTS[name];
}

/**
 * Every area of a layout tree, parents before children, in the order
 * they are written.
 */
export function* walkLayoutAreas(area: ILayoutArea): Generator<ILayoutArea> {
  yield area;

  for (const child of area.areas ?? []) {
    yield* walkLayoutAreas(child);
  }
}

/**
 * Whether an area is a placeholder: a `tabs` list with nothing in it,
 * which holds whatever is open that the layout does not name.
 */
export function isLayoutPlaceholder(area: ILayoutArea): boolean {
  return area.areas === undefined && area.tabs?.length === 0;
}

/**
 * The names of every area declared across a set of layouts, so an
 * action's `area` option can be checked against them.
 */
export function layoutAreaNames(
  layouts: Record<string, ILayoutSpec>
): Set<string> {
  const names = new Set<string>();

  for (const spec of Object.values(layouts)) {
    if (!spec.main) {
      continue;
    }

    for (const area of walkLayoutAreas(spec.main)) {
      if (area.name) {
        names.add(area.name);
      }
    }
  }

  return names;
}
