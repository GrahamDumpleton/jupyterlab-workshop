import { ServerConnection } from '@jupyterlab/services';

import { requestAPI } from './request';
import { ITrustStore, IWorkshopEvent, IWorkshopManager } from './tokens';

/** How long to gather events before posting a batch. */
const FLUSH_DELAY_MS = 2000;

/** Events that are posted straight away rather than batched. */
const IMMEDIATE: ReadonlySet<string> = new Set([
  'workshop-finish',
  'workshop-abandon'
]);

/** What one batch posts to the server. */
interface IEventsBatch {
  workshop: string;
  events: IWorkshopEvent[];
  sink: string;
  identity: 'none' | 'hub';
}

/**
 * Collects the manager's progress events and posts them to the server in
 * batches, which appends them to the workshop's events file and forwards
 * them to the sink the learner or an administrator chose.
 */
export class AnalyticsRecorder {
  constructor(options: AnalyticsRecorder.IOptions) {
    this._manager = options.manager;
    this._serverSettings = options.serverSettings;
    this._trustStore = options.trustStore;

    this._manager.events.connect(this._onEvent, this);
    window.addEventListener('pagehide', () => void this.flush());
  }

  /**
   * Post everything gathered so far.
   */
  async flush(): Promise<void> {
    if (this._timer !== null) {
      window.clearTimeout(this._timer);
      this._timer = null;
    }

    const batches = this._pending;

    this._pending = new Map();

    for (const batch of batches.values()) {
      try {
        await requestAPI('events', this._serverSettings, {
          method: 'POST',
          body: JSON.stringify(batch)
        });
      } catch (error) {
        console.warn('Unable to record workshop events', error);
      }
    }
  }

  private _onEvent(_: IWorkshopManager, event: IWorkshopEvent): void {
    // Each open workshop gets its own batch, since the file the events go
    // to belongs to the workshop that produced them.
    const batch = this._pending.get(event.workshop) ?? {
      workshop: event.workshop,
      events: [],
      sink: this._manager.analyticsSink,
      identity: this._trustStore.policy.analyticsIdentity
    };

    batch.events.push(event);
    this._pending.set(event.workshop, batch);

    if (IMMEDIATE.has(event.kind)) {
      void this.flush();
    } else if (this._timer === null) {
      this._timer = window.setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
    }
  }

  private _manager: IWorkshopManager;
  private _serverSettings: ServerConnection.ISettings;
  private _trustStore: ITrustStore;
  private _pending = new Map<string, IEventsBatch>();
  private _timer: number | null = null;
}

export namespace AnalyticsRecorder {
  export interface IOptions {
    manager: IWorkshopManager;
    serverSettings: ServerConnection.ISettings;
    trustStore: ITrustStore;
  }
}
