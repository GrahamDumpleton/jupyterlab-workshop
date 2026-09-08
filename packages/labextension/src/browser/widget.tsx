import {
  ICatalog,
  ICollectionEntry,
  collectionTags,
  latestVersion,
  normalizeLocation,
  resolveLocation,
  searchCollection,
  supportsPlatform
} from '@jupyterlab-workshop/core';
import { Dialog, showDialog, showErrorMessage } from '@jupyterlab/apputils';
import {
  ReactWidget,
  UseSignal,
  caretDownIcon,
  caretRightIcon,
  ellipsesIcon,
  refreshIcon
} from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { ISignal, Signal } from '@lumino/signaling';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { workshopIcon } from '../icons';
import {
  CommandIDs,
  IFeaturePolicy,
  IInstalledWorkshop,
  IWorkshopManager,
  errorMessage
} from '../tokens';
import { describeSource } from '../trust/summary';
import { installAll, removeAll } from './bulk';
import { showCollectionsDialog } from './dialog';
import { SourceIcon } from './icon';
import { installEntry, isInstalledFrom } from './install';
import {
  ILoadedCollection,
  IMatchedCollection,
  ISequenceStep,
  collectionOf,
  loadCollection,
  sequenceStep,
  upNext
} from './match';
import {
  ISubscribedSource,
  SourceKind,
  SourceStore,
  sameLocation
} from './sources';

/** Id of the browser widget. */
export const BROWSER_ID = 'jupyterlab-workshop-browser';

/** Settings the browser reads each time it refreshes. */
export interface IBrowserSettings {
  workshopsDirectory: string;
}

/** A subscribed catalog that has been read, or failed to be. */
interface ILoadedCatalog extends ISubscribedSource {
  catalog?: ICatalog;
  error?: string;
}

/** Size of the icon beside a collection heading. */
const GROUP_ICON_SIZE = 48;

/** Prefix of the localStorage keys remembering collapsed groups. */
const COLLAPSED_KEY = 'jupyterlab-workshop:collapsed:';

/**
 * Main-area widget listing the workshops of the subscribed collections,
 * grouped by collection, and those already installed, with search, tag
 * filters and install, resume and remove buttons.
 */
export class WorkshopBrowser extends ReactWidget {
  constructor(options: WorkshopBrowser.IOptions) {
    super();

    this._options = options;
    this.id = BROWSER_ID;
    this.title.label = 'Workshops';
    this.title.icon = workshopIcon;
    this.title.closable = true;
    this.addClass('jp-WorkshopBrowser');

    // Once a workshop is opened, from here or anywhere else, it takes over
    // the main area and the browser gets out of the way. It stays open
    // while a workshop that was already open is browsed alongside.
    this._openPath = options.manager.workshop?.path ?? null;
    options.manager.changed.connect(this._onWorkshopChanged, this);
    options.features.changed.connect(this.update, this);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this._options.manager.changed.disconnect(this._onWorkshopChanged, this);
    this._options.features.changed.disconnect(this.update, this);
    super.dispose();
  }

  /** Emitted to ask the component to reload the sources and installs. */
  get refreshRequested(): ISignal<this, void> {
    return this._refreshRequested;
  }

  /**
   * Reload the collections, catalogs and the installed list.
   */
  refresh(): void {
    this._refreshRequested.emit();
  }

  protected render(): JSX.Element {
    return (
      <UseSignal signal={this._refreshRequested}>
        {() => (
          <BrowserContent
            {...this._options}
            refreshSignal={this._refreshRequested}
          />
        )}
      </UseSignal>
    );
  }

  private _onWorkshopChanged(): void {
    const path = this._options.manager.workshop?.path ?? null;

    if (path === this._openPath) {
      return;
    }

    this._openPath = path;

    if (path !== null && this.isAttached) {
      this.close();
    }
  }

  private _options: WorkshopBrowser.IOptions;
  private _refreshRequested = new Signal<this, void>(this);
  private _openPath: string | null;
}

export namespace WorkshopBrowser {
  export interface IOptions {
    manager: IWorkshopManager;
    commands: CommandRegistry;

    /** Which buttons and sections the settings leave enabled. */
    features: IFeaturePolicy;

    /** The subscribed collections and catalogs. */
    store: SourceStore;

    /** Current values of the settings the browser depends on. */
    readSettings: () => Promise<IBrowserSettings>;
  }
}

interface IContentProps extends WorkshopBrowser.IOptions {
  refreshSignal: ISignal<WorkshopBrowser, void>;
}

function BrowserContent(props: IContentProps): JSX.Element {
  const { manager, commands, features, store, readSettings, refreshSignal } =
    props;
  const [collections, setCollections] = useState<ILoadedCollection[]>([]);
  const [catalogs, setCatalogs] = useState<ILoadedCatalog[]>([]);
  const [installed, setInstalled] = useState<IInstalledWorkshop[]>([]);
  const [directory, setDirectory] = useState('workshops');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [platform, setPlatform] = useState(manager.platform?.os ?? '');

  // Reload when asked, when a workshop is opened or closed, when the
  // subscribed sources change, or at first.
  useEffect(() => {
    const bump = (): void => setVersion(value => value + 1);

    refreshSignal.connect(bump);
    manager.changed.connect(bump);
    store.changed.connect(bump);

    return () => {
      refreshSignal.disconnect(bump);
      manager.changed.disconnect(bump);
      store.changed.disconnect(bump);
    };
  }, [manager, refreshSignal, store]);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      setLoading(true);

      const settings = await readSettings();
      const [subscribedCollections, subscribedCatalogs] = await Promise.all([
        store.list('collection'),
        store.list('catalog')
      ]);
      const [loadedCollections, loadedCatalogs] = await Promise.all([
        Promise.all(
          subscribedCollections.map(item => loadCollection(manager, item))
        ),
        Promise.all(subscribedCatalogs.map(item => loadCatalog(manager, item)))
      ]);
      let list: IInstalledWorkshop[] = [];

      try {
        list = await manager.installed(settings.workshopsDirectory);
      } catch (error) {
        console.warn('Unable to list installed workshops', error);
      }

      // The manager learns the platform when a workshop opens; before
      // that the browser asks the backend itself, so cards for other
      // platforms are dimmed and Install all leaves them unticked.
      let os = manager.platform?.os ?? '';

      if (os === '') {
        try {
          os = (await manager.backend.platform()).os;
        } catch (error) {
          console.warn('Unable to read the platform', error);
        }
      }

      if (!cancelled) {
        setCollections(loadedCollections);
        setCatalogs(loadedCatalogs);
        setInstalled(orderInstalled(list, loadedCollections));
        setDirectory(settings.workshopsDirectory);
        setPlatform(os);
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [manager, readSettings, store, version]);

  // Each collection's entries that are not installed yet, after the
  // search and tag filters; an installed workshop is listed once, under
  // Installed, where its card offers an update.
  const groups = useMemo(
    () =>
      collections.map(collection => {
        const entries = collection.index?.workshops ?? [];
        const notInstalled = entries.filter(
          entry =>
            !installed.some(item =>
              isInstalledFrom(item, collection.url, entry.name)
            )
        );

        const removable = installed.filter(
          item =>
            item.collection !== null &&
            isInstalledFrom(item, collection.url, item.name)
        ).length;

        return {
          collection,
          notInstalled,
          removable,
          shown: searchCollection(notInstalled, query, tags),
          upNext: upNext(collection, installed, collections)
        };
      }),
    [collections, installed, query, tags]
  );
  const allTags = useMemo(
    () => collectionTags(groups.flatMap(group => group.notInstalled)),
    [groups]
  );
  const filtering = query.trim() !== '' || tags.length > 0;
  const anyNotInstalled = groups.some(group => group.notInstalled.length > 0);
  const anyProblem =
    collections.some(item => item.error) || catalogs.some(item => item.error);
  const canSubscribe =
    store.canChange('collection') || store.canChange('catalog');
  const nothingSubscribed =
    collections.length === 0 && catalogs.length === 0 && !loading;
  const suggestions = useMemo(
    () => suggestedCollections(catalogs, collections),
    [catalogs, collections]
  );

  // The Available section, with the search and tags that filter it, is
  // only there when it has something to show or explain: an image whose
  // collection lists exactly the workshops it ships has nothing to add.
  const showAvailable =
    features.enabled('available') &&
    (anyNotInstalled ||
      filtering ||
      anyProblem ||
      suggestions.length > 0 ||
      (nothingSubscribed && canSubscribe));
  const ways = [
    showAvailable ? 'install one below' : '',
    features.enabled('open-url') ? 'add one from a URL' : '',
    features.enabled('open-directory') ? 'open a directory' : ''
  ].filter(Boolean);
  const installHints =
    ways.length === 0
      ? ''
      : ` You can ${ways.join(', ').replace(/, ([^,]*)$/, ' or $1')}.`;

  const toggleTag = (tag: string): void =>
    setTags(current =>
      current.includes(tag)
        ? current.filter(item => item !== tag)
        : [...current, tag]
    );

  // Opening and installing take a moment (the trust dialog, a download,
  // reading the pages), so the pressed card shows it is busy until the
  // command finishes; the browser closes itself once a workshop opens.
  const [busy, setBusy] = useState<string | null>(null);

  const whileBusy = async (
    key: string,
    work: () => Promise<unknown>
  ): Promise<void> => {
    setBusy(key);

    try {
      await work();
    } finally {
      setBusy(current => (current === key ? null : current));
    }
  };

  // Installing downloads the workshop and lists it under Installed,
  // where Open starts it; the list is reloaded once the download ends.
  const install = (collection: string, entry: ICollectionEntry): void => {
    void whileBusy(
      `install:${normalizeLocation(collection)}:${entry.name}`,
      () =>
        installEntry(commands, collection, entry, installed, { open: false })
    ).then(() => setVersion(value => value + 1));
  };

  // Install all and Remove all work through the manager directly, one
  // workshop at a time; the list is reloaded once the whole run ends
  // rather than after each step.
  const installAllFor = (group: IGroup): void => {
    void whileBusy(
      `install-all:${normalizeLocation(group.collection.url)}`,
      () =>
        installAll({
          manager,
          collection: group.collection.url,
          title: group.collection.title,
          entries: group.collection.index?.workshops ?? [],
          installed,
          directory,
          platform
        })
    ).then(() => setVersion(value => value + 1));
  };

  const removeAllFor = (group: IGroup): void => {
    void whileBusy(
      `install-all:${normalizeLocation(group.collection.url)}`,
      () =>
        removeAll({
          manager,
          collection: group.collection.url,
          title: group.collection.title,
          installed
        })
    ).then(() => setVersion(value => value + 1));
  };

  const open = (path: string): void => {
    void whileBusy(`open:${path}`, () =>
      commands.execute(CommandIDs.open, { path })
    );
  };

  const restart = async (item: IInstalledWorkshop): Promise<void> => {
    await commands.execute(CommandIDs.restart, {
      path: item.path,
      title: item.title
    });
    setVersion(value => value + 1);
  };

  const collectionFor = (
    item: IInstalledWorkshop
  ): IMatchedCollection | undefined => collectionOf(item, collections);

  const updateFor = (
    item: IInstalledWorkshop
  ): { version: string; run: () => void } | undefined => {
    const found = collectionFor(item);
    const entry = found?.entry;
    const version = entry ? latestVersion(entry).version : '';

    if (!found || !entry || !version || version === item.version) {
      return undefined;
    }

    return { version, run: () => install(found.collection.url, entry) };
  };

  const remove = async (item: IInstalledWorkshop): Promise<void> => {
    const result = await showDialog({
      title: `Remove workshop "${item.title}"?`,
      body: `The directory ${item.path} and any progress recorded in it will be deleted.`,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Remove' })]
    });

    if (!result.button.accept) {
      return;
    }

    try {
      await manager.removeInstalled(item.path);
      setVersion(value => value + 1);
    } catch (error) {
      await showErrorMessage(
        'Unable to remove the workshop',
        errorMessage(error)
      );
    }
  };

  const manage = (tab: SourceKind): void => {
    void showCollectionsDialog({ manager, store, tab }).then(() =>
      setVersion(value => value + 1)
    );
  };

  const subscribeSuggested = async (url: string): Promise<void> => {
    try {
      await store.subscribe('collection', url);
    } catch (error) {
      await showErrorMessage(
        'Unable to subscribe to the collection',
        errorMessage(error)
      );
    }
  };

  return (
    <div className="jp-WorkshopBrowser-content">
      <div className="jp-WorkshopBrowser-toolbar">
        {showAvailable ? (
          <input
            type="search"
            className="jp-WorkshopBrowser-search"
            placeholder="Search workshops"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        ) : null}
        {features.enabled('open-url') ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            onClick={() => void commands.execute(CommandIDs.openUrl)}
          >
            Add from URL…
          </button>
        ) : null}
        {features.enabled('open-directory') ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            onClick={() => void commands.execute(CommandIDs.open)}
          >
            Open a directory…
          </button>
        ) : null}
        {canSubscribe ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            title="See, subscribe to and unsubscribe from collections and catalogs"
            onClick={() => manage('collection')}
          >
            Collections…
          </button>
        ) : null}
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-minimal jp-WorkshopBrowser-refresh"
          title="Refresh"
          onClick={() => setVersion(value => value + 1)}
        >
          <refreshIcon.react tag="span" width="16px" height="16px" />
        </button>
      </div>
      {showAvailable && allTags.length > 0 ? (
        <div className="jp-WorkshopBrowser-tags">
          {allTags.map(tag => (
            <button
              key={tag}
              type="button"
              className={`jp-WorkshopBrowser-tag${tags.includes(tag) ? ' jp-mod-selected' : ''}`}
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
      <h2 className="jp-WorkshopBrowser-heading">Installed</h2>
      {installed.length === 0 ? (
        <p className="jp-WorkshopBrowser-note">
          {loading
            ? 'Looking for installed workshops…'
            : `No workshops are installed under ${directory || 'the JupyterLab root'} yet.${installHints}`}
        </p>
      ) : (
        <div className="jp-WorkshopBrowser-cards">
          {installed.map(item => {
            const found = collectionFor(item);
            const next = found
              ? upNext(found.collection, installed, collections)
              : undefined;

            return (
              <InstalledCard
                key={item.path}
                item={item}
                collection={found?.collection}
                step={sequenceStep(found)}
                upNext={found?.entry !== undefined && next === found.entry}
                open={manager.workshop?.path === item.path}
                busy={busy === `open:${item.path}`}
                onOpen={() => open(item.path)}
                onRestart={() => void restart(item)}
                onRemove={
                  features.enabled('remove')
                    ? () => void remove(item)
                    : undefined
                }
                update={updateFor(item)}
              />
            );
          })}
        </div>
      )}
      {showAvailable ? (
        <AvailableSection
          groups={groups}
          catalogs={catalogs}
          suggestions={suggestions}
          filtering={filtering}
          nothingSubscribed={nothingSubscribed}
          canSubscribeCollections={store.canChange('collection')}
          canSubscribeCatalogs={store.canChange('catalog')}
          platform={platform}
          busy={busy}
          onInstall={install}
          onInstallAll={
            features.enabled('install-all') ? installAllFor : undefined
          }
          onRemoveAll={
            features.enabled('install-all') && features.enabled('remove')
              ? removeAllFor
              : undefined
          }
          onManage={manage}
          onSubscribe={url => void subscribeSuggested(url)}
        />
      ) : null}
    </div>
  );
}

/** A collection's entries after installs and filters are accounted for. */
interface IGroup {
  collection: ILoadedCollection;
  notInstalled: ICollectionEntry[];

  /** How many installed workshops record this collection as their source. */
  removable: number;
  shown: ICollectionEntry[];

  /** The first workshop not yet finished, when the collection is ordered. */
  upNext?: ICollectionEntry;
}

/** A collection a catalog offers that is not subscribed to yet. */
interface ISuggestion {
  url: string;
  title: string;
  description?: string;
  icon?: string;
  publisher?: string;
  catalog: string;
}

function AvailableSection({
  groups,
  catalogs,
  suggestions,
  filtering,
  nothingSubscribed,
  canSubscribeCollections,
  canSubscribeCatalogs,
  platform,
  busy,
  onInstall,
  onInstallAll,
  onRemoveAll,
  onManage,
  onSubscribe
}: {
  groups: IGroup[];
  catalogs: ILoadedCatalog[];
  suggestions: ISuggestion[];

  /** Whether the search or tags are in force. */
  filtering: boolean;

  /** Whether there is no collection or catalog subscription. */
  nothingSubscribed: boolean;
  canSubscribeCollections: boolean;
  canSubscribeCatalogs: boolean;
  platform: string;

  /** The busy key of the card being installed, if any. */
  busy: string | null;
  onInstall: (collection: string, entry: ICollectionEntry) => void;

  /** Install every workshop of a group, when the settings allow it. */
  onInstallAll?: (group: IGroup) => void;

  /** Remove every installed workshop of a group, when the settings allow it. */
  onRemoveAll?: (group: IGroup) => void;
  onManage: (tab: SourceKind) => void;
  onSubscribe: (url: string) => void;
}): JSX.Element {
  const anyShown = groups.some(group => group.shown.length > 0);
  const anyNotInstalled = groups.some(group => group.notInstalled.length > 0);

  return (
    <>
      <h2 className="jp-WorkshopBrowser-heading">Available</h2>
      {nothingSubscribed ? (
        <div className="jp-WorkshopBrowser-empty">
          <p className="jp-WorkshopBrowser-note">
            You are not subscribed to any collections or catalogs. A collection
            is a published list of workshops; a catalog lists collections.
            Subscribe to one by its URL to see what it offers.
          </p>
          <div className="jp-WorkshopBrowser-emptyActions">
            {canSubscribeCollections ? (
              <button
                type="button"
                className="jp-Button jp-mod-styled jp-mod-accept"
                onClick={() => onManage('collection')}
              >
                Subscribe to a collection…
              </button>
            ) : null}
            {canSubscribeCatalogs ? (
              <button
                type="button"
                className="jp-Button jp-mod-styled"
                onClick={() => onManage('catalog')}
              >
                Subscribe to a catalog…
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {catalogs.map(item =>
        item.error ? (
          <p key={item.url} className="jp-WorkshopBrowser-error">
            Unable to read the catalog {item.url}: {item.error}
          </p>
        ) : null
      )}
      {filtering && anyNotInstalled && !anyShown ? (
        <p className="jp-WorkshopBrowser-note">No workshops match.</p>
      ) : null}
      {groups.map(group =>
        !filtering || group.shown.length > 0 ? (
          <CollectionGroup
            key={group.collection.url}
            group={group}
            platform={platform}
            busy={busy}
            onInstall={entry => onInstall(group.collection.url, entry)}
            onInstallAll={onInstallAll ? () => onInstallAll(group) : undefined}
            onRemoveAll={onRemoveAll ? () => onRemoveAll(group) : undefined}
          />
        ) : null
      )}
      {suggestions.length > 0 && !filtering ? (
        <div className="jp-WorkshopBrowser-suggestions">
          <h3 className="jp-WorkshopBrowser-subheading">
            Collections you can subscribe to
          </h3>
          <p className="jp-WorkshopBrowser-note">
            The subscribed catalogs offer these collections. Subscribing to one
            lists its workshops here.
          </p>
          <div className="jp-WorkshopBrowser-cards">
            {suggestions.map(item => (
              <div
                key={item.url}
                className="jp-WorkshopBrowser-card jp-WorkshopBrowser-suggestion"
                data-collection={item.url}
              >
                <div className="jp-WorkshopBrowser-suggestionHead">
                  <SourceIcon
                    icon={item.icon}
                    title={item.title}
                    size={GROUP_ICON_SIZE}
                  />
                  <div>
                    <div className="jp-WorkshopBrowser-cardTitle">
                      {item.title}
                    </div>
                    {item.publisher ? (
                      <div className="jp-WorkshopBrowser-cardText">
                        by {item.publisher}
                      </div>
                    ) : null}
                  </div>
                </div>
                {item.description ? (
                  <p className="jp-WorkshopBrowser-cardText">
                    {item.description}
                  </p>
                ) : null}
                <div className="jp-WorkshopBrowser-cardMeta">
                  <span className="jp-WorkshopBrowser-chip" title={item.url}>
                    from {item.catalog}
                  </span>
                </div>
                <div className="jp-WorkshopBrowser-cardActions">
                  {canSubscribeCollections ? (
                    <button
                      type="button"
                      className="jp-Button jp-mod-styled jp-mod-accept"
                      onClick={() => onSubscribe(item.url)}
                    >
                      Subscribe
                    </button>
                  ) : (
                    <span className="jp-WorkshopBrowser-note">
                      Subscribing to collections is disabled here
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

function CollectionGroup({
  group,
  platform,
  busy,
  onInstall,
  onInstallAll,
  onRemoveAll
}: {
  group: IGroup;
  platform: string;
  busy: string | null;
  onInstall: (entry: ICollectionEntry) => void;
  onInstallAll?: () => void;
  onRemoveAll?: () => void;
}): JSX.Element {
  const { collection } = group;
  const [collapsed, setCollapsed] = useState(() =>
    readCollapsed(collection.url)
  );
  const toggle = (): void => {
    setCollapsed(current => {
      writeCollapsed(collection.url, !current);

      return !current;
    });
  };
  const index = collection.index;
  const icon = index?.icon
    ? resolveLocation(collection.url, index.icon)
    : undefined;
  const Caret = collapsed ? caretRightIcon : caretDownIcon;
  const count = group.notInstalled.length;

  // A bulk run holds the whole group: its cards' Install buttons wait
  // for it, so a single install cannot race the run for a directory.
  const groupBusy = busy === `install-all:${normalizeLocation(collection.url)}`;
  const canInstallAll =
    onInstallAll !== undefined && !collection.error && count > 1;
  const canRemoveAll =
    onRemoveAll !== undefined && !collection.error && group.removable > 0;

  return (
    <section
      className={`jp-WorkshopBrowser-group${collapsed ? ' jp-mod-collapsed' : ''}`}
      data-collection={collection.url}
    >
      <div className="jp-WorkshopBrowser-groupHeader">
        <button
          type="button"
          className="jp-WorkshopBrowser-groupToggle"
          aria-expanded={!collapsed}
          title={collapsed ? 'Show the workshops' : 'Hide the workshops'}
          onClick={toggle}
        >
          <Caret.react tag="span" width="16px" height="16px" />
        </button>
        <SourceIcon
          icon={icon}
          title={collection.title}
          size={GROUP_ICON_SIZE}
        />
        <div className="jp-WorkshopBrowser-groupText">
          <h3 className="jp-WorkshopBrowser-groupTitle">
            {index?.homepage ? (
              <a href={index.homepage} target="_blank" rel="noreferrer">
                {collection.title}
              </a>
            ) : (
              collection.title
            )}
            <span className="jp-WorkshopBrowser-groupCount">
              {count === 1 ? '1 workshop' : `${count} workshops`}
            </span>
          </h3>
          {index?.description ? (
            <p className="jp-WorkshopBrowser-groupDescription">
              {index.description}
            </p>
          ) : null}
          <div className="jp-WorkshopBrowser-groupMeta">
            {index?.publisher ? (
              <span className="jp-WorkshopBrowser-groupPublisher">
                by{' '}
                {index.publisher.url ? (
                  <a
                    href={index.publisher.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {index.publisher.name}
                  </a>
                ) : (
                  index.publisher.name
                )}
              </span>
            ) : null}
            <span
              className="jp-WorkshopBrowser-groupUrl"
              title={collection.url}
            >
              {collection.url}
            </span>
          </div>
          {collection.error ? (
            <p className="jp-WorkshopBrowser-error">
              Unable to read this collection: {collection.error}
            </p>
          ) : null}
        </div>
        {canInstallAll || canRemoveAll ? (
          <div className="jp-WorkshopBrowser-groupActions">
            {canInstallAll ? (
              <button
                type="button"
                className="jp-Button jp-mod-styled jp-mod-accept"
                title="Download every workshop of this collection that is not installed yet, after choosing which"
                disabled={groupBusy}
                onClick={onInstallAll}
              >
                {groupBusy ? 'Installing…' : 'Install all…'}
              </button>
            ) : null}
            {canRemoveAll ? (
              <GroupMenu
                items={[
                  {
                    label: `Remove all ${group.removable === 1 ? 'installed workshop' : `${group.removable} installed workshops`}…`,
                    warn: true,
                    disabled: groupBusy,
                    run: onRemoveAll ?? ((): void => undefined)
                  }
                ]}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {!collapsed && !collection.error && group.notInstalled.length === 0 ? (
        <p className="jp-WorkshopBrowser-note">
          Every workshop of this collection is installed.
        </p>
      ) : null}
      {!collapsed ? (
        <div className="jp-WorkshopBrowser-cards">
          {group.shown.map(entry => (
            <CollectionCard
              key={entry.name}
              entry={entry}
              collection={collection}
              step={sequenceStep({ collection, entry })}
              upNext={group.upNext === entry}
              platform={platform}
              busy={
                busy ===
                `install:${normalizeLocation(collection.url)}:${entry.name}`
              }
              disabled={groupBusy}
              onInstall={() => onInstall(entry)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** An item of a group's heading menu. */
interface IMenuItem {
  label: string;

  /** Whether the item does something destructive. */
  warn?: boolean;
  disabled?: boolean;
  run: () => void;
}

/**
 * The heading menu behind an ellipsis button, holding the actions that
 * should take a deliberate second step, such as Remove all. It closes
 * when an item runs, on Escape, or on a click anywhere else.
 */
function GroupMenu({ items }: { items: IMenuItem[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointer = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="jp-WorkshopBrowser-groupMenu" ref={root}>
      <button
        type="button"
        className="jp-Button jp-mod-styled jp-mod-minimal"
        title="More actions for this collection"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <ellipsesIcon.react tag="span" width="16px" height="16px" />
      </button>
      {open ? (
        <ul className="jp-WorkshopBrowser-groupMenuList" role="menu">
          {items.map(item => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                className={`jp-WorkshopBrowser-groupMenuItem${item.warn ? ' jp-mod-warn' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The chips a card carries when its collection is ordered: the step in
 * the sequence, and a mark on the one to take next.
 */
function SequenceChips({
  step,
  upNext
}: {
  step?: ISequenceStep;
  upNext: boolean;
}): JSX.Element | null {
  if (!step && !upNext) {
    return null;
  }

  return (
    <>
      {step ? (
        <span
          className="jp-WorkshopBrowser-chip jp-mod-step"
          title="Its place in the collection's sequence"
        >
          {step.step} of {step.total}
        </span>
      ) : null}
      {upNext ? (
        <span className="jp-WorkshopBrowser-chip jp-mod-next">Up next</span>
      ) : null}
    </>
  );
}

function CollectionCard({
  entry,
  collection,
  step,
  upNext,
  platform,
  busy,
  disabled,
  onInstall
}: {
  entry: ICollectionEntry;
  collection: ILoadedCollection;

  /** Its place in the sequence, when the collection is ordered. */
  step?: ISequenceStep;
  upNext: boolean;
  platform: string;

  /** Whether this workshop is being installed right now. */
  busy: boolean;

  /** Whether a bulk run on the collection holds the button. */
  disabled: boolean;
  onInstall: () => void;
}): JSX.Element {
  const version = latestVersion(entry);
  const supported = platform === '' || supportsPlatform(entry, platform);

  return (
    <div
      className={`jp-WorkshopBrowser-card${supported ? '' : ' jp-mod-unsupported'}`}
      data-workshop={entry.name}
      data-collection={collection.url}
    >
      <div className="jp-WorkshopBrowser-cardTitle">
        {entry.title}
        <span className="jp-WorkshopBrowser-cardVersion">
          {version.version}
        </span>
      </div>
      {entry.description ? (
        <p className="jp-WorkshopBrowser-cardText">{entry.description}</p>
      ) : null}
      <div className="jp-WorkshopBrowser-cardMeta">
        <SequenceChips step={step} upNext={upNext} />
        <span
          className="jp-WorkshopBrowser-chip jp-mod-source"
          title={collection.url}
        >
          {collection.title}
        </span>
        {entry.platforms.map(name => (
          <span
            key={name}
            className={`jp-WorkshopBrowser-chip jp-mod-platform${name === platform ? ' jp-mod-current' : ''}`}
          >
            {name}
          </span>
        ))}
        {entry.capabilities.map(name => (
          <span key={name} className="jp-WorkshopBrowser-chip">
            {name}
          </span>
        ))}
        {entry.duration ? (
          <span className="jp-WorkshopBrowser-chip jp-mod-duration">
            {entry.duration}
          </span>
        ) : null}
      </div>
      <div className="jp-WorkshopBrowser-cardActions">
        {!supported ? (
          <span className="jp-WorkshopBrowser-note">
            Not written for {platform}
          </span>
        ) : null}
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-accept"
          disabled={busy || disabled}
          onClick={onInstall}
        >
          {busy ? 'Installing…' : 'Install'}
        </button>
      </div>
    </div>
  );
}

function InstalledCard({
  item,
  collection,
  step,
  upNext,
  open,
  busy,
  onOpen,
  onRestart,
  onRemove,
  update
}: {
  item: IInstalledWorkshop;

  /** The subscribed collection it came from, when known. */
  collection?: ILoadedCollection;

  /** Its place in the sequence, when the collection is ordered. */
  step?: ISequenceStep;
  upNext: boolean;
  open: boolean;

  /** Whether this workshop is being opened right now. */
  busy: boolean;
  onOpen: () => void;

  /** Put the files back as first opened and forget the progress. */
  onRestart: () => void;

  /** Delete the workshop, when the settings allow removing. */
  onRemove?: () => void;

  /** The collection version to move to, when it differs from the installed one. */
  update?: { version: string; run: () => void };
}): JSX.Element {
  const progress =
    item.pages > 0 ? Math.round((item.done / item.pages) * 100) : 0;

  return (
    <div
      className={`jp-WorkshopBrowser-card${open ? ' jp-mod-open' : ''}`}
      data-workshop={item.name}
    >
      <div className="jp-WorkshopBrowser-cardTitle">
        {item.title}
        {item.version ? (
          <span className="jp-WorkshopBrowser-cardVersion">{item.version}</span>
        ) : null}
      </div>
      {item.description ? (
        <p className="jp-WorkshopBrowser-cardText">{item.description}</p>
      ) : null}
      <div className="jp-WorkshopBrowser-cardMeta">
        <SequenceChips step={step} upNext={upNext} />
        <span className="jp-WorkshopBrowser-chip">{item.path}</span>
        {item.source ? (
          <span
            className="jp-WorkshopBrowser-chip"
            title={describeSource(item.source)}
          >
            {item.source.kind}
          </span>
        ) : null}
        {collection ? (
          <span
            className="jp-WorkshopBrowser-chip jp-mod-source"
            title={collection.url}
          >
            {collection.title}
          </span>
        ) : item.collection ? (
          <span
            className="jp-WorkshopBrowser-chip jp-mod-source"
            title={item.collection}
          >
            collection not subscribed
          </span>
        ) : null}
        {item.started ? (
          <span className="jp-WorkshopBrowser-chip jp-mod-progress">
            {item.done} of {item.pages} pages done ({progress}%)
          </span>
        ) : (
          <span className="jp-WorkshopBrowser-chip">not started</span>
        )}
      </div>
      <div className="jp-WorkshopBrowser-cardActions">
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-accept"
          disabled={open || busy}
          title={open ? 'This workshop is open' : undefined}
          onClick={onOpen}
        >
          {busy ? 'Opening…' : item.started && !open ? 'Resume' : 'Open'}
        </button>
        {item.started ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            title="Put the files back as they were when first opened and forget the progress"
            onClick={onRestart}
          >
            Restart
          </button>
        ) : null}
        {update ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            title="Download this version from the collection, replacing the files"
            onClick={update.run}
          >
            Update to {update.version}
          </button>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled jp-mod-warn"
            onClick={onRemove}
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}

async function loadCatalog(
  manager: IWorkshopManager,
  item: ISubscribedSource
): Promise<ILoadedCatalog> {
  try {
    return { ...item, catalog: await manager.fetchCatalog(item.url) };
  } catch (error) {
    return { ...item, error: errorMessage(error) };
  }
}

/**
 * Installed workshops in collection order: those belonging to a
 * subscribed collection, by record or by a unique name match, by the
 * collection's position and then their position in its index, then the
 * rest by title.
 */
function orderInstalled(
  installed: IInstalledWorkshop[],
  collections: ILoadedCollection[]
): IInstalledWorkshop[] {
  const rank = (item: IInstalledWorkshop): [number, number] => {
    const found = collectionOf(item, collections);

    if (!found) {
      return [collections.length, 0];
    }

    const entries = found.collection.index?.workshops ?? [];
    const index = found.entry ? entries.indexOf(found.entry) : entries.length;

    return [collections.indexOf(found.collection), index];
  };

  return [...installed]
    .map((item, order) => ({ item, order, rank: rank(item) }))
    .sort(
      (a, b) =>
        a.rank[0] - b.rank[0] ||
        a.rank[1] - b.rank[1] ||
        a.item.title.toLowerCase().localeCompare(b.item.title.toLowerCase()) ||
        a.order - b.order
    )
    .map(({ item }) => item);
}

/**
 * The collections the subscribed catalogs offer that are not subscribed to,
 * each listed once, with the catalog's word on it.
 */
function suggestedCollections(
  catalogs: ILoadedCatalog[],
  collections: ILoadedCollection[]
): ISuggestion[] {
  const seen = new Set<string>();
  const suggestions: ISuggestion[] = [];

  for (const item of catalogs) {
    for (const entry of item.catalog?.collections ?? []) {
      const key = normalizeLocation(entry.url);

      if (
        seen.has(key) ||
        collections.some(collection => sameLocation(collection.url, entry.url))
      ) {
        continue;
      }

      seen.add(key);
      suggestions.push({
        url: entry.url,
        title: entry.title ?? entry.url,
        description: entry.description,
        icon: entry.icon,
        publisher: entry.publisher?.name,
        catalog: item.catalog?.title ?? item.url
      });
    }
  }

  return suggestions;
}

function readCollapsed(url: string): boolean {
  try {
    return (
      window.localStorage.getItem(COLLAPSED_KEY + normalizeLocation(url)) ===
      '1'
    );
  } catch {
    return false;
  }
}

function writeCollapsed(url: string, collapsed: boolean): void {
  try {
    const key = COLLAPSED_KEY + normalizeLocation(url);

    if (collapsed) {
      window.localStorage.setItem(key, '1');
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable; the state then lasts the session.
  }
}
