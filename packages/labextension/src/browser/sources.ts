import {
  ILibrary,
  mergeSources,
  normalizeLocation
} from '@jupyterlab-workshop/core';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import { ISignal, Signal } from '@lumino/signaling';

import {
  readSettingList,
  readUserSettingList,
  writeSettingList
} from '../settings';
import { LibraryService } from '../library/service';
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

/** The key of a workshop library's registry each kind is kept under. */
const REGISTRY_KEY: Record<SourceKind, 'collections' | 'catalogs'> = {
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
   * defaults or an administrator's overrides, `library` for the
   * registry of the workshop library, `session` for a launch link,
   * which is kept in the workspace's saved state until it is subscribed
   * to or removed.
   */
  origin: 'user' | 'defaults' | 'library' | 'session';
}

/**
 * The collections and catalogs this JupyterLab is subscribed to: the
 * settings lists, plus any a launch link added for the session.
 * Subscribing and unsubscribing write the user's settings; a launch
 * link's source is subscribed to the same way.
 *
 * In a workshop library the registry takes the place of the user's
 * settings: once it has a list of a kind, that list replaces the
 * defaults, as a list in the user's settings does, and subscribing
 * writes the registry. The defaults and the session work as before.
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
    this._library = options.library ?? null;
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

    const registry = await this._registry();
    const own = registry?.[REGISTRY_KEY[kind]];

    if (own !== undefined) {
      return mergeSources(own, 'library', this._session[kind]);
    }

    const configured = await readSettingList(this._settings, SETTING[kind]);
    const user = await readUserSettingList(this._settings, SETTING[kind]);

    return mergeSources(
      configured,
      user !== null ? 'user' : 'defaults',
      this._session[kind]
    );
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
   * Subscribe to a source in the user's settings, or the library's
   * registry in a workshop library, keeping whatever is listed already.
   * A source the session added is promoted.
   */
  async subscribe(kind: SourceKind, url: string): Promise<void> {
    this._assertAllowed(kind);

    await this._changeConfigured(kind, current =>
      current.some(item => sameLocation(item, url)) ? null : [...current, url]
    );

    this._session[kind] = this._session[kind].filter(
      item => !sameLocation(item, url)
    );
    await this._save();
    this._changed.emit();
  }

  /**
   * Unsubscribe from a source: drop it from the session list, or from
   * the user's settings or the library's registry, where removing one
   * that the defaults supplied writes the shortened list as their own.
   */
  async unsubscribe(kind: SourceKind, url: string): Promise<void> {
    this._assertAllowed(kind);

    const before = this._session[kind].length;

    this._session[kind] = this._session[kind].filter(
      item => !sameLocation(item, url)
    );

    if (this._session[kind].length === before) {
      await this._changeConfigured(kind, current =>
        current.filter(item => !sameLocation(item, url))
      );
    } else {
      await this._save();
    }

    this._changed.emit();
  }

  /**
   * The list of a kind the user set in their own settings, or null when
   * the defaults or an administrator's overrides supply it. Making a
   * directory a library carries this over, and leaves the defaults to
   * keep applying.
   */
  async userList(kind: SourceKind): Promise<string[] | null> {
    return readUserSettingList(this._settings, SETTING[kind]);
  }

  /** Whether the settings allow changing sources of a kind. */
  canChange(kind: SourceKind): boolean {
    return (
      this._features.enabled(FEATURE[kind]) &&
      (this._settings !== null || this._library !== null)
    );
  }

  /**
   * Change the configured list of a kind: the library's registry when
   * the workshops directory is a library, else the user's settings. The
   * change starts from what is listed now, the defaults included, and
   * returns the new list, or null to leave it alone.
   */
  private async _changeConfigured(
    kind: SourceKind,
    change: (current: string[]) => string[] | null
  ): Promise<void> {
    const key = REGISTRY_KEY[kind];
    const configured = await readSettingList(this._settings, SETTING[kind]);

    if ((await this._registry()) !== null && this._library) {
      await this._library.update(library => {
        const next = change(library[key] ?? configured);

        return next === null ? library : { ...library, [key]: next };
      });

      return;
    }

    const next = change(configured);

    if (next !== null) {
      await writeSettingList(this._settings, SETTING[kind], next);
    }
  }

  // The library's registry, or null outside a library; a registry that
  // cannot be read is reported and treated as no library, so the browser
  // still lists what the settings say.
  private async _registry(): Promise<ILibrary | null> {
    if (!this._library) {
      return null;
    }

    try {
      return await this._library.read();
    } catch (error) {
      console.warn(error);

      return null;
    }
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
  private _library: LibraryService | null;
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

    /** The workshop library, whose registry holds the user's own lists. */
    library?: LibraryService | null;
  }
}

/**
 * Whether two locations name the same collection or catalog.
 */
export function sameLocation(a: string, b: string): boolean {
  return normalizeLocation(a) === normalizeLocation(b);
}
