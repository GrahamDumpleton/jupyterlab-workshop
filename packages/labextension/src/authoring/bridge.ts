import { JupyterFrontEnd } from '@jupyterlab/application';
import { Event, ServerConnection } from '@jupyterlab/services';
import { ReadonlyJSONObject } from '@lumino/coreutils';

import { requestAPI } from '../request';
import { CommandIDs, IWorkshopManager, errorMessage } from '../tokens';

/** Schema id of the bridge events the server emits. */
export const BRIDGE_SCHEMA_ID =
  'https://grahamdumpleton.github.io/jupyterlab-workshop/bridge/v1';

/** Commands answered even when no workshop is open in author mode. */
const ALWAYS: ReadonlySet<string> = new Set([
  CommandIDs.bridgeOpen,
  CommandIDs.bridgeStatus
]);

/**
 * Answers requests that tools outside the browser make through the
 * server: each arrives as a Jupyter Server event naming a workshop
 * command, which is run here and its result posted back.
 */
export class BridgeListener {
  constructor(options: BridgeListener.IOptions) {
    this._app = options.app;
    this._manager = options.manager;
    this._serverSettings = options.serverSettings;

    this._app.serviceManager.events.stream.connect(this._onEvent, this);
  }

  /**
   * Stop answering requests.
   */
  dispose(): void {
    this._app.serviceManager.events.stream.disconnect(this._onEvent, this);
  }

  private _onEvent(_: Event.IManager, emission: Event.Emission): void {
    if (emission.schema_id !== BRIDGE_SCHEMA_ID) {
      return;
    }

    const requestId = String(emission.request_id ?? '');
    const command = String(emission.command ?? '');
    const args = isObject(emission.args) ? emission.args : {};

    // Other tabs may answer too; only a session editing a workshop acts on
    // requests that change it.
    if (!requestId || (!this._manager.authoring && !ALWAYS.has(command))) {
      return;
    }

    void this._run(requestId, command, args);
  }

  private async _run(
    requestId: string,
    command: string,
    args: ReadonlyJSONObject
  ): Promise<void> {
    let body: Record<string, unknown>;

    try {
      if (!this._app.commands.hasCommand(command)) {
        throw new Error(`Unknown command "${command}"`);
      }

      const result = await this._app.commands.execute(command, args);

      body = { request_id: requestId, result: result ?? null };
    } catch (error) {
      body = { request_id: requestId, error: errorMessage(error) };
    }

    try {
      await requestAPI('bridge/result', this._serverSettings, {
        method: 'POST',
        body: JSON.stringify(body)
      });
    } catch (error) {
      console.warn('Unable to answer a workshop bridge request', error);
    }
  }

  private _app: JupyterFrontEnd;
  private _manager: IWorkshopManager;
  private _serverSettings: ServerConnection.ISettings;
}

export namespace BridgeListener {
  export interface IOptions {
    app: JupyterFrontEnd;
    manager: IWorkshopManager;
    serverSettings: ServerConnection.ISettings;
  }
}

function isObject(value: unknown): value is ReadonlyJSONObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
