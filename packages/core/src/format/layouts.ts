import { ILayoutSpec } from './manifest';

/** Layouts available to every workshop without declaring them. */
export const BUILTIN_LAYOUTS: Readonly<Record<string, ILayoutSpec>> = {
  default: {
    main: [{ area: 'bottom', widgets: ['terminal:workshop'] }]
  },
  'terminal-only': {
    main: [{ area: 'top', widgets: ['terminal:workshop'] }]
  },
  notebook: {
    main: []
  }
};

/** The kinds of widget a layout's `main` entries can name. */
export const LAYOUT_WIDGET_KINDS: ReadonlySet<string> = new Set([
  'terminal',
  'editor',
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
