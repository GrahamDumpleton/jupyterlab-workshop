import {
  IEventsBatch,
  ITrustStore,
  IWorkshopEvent,
  IWorkshopManager
} from './tokens';

/** How long to gather events before posting a batch. */
const FLUSH_DELAY_MS = 2000;

/** Events that are posted straight away rather than batched. */
const IMMEDIATE: ReadonlySet<string> = new Set([
  'workshop-finish',
  'workshop-abandon'
]);

/** How often a heartbeat is sent while the page is visible. */
const HEARTBEAT_VISIBLE_MS = 60 * 1000;

/** How often a heartbeat is sent while the page is hidden. */
const HEARTBEAT_HIDDEN_MS = 5 * 60 * 1000;

/**
 * Collects the manager's progress events and hands them to the backend
 * in batches, which appends them to the workshop's events file and
 * forwards them to the sink that applies: the administrator's, the
 * collection's or the workshop's, with its token.
 */
export class AnalyticsRecorder {
  constructor(options: AnalyticsRecorder.IOptions) {
    this._manager = options.manager;
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
        await this._manager.backend.recordEvents(batch);
      } catch (error) {
        console.warn('Unable to record workshop events', error);
      }
    }
  }

  private _onEvent(_: IWorkshopManager, event: IWorkshopEvent): void {
    // An author trying pages out is not a learner; nothing is recorded.
    if (this._manager.authoring) {
      return;
    }

    // Each open workshop gets its own batch, since the file the events go
    // to belongs to the workshop that produced them. The sink and token
    // are those of the block that applies when the batch starts.
    const block = this._manager.analytics;
    const batch = this._pending.get(event.workshop) ?? {
      workshop: event.workshop,
      events: [],
      sink: block?.sink ?? '',
      token: block?.token ?? '',
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
  private _trustStore: ITrustStore;
  private _pending = new Map<string, IEventsBatch>();
  private _timer: number | null = null;
}

export namespace AnalyticsRecorder {
  export interface IOptions {
    manager: IWorkshopManager;
    trustStore: ITrustStore;
  }
}

/**
 * Emits a `heartbeat` event while a workshop is open: every minute while
 * the page is visible, every five minutes while it is hidden, and once
 * at every change of visibility. Beating while hidden, with the flag
 * set, is what lets a sink tell a learner who switched windows from a
 * tab that was closed or a server that was culled, which just go quiet.
 */
export class HeartbeatTimer {
  constructor(options: HeartbeatTimer.IOptions) {
    this._manager = options.manager;

    this._manager.changed.connect(this._onChanged, this);
    document.addEventListener('visibilitychange', () => {
      if (this._manager.workshop) {
        this._beat();
        this._schedule();
      }
    });
  }

  private _onChanged(): void {
    const session = this._manager.sessionId;

    // A new session starts the clock again; no session stops it.
    if (session === this._session) {
      return;
    }

    this._session = session;

    if (session === '') {
      this._stop();
    } else {
      this._schedule();
    }
  }

  private _schedule(): void {
    this._stop();

    const delay = document.hidden ? HEARTBEAT_HIDDEN_MS : HEARTBEAT_VISIBLE_MS;

    this._timer = window.setTimeout(() => {
      this._timer = null;

      if (this._manager.workshop) {
        this._beat();
        this._schedule();
      }
    }, delay);
  }

  private _stop(): void {
    if (this._timer !== null) {
      window.clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _beat(): void {
    this._manager.track('heartbeat', {
      page: this._manager.currentPage?.id ?? '',
      hidden: document.hidden
    });
  }

  private _manager: IWorkshopManager;
  private _session = '';
  private _timer: number | null = null;
}

export namespace HeartbeatTimer {
  export interface IOptions {
    manager: IWorkshopManager;
  }
}
