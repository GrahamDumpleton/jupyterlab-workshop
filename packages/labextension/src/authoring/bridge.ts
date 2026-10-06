import { JupyterFrontEnd } from '@jupyterlab/application';
import { Event, ServerConnection } from '@jupyterlab/services';
import { ReadonlyJSONObject, UUID } from '@lumino/coreutils';

import { requestAPI } from '../request';
import { CommandIDs, IWorkshopManager, errorMessage } from '../tokens';

/** Schema id of the bridge events the server emits. */
export const BRIDGE_SCHEMA_ID =
  'https://grahamdumpleton.github.io/jupyterlab-workshop/bridge/v1';

/**
 * The id of this browser tab, which a bridge request names as its target
 * to be run here and in no other tab. It lasts as long as the page.
 */
export const BRIDGE_CLIENT_ID: string = UUID.uuid4();

/**
 * Commands answered even when no workshop is open in author mode. A run's
 * progress is among them, since a run that passes closes the workshop and
 * its report is asked for afterwards.
 */
const ALWAYS: ReadonlySet<string> = new Set([
  CommandIDs.bridgeOpen,
  CommandIDs.bridgeStatus,
  CommandIDs.selfTestProgress
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
    const target = String(emission.target ?? '');

    if (!requestId) {
      return;
    }

    // A request aimed at a tab is that tab's alone. Otherwise other tabs
    // may answer too, and only a session editing a workshop acts on
    // requests that change it.
    if (target && target !== BRIDGE_CLIENT_ID) {
      return;
    }

    if (!this._manager.authoring && !ALWAYS.has(command)) {
      // A request aimed at this tab is answered, so the tool hears at once
      // what is missing rather than waiting out its timeout.
      if (target) {
        void this._answer({
          request_id: requestId,
          error:
            'This tab has no workshop open in author mode; open it with open_workshop first'
        });
      }

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

    await this._answer(body);
  }

  private async _answer(body: Record<string, unknown>): Promise<void> {
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
