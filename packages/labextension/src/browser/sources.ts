import { normalizeLocation } from '@jupyterlab-workshop/core';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ISignal, Signal } from '@lumino/signaling';

import {
  readSettingList,
  readUserSettingList,
  writeSettingList
} from '../settings';
import { IFeaturePolicy } from '../tokens';

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
   * link, which lasts until the page is reloaded unless subscribed to.
   */
  origin: 'user' | 'defaults' | 'session';
}

/**
 * The collections and catalogs this JupyterLab is subscribed to: the
 * settings lists, plus any a launch link added for the session.
 * Subscribing and unsubscribing write the user's settings; a launch
 * link's source is subscribed to the same way.
 */
export class SourceStore {
  constructor(options: SourceStore.IOptions) {
    this._settings = options.settingRegistry;
    this._features = options.features;
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
   * Add a source for this session only, as a launch link does. Nothing
   * happens when the feature is disabled or it is listed already.
   */
  async addForSession(kind: SourceKind, url: string): Promise<boolean> {
    if (!this._features.enabled(FEATURE[kind])) {
      return false;
    }

    const listed = await this.list(kind);

    if (listed.some(item => sameLocation(item.url, url))) {
      return false;
    }

    this._session[kind].push(url);
    this._changed.emit();

    return true;
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

  private _settings: ISettingRegistry | null;
  private _features: IFeaturePolicy;
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
  }
}

/**
 * Whether two locations name the same collection or catalog.
 */
export function sameLocation(a: string, b: string): boolean {
  return normalizeLocation(a) === normalizeLocation(b);
}
