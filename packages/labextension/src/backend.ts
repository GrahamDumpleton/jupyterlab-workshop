import { ServerConnection } from '@jupyterlab/services';

import { requestAPI } from './request';
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
} from './tokens';

/**
 * The backend that talks to the `educates_jupyterlab_workshop` server
 * extension over its REST endpoints.
 */
export class ServerBackend implements IWorkshopBackend {
  constructor(serverSettings: ServerConnection.ISettings) {
    this._settings = serverSettings;
  }

  readonly kind = 'server';

  platform(): Promise<IPlatformInfo> {
    return requestAPI<IPlatformInfo>('platform', this._settings);
  }

  fetch(request: IFetchRequest): Promise<IFetchResult> {
    const body = {
      source: request.archive
        ? { archive: request.url, sha256: request.sha256 ?? '' }
        : {
            url: request.url,
            ref: request.ref ?? '',
            subdir: request.subdir ?? '',
            sha256: request.sha256 ?? ''
          },
      directory: request.directory,
      overwrite: request.overwrite ?? false
    };

    return requestAPI<IFetchResult>('fetch', this._settings, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async fetchRegistry(url: string): Promise<unknown> {
    const response = await requestAPI<{ url: string; index: unknown }>(
      `registry?url=${encodeURIComponent(url)}`,
      this._settings
    );

    return response.index;
  }

  async installed(directory: string): Promise<IInstalledWorkshop[]> {
    const response = await requestAPI<{ workshops: IInstalledWorkshop[] }>(
      `workshops?directory=${encodeURIComponent(directory)}`,
      this._settings
    );

    return response.workshops;
  }

  async removeInstalled(path: string): Promise<void> {
    await requestAPI<{ removed: string }>(
      `workshops?path=${encodeURIComponent(path)}`,
      this._settings,
      { method: 'DELETE' }
    );
  }

  async checkpoint(
    workshop: string,
    name: string,
    variables: ICheckpointRecord['variables']
  ): Promise<void> {
    await requestAPI('checkpoints', this._settings, {
      method: 'POST',
      body: JSON.stringify({ workshop, name, variables })
    });
  }

  async restoreCheckpoint(
    workshop: string,
    name: string
  ): Promise<ICheckpointRecord> {
    const record = await requestAPI<Partial<ICheckpointRecord>>(
      'checkpoints',
      this._settings,
      {
        method: 'POST',
        body: JSON.stringify({ workshop, name, action: 'restore' })
      }
    );

    return {
      name: record.name ?? name,
      createdAt: record.createdAt ?? '',
      variables: record.variables ?? {}
    };
  }

  environmentStatus(
    workshop: string,
    kernel: string
  ): Promise<IEnvironmentStatus> {
    return requestAPI<IEnvironmentStatus>(
      `environment?workshop=${encodeURIComponent(workshop)}&kernel=${encodeURIComponent(kernel)}`,
      this._settings
    );
  }

  createEnvironment(request: IEnvironmentRequest): Promise<IEnvironmentStatus> {
    return requestAPI<IEnvironmentStatus>('environment', this._settings, {
      method: 'POST',
      body: JSON.stringify({ ...request, action: 'create' })
    });
  }

  async removeEnvironment(workshop: string, kernel: string): Promise<void> {
    await requestAPI('environment', this._settings, {
      method: 'POST',
      body: JSON.stringify({ workshop, action: 'remove', kernel })
    });
  }

  runScript(request: IScriptRequest): Promise<IScriptResult> {
    return requestAPI<IScriptResult>('verify', this._settings, {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async preflight(
    tools: IToolRequest[],
    versions: boolean
  ): Promise<IPreflightResult[]> {
    const response = await requestAPI<{ tools: IPreflightResult[] }>(
      'preflight',
      this._settings,
      {
        method: 'POST',
        body: JSON.stringify({ tools, versions })
      }
    );

    return response.tools;
  }

  async recordEvents(batch: IEventsBatch): Promise<void> {
    await requestAPI('events', this._settings, {
      method: 'POST',
      body: JSON.stringify(batch)
    });
  }

  private _settings: ServerConnection.ISettings;
}
