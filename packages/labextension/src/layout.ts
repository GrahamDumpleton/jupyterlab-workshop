import {
  findLayout,
  ILayoutArea,
  ILayoutSide,
  ILayoutSpec,
  parseLayoutWidget
} from '@jupyterlab-workshop/core';
import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { Launcher } from '@jupyterlab/launcher';
import { IStateDB } from '@jupyterlab/statedb';
import { DockLayout, DockPanel, SplitPanel, Widget } from '@lumino/widgets';

import { openEditor } from './actions/files';
import { TerminalSessions } from './actions/terminal';
import { ILoadedWorkshop, IWorkshopManager } from './tokens';

/** Widget factory that renders a Markdown file as a preview. */
const MARKDOWN_FACTORY = 'Markdown Preview';

/** Where the workshops whose layout has been applied are recorded. */
const STATE_KEY = '@jupyterlab-workshop/labextension:layouts';

/** Ids JupyterLab gives the panels whose sizes a layout adjusts. */
const DOCK_PANEL_ID = 'jp-main-dock-panel';
const SPLIT_PANEL_ID = 'jp-main-split-panel';

/** The most of the window width the two sidebars together may take. */
const SIDEBARS_MAX = 0.8;

/** Share of the window the instructions panel gets when its sidebar had none. */
const DEFAULT_PANEL_SHARE = 0.25;

/** A sidebar share below this counts as no width at all. */
const MIN_SHARE = 0.02;

/** Services the layout manager needs. */
export interface ILayoutContext {
  app: JupyterFrontEnd;
  shell: ILabShell;
  manager: IWorkshopManager;
  terminals: TerminalSessions;
  docManager: IDocumentManager;
  stateDB: IStateDB | null;

  /** Id of the instructions panel widget. */
  panelId: string;
}

/** What the state database holds under the layouts key. */
interface ILayoutRecord {
  /** Paths of the workshops whose layout has been applied in this workspace. */
  applied: string[];
}

function isLayoutRecord(value: unknown): value is ILayoutRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { applied?: unknown }).applied)
  );
}

/**
 * Arranges JupyterLab panels according to a named layout from the
 * manifest or the built-in set. The arrangement is approximate: widgets
 * are added with split and tab modes and the learner may rearrange them.
 */
export class LayoutManager {
  constructor(context: ILayoutContext) {
    this._context = context;
  }

  /**
   * Find a layout by name in the manifest, then the built-ins.
   */
  find(name: string): ILayoutSpec | undefined {
    return findLayout(
      this._context.manager.workshop?.manifest.layouts ?? {},
      name
    );
  }

  /**
   * Apply the layout the manifest names when a workshop is opened.
   *
   * The layout is applied the first time a workshop is opened in a
   * workspace, and every time it is opened from a launch link. After that
   * JupyterLab restores whatever arrangement the learner left, so the
   * layout is left alone and only the instructions panel is shown.
   */
  async applyOnOpen(workshop: ILoadedWorkshop): Promise<void> {
    // Which sidebars have no width is read now, before the command that
    // opened the workshop reveals the panel at its minimum width.
    const empty = this._emptySides();
    const name = workshop.manifest.layout;

    if (!name) {
      this._showPanel(empty);

      return;
    }

    if (!workshop.launched && (await this._wasApplied(workshop.path))) {
      this._showPanel(empty);

      return;
    }

    await this._recordApplied(workshop.path);
    await this.apply(name, empty);
  }

  /**
   * Apply a named layout in full: the main area regions and their sizes,
   * then the sidebars, finishing with the instructions panel shown.
   */
  async apply(
    name: string,
    empty: ReadonlySet<'left' | 'right'> = this._emptySides()
  ): Promise<void> {
    const spec = this.find(name);

    if (!spec) {
      throw new Error(`Unknown layout "${name}"`);
    }

    await this._arrangeMain(spec);

    for (const side of ['left', 'right'] as const) {
      this._arrangeSide(side, spec[side]);
    }

    this._resizeSides([spec.left?.size, spec.right?.size]);
    this._showPanel(empty, spec);
  }

  /**
   * Bring the instructions panel forward. A sidebar that had no width,
   * as after a session started in the browser with both collapsed, is
   * given the default share so the panel does not appear at its minimum,
   * unless the layout sized that side itself.
   */
  private _showPanel(
    empty: ReadonlySet<'left' | 'right'>,
    spec?: ILayoutSpec
  ): void {
    const { shell, panelId } = this._context;

    shell.activateById(panelId);

    const side = this._panelSide();

    if (!side || !empty.has(side) || spec?.[side]?.size !== undefined) {
      return;
    }

    this._resizeSides(
      side === 'left'
        ? [DEFAULT_PANEL_SHARE, undefined]
        : [undefined, DEFAULT_PANEL_SHARE]
    );
  }

  /**
   * The sidebars that currently take no width, collapsed or never shown.
   */
  private _emptySides(): Set<'left' | 'right'> {
    const empty = new Set<'left' | 'right'>();
    const split = findWidget(this._context.shell, SPLIT_PANEL_ID);

    if (!(split instanceof SplitPanel) || split.widgets.length !== 3) {
      return empty;
    }

    const sizes = split.relativeSizes();

    if ((sizes[0] ?? 0) < MIN_SHARE) {
      empty.add('left');
    }

    if ((sizes[2] ?? 0) < MIN_SHARE) {
      empty.add('right');
    }

    return empty;
  }

  private _panelSide(): 'left' | 'right' | null {
    const { shell, panelId } = this._context;

    for (const side of ['left', 'right'] as const) {
      for (const widget of shell.widgets(side)) {
        if (widget.id === panelId) {
          return side;
        }
      }
    }

    return null;
  }

  private async _wasApplied(path: string): Promise<boolean> {
    const record = await this._readRecord();

    return record.applied.includes(path);
  }

  private async _recordApplied(path: string): Promise<void> {
    const { stateDB } = this._context;

    if (!stateDB) {
      return;
    }

    const record = await this._readRecord();

    if (record.applied.includes(path)) {
      return;
    }

    try {
      await stateDB.save(STATE_KEY, {
        applied: [...record.applied, path]
      });
    } catch (error) {
      console.warn('Unable to record the workshop layout', error);
    }
  }

  private async _readRecord(): Promise<ILayoutRecord> {
    const { stateDB } = this._context;

    if (!stateDB) {
      return { applied: [] };
    }

    try {
      const stored = await stateDB.fetch(STATE_KEY);

      return isLayoutRecord(stored) ? stored : { applied: [] };
    } catch (error) {
      console.warn('Unable to read the workshop layout record', error);

      return { applied: [] };
    }
  }

  /**
   * Split the main area into the regions of the layout, each holding its
   * widgets as tabs, sizing a region when the layout asks for it.
   */
  private async _arrangeMain(spec: ILayoutSpec): Promise<void> {
    const { shell } = this._context;
    let anchor: Widget | null = null;

    // A launcher JupyterLab shows because the main area was empty gives way
    // to the layout's own widgets, as it does when an item is launched.
    const wantsLauncher = spec.main.some(area =>
      area.widgets.some(
        reference => parseLayoutWidget(reference).kind === 'launcher'
      )
    );
    const onlyLaunchers = !wantsLauncher && isPlaceholderMain(shell);

    for (const area of spec.main) {
      const widgets: Widget[] = [];

      for (const reference of area.widgets) {
        const widget = await this._resolve(reference);

        if (widget) {
          widgets.push(widget);
        }
      }

      if (widgets.length === 0) {
        continue;
      }

      // The first widget of an area splits off the previous area; the rest
      // become tabs beside it.
      const [first, ...rest] = widgets;

      // Areas split the dock: the first relative to the whole main area, the
      // rest relative to the previous area's first widget.
      shell.add(first, 'main', {
        mode: `split-${area.area}`,
        ref: anchor ? anchor.id : null,
        activate: false
      });

      for (const widget of rest) {
        shell.add(widget, 'main', {
          mode: 'tab-after',
          ref: first.id,
          activate: false
        });
      }

      this._resizeRegion(first, area);
      anchor = first;
    }

    if (anchor && onlyLaunchers) {
      closePlaceholders(shell);
    }
  }

  /**
   * Show, move or collapse one sidebar as the layout asks. Naming
   * `instructions` pins the workshop panel to that side; any other widget
   * name is a sidebar widget id to bring forward.
   */
  private _arrangeSide(
    side: 'left' | 'right',
    spec: ILayoutSide | undefined
  ): void {
    const { shell } = this._context;

    if (!spec) {
      return;
    }

    if (spec.widget === 'instructions') {
      this._movePanel(side);
      shell.activateById(this._context.panelId);
    } else if (spec.widget) {
      shell.activateById(spec.widget);
    }

    if (spec.collapsed) {
      if (side === 'left') {
        shell.collapseLeft();
      } else {
        shell.collapseRight();
      }

      return;
    }

    // A width only means something for a sidebar that is showing, so a
    // collapsed one is expanded first.
    if (spec.size !== undefined) {
      const collapsed =
        side === 'left' ? shell.leftCollapsed : shell.rightCollapsed;

      if (collapsed) {
        if (side === 'left') {
          shell.expandLeft();
        } else {
          shell.expandRight();
        }
      }
    }
  }

  /**
   * Give the sidebars the share of the window width the layout asks for.
   *
   * The shell keeps the left area, the main area and the right area in one
   * split panel. A collapsed area is hidden and takes no width, so the
   * requested fractions are of the visible width, and a hidden area keeps
   * its old share for when it is expanded again.
   */
  private _resizeSides(wanted: [number | undefined, number | undefined]): void {
    if (wanted.every(size => size === undefined)) {
      return;
    }

    const split = findWidget(this._context.shell, SPLIT_PANEL_ID);

    if (!(split instanceof SplitPanel) || split.widgets.length !== 3) {
      return;
    }

    // Fall back to JupyterLab's own default proportions when the panel has
    // not been laid out yet and reports no sizes.
    const hidden = split.widgets.map(widget => widget.isHidden);
    let current = split.relativeSizes();

    if (current.reduce((sum, size) => sum + size, 0) <= 0) {
      current = [1 / 4.5, 2.5 / 4.5, 1 / 4.5];
    }

    const visibleTotal = current.reduce(
      (sum, size, index) => (hidden[index] ? sum : sum + size),
      0
    );

    if (visibleTotal <= 0) {
      return;
    }

    // Fractions of the visible width: a requested size, or the share an
    // unrequested visible sidebar has now.
    let left = hidden[0] ? 0 : (wanted[0] ?? current[0] / visibleTotal);
    let right = hidden[2] ? 0 : (wanted[1] ?? current[2] / visibleTotal);

    if (left + right > SIDEBARS_MAX) {
      const scale = SIDEBARS_MAX / (left + right);

      left *= scale;
      right *= scale;
    }

    const main = 1 - left - right;

    split.setRelativeSizes([
      hidden[0] ? current[0] : left * visibleTotal,
      main * visibleTotal,
      hidden[2] ? current[2] : right * visibleTotal
    ]);
  }

  /**
   * Give the region holding a widget the fraction of the main area the
   * layout asks for, by rewriting the sizes of the dock split it sits in.
   */
  private _resizeRegion(widget: Widget, area: ILayoutArea): void {
    const { shell } = this._context;

    if (area.size === undefined || shell.mode !== 'multiple-document') {
      return;
    }

    const dock = findWidget(shell, DOCK_PANEL_ID);

    if (!(dock instanceof DockPanel)) {
      return;
    }

    const config = dock.saveLayout();
    const orientation =
      area.area === 'top' || area.area === 'bottom' ? 'vertical' : 'horizontal';

    if (
      config.main &&
      resizeAreaConfig(config.main, widget, orientation, area.size)
    ) {
      dock.restoreLayout(config);
    }
  }

  private _movePanel(side: 'left' | 'right'): void {
    const { shell, panelId } = this._context;

    for (const widget of shell.widgets(side)) {
      if (widget.id === panelId) {
        return;
      }
    }

    for (const widget of shell.widgets(side === 'left' ? 'right' : 'left')) {
      if (widget.id === panelId) {
        shell.add(widget, side, { rank: 600 });

        return;
      }
    }
  }

  private async _resolve(reference: string): Promise<Widget | null> {
    const { app, manager, terminals, docManager } = this._context;
    const { kind, target } = parseLayoutWidget(reference);

    switch (kind) {
      case 'terminal':
        return terminals.get(target || 'workshop', {
          cwd: manager.workshop?.path
        });
      case 'editor':
        return this._context.app.shell.currentWidget ?? null;
      case 'file':
        return openEditor(
          { app, docManager, editorTracker: null, manager, terminals },
          manager.resolvePath(target)
        );
      case 'markdown':
        return (
          docManager.openOrReveal(
            manager.resolvePath(target),
            MARKDOWN_FACTORY
          ) ?? null
        );
      case 'notebook':
        return (
          docManager.openOrReveal(manager.resolvePath(target), 'Notebook') ??
          null
        );
      case 'launcher': {
        const widget = (await app.commands.execute(
          'launcher:create'
        )) as unknown;

        return widget instanceof Widget ? widget : null;
      }
      default:
        console.warn(`Unknown layout widget "${reference}"`);

        return null;
    }
  }

  private _context: ILayoutContext;
}

/**
 * Whether a main area widget is the launcher, wrapped or not.
 */
function isLauncher(widget: Widget): boolean {
  const content = widget instanceof MainAreaWidget ? widget.content : widget;

  return content instanceof Launcher;
}

/**
 * Whether the main area is empty or holds nothing but the launcher
 * JupyterLab shows for an empty session, which is how a fresh workspace
 * looks.
 */
export function isPlaceholderMain(shell: ILabShell): boolean {
  return [...shell.widgets('main')].every(widget => isLauncher(widget));
}

/**
 * Close the launchers in the main area once something else has taken
 * their place.
 */
export function closePlaceholders(shell: ILabShell): void {
  for (const widget of [...shell.widgets('main')]) {
    if (isLauncher(widget)) {
      widget.close();
    }
  }
}

/**
 * Find a widget by id in the tree below a root widget.
 */
function findWidget(root: Widget, id: string): Widget | null {
  if (root.id === id) {
    return root;
  }

  const layout = root.layout;

  if (!layout) {
    return null;
  }

  for (const child of layout) {
    const found = findWidget(child, id);

    if (found) {
      return found;
    }
  }

  return null;
}

/**
 * In a saved dock layout, find the split whose direct child tab area holds
 * the widget and, when the split runs the right way, give that child the
 * requested fraction with the rest shared among its siblings as before.
 *
 * Returns whether the configuration was changed.
 */
function resizeAreaConfig(
  config: DockLayout.AreaConfig,
  widget: Widget,
  orientation: 'horizontal' | 'vertical',
  size: number
): boolean {
  if (config.type !== 'split-area') {
    return false;
  }

  const index = config.children.findIndex(
    child => child.type === 'tab-area' && child.widgets.includes(widget)
  );

  if (index === -1) {
    return config.children.some(child =>
      resizeAreaConfig(child, widget, orientation, size)
    );
  }

  if (config.orientation !== orientation) {
    return false;
  }

  const others = config.sizes.reduce(
    (sum, value, i) => (i === index ? sum : sum + value),
    0
  );
  const count = config.sizes.length;

  config.sizes = config.sizes.map((value, i) => {
    if (i === index) {
      return size;
    }

    return others > 0
      ? ((1 - size) * value) / others
      : (1 - size) / Math.max(1, count - 1);
  });

  return true;
}
