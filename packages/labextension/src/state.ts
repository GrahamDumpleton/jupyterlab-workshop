import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';
import { Debouncer } from '@lumino/polling';

import { ensureDirectory, readIfExists } from './actions/contents';
import {
  IActionLogEntry,
  IActionStatus,
  IPageProgress,
  VariableSource
} from './tokens';

/**
 * Directory inside the workshop holding generated files. It is not a dot
 * directory because Jupyter Server hides those from the contents API
 * unless configured otherwise.
 */
export const WORKSHOP_STATE_DIR = '_workshop';

const STATE_FILE = 'state.json';

const LOG_LIMIT = 200;

/** Persisted learner progress for a workshop. */
export interface IWorkshopState {
  version: 1;
  workshop: { name: string; version: string };
  currentPage: string;
  pages: Record<string, IPageProgress>;
  actions: Record<string, IActionStatus>;
  variables: Record<string, { value: string; source: VariableSource }>;
  log: IActionLogEntry[];
}

/**
 * Create an empty state for a workshop.
 */
export function emptyState(name: string, version: string): IWorkshopState {
  return {
    version: 1,
    workshop: { name, version },
    currentPage: '',
    pages: {},
    actions: {},
    variables: {},
    log: []
  };
}

/**
 * Reads and writes `_workshop/state.json` inside a workshop directory.
 *
 * Writes are debounced so that rapid changes, such as a cascade of
 * actions, produce one save.
 */
export class StateStore {
  constructor(contents: Contents.IManager) {
    this._contents = contents;
    this._debouncer = new Debouncer(() => this._flush(), 500);
  }

  /** The state being tracked, or null when no workshop is open. */
  get state(): IWorkshopState | null {
    return this._state;
  }

  /**
   * Load the state file of a workshop, falling back to an empty state.
   */
  async load(
    workshopPath: string,
    name: string,
    version: string
  ): Promise<IWorkshopState> {
    await this._debouncer.stop();

    this._path = PathExt.join(workshopPath, WORKSHOP_STATE_DIR, STATE_FILE);
    this._state = emptyState(name, version);

    const content = await readIfExists(this._contents, this._path);

    if (content !== null) {
      try {
        const parsed = JSON.parse(content) as Partial<IWorkshopState>;

        if (parsed.version === 1 && parsed.workshop?.name === name) {
          this._state = {
            ...this._state,
            ...parsed,
            workshop: { name, version }
          };
        }
      } catch (error) {
        console.warn(`Ignoring unreadable ${this._path}`, error);
      }
    }

    return this._state;
  }

  /**
   * Forget the current workshop without writing.
   */
  async unload(): Promise<void> {
    await this._debouncer.stop();

    this._state = null;
    this._path = '';
  }

  /**
   * Append a log entry, keeping the log bounded.
   */
  appendLog(entry: IActionLogEntry): void {
    if (!this._state) {
      return;
    }

    this._state.log.push(entry);

    if (this._state.log.length > LOG_LIMIT) {
      this._state.log.splice(0, this._state.log.length - LOG_LIMIT);
    }
  }

  /**
   * Schedule a save of the current state.
   */
  save(): void {
    if (this._state) {
      void this._debouncer.invoke();
    }
  }

  /**
   * Write immediately, for example before closing.
   */
  async flush(): Promise<void> {
    await this._debouncer.stop();
    await this._flush();
  }

  private async _flush(): Promise<void> {
    if (!this._state || !this._path) {
      return;
    }

    try {
      await ensureDirectory(this._contents, PathExt.dirname(this._path));
      await this._contents.save(this._path, {
        type: 'file',
        format: 'text',
        content: JSON.stringify(this._state, null, 2)
      });
    } catch (error) {
      console.warn(`Unable to save ${this._path}`, error);
    }
  }

  private _contents: Contents.IManager;
  private _debouncer: Debouncer;
  private _state: IWorkshopState | null = null;
  private _path = '';
}
