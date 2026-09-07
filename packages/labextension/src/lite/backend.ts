import { JupyterFrontEnd } from '@jupyterlab/application';
import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';

import { readIfExists } from '../actions/contents';
import {
  ICheckpointRecord,
  IEnvironmentRequest,
  IEnvironmentStatus,
  IEventsBatch,
  IFetchRequest,
  IFetchResult,
  IInstalledWorkshop,
  IPlatformInfo,
  IPreflightResult,
  IScriptRequest,
  IScriptResult,
  IToolRequest,
  IWorkshopBackend
} from '../tokens';
import { createCheckpoint, restoreCheckpoint } from './checkpoints';
import { LITE_PLATFORM } from './detect';
import { recordEvents } from './events';
import { fetchJson, fetchWorkshopFiles } from './fetch';
import { listInstalled, removeInstalled } from './installed';
import { litePreflight } from './preflight';

/** Largest collection index or catalog the browser will read. */
const MAX_INDEX_BYTES = 5 * 1024 * 1024;

/**
 * The backend for JupyterLite, where there is no server: everything runs
 * in the browser against the contents API, the network and the terminal
 * extension's headless shell. Isolated environments and verify scripts
 * need an operating system and are reported as unavailable.
 */
export class LiteBackend implements IWorkshopBackend {
  constructor(options: LiteBackend.IOptions) {
    this._app = options.app;
  }

  readonly kind = 'lite';

  async platform(): Promise<IPlatformInfo> {
    return { ...LITE_PLATFORM };
  }

  fetch(request: IFetchRequest): Promise<IFetchResult> {
    return fetchWorkshopFiles(this._contents, request);
  }

  fetchCollection(url: string): Promise<unknown> {
    return this._fetchIndex(url, 'collection');
  }

  fetchCatalog(url: string): Promise<unknown> {
    return this._fetchIndex(url, 'catalog');
  }

  private async _fetchIndex(url: string, what: string): Promise<unknown> {
    // A path rather than a URL is a file in the site's contents.
    if (!/^https?:\/\//i.test(url)) {
      const text = await readIfExists(this._contents, PathExt.normalize(url));

      if (text === null) {
        throw new Error(`There is no ${what} file at ${url}`);
      }

      return JSON.parse(text) as unknown;
    }

    const index = await fetchJson(url);

    if (JSON.stringify(index).length > MAX_INDEX_BYTES) {
      throw new Error(`The ${what} at ${url} is larger than the limit`);
    }

    return index;
  }

  installed(directory: string): Promise<IInstalledWorkshop[]> {
    return listInstalled(this._contents, directory);
  }

  removeInstalled(path: string): Promise<void> {
    return removeInstalled(this._contents, path);
  }

  async checkpoint(
    workshop: string,
    name: string,
    variables: ICheckpointRecord['variables']
  ): Promise<void> {
    await createCheckpoint(this._contents, workshop, name, variables);
  }

  restoreCheckpoint(
    workshop: string,
    name: string
  ): Promise<ICheckpointRecord> {
    return restoreCheckpoint(this._contents, workshop, name);
  }

  async environmentStatus(): Promise<IEnvironmentStatus> {
    throw new Error(NO_ENVIRONMENTS);
  }

  async createEnvironment(
    request: IEnvironmentRequest
  ): Promise<IEnvironmentStatus> {
    throw new Error(NO_ENVIRONMENTS);
  }

  async removeEnvironment(): Promise<void> {
    throw new Error(NO_ENVIRONMENTS);
  }

  async runScript(request: IScriptRequest): Promise<IScriptResult> {
    throw new Error(
      `Verify scripts such as ${request.script} need the JupyterLab server; in JupyterLite use the kernel, shell, contents or ui substrate`
    );
  }

  preflight(tools: IToolRequest[]): Promise<IPreflightResult[]> {
    return litePreflight(this._app.commands, tools);
  }

  recordEvents(batch: IEventsBatch): Promise<void> {
    return recordEvents(this._contents, batch);
  }

  private get _contents(): Contents.IManager {
    return this._app.serviceManager.contents;
  }

  private _app: JupyterFrontEnd;
}

export namespace LiteBackend {
  export interface IOptions {
    app: JupyterFrontEnd;
  }
}

const NO_ENVIRONMENTS =
  'Isolated environments need the JupyterLab server; they are not available in JupyterLite';
