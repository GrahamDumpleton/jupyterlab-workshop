import {
  ICatalog,
  ICollectionInfo,
  resolveLocation
} from '@jupyterlab-workshop/core';
import { Dialog } from '@jupyterlab/apputils';
import { ReactWidget } from '@jupyterlab/ui-components';
import React, { useCallback, useEffect, useState } from 'react';

import { IWorkshopManager, errorMessage } from '../tokens';
import { SourceIcon } from './icon';
import {
  ISubscribedSource,
  SourceKind,
  SourceStore,
  sameLocation
} from './sources';

/** Options for the Collections dialog. */
export interface ICollectionsDialogOptions {
  manager: IWorkshopManager;
  store: SourceStore;

  /** The tab to open on. */
  tab?: SourceKind;
}

/**
 * Show the dialog that manages collection and catalog subscriptions:
 * what is subscribed to and where from, subscribing by URL, subscribing
 * to a collection a catalog offers, and unsubscribing.
 */
export async function showCollectionsDialog(
  options: ICollectionsDialogOptions
): Promise<void> {
  const body = ReactWidget.create(
    <CollectionsDialog {...options} tab={options.tab ?? 'collection'} />
  );

  body.addClass('jp-WorkshopSources');

  const dialog = new Dialog({
    title: 'Collections and catalogs',
    body,
    buttons: [Dialog.okButton({ label: 'Close' })],
    hasClose: true
  });

  dialog.addClass('jp-WorkshopSourcesDialog');

  await dialog.launch();
}

/** A subscribed source with what its file says about itself, once read. */
interface ILoadedSource extends ISubscribedSource {
  kind: SourceKind;
  info?: ICollectionInfo;
  catalog?: ICatalog;
  error?: string;
  loading: boolean;
}

function CollectionsDialog(
  props: ICollectionsDialogOptions & { tab: SourceKind }
): JSX.Element {
  const { manager, store } = props;
  const [tab, setTab] = useState<SourceKind>(props.tab);
  const [collections, setCollections] = useState<ILoadedSource[]>([]);
  const [catalogs, setCatalogs] = useState<ILoadedSource[]>([]);
  const [version, setVersion] = useState(0);
  const [problem, setProblem] = useState('');

  const refresh = useCallback((): void => setVersion(value => value + 1), []);

  // The subscribed lists are read, shown at once by URL, then filled in
  // as each file is read; a file that cannot be read shows its error.
  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const [subscribedCollections, subscribedCatalogs] = await Promise.all([
        store.list('collection'),
        store.list('catalog')
      ]);
      const pending = (
        items: ISubscribedSource[],
        kind: SourceKind
      ): ILoadedSource[] =>
        items.map(item => ({ ...item, kind, loading: true }));

      if (cancelled) {
        return;
      }

      setCollections(pending(subscribedCollections, 'collection'));
      setCatalogs(pending(subscribedCatalogs, 'catalog'));

      await Promise.all([
        ...subscribedCollections.map(async item => {
          const update: Partial<ILoadedSource> = { loading: false };

          try {
            update.info = await manager.fetchCollection(item.url);
          } catch (error) {
            update.error = errorMessage(error);
          }

          if (!cancelled) {
            setCollections(current => patch(current, item.url, update));
          }
        }),
        ...subscribedCatalogs.map(async item => {
          const update: Partial<ILoadedSource> = { loading: false };

          try {
            update.catalog = await manager.fetchCatalog(item.url);
          } catch (error) {
            update.error = errorMessage(error);
          }

          if (!cancelled) {
            setCatalogs(current => patch(current, item.url, update));
          }
        })
      ]);
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [manager, store, version]);

  const run = async (work: () => Promise<void>): Promise<void> => {
    setProblem('');

    try {
      await work();
    } catch (error) {
      setProblem(errorMessage(error));
    }

    refresh();
  };

  const subscribe = (kind: SourceKind, url: string): Promise<void> =>
    run(() => store.subscribe(kind, url));
  const unsubscribe = (kind: SourceKind, url: string): Promise<void> =>
    run(() => store.unsubscribe(kind, url));
  const canChange = store.canChange(tab);
  const shown = tab === 'collection' ? collections : catalogs;
  const subscribedUrls = collections.map(item => item.url);

  return (
    <div className="jp-WorkshopSources-content">
      <div className="jp-WorkshopSources-tabs" role="tablist">
        {(['collection', 'catalog'] as const).map(kind => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={tab === kind}
            className={`jp-WorkshopSources-tab${tab === kind ? ' jp-mod-selected' : ''}`}
            onClick={() => setTab(kind)}
          >
            {kind === 'collection' ? 'Collections' : 'Catalogs'}
          </button>
        ))}
      </div>
      <p className="jp-WorkshopSources-lead">
        {tab === 'collection'
          ? 'A collection is a published list of workshops. The browser offers the workshops of every collection you subscribe to.'
          : 'A catalog is a published list of collections. Subscribe to one to pick collections from it.'}
      </p>
      {shown.length === 0 ? (
        <p className="jp-WorkshopBrowser-note">
          {tab === 'collection'
            ? 'You are not subscribed to any collections.'
            : 'You are not subscribed to any catalogs.'}
        </p>
      ) : (
        <ul className="jp-WorkshopSources-list">
          {shown.map(item => (
            <SourceRow
              key={item.url}
              item={item}
              canChange={canChange}
              onUnsubscribe={() => void unsubscribe(item.kind, item.url)}
              onSubscribe={() => void subscribe(item.kind, item.url)}
            />
          ))}
        </ul>
      )}
      {canChange ? (
        <SubscribeByUrl
          kind={tab}
          onSubscribe={url => void subscribe(tab, url)}
          subscribed={shown.map(item => item.url)}
        />
      ) : (
        <p className="jp-WorkshopBrowser-note">
          {tab === 'collection'
            ? 'Changing collection subscriptions is disabled here.'
            : 'Changing catalog subscriptions is disabled here.'}
        </p>
      )}
      {tab === 'collection' && catalogs.length > 0 ? (
        <FromCatalogs
          catalogs={catalogs}
          subscribed={subscribedUrls}
          canChange={canChange}
          onSubscribe={url => void subscribe('collection', url)}
        />
      ) : null}
      {problem ? <p className="jp-WorkshopBrowser-error">{problem}</p> : null}
    </div>
  );
}

function SourceRow({
  item,
  canChange,
  onUnsubscribe,
  onSubscribe
}: {
  item: ILoadedSource;
  canChange: boolean;
  onUnsubscribe: () => void;
  onSubscribe: () => void;
}): JSX.Element {
  const info: ICollectionInfo | ICatalog | undefined =
    item.info ?? item.catalog;
  const title = info?.title || item.url;

  // A collection's icon is relative to its index; a catalog's was
  // resolved when the catalog was read.
  const icon =
    info?.icon && item.kind === 'collection'
      ? resolveLocation(item.url, info.icon)
      : info?.icon;
  const origin =
    item.origin === 'session'
      ? 'this session'
      : item.origin === 'user'
        ? 'your settings'
        : 'the defaults';

  return (
    <li className="jp-WorkshopSources-row" data-url={item.url}>
      <SourceIcon icon={icon} title={title} size={64} />
      <div className="jp-WorkshopSources-text">
        <div className="jp-WorkshopSources-title">
          {info?.homepage ? (
            <a
              className="jp-WorkshopSources-link"
              href={info.homepage}
              target="_blank"
              rel="noreferrer"
            >
              {title}
            </a>
          ) : (
            title
          )}
          {info?.publisher ? (
            <span className="jp-WorkshopSources-publisher">
              {' '}
              by{' '}
              {info.publisher.url ? (
                <a
                  className="jp-WorkshopSources-link"
                  href={info.publisher.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {info.publisher.name}
                </a>
              ) : (
                info.publisher.name
              )}
            </span>
          ) : null}
        </div>
        {info?.description ? (
          <p className="jp-WorkshopSources-description">{info.description}</p>
        ) : null}
        <div className="jp-WorkshopSources-meta">
          <span className="jp-WorkshopSources-url" title={item.url}>
            {item.url}
          </span>
          <span className="jp-WorkshopBrowser-chip">from {origin}</span>
          {item.loading ? (
            <span className="jp-WorkshopBrowser-chip">reading…</span>
          ) : null}
        </div>
        {item.error ? (
          <p className="jp-WorkshopBrowser-error">
            Unable to read it: {item.error}
          </p>
        ) : null}
      </div>
      {canChange ? (
        <div className="jp-WorkshopSources-actions">
          {item.origin === 'session' ? (
            <button
              type="button"
              className="jp-Button jp-mod-styled jp-mod-accept"
              title="Add this to your settings so the subscription stays"
              onClick={onSubscribe}
            >
              Subscribe
            </button>
          ) : null}
          <button
            type="button"
            className="jp-Button jp-mod-styled jp-mod-warn"
            onClick={onUnsubscribe}
          >
            {item.origin === 'session' ? 'Remove' : 'Unsubscribe'}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function SubscribeByUrl({
  kind,
  subscribed,
  onSubscribe
}: {
  kind: SourceKind;
  subscribed: string[];
  onSubscribe: (url: string) => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const url = value.trim();
  const duplicate = subscribed.some(item => sameLocation(item, url));
  const submit = (): void => {
    if (url && !duplicate) {
      onSubscribe(url);
      setValue('');
    }
  };

  return (
    <form
      className="jp-WorkshopSources-add"
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        type="text"
        className="jp-mod-styled jp-WorkshopSources-input"
        placeholder={
          kind === 'collection'
            ? 'URL or path of a collection.json file'
            : 'URL or path of a catalog.json file'
        }
        value={value}
        onChange={event => setValue(event.target.value)}
      />
      <button
        type="submit"
        className="jp-Button jp-mod-styled jp-mod-accept"
        disabled={url === '' || duplicate}
        title={duplicate ? 'Already subscribed' : undefined}
      >
        Subscribe
      </button>
    </form>
  );
}

function FromCatalogs({
  catalogs,
  subscribed,
  canChange,
  onSubscribe
}: {
  catalogs: ILoadedSource[];
  subscribed: string[];
  canChange: boolean;
  onSubscribe: (url: string) => void;
}): JSX.Element {
  return (
    <div className="jp-WorkshopSources-catalogs">
      <h3 className="jp-WorkshopSources-heading">From subscribed catalogs</h3>
      {catalogs.map(item => (
        <div key={item.url} className="jp-WorkshopSources-catalog">
          <div className="jp-WorkshopSources-catalogTitle">
            {item.catalog?.title || item.url}
          </div>
          {item.error ? (
            <p className="jp-WorkshopBrowser-error">
              Unable to read {item.url}: {item.error}
            </p>
          ) : null}
          {item.catalog && item.catalog.collections.length === 0 ? (
            <p className="jp-WorkshopBrowser-note">
              This catalog lists no collections.
            </p>
          ) : null}
          <ul className="jp-WorkshopSources-list">
            {(item.catalog?.collections ?? []).map(entry => {
              const added = subscribed.some(url =>
                sameLocation(url, entry.url)
              );
              const title = entry.title || entry.url;

              return (
                <li
                  key={entry.url}
                  className="jp-WorkshopSources-row"
                  data-url={entry.url}
                >
                  <SourceIcon icon={entry.icon} title={title} size={64} />
                  <div className="jp-WorkshopSources-text">
                    <div className="jp-WorkshopSources-title">
                      {title}
                      {entry.publisher ? (
                        <span className="jp-WorkshopSources-publisher">
                          {' '}
                          by {entry.publisher.name}
                        </span>
                      ) : null}
                    </div>
                    {entry.description ? (
                      <p className="jp-WorkshopSources-description">
                        {entry.description}
                      </p>
                    ) : null}
                    <div className="jp-WorkshopSources-meta">
                      <span
                        className="jp-WorkshopSources-url"
                        title={entry.url}
                      >
                        {entry.url}
                      </span>
                      {entry.tags.map(tag => (
                        <span key={tag} className="jp-WorkshopBrowser-chip">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="jp-WorkshopSources-actions">
                    {added ? (
                      <span className="jp-WorkshopBrowser-chip jp-mod-progress">
                        subscribed
                      </span>
                    ) : canChange ? (
                      <button
                        type="button"
                        className="jp-Button jp-mod-styled jp-mod-accept"
                        onClick={() => onSubscribe(entry.url)}
                      >
                        Subscribe
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function patch(
  items: ILoadedSource[],
  url: string,
  update: Partial<ILoadedSource>
): ILoadedSource[] {
  return items.map(item => (item.url === url ? { ...item, ...update } : item));
}
