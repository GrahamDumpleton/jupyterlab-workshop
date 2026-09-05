import {
  IDirectiveNode,
  IPage,
  Variables,
  parseManifest,
  parsePage,
  renderEnvPs1,
  renderEnvSh
} from '@educates/workshop-core';
import { PathExt } from '@jupyterlab/coreutils';
import { Contents, ServerConnection } from '@jupyterlab/services';
import { IStateDB } from '@jupyterlab/statedb';
import { Debouncer } from '@lumino/polling';
import { ISignal, Signal } from '@lumino/signaling';

import { readTextFile, writeTextFile } from './actions/contents';
import { requestAPI } from './request';
import { StateStore, WORKSHOP_STATE_DIR } from './state';
import {
  ActionTrigger,
  IActionLogEntry,
  IActionRegistry,
  IActionRequest,
  IActionResult,
  IActionStatus,
  ILoadedWorkshop,
  IPageProgress,
  IPlatformInfo,
  IWorkshopManager,
  errorMessage
} from './tokens';
import {
  conditionHolds,
  parseDuration,
  sleep,
  visibleDirectives
} from './util';
import { VariableStore } from './variables';

const STATE_KEY = '@educates/jupyterlab-workshop:state';

const MANIFEST_FILE = 'workshop.yaml';

interface IStoredState {
  workshopPath: string;
}

interface IQueued {
  node: IDirectiveNode;
  trigger: ActionTrigger;
  delayMs: number;
}

/**
 * Loads a workshop through the contents API, tracks progress and runs
 * actions, including cascades and automatic runs.
 */
export class WorkshopManager implements IWorkshopManager {
  constructor(options: WorkshopManager.IOptions) {
    this._contents = options.contents;
    this._serverSettings = options.serverSettings;
    this._stateDB = options.stateDB;
    this._state = new StateStore(options.contents);
    this._envWriter = new Debouncer(() => this._writeEnvFiles(), 300);

    this._store.changed.connect(this._onVariablesChanged, this);
  }

  registry: IActionRegistry | null = null;

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get actionChanged(): ISignal<this, string> {
    return this._actionChanged;
  }

  get actionFocused(): ISignal<this, string> {
    return this._actionFocused;
  }

  get environmentChanged(): ISignal<this, void> {
    return this._environmentChanged;
  }

  get workshop(): ILoadedWorkshop | null {
    return this._workshop;
  }

  get variables(): VariableStore {
    return this._store;
  }

  get platform(): IPlatformInfo | null {
    return this._platform;
  }

  get error(): string | null {
    return this._error;
  }

  get visiblePages(): IPage[] {
    if (!this._workshop) {
      return [];
    }

    const values = this._store.values;

    return this._workshop.pages.filter(page =>
      conditionHolds(page.frontmatter.when, values)
    );
  }

  get pageIndex(): number {
    const index = this.visiblePages.findIndex(
      page => page.id === this._currentPageId
    );

    return index < 0 ? 0 : index;
  }

  get currentPage(): IPage | null {
    return this.visiblePages[this.pageIndex] ?? null;
  }

  get chainRunning(): boolean {
    return this._queue.length > 0 || this._pumping;
  }

  get log(): readonly IActionLogEntry[] {
    return this._state.state?.log ?? [];
  }

  async open(path: string): Promise<void> {
    const workshopPath = normalizeWorkshopPath(path);

    this.stopChain();
    this._error = null;
    this._loading = true;

    try {
      const platform = await this._ensurePlatform();
      const manifestPath = PathExt.join(workshopPath, MANIFEST_FILE);
      const manifest = parseManifest(
        await readTextFile(this._contents, manifestPath),
        manifestPath
      );

      // Read every page up front so navigation is instant.
      const sources: Record<string, string> = {};

      await Promise.all(
        manifest.pages.map(async pagePath => {
          sources[pagePath] = await readTextFile(
            this._contents,
            PathExt.join(workshopPath, pagePath)
          );
        })
      );

      const state = await this._state.load(
        workshopPath,
        manifest.name,
        manifest.version ?? ''
      );

      this._workshop = { path: workshopPath, manifest, sources, pages: [] };
      this._store.load(
        buildBuiltins(workshopPath, platform),
        manifest.variables,
        state.variables
      );
      this._renderPages();

      // Return to the saved page when it is still visible.
      const visible = this.visiblePages;
      const saved = visible.find(page => page.id === state.currentPage);
      const first = saved ?? visible[0];

      if (first) {
        this._enterPage(
          first.id,
          saved === undefined || !state.pages[first.id]?.enteredAt
        );
      }
    } catch (error) {
      this._workshop = null;
      this._currentPageId = '';
      this._error = `Unable to open workshop "${workshopPath}": ${errorMessage(error)}`;
    }

    this._loading = false;
    void this._envWriter.invoke();
    await this._saveStateDB();
    this._changed.emit();
  }

  async close(): Promise<void> {
    this.stopChain();
    await this._state.flush();
    await this._state.unload();

    this._workshop = null;
    this._currentPageId = '';
    this._error = null;
    this._store.load({}, []);

    await this._saveStateDB();
    this._changed.emit();
  }

  /**
   * Reopen the workshop that was open in a previous session.
   *
   * Returns whether a workshop was restored.
   */
  async restore(): Promise<boolean> {
    if (!this._stateDB) {
      return false;
    }

    const stored = await this._stateDB.fetch(STATE_KEY);

    if (!isStoredState(stored) || stored.workshopPath === '') {
      return false;
    }

    await this.open(stored.workshopPath);

    return this._workshop !== null;
  }

  goTo(index: number): void {
    const visible = this.visiblePages;
    const page = visible[Math.max(0, Math.min(index, visible.length - 1))];

    if (page && page.id !== this._currentPageId) {
      this._enterPage(page.id, true);
      this._changed.emit();
    }
  }

  goToPage(id: string): void {
    const index = this.visiblePages.findIndex(page => page.id === id);

    if (index >= 0) {
      this.goTo(index);
    }
  }

  next(): void {
    this.goTo(this.pageIndex + 1);
  }

  previous(): void {
    this.goTo(this.pageIndex - 1);
  }

  pageProgress(id: string): IPageProgress {
    return this._state.state?.pages[id] ?? { done: false };
  }

  markDone(id?: string, done = true): void {
    const state = this._state.state;
    const pageId = id ?? this._currentPageId;

    if (!state || !pageId) {
      return;
    }

    state.pages[pageId] = { ...state.pages[pageId], done };
    this._state.save();
    this._changed.emit();
  }

  actionStatus(id: string): IActionStatus {
    return (
      this._running.get(id) ??
      this._state.state?.actions[id] ?? { status: 'idle', runs: 0 }
    );
  }

  async runAction(
    node: IDirectiveNode,
    trigger: ActionTrigger,
    argument?: string
  ): Promise<IActionResult> {
    return this.runRequest(this._toRequest(node, argument), trigger, node);
  }

  async runRequest(
    request: IActionRequest,
    trigger: ActionTrigger,
    node?: IDirectiveNode
  ): Promise<IActionResult> {
    const registry = this.registry;

    if (!registry) {
      return { status: 'error', message: 'No action registry is available' };
    }

    // A click while a chain is pending cancels the chain first.
    if (trigger === 'click' || trigger === 'role') {
      this.stopChain();
    }

    this._running.set(request.id, {
      status: 'running',
      runs: this.actionStatus(request.id).runs
    });
    this._actionChanged.emit(request.id);

    const result = await registry.run(request);

    if (result.captured) {
      for (const [name, value] of Object.entries(result.captured)) {
        this._store.set(name, value, 'capture');
      }
    }

    this._record(request, result, trigger, registry.describe(request));
    this._running.delete(request.id);
    this._actionChanged.emit(request.id);

    if (node && request.page) {
      if (result.status === 'ok') {
        this._queueFollowers(node, request.page);
      } else if (
        result.status === 'error' &&
        request.options['on-error'] !== 'continue'
      ) {
        this.stopChain();
      }
    }

    return result;
  }

  stopChain(): void {
    this._queue = [];
    this._abort?.abort();
    this._abort = null;
  }

  evaluate(condition: string): boolean {
    return conditionHolds(condition, this._store.values);
  }

  resolvePath(path: string): string {
    if (!this._workshop) {
      throw new Error('No workshop is open');
    }

    const root = this._workshop.path;
    const resolved = PathExt.normalize(PathExt.join(root, path));
    const inside =
      root === ''
        ? !resolved.startsWith('..')
        : resolved === root || resolved.startsWith(`${root}/`);

    if (!inside) {
      throw new Error(`Path "${path}" is outside the workshop directory`);
    }

    return resolved;
  }

  absolutePath(path = ''): string {
    if (!this._workshop) {
      throw new Error('No workshop is open');
    }

    const root = this._platform?.root_dir ?? '';
    const relative = path
      ? PathExt.join(this._workshop.path, path)
      : this._workshop.path;
    const separator = this._platform?.path_sep ?? '/';

    return [root, ...relative.split('/')]
      .filter(part => part !== '')
      .join(separator);
  }

  private _toRequest(node: IDirectiveNode, argument?: string): IActionRequest {
    const defaults = this._workshop?.manifest.defaults ?? {};

    return {
      type: node.name,
      id: node.id,
      argument: argument ?? node.argument,
      options: { ...defaults, ...node.options },
      body: node.body,
      page: this._currentPageId
    };
  }

  private _record(
    request: IActionRequest,
    result: IActionResult,
    trigger: ActionTrigger,
    description: string
  ): void {
    const state = this._state.state;

    if (!state) {
      return;
    }

    const previous = state.actions[request.id];
    const status: IActionStatus = {
      status: result.status,
      message: result.message,
      runs: (previous?.runs ?? 0) + 1
    };

    state.actions[request.id] = status;

    this._state.appendLog({
      time: new Date().toISOString(),
      page: request.page ?? '',
      id: request.id,
      type: request.type,
      text: `${description}${request.body ? `: ${firstLine(request.body)}` : ''}`,
      status: result.status,
      message: result.message,
      trigger
    });

    this._state.save();
  }

  private _enterPage(id: string, runAutos: boolean): void {
    this.stopChain();
    this._currentPageId = id;

    const state = this._state.state;

    if (state) {
      state.currentPage = id;
      state.pages[id] = {
        ...state.pages[id],
        enteredAt: new Date().toISOString()
      };
      this._state.save();
    }

    if (runAutos) {
      const page = this.currentPage;

      if (page) {
        const autos = visibleDirectives(page, this._store.values).filter(
          node => node.options.auto === 'page-enter'
        );

        this._enqueue(
          autos.map(node => ({
            node,
            trigger: 'auto' as const,
            delayMs: this._delayFor(node)
          }))
        );
      }
    }
  }

  private _queueFollowers(node: IDirectiveNode, pageId: string): void {
    const page = this.currentPage;

    if (!page || page.id !== pageId) {
      return;
    }

    const directives = visibleDirectives(page, this._store.values);
    const followers: IQueued[] = [];

    // Cascade from the producer: the next action in document order, or a
    // named one, optionally with its own delay.
    const cascade =
      node.options.cascade ?? this._workshop?.manifest.defaults.cascade;

    if (cascade && cascade !== 'false') {
      let target: IDirectiveNode | undefined;
      let delayMs: number | undefined;

      if (cascade === 'true') {
        const index = directives.findIndex(item => item.id === node.id);

        target = index >= 0 ? directives[index + 1] : undefined;
      } else {
        const link = /^(\S+)(?:\s+after\s+(\S+))?$/.exec(cascade.trim());

        target = link
          ? directives.find(item => item.id === link[1])
          : undefined;
        delayMs = link?.[2] ? parseDuration(link[2], 0) : undefined;
      }

      if (target) {
        followers.push({
          node: target,
          trigger: 'cascade',
          delayMs: delayMs ?? this._delayFor(target)
        });
      }
    }

    // Triggers on consumers waiting for this action.
    for (const item of directives) {
      if (item.options.auto === `after:${node.id}` && item.id !== node.id) {
        followers.push({
          node: item,
          trigger: 'auto',
          delayMs: this._delayFor(item)
        });
      }
    }

    this._enqueue(followers);
  }

  private _delayFor(node: IDirectiveNode): number {
    const fallback = parseDuration(this._workshop?.manifest.defaults.delay, 0);

    return parseDuration(node.options.delay, fallback);
  }

  private _enqueue(items: IQueued[]): void {
    if (items.length === 0) {
      return;
    }

    this._queue.unshift(...items);
    void this._pump();
  }

  private async _pump(): Promise<void> {
    if (this._pumping) {
      return;
    }

    this._pumping = true;
    this._changed.emit();

    try {
      while (this._queue.length > 0) {
        const item = this._queue.shift() as IQueued;
        const abort = new AbortController();

        this._abort = abort;

        if (!(await sleep(item.delayMs, abort.signal))) {
          break;
        }

        if (abort.signal.aborted) {
          break;
        }

        if (item.node.options.scroll !== 'false') {
          this._actionFocused.emit(item.node.id);
        }

        await this.runRequest(
          this._toRequest(item.node),
          item.trigger,
          item.node
        );
      }
    } finally {
      this._pumping = false;
      this._abort = null;
      this._changed.emit();
    }
  }

  private _renderPages(): void {
    const workshop = this._workshop;

    if (!workshop) {
      return;
    }

    const variables = this._store.values;
    const pathSep = this._platform?.path_sep ?? '/';

    workshop.pages = workshop.manifest.pages.map(pagePath =>
      parsePage(workshop.sources[pagePath], {
        path: pagePath,
        variables,
        pathSep,
        declared: this._declared
      })
    );
  }

  private _onVariablesChanged(): void {
    // While opening, the caller renders pages and writes files itself.
    if (!this._workshop || this._loading) {
      return;
    }

    this._renderPages();

    const state = this._state.state;

    if (state) {
      state.variables = this._store.persistable();
      this._state.save();
    }

    void this._envWriter.invoke();
    this._changed.emit();
  }

  private async _writeEnvFiles(): Promise<void> {
    const workshop = this._workshop;

    if (!workshop) {
      return;
    }

    const values = this._store.values;
    const directory = PathExt.join(workshop.path, WORKSHOP_STATE_DIR);

    try {
      await writeTextFile(
        this._contents,
        PathExt.join(directory, 'env.sh'),
        renderEnvSh(values)
      );
      await writeTextFile(
        this._contents,
        PathExt.join(directory, 'env.ps1'),
        renderEnvPs1(values)
      );
    } catch (error) {
      console.warn('Unable to write workshop environment files', error);
    }
  }

  private async _ensurePlatform(): Promise<IPlatformInfo> {
    if (this._platform) {
      return this._platform;
    }

    try {
      this._platform = await requestAPI<IPlatformInfo>(
        'platform',
        this._serverSettings
      );
    } catch (error) {
      // Without the server extension fall back to generic values.
      console.warn(
        'Workshop server extension unavailable, assuming defaults',
        error
      );

      this._platform = {
        os: 'linux',
        shell: 'sh',
        home: '',
        user: '',
        path_sep: '/',
        root_dir: ''
      };
    }

    return this._platform;
  }

  private async _saveStateDB(): Promise<void> {
    if (!this._stateDB) {
      return;
    }

    const state: IStoredState = {
      workshopPath: this._workshop ? this._workshop.path : ''
    };

    try {
      await this._stateDB.save(STATE_KEY, { ...state });
    } catch (error) {
      console.warn('Unable to save workshop state', error);
    }
  }

  private _changed = new Signal<this, void>(this);
  private _actionChanged = new Signal<this, string>(this);
  private _actionFocused = new Signal<this, string>(this);
  private _environmentChanged = new Signal<this, void>(this);
  private _contents: Contents.IManager;
  private _serverSettings: ServerConnection.ISettings;
  private _stateDB: IStateDB | null;
  private _state: StateStore;
  private _store = new VariableStore();
  private _envWriter: Debouncer;
  private _workshop: ILoadedWorkshop | null = null;
  private _currentPageId = '';
  private _platform: IPlatformInfo | null = null;
  private _error: string | null = null;
  private _running = new Map<string, IActionStatus>();
  private _queue: IQueued[] = [];
  private _pumping = false;
  private _loading = false;
  private _declared = new Set<string>();
  private _abort: AbortController | null = null;
}

export namespace WorkshopManager {
  export interface IOptions {
    contents: Contents.IManager;
    serverSettings: ServerConnection.ISettings;
    stateDB: IStateDB | null;
  }
}

function normalizeWorkshopPath(path: string): string {
  return PathExt.normalize(path.trim()).replace(/^\/+|\/+$/g, '');
}

function buildBuiltins(
  workshopPath: string,
  platform: IPlatformInfo
): Variables {
  return {
    platform: platform.os,
    shell: platform.shell,
    path_sep: platform.path_sep,
    workshop_dir: workshopPath,
    home: platform.home,
    user: platform.user,
    lite: 'false',
    hub: 'false'
  };
}

function isStoredState(value: unknown): value is IStoredState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IStoredState).workshopPath === 'string'
  );
}

function firstLine(text: string): string {
  const line = text.split('\n')[0];

  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
