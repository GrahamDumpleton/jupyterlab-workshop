import {
  findLayout,
  ILayoutArea,
  ILayoutSpec,
  IWorkshopManifest,
  isLayoutPlaceholder,
  LAYOUT_AREA_KEYWORDS,
  parseLayoutWidget,
  sha256
} from '@jupyterlab-workshop/core';
import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { Launcher } from '@jupyterlab/launcher';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import { Terminal } from '@jupyterlab/terminal';
import { Token } from '@lumino/coreutils';
import { DockLayout, DockPanel, SplitPanel, Widget } from '@lumino/widgets';

import { openEditorWidget } from './actions/files';
import { TerminalSessions } from './actions/terminal';
import { readSetting } from './settings';
import { fetchForServer, saveForServer } from './statedb';
import { ILoadedWorkshop, IWorkshopManager } from './tokens';

/** Widget factory that renders a Markdown file as a preview. */
const MARKDOWN_FACTORY = 'Markdown Preview';

/** Widget factory that opens a notebook. */
const NOTEBOOK_FACTORY = 'Notebook';

/** Where the workshops whose layout has been applied are recorded. */
const STATE_KEY = '@jupyterlab-workshop/labextension:layouts';

/** Ids JupyterLab gives the panels a layout reads and adjusts. */
const DOCK_PANEL_ID = 'jp-main-dock-panel';
const SPLIT_PANEL_ID = 'jp-main-split-panel';

/** The most of the window width the two sidebars together may take. */
const SIDEBARS_MAX = 0.8;

/** Share of the window the instructions panel gets when its sidebar had none. */
const DEFAULT_PANEL_SHARE = 0.25;

/** A sidebar share below this counts as no width at all. */
const MIN_SHARE = 0.02;

/** Rank a sidebar widget gets when a layout moves it to the other side. */
const SIDEBAR_RANK = 100;

/** A sidebar of the JupyterLab shell. */
export type Side = 'left' | 'right';

/** The kinds of widget an action opens, for choosing where it goes. */
export type PlacementKind = 'document' | 'terminal';

/** Services the layout manager needs. */
export interface ILayoutContext {
  app: JupyterFrontEnd;
  shell: ILabShell;
  manager: IWorkshopManager;
  terminals: TerminalSessions;
  docManager: IDocumentManager;
  editorTracker: IEditorTracker | null;
  settingRegistry: ISettingRegistry | null;
  stateDB: IStateDB | null;

  /** Id of the instructions panel widget. */
  panelId: string;
}

/** What applying a layout produced. */
export interface ILayoutOutcome {
  /** Widget references that could not be opened, in the order written. */
  missing: string[];

  /** Whether the dock ended up arranged as the layout declares. */
  arranged: boolean;
}

/** Options for applying a layout. */
export interface IApplyOptions {
  /**
   * Whether this is the workshop's own opening of the layout, when the
   * manifest's sidebar default applies, as opposed to a page directive,
   * which leaves a sidebar it says nothing about alone.
   */
  initial?: boolean;

  /** Widgets to put in areas beyond what the layout names, by area id. */
  extra?: Map<string, Widget[]>;
}

/** What the state database holds under the layouts key. */
interface ILayoutRecord {
  /**
   * Keys of the workshops whose layout has been applied in this
   * workspace, on this server: the path and a hash of the layout, so an
   * edited layout applies again.
   */
  applied: string[];
}

/** One area of a layout tree while it is being realised. */
interface INode {
  /** Position in the tree, such as `0.1`, stable across applications. */
  id: string;
  name?: string;
  leaf: boolean;
  placeholder: boolean;

  /** Widget references of a leaf, as written. */
  refs: string[];

  /** Widgets the leaf holds once resolved, strays and extras included. */
  widgets: Widget[];
  split: 'rows' | 'columns';
  children: INode[];
  size?: number;
}

/** Where a widget should go: shell options, or an area to apply again. */
type Target =
  | { options: DocumentRegistry.IOpenOptions }
  | { layout: string; areaId: string };

function isLayoutRecord(value: unknown): value is ILayoutRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { applied?: unknown }).applied)
  );
}

/**
 * Arranges the JupyterLab window according to a named layout from the
 * manifest or the built-in set.
 *
 * A layout describes a result. The main area is a tree of tab areas and
 * splits that is handed to the dock panel whole, so applying the same
 * layout twice gives the same window, and a widget the layout does not
 * name is kept as a tab in the placeholder area rather than closed.
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

  /** The name of the layout last applied to the open workshop, if any. */
  get applied(): string | null {
    return this._applied;
  }

  /**
   * Apply the layout the manifest names when a workshop is opened.
   *
   * The layout is applied the first time a workshop is opened in a
   * workspace, every time it is opened from a launch link, and whenever
   * it opens with no recorded progress, as after Restart, Reset Progress
   * or a state directory removed by hand. After that JupyterLab restores
   * whatever arrangement the learner left, so the layout is left alone
   * and only the instructions panel is shown.
   */
  async applyOnOpen(workshop: ILoadedWorkshop): Promise<void> {
    // Which sidebars have no width is read now, before the command that
    // opened the workshop reveals the panel at its minimum width.
    const empty = this._emptySides();
    const key = this._recordKey(workshop);
    const name = workshop.manifest.layout;

    this._applied = null;
    this._nodes = new Map();

    if (
      !workshop.launched &&
      !workshop.fresh &&
      (await this._wasApplied(key))
    ) {
      // JupyterLab restored the learner's arrangement; note which of its
      // widgets belong to which area so actions still find their places.
      const spec = name ? this.find(name) : undefined;

      if (name && spec) {
        this._adopt(name, spec);
      }

      // No layout runs to size the panel's sidebar, so one the learner
      // left without width is given the manifest's share here.
      this._widenPanel(empty, workshop.manifest);
      this._showPanel(empty);

      return;
    }

    await this._recordApplied(key);

    if (!name) {
      await this._arrangeSides(undefined, true);
      this._showPanel(empty);

      return;
    }

    await this.apply(name, { initial: true }, empty);
  }

  /**
   * Show the instructions panel for a workshop whose trust prompt is up,
   * on the side and at the width its manifest asks for, so the learner
   * sees the first page behind the dialog. The layout itself waits for
   * the answer; the other sidebar and the main area are left alone.
   */
  async revealPanel(manifest: IWorkshopManifest): Promise<void> {
    const empty = this._emptySides();
    const side =
      manifest.instructions?.side ??
      this._panelSide() ??
      (await this._settingSide());

    this._movePanel(side);

    const width = manifest.instructions?.width;

    if (width !== undefined) {
      this._expand(side);
      this._resizeSides(
        side === 'left' ? [width, undefined] : [undefined, width]
      );
    }

    this._showPanel(empty, undefined, manifest);
  }

  /**
   * Apply a named layout in full: the main area as declared, then the
   * sidebars, finishing with the instructions panel shown. Widgets the
   * layout could not open are reported rather than stopping the rest.
   */
  async apply(
    name: string,
    options: IApplyOptions = {},
    empty: ReadonlySet<Side> = this._emptySides()
  ): Promise<ILayoutOutcome> {
    const spec = this.find(name);

    if (!spec) {
      throw new Error(`Unknown layout "${name}"`);
    }

    const outcome = spec.main
      ? await this._arrangeMain(name, spec.main, options.extra)
      : { missing: [], arranged: true };

    this._applied = name;

    await this._arrangeSides(spec, options.initial === true);
    this._showPanel(empty, spec);

    return outcome;
  }

  /**
   * Shell options that put a widget an action is about to open where its
   * `area` option, or the applied layout, says. Undefined leaves the
   * placement to JupyterLab, or to `place` once the widget exists.
   */
  placement(
    kind: PlacementKind,
    area?: string
  ): DocumentRegistry.IOpenOptions | undefined {
    const target = this._target(kind, area);

    return target && 'options' in target ? target.options : undefined;
  }

  /**
   * Put a widget an action opened or revealed where its `area` option,
   * or the applied layout, says, and bring it forward. A widget that
   * was already open moves only when an area is asked for; one that was
   * opened with the options `placement` gave (`placed`) is where it
   * should be unless its area had nothing open in it, which needs the
   * layout applied again with the widget added.
   */
  async place(
    widget: Widget,
    kind: PlacementKind,
    area: string | undefined,
    state: { existed: boolean; placed: boolean }
  ): Promise<void> {
    const { shell } = this._context;
    const target =
      state.existed && area === undefined ? null : this._target(kind, area);

    if (target && 'areaId' in target) {
      await this.apply(target.layout, {
        extra: new Map([[target.areaId, [widget]]])
      });

      return;
    }

    if (target && !state.placed) {
      shell.add(widget, 'main', { ...target.options, activate: false });
    }

    shell.activateById(widget.id);
  }

  /**
   * Bring a sidebar widget forward in the sidebar the instructions panel
   * is not in, moving it there first if it shares the panel's side, so
   * the two never cover each other. Returns false when no sidebar holds
   * a widget with the id.
   */
  showSidebarWidget(id: string): boolean {
    const { shell, panelId } = this._context;

    // The instructions panel itself stays where it is: "the side the
    // instructions are not in" would otherwise move it across.
    if (id === panelId) {
      const own = this._panelSide();

      if (own === null) {
        return false;
      }

      this._expand(own);
      shell.activateById(id);

      return true;
    }

    const side = this.otherSide();

    for (const candidate of ['left', 'right'] as const) {
      for (const widget of shell.widgets(candidate)) {
        if (widget.id !== id) {
          continue;
        }

        if (candidate !== side) {
          shell.add(widget, side, { rank: SIDEBAR_RANK });
        }

        this._expand(side);
        shell.activateById(id);

        return true;
      }
    }

    return false;
  }

  /** The sidebar the instructions panel is not in. */
  otherSide(): Side {
    return (this._panelSide() ?? 'right') === 'left' ? 'right' : 'left';
  }

  /**
   * Forget that a workshop's layout was applied, so it applies again the
   * next time the workshop is opened at that path.
   */
  async forget(path: string): Promise<void> {
    const { stateDB } = this._context;

    if (!stateDB) {
      return;
    }

    const record = await this._readRecord();
    const applied = record.applied.filter(
      key => key !== path && !key.startsWith(`${path}#`)
    );

    if (applied.length === record.applied.length) {
      return;
    }

    try {
      await saveForServer(stateDB, STATE_KEY, { applied });
    } catch (error) {
      console.warn('Unable to forget the workshop layout', error);
    }
  }

  /**
   * Realise the main-area tree: open what it names, gather what is open
   * that it does not name into the placeholder, and hand the dock the
   * result as one configuration.
   */
  private async _arrangeMain(
    name: string,
    main: ILayoutArea,
    extra?: Map<string, Widget[]>
  ): Promise<ILayoutOutcome> {
    const { shell } = this._context;
    const root = buildTree(main);
    const nodes = new Map<string, INode>();
    const leaves: INode[] = [];

    for (const node of walk(root)) {
      nodes.set(node.id, node);

      if (node.leaf) {
        leaves.push(node);
      }
    }

    // A launcher JupyterLab shows because the main area was empty gives way
    // to the layout's own widgets, as it does when an item is launched.
    const wantsLauncher = leaves.some(node =>
      node.refs.some(
        reference => parseLayoutWidget(reference).kind === 'launcher'
      )
    );
    const onlyLaunchers = !wantsLauncher && isPlaceholderMain(shell);

    // Open or find every widget the layout names. One that cannot be
    // opened is left out and reported; the rest of the tree stands.
    const missing: string[] = [];
    const named = new Set<Widget>();

    for (const node of leaves) {
      for (const reference of node.refs) {
        const widget = await this._resolve(reference);

        if (widget && !named.has(widget)) {
          node.widgets.push(widget);
          named.add(widget);
        } else if (!widget) {
          missing.push(reference);
        }
      }
    }

    for (const [id, widgets] of extra ?? []) {
      const node = nodes.get(id);

      if (!node) {
        continue;
      }

      for (const widget of widgets) {
        if (!named.has(widget)) {
          node.widgets.push(widget);
          named.add(widget);
        }
      }
    }

    // Whatever else is open goes to the placeholder, or the first area
    // when the layout has none, as tabs behind what the layout named.
    const placeholder =
      leaves.find(node => node.placeholder) ?? leaves[0] ?? null;

    for (const widget of shell.widgets('main')) {
      if (
        widget.isDisposed ||
        named.has(widget) ||
        (onlyLaunchers && isLauncher(widget))
      ) {
        continue;
      }

      if (placeholder) {
        placeholder.widgets.push(widget);
        named.add(widget);
      }
    }

    this._nodes = nodes;
    this._placeholderId = placeholder?.id ?? null;
    this._watch(named);

    const config = toConfig(root);

    if (!config || shell.mode !== 'multiple-document') {
      return { missing, arranged: true };
    }

    const dock = findWidget(shell, DOCK_PANEL_ID);

    if (!(dock instanceof DockPanel)) {
      return { missing, arranged: false };
    }

    if (onlyLaunchers) {
      closePlaceholders(shell);
    }

    dock.restoreLayout({ main: config });

    const arranged = shape(dock.saveLayout().main) === shape(config);

    if (!arranged) {
      console.warn(`Layout "${name}" was not arranged as declared`);
    }

    // The first tab of the first area is the natural current widget.
    const first = leaves.find(node => node.widgets.length > 0)?.widgets[0];

    if (first) {
      shell.activateById(first.id);
    }

    return { missing, arranged };
  }

  /**
   * Note which of the widgets JupyterLab restored belong to which area of
   * the manifest's layout, without opening or moving anything, so that
   * actions opening into an area find their anchors after a reload.
   */
  private _adopt(name: string, spec: ILayoutSpec): void {
    if (!spec.main) {
      return;
    }

    const root = buildTree(spec.main);
    const nodes = new Map<string, INode>();
    const open = [...this._context.shell.widgets('main')];
    const named = new Set<Widget>();
    let placeholder: INode | null = null;

    for (const node of walk(root)) {
      nodes.set(node.id, node);

      if (!node.leaf) {
        continue;
      }

      if (node.placeholder && !placeholder) {
        placeholder = node;
      }

      for (const reference of node.refs) {
        const widget = this._findOpen(reference, open);

        if (widget && !named.has(widget)) {
          node.widgets.push(widget);
          named.add(widget);
        }
      }
    }

    this._applied = name;
    this._nodes = nodes;
    this._placeholderId = placeholder?.id ?? null;
    this._watch(named);
  }

  /**
   * Where a widget of a kind, or one bound for a named area, goes now:
   * beside a widget already in that area, or into an area that has
   * nothing open, which means applying its layout again with the widget
   * added. Null leaves the placement to the caller's own fallback.
   */
  private _target(kind: PlacementKind, area?: string): Target | null {
    const current = this._context.shell.currentWidget;

    // The keywords place relative to the current widget, whatever the
    // layout.
    if (area !== undefined && LAYOUT_AREA_KEYWORDS.has(area)) {
      if (!current) {
        return null;
      }

      return {
        options:
          area === 'tab'
            ? { mode: 'tab-after', ref: current.id }
            : { mode: `split-${area as 'right' | 'bottom'}`, ref: current.id }
      };
    }

    if (area !== undefined) {
      const found = this._areaByName(area);

      if (!found) {
        console.warn(`No layout declares an area named "${area}"`);

        return null;
      }

      if (found.layout === this._applied) {
        const live = this._live(found.areaId);

        if (live.length > 0) {
          return {
            options: { mode: 'tab-after', ref: live[live.length - 1].id }
          };
        }
      }

      return found;
    }

    if (!this._applied) {
      return this._fallback(kind);
    }

    // No area asked for: beside the first widget of the same kind the
    // layout holds, else the placeholder for a document, else the
    // fallback a workshop without a layout gets.
    for (const node of this._nodes.values()) {
      if (!node.leaf) {
        continue;
      }

      const match = this._live(node.id).find(widget =>
        kind === 'terminal' ? isTerminal(widget) : !isTerminal(widget)
      );

      if (match) {
        return { options: { mode: 'tab-after', ref: match.id } };
      }
    }

    if (kind === 'document' && this._placeholderId !== null) {
      return { layout: this._applied, areaId: this._placeholderId };
    }

    return this._fallback(kind);
  }

  /**
   * Where a widget goes when no layout says: a document beside the
   * current editor, else beside the first document open, else above the
   * first workshop terminal; a terminal below the main area, or beside
   * the first terminal when there is one.
   */
  private _fallback(kind: PlacementKind): Target | null {
    const { shell, docManager, editorTracker, terminals } = this._context;

    if (kind === 'terminal') {
      const first = terminals.first;

      return {
        options: first
          ? { mode: 'split-right', ref: first.id }
          : { mode: 'split-bottom' }
      };
    }

    const editor = editorTracker?.currentWidget;

    if (editor && !editor.isDisposed) {
      return { options: { mode: 'tab-after', ref: editor.id } };
    }

    for (const widget of shell.widgets('main')) {
      if (!widget.isDisposed && docManager.contextForWidget(widget)) {
        return { options: { mode: 'tab-after', ref: widget.id } };
      }
    }

    const terminal = terminals.first;

    return terminal
      ? { options: { mode: 'split-top', ref: terminal.id } }
      : null;
  }

  /**
   * The layout, the applied one first, that declares an area name, with
   * the area's id in that layout's tree.
   */
  private _areaByName(name: string): { layout: string; areaId: string } | null {
    const layouts = this._context.manager.workshop?.manifest.layouts ?? {};
    const candidates = this._applied
      ? [this._applied, ...Object.keys(layouts)]
      : Object.keys(layouts);

    for (const layout of candidates) {
      const spec = this.find(layout);

      if (!spec?.main) {
        continue;
      }

      for (const node of walk(buildTree(spec.main))) {
        if (node.name === name) {
          return { layout, areaId: node.id };
        }
      }
    }

    return null;
  }

  /** The widgets of an area that are still open in the main area. */
  private _live(areaId: string): Widget[] {
    const node = this._nodes.get(areaId);

    if (!node) {
      return [];
    }

    const open = new Set(this._context.shell.widgets('main'));

    return node.widgets.filter(
      widget => !widget.isDisposed && open.has(widget)
    );
  }

  /**
   * When a widget the layout placed closes, put the declared sizes back
   * on the areas that remain, since the dock hands a closed area's share
   * to its siblings in equal parts rather than in proportion.
   */
  private _watch(widgets: Iterable<Widget>): void {
    for (const widget of widgets) {
      if (this._watched.has(widget)) {
        continue;
      }

      this._watched.add(widget);
      widget.disposed.connect(() => {
        this._watched.delete(widget);
        this._restoreSizes();
      });
    }
  }

  private _restoreSizes(): void {
    const { shell } = this._context;

    if (!this._applied || shell.mode !== 'multiple-document') {
      return;
    }

    const dock = findWidget(shell, DOCK_PANEL_ID);

    if (!(dock instanceof DockPanel)) {
      return;
    }

    const config = dock.saveLayout();
    let changed = false;

    for (const node of this._nodes.values()) {
      const parent = this._parentOf(node);

      if (node.size === undefined || !parent) {
        continue;
      }

      const live = leafWidgets(node).find(
        widget => !widget.isDisposed && widget.parent !== null
      );
      const orientation =
        parent.split === 'columns' ? 'horizontal' : 'vertical';

      if (
        live &&
        config.main &&
        resizeAreaConfig(config.main, live, orientation, node.size)
      ) {
        changed = true;
      }
    }

    if (changed) {
      dock.restoreLayout(config);
    }
  }

  private _parentOf(node: INode): INode | null {
    const index = node.id.lastIndexOf('.');

    return index === -1
      ? null
      : (this._nodes.get(node.id.slice(0, index)) ?? null);
  }

  /**
   * Place the instructions panel and deal with the other sidebar: the
   * panel goes to the manifest's side, or stays where it is, at the
   * width the layout or the manifest asks for; the other sidebar is
   * collapsed or shows the widget asked for.
   */
  private async _arrangeSides(
    spec: ILayoutSpec | undefined,
    initial: boolean
  ): Promise<void> {
    const { shell } = this._context;
    const manifest = this._context.manager.workshop?.manifest;
    const side =
      manifest?.instructions?.side ??
      this._panelSide() ??
      (await this._settingSide());
    const other: Side = side === 'left' ? 'right' : 'left';

    this._movePanel(side);

    const sidebar =
      spec?.sidebar ?? (initial ? (manifest?.sidebar ?? 'hidden') : undefined);

    if (sidebar === 'hidden') {
      if (other === 'left') {
        shell.collapseLeft();
      } else {
        shell.collapseRight();
      }
    } else if (sidebar !== undefined) {
      this.showSidebarWidget(sidebar);
    }

    const width = spec?.instructions?.width ?? manifest?.instructions?.width;

    if (width !== undefined) {
      this._expand(side);
      this._resizeSides(
        side === 'left' ? [width, undefined] : [undefined, width]
      );
    }
  }

  /**
   * Bring the instructions panel forward. A sidebar that had no width,
   * as after a session started in the browser with both collapsed, is
   * given the default share so the panel does not appear at its minimum,
   * unless the layout or the manifest sized that side itself.
   */
  private _showPanel(
    empty: ReadonlySet<Side>,
    spec?: ILayoutSpec,
    manifest: IWorkshopManifest | undefined = this._context.manager.workshop
      ?.manifest
  ): void {
    const { shell, panelId } = this._context;

    shell.activateById(panelId);

    const side = this._panelSide();
    const sized =
      spec?.instructions?.width !== undefined ||
      manifest?.instructions?.width !== undefined;

    if (!side || !empty.has(side) || sized) {
      return;
    }

    this._resizeSides(
      side === 'left'
        ? [DEFAULT_PANEL_SHARE, undefined]
        : [undefined, DEFAULT_PANEL_SHARE]
    );
  }

  /**
   * Give the instructions panel the width its manifest asks for when its
   * sidebar has none, for an open that applies no layout.
   */
  private _widenPanel(
    empty: ReadonlySet<Side>,
    manifest: IWorkshopManifest
  ): void {
    const side = this._panelSide();
    const width = manifest.instructions?.width;

    if (!side || !empty.has(side) || width === undefined) {
      return;
    }

    this._expand(side);
    this._resizeSides(
      side === 'left' ? [width, undefined] : [undefined, width]
    );
  }

  private async _settingSide(): Promise<Side> {
    const side = await readSetting(
      this._context.settingRegistry,
      'panelSide',
      'right'
    );

    return side === 'left' ? 'left' : 'right';
  }

  private _expand(side: Side): void {
    const { shell } = this._context;

    if (side === 'left' && shell.leftCollapsed) {
      shell.expandLeft();
    } else if (side === 'right' && shell.rightCollapsed) {
      shell.expandRight();
    }
  }

  /**
   * The sidebars that nobody has sized: collapsed, never shown, or held
   * at the minimum width JupyterLab's stylesheet allows. A sidebar sits
   * at that minimum when a restored arrangement carried no proportions,
   * as happens after a reload in JupyterLite, and a panel that narrow is
   * no arrangement the learner chose.
   */
  private _emptySides(): Set<Side> {
    const empty = new Set<Side>();
    const split = findWidget(this._context.shell, SPLIT_PANEL_ID);

    if (!(split instanceof SplitPanel) || split.widgets.length !== 3) {
      return empty;
    }

    const sizes = split.relativeSizes();
    const sides: [number, Side][] = [
      [0, 'left'],
      [2, 'right']
    ];

    for (const [index, side] of sides) {
      const area = split.widgets[index];

      if ((sizes[index] ?? 0) < MIN_SHARE) {
        empty.add(side);
        continue;
      }

      const minimum = parseFloat(getComputedStyle(area.node).minWidth);
      const width = area.node.getBoundingClientRect().width;

      if (!area.isHidden && minimum > 0 && width <= minimum + 1) {
        empty.add(side);
      }
    }

    return empty;
  }

  private _panelSide(): Side | null {
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

  private _recordKey(workshop: ILoadedWorkshop): string {
    const { manifest } = workshop;
    const name = manifest.layout;
    const layout = name ? (findLayout(manifest.layouts, name) ?? null) : null;
    const hash = sha256(
      JSON.stringify([
        name ?? null,
        layout,
        manifest.instructions ?? null,
        manifest.sidebar ?? null
      ])
    );

    return `${workshop.path}#${hash}`;
  }

  private async _wasApplied(key: string): Promise<boolean> {
    const record = await this._readRecord();

    return record.applied.includes(key);
  }

  private async _recordApplied(key: string): Promise<void> {
    const { stateDB } = this._context;

    if (!stateDB) {
      return;
    }

    const record = await this._readRecord();

    if (record.applied.includes(key)) {
      return;
    }

    try {
      await saveForServer(stateDB, STATE_KEY, {
        applied: [...record.applied, key]
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
      const stored = await fetchForServer(stateDB, STATE_KEY);

      return isLayoutRecord(stored) ? stored : { applied: [] };
    } catch (error) {
      console.warn('Unable to read the workshop layout record', error);

      return { applied: [] };
    }
  }

  /**
   * Give the sidebars the share of the window width the layout asks for.
   *
   * The shell keeps the left area, the main area and the right area in one
   * split panel. A collapsed area is hidden and takes no width, but the
   * size it reports is stale until the panel next updates: an area the
   * layout collapsed a moment ago still holds the share it had, and the
   * update hands that share to the main area, the only one that
   * stretches. So a sidebar's fraction is of the whole width, the main
   * area is given what is left after the sidebars and the hidden entries,
   * and a hidden entry is passed back as it is, which keeps the hint that
   * sizes the area when it is expanded again.
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

    // Fractions of the whole width: a requested size, or the share an
    // unrequested visible sidebar has now.
    let left = hidden[0] ? 0 : (wanted[0] ?? current[0]);
    let right = hidden[2] ? 0 : (wanted[1] ?? current[2]);

    if (left + right > SIDEBARS_MAX) {
      const scale = SIDEBARS_MAX / (left + right);

      left *= scale;
      right *= scale;
    }

    const hiddenTotal = current.reduce(
      (sum, size, index) => (hidden[index] ? sum + size : sum),
      0
    );
    const main = Math.max(0, 1 - left - right - hiddenTotal);

    split.setRelativeSizes([
      hidden[0] ? current[0] : left,
      main,
      hidden[2] ? current[2] : right
    ]);
  }

  private _movePanel(side: Side): void {
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

  /**
   * Open the widget a reference names, or find it when it is open. A file
   * that does not exist is reported as missing rather than opened, which
   * would raise JupyterLab's load error dialog.
   */
  private async _resolve(reference: string): Promise<Widget | null> {
    const { app, manager, terminals, docManager } = this._context;
    const { kind, target } = parseLayoutWidget(reference);

    try {
      switch (kind) {
        case 'terminal':
          // Layout terminals start where action terminals do: in the
          // workspace when one is declared.
          return await terminals.get(target || 'workshop', {
            cwd: manager.workspacePath ?? manager.workshop?.path
          });
        case 'file':
        case 'markdown':
        case 'notebook': {
          const path = manager.resolvePath(target);

          if (!(await this._exists(path))) {
            return null;
          }

          if (kind === 'file') {
            return await openEditorWidget(this._context, path);
          }

          return (
            docManager.openOrReveal(
              path,
              kind === 'markdown' ? MARKDOWN_FACTORY : NOTEBOOK_FACTORY
            ) ?? null
          );
        }
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
    } catch (error) {
      console.warn(`Unable to open layout widget "${reference}"`, error);

      return null;
    }
  }

  /** The open main-area widget a reference names, without opening one. */
  private _findOpen(reference: string, open: Widget[]): Widget | null {
    const { manager, docManager } = this._context;
    const { kind, target } = parseLayoutWidget(reference);

    switch (kind) {
      case 'terminal': {
        const id = `jupyterlab-workshop-terminal-${target || 'workshop'}`;

        return open.find(widget => widget.id === id) ?? null;
      }
      case 'file':
      case 'markdown':
      case 'notebook': {
        const path = manager.resolvePath(target);

        return (
          open.find(
            widget => docManager.contextForWidget(widget)?.path === path
          ) ?? null
        );
      }
      case 'launcher':
        return open.find(isLauncher) ?? null;
      default:
        return null;
    }
  }

  private async _exists(path: string): Promise<boolean> {
    try {
      await this._context.docManager.services.contents.get(path, {
        content: false
      });

      return true;
    } catch {
      return false;
    }
  }

  private _context: ILayoutContext;
  private _applied: string | null = null;
  private _nodes: Map<string, INode> = new Map();
  private _placeholderId: string | null = null;
  private _watched: Set<Widget> = new Set();
}

/** The layout manager, for plugins that arrange or forget layouts. */
export const ILayoutManager = new Token<LayoutManager>(
  '@jupyterlab-workshop/labextension:ILayoutManager',
  'Arranges the JupyterLab window as a workshop layout asks.'
);

/**
 * Turn a layout's main-area tree into nodes with stable ids, without
 * resolving any widget.
 */
function buildTree(area: ILayoutArea, id = '0'): INode {
  const leaf = area.areas === undefined;

  return {
    id,
    name: area.name,
    leaf,
    placeholder: isLayoutPlaceholder(area),
    refs: leaf ? [...(area.tabs ?? [])] : [],
    widgets: [],
    split: area.split ?? 'rows',
    children: leaf
      ? []
      : (area.areas ?? []).map((child, index) =>
          buildTree(child, `${id}.${index}`)
        ),
    size: area.size
  };
}

function* walk(node: INode): Generator<INode> {
  yield node;

  for (const child of node.children) {
    yield* walk(child);
  }
}

function leafWidgets(node: INode): Widget[] {
  return node.leaf
    ? node.widgets
    : node.children.flatMap(child => leafWidgets(child));
}

/**
 * The dock configuration a tree of resolved nodes describes: areas with
 * nothing in them are dropped, a split with one child collapses into it,
 * a child split running the same way is merged into its parent, as the
 * dock itself normalises, and sizes not given share what is left.
 */
function toConfig(node: INode): DockLayout.AreaConfig | null {
  if (node.leaf) {
    return node.widgets.length > 0
      ? { type: 'tab-area', widgets: node.widgets, currentIndex: 0 }
      : null;
  }

  const kept: { config: DockLayout.AreaConfig; size?: number }[] = [];

  for (const child of node.children) {
    const config = toConfig(child);

    if (config) {
      kept.push({ config, size: child.size });
    }
  }

  if (kept.length === 0) {
    return null;
  }

  if (kept.length === 1) {
    return kept[0].config;
  }

  const orientation = node.split === 'columns' ? 'horizontal' : 'vertical';
  const sizes = shareSizes(kept.map(item => item.size));
  const children: DockLayout.AreaConfig[] = [];
  const flat: number[] = [];

  kept.forEach((item, index) => {
    const { config } = item;

    if (config.type === 'split-area' && config.orientation === orientation) {
      const total = config.sizes.reduce((sum, size) => sum + size, 0) || 1;

      children.push(...config.children);
      flat.push(...config.sizes.map(size => (sizes[index] * size) / total));
    } else {
      children.push(config);
      flat.push(sizes[index]);
    }
  });

  return { type: 'split-area', orientation, children, sizes: flat };
}

/**
 * Fractions for the children of a split: those given as written, the
 * rest sharing what remains equally.
 */
function shareSizes(declared: (number | undefined)[]): number[] {
  const given = declared.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  const open = declared.filter(size => size === undefined).length;
  const remaining = Math.max(0, 1 - given);
  const share = open > 0 ? remaining / open : 0;

  return declared.map(
    size => size ?? (share > 0 ? share : 1 / declared.length)
  );
}

/**
 * The structure of a dock configuration as a string: which widgets share
 * an area and how areas are split, sizes aside, for comparing what the
 * dock did with what was asked.
 */
function shape(config: DockLayout.AreaConfig | null): string {
  if (!config) {
    return 'empty';
  }

  if (config.type === 'tab-area') {
    return `[${config.widgets.map(widget => widget.id).join(',')}]`;
  }

  const inner = config.children.map(child => shape(child)).join(' ');

  return `${config.orientation === 'horizontal' ? 'cols' : 'rows'}(${inner})`;
}

/**
 * Whether a main area widget is a workshop terminal.
 */
function isTerminal(widget: Widget): boolean {
  return widget instanceof MainAreaWidget && widget.content instanceof Terminal;
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
