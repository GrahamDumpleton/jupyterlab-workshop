import { normalizeLocation } from '@jupyterlab-workshop/core';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import { ISignal, Signal } from '@lumino/signaling';

import {
  readSettingList,
  readUserSettingList,
  writeSettingList
} from '../settings';
import { fetchForServer, saveForServer } from '../statedb';
import { IFeaturePolicy } from '../tokens';

/** The state database key the session's sources are kept under. */
const SESSION_KEY = 'jupyterlab-workshop:sources';

/** The two kinds of source a learner subscribes to: lists of workshops, and lists of those. */
export type SourceKind = 'collection' | 'catalog';

/** The setting each kind is stored in. */
const SETTING: Record<SourceKind, string> = {
  collection: 'collections',
  catalog: 'catalogs'
};

/** The feature that must be enabled to change each kind. */
const FEATURE: Record<SourceKind, 'collections' | 'catalogs'> = {
  collection: 'collections',
  catalog: 'catalogs'
};

/** A collection or catalog location and where its subscription came from. */
export interface ISubscribedSource {
  url: string;

  /**
   * `user` for the learner's own settings, `defaults` for the shipped
   * defaults or an administrator's overrides, `session` for a launch
   * link, which is kept in the workspace's saved state until it is
   * subscribed to or removed.
   */
  origin: 'user' | 'defaults' | 'session';
}

/**
 * The collections and catalogs this JupyterLab is subscribed to: the
 * settings lists, plus any a launch link added for the session.
 * Subscribing and unsubscribing write the user's settings; a launch
 * link's source is subscribed to the same way.
 *
 * The session's sources are saved in the state database, when there is
 * one, so a reload of the page keeps the ordering a link gave the
 * browser: the link's parameters are taken out of the address once
 * handled, so nothing else would bring them back.
 */
export class SourceStore {
  constructor(options: SourceStore.IOptions) {
    this._settings = options.settingRegistry;
    this._features = options.features;
    this._stateDB = options.stateDB ?? null;
  }

  /** Emitted when a source is added for the session, subscribed to or unsubscribed from. */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /**
   * Every subscribed source of a kind, settings first and then the
   * session's, without duplicates.
   */
  async list(kind: SourceKind): Promise<ISubscribedSource[]> {
    await this._restore();

    const configured = await readSettingList(this._settings, SETTING[kind]);
    const user = await readUserSettingList(this._settings, SETTING[kind]);
    const seen = new Set<string>();
    const sources: ISubscribedSource[] = [];
    const add = (url: string, origin: ISubscribedSource['origin']): void => {
      const key = normalizeLocation(url);

      if (key === '' || seen.has(key)) {
        return;
      }

      seen.add(key);
      sources.push({ url, origin });
    };

    for (const url of configured) {
      add(url, user !== null ? 'user' : 'defaults');
    }

    for (const url of this._session[kind]) {
      add(url, 'session');
    }

    return sources;
  }

  /**
   * Add sources for this session, as a launch link does, in the order
   * given and after those already listed. Nothing happens when the
   * feature is disabled, and a source listed already is left where it
   * is. Returns the sources added; one change is emitted for them all.
   */
  async addForSession(
    kind: SourceKind,
    urls: string | string[]
  ): Promise<string[]> {
    const wanted = typeof urls === 'string' ? [urls] : urls;

    if (!this._features.enabled(FEATURE[kind]) || wanted.length === 0) {
      return [];
    }

    const listed = (await this.list(kind)).map(item => item.url);
    const added: string[] = [];

    for (const url of wanted) {
      if ([...listed, ...added].some(item => sameLocation(item, url))) {
        continue;
      }

      added.push(url);
    }

    if (added.length === 0) {
      return [];
    }

    this._session[kind].push(...added);
    await this._save();
    this._changed.emit();

    return added;
  }

  /**
   * Subscribe to a source in the user's settings, keeping whatever the
   * settings already list. A source the session added is promoted.
   */
  async subscribe(kind: SourceKind, url: string): Promise<void> {
    this._assertAllowed(kind);

    const current = await readSettingList(this._settings, SETTING[kind]);

    if (!current.some(item => sameLocation(item, url))) {
      await writeSettingList(this._settings, SETTING[kind], [...current, url]);
    }

    this._session[kind] = this._session[kind].filter(
      item => !sameLocation(item, url)
    );
    await this._save();
    this._changed.emit();
  }

  /**
   * Unsubscribe from a source: drop it from the session list, or from
   * the user's settings, where removing one that the defaults supplied
   * writes the shortened list as the user's own.
   */
  async unsubscribe(kind: SourceKind, url: string): Promise<void> {
    this._assertAllowed(kind);

    const before = this._session[kind].length;

    this._session[kind] = this._session[kind].filter(
      item => !sameLocation(item, url)
    );

    if (this._session[kind].length === before) {
      const current = await readSettingList(this._settings, SETTING[kind]);

      await writeSettingList(
        this._settings,
        SETTING[kind],
        current.filter(item => !sameLocation(item, url))
      );
    } else {
      await this._save();
    }

    this._changed.emit();
  }

  /** Whether the settings allow changing sources of a kind. */
  canChange(kind: SourceKind): boolean {
    return this._features.enabled(FEATURE[kind]) && this._settings !== null;
  }

  private _assertAllowed(kind: SourceKind): void {
    if (!this.canChange(kind)) {
      throw new Error(`Changing ${SETTING[kind]} is disabled here`);
    }
  }

  // The saved session sources are read once, before the first listing,
  // so a page reload starts where the last one left off.
  private _restore(): Promise<void> {
    if (!this._restored) {
      this._restored = (async (): Promise<void> => {
        if (!this._stateDB) {
          return;
        }

        try {
          const stored = await fetchForServer(this._stateDB, SESSION_KEY);

          for (const kind of ['collection', 'catalog'] as SourceKind[]) {
            const urls = (stored as Partial<Record<SourceKind, unknown>>)?.[
              kind
            ];

            if (Array.isArray(urls)) {
              this._session[kind] = urls.filter(
                (item): item is string => typeof item === 'string'
              );
            }
          }
        } catch (error) {
          console.warn('Unable to restore the session sources', error);
        }
      })();
    }

    return this._restored;
  }

  private async _save(): Promise<void> {
    if (!this._stateDB) {
      return;
    }

    try {
      await saveForServer(this._stateDB, SESSION_KEY, {
        collection: [...this._session.collection],
        catalog: [...this._session.catalog]
      });
    } catch (error) {
      console.warn('Unable to save the session sources', error);
    }
  }

  private _settings: ISettingRegistry | null;
  private _features: IFeaturePolicy;
  private _stateDB: IStateDB | null;
  private _restored: Promise<void> | null = null;
  private _session: Record<SourceKind, string[]> = {
    collection: [],
    catalog: []
  };
  private _changed = new Signal<this, void>(this);
}

export namespace SourceStore {
  export interface IOptions {
    settingRegistry: ISettingRegistry | null;
    features: IFeaturePolicy;

    /** Where the session's sources are kept across reloads, when given. */
    stateDB?: IStateDB | null;
  }
}

/**
 * Whether two locations name the same collection or catalog.
 */
export function sameLocation(a: string, b: string): boolean {
  return normalizeLocation(a) === normalizeLocation(b);
}
