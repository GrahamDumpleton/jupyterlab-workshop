import {
  IPage,
  IWorkshopManifest,
  Variables,
  parseManifest,
  parsePage
} from '@educates/workshop-core';
import { PathExt } from '@jupyterlab/coreutils';
import { Contents, ServerConnection } from '@jupyterlab/services';
import { IStateDB } from '@jupyterlab/statedb';
import { ISignal, Signal } from '@lumino/signaling';

import { requestAPI } from './request';
import {
  ILoadedWorkshop,
  IPlatformInfo,
  IWorkshopManager,
  errorMessage
} from './tokens';

const STATE_KEY = '@educates/jupyterlab-workshop:state';

const MANIFEST_FILE = 'workshop.yaml';

interface IStoredState {
  workshopPath: string;
  pageIndex: number;
}

/**
 * Loads a workshop through the contents API and tracks the current page.
 */
export class WorkshopManager implements IWorkshopManager {
  constructor(options: WorkshopManager.IOptions) {
    this._contents = options.contents;
    this._serverSettings = options.serverSettings;
    this._stateDB = options.stateDB;
  }

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get workshop(): ILoadedWorkshop | null {
    return this._workshop;
  }

  get pageIndex(): number {
    return this._pageIndex;
  }

  get currentPage(): IPage | null {
    return this._workshop
      ? (this._workshop.pages[this._pageIndex] ?? null)
      : null;
  }

  get variables(): Variables {
    return this._variables;
  }

  get platform(): IPlatformInfo | null {
    return this._platform;
  }

  get error(): string | null {
    return this._error;
  }

  /**
   * Open the workshop in a directory relative to the JupyterLab root.
   */
  async open(path: string): Promise<void> {
    const workshopPath = normalizeWorkshopPath(path);

    this._error = null;

    try {
      const platform = await this._ensurePlatform();
      const manifestPath = PathExt.join(workshopPath, MANIFEST_FILE);
      const manifest = parseManifest(
        await this._readFile(manifestPath),
        manifestPath
      );

      const variables = buildVariables(workshopPath, manifest, platform);

      // Read and parse every page up front so navigation is instant.
      const pages = await Promise.all(
        manifest.pages.map(async pagePath =>
          parsePage(
            await this._readFile(PathExt.join(workshopPath, pagePath)),
            {
              path: pagePath,
              variables,
              pathSep: platform.path_sep
            }
          )
        )
      );

      this._workshop = { path: workshopPath, manifest, pages };
      this._variables = variables;
      this._pageIndex = 0;
    } catch (error) {
      this._workshop = null;
      this._variables = {};
      this._pageIndex = 0;
      this._error = `Unable to open workshop "${workshopPath}": ${errorMessage(error)}`;
    }

    await this._saveState();
    this._changed.emit();
  }

  /**
   * Close the current workshop.
   */
  async close(): Promise<void> {
    this._workshop = null;
    this._variables = {};
    this._pageIndex = 0;
    this._error = null;

    await this._saveState();
    this._changed.emit();
  }

  /**
   * Reopen the workshop and page that were open in a previous session.
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

    if (this._workshop) {
      this.goTo(stored.pageIndex);
    }

    return this._workshop !== null;
  }

  goTo(index: number): void {
    if (!this._workshop) {
      return;
    }

    const clamped = Math.max(
      0,
      Math.min(index, this._workshop.pages.length - 1)
    );

    if (clamped === this._pageIndex) {
      return;
    }

    this._pageIndex = clamped;

    void this._saveState();
    this._changed.emit();
  }

  next(): void {
    this.goTo(this._pageIndex + 1);
  }

  previous(): void {
    this.goTo(this._pageIndex - 1);
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

  private async _readFile(path: string): Promise<string> {
    const model = await this._contents.get(path, {
      content: true,
      type: 'file',
      format: 'text'
    });

    if (typeof model.content !== 'string') {
      throw new Error(`${path} is not a text file`);
    }

    return model.content;
  }

  private async _saveState(): Promise<void> {
    if (!this._stateDB) {
      return;
    }

    const state: IStoredState = {
      workshopPath: this._workshop ? this._workshop.path : '',
      pageIndex: this._pageIndex
    };

    try {
      await this._stateDB.save(STATE_KEY, { ...state });
    } catch (error) {
      console.warn('Unable to save workshop state', error);
    }
  }

  private _changed = new Signal<this, void>(this);
  private _contents: Contents.IManager;
  private _serverSettings: ServerConnection.ISettings;
  private _stateDB: IStateDB | null;
  private _workshop: ILoadedWorkshop | null = null;
  private _variables: Variables = {};
  private _pageIndex = 0;
  private _platform: IPlatformInfo | null = null;
  private _error: string | null = null;
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

function buildVariables(
  workshopPath: string,
  manifest: IWorkshopManifest,
  platform: IPlatformInfo
): Variables {
  const variables: Variables = {
    platform: platform.os,
    shell: platform.shell,
    path_sep: platform.path_sep,
    workshop_dir: workshopPath,
    home: platform.home,
    user: platform.user,
    lite: 'false',
    hub: 'false'
  };

  for (const variable of manifest.variables) {
    variables[variable.name] = variable.default ?? '';
  }

  return variables;
}

function isStoredState(value: unknown): value is IStoredState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IStoredState).workshopPath === 'string' &&
    typeof (value as IStoredState).pageIndex === 'number'
  );
}
