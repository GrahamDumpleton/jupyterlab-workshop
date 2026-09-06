import {
  IRegistryEntry,
  IRegistryIndex,
  latestVersion,
  registryTags,
  searchRegistry,
  supportsPlatform
} from '@jupyterlab-workshop/core';
import { Dialog, showDialog, showErrorMessage } from '@jupyterlab/apputils';
import { ReactWidget, UseSignal, refreshIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { ISignal, Signal } from '@lumino/signaling';
import React, { useEffect, useMemo, useState } from 'react';

import { workshopIcon } from '../icons';
import {
  CommandIDs,
  IFeaturePolicy,
  IInstalledWorkshop,
  IWorkshopManager,
  errorMessage
} from '../tokens';
import { describeSource } from '../trust/summary';

/** Id of the browser widget. */
export const BROWSER_ID = 'jupyterlab-workshop-browser';

/** Settings the browser reads each time it refreshes. */
export interface IBrowserSettings {
  registries: string[];
  workshopsDirectory: string;
}

/** A registry that has been loaded, or failed to. */
interface ILoadedRegistry {
  url: string;
  title: string;
  entries: IRegistryEntry[];
  error?: string;
}

/**
 * Main-area widget listing the workshops of the configured registries
 * and those already installed, with search, tag filters and install,
 * resume and remove buttons.
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

  /** Emitted to ask the component to reload registries and installs. */
  get refreshRequested(): ISignal<this, void> {
    return this._refreshRequested;
  }

  /**
   * Reload the registries and the installed list.
   */
  refresh(): void {
    this._refreshRequested.emit();
  }

  protected render(): JSX.Element {
    const { manager, commands, features, readSettings } = this._options;

    return (
      <UseSignal signal={this._refreshRequested}>
        {() => (
          <BrowserContent
            manager={manager}
            commands={commands}
            features={features}
            readSettings={readSettings}
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

    /** Current values of the settings the browser depends on. */
    readSettings: () => Promise<IBrowserSettings>;
  }
}

interface IContentProps extends WorkshopBrowser.IOptions {
  refreshSignal: ISignal<WorkshopBrowser, void>;
}

function BrowserContent(props: IContentProps): JSX.Element {
  const { manager, commands, features, readSettings, refreshSignal } = props;
  const [registries, setRegistries] = useState<ILoadedRegistry[]>([]);
  const [installed, setInstalled] = useState<IInstalledWorkshop[]>([]);
  const [directory, setDirectory] = useState('workshops');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [version, setVersion] = useState(0);

  // Reload when asked, when a workshop is opened or closed, or at first.
  useEffect(() => {
    const bump = (): void => setVersion(value => value + 1);

    refreshSignal.connect(bump);
    manager.changed.connect(bump);

    return () => {
      refreshSignal.disconnect(bump);
      manager.changed.disconnect(bump);
    };
  }, [manager, refreshSignal]);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      setLoading(true);

      const settings = await readSettings();
      const loaded = await Promise.all(
        settings.registries.map(url => loadRegistry(manager, url))
      );
      let list: IInstalledWorkshop[] = [];

      try {
        list = await manager.installed(settings.workshopsDirectory);
      } catch (error) {
        console.warn('Unable to list installed workshops', error);
      }

      if (!cancelled) {
        setRegistries(loaded);
        setInstalled(list);
        setDirectory(settings.workshopsDirectory);
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [manager, readSettings, version]);

  const entries = useMemo(
    () => registries.flatMap(registry => registry.entries),
    [registries]
  );
  const allTags = useMemo(() => registryTags(entries), [entries]);
  const installedByName = useMemo(
    () => new Map(installed.map(item => [item.name, item])),
    [installed]
  );
  const entriesByName = useMemo(
    () => new Map(entries.map(entry => [entry.name, entry])),
    [entries]
  );

  // A workshop that is installed is listed once, under Installed, where
  // its card offers an update when the registry has another version.
  const notInstalled = useMemo(
    () => entries.filter(entry => !installedByName.has(entry.name)),
    [entries, installedByName]
  );
  const shown = useMemo(
    () => searchRegistry(notInstalled, query, tags),
    [notInstalled, query, tags]
  );
  const platform = manager.platform?.os ?? '';

  // The Available section, with the search and tags that filter it, is
  // only there when it has something to show or explain: an image whose
  // registry lists exactly the workshops it ships has nothing to add.
  const filtering = query.trim() !== '' || tags.length > 0;
  const registryProblem = registries.some(registry => registry.error);
  const noRegistries =
    registries.length === 0 && !loading && features.enabled('registries');
  const showAvailable =
    features.enabled('available') &&
    (notInstalled.length > 0 || filtering || registryProblem || noRegistries);
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

  const install = (entry: IRegistryEntry): void => {
    const chosen = latestVersion(entry);
    const source = chosen.source;

    void commands.execute(CommandIDs.openUrl, {
      url: source.archive ?? source.git ?? '',
      ref: source.ref,
      subdir: source.subdir,
      sha256: chosen.sha256,
      archive: source.archive !== undefined
    });
  };

  const open = (path: string): void => {
    void commands.execute(CommandIDs.open, { path });
  };

  const restart = async (item: IInstalledWorkshop): Promise<void> => {
    await commands.execute(CommandIDs.restart, {
      path: item.path,
      title: item.title
    });
    setVersion(value => value + 1);
  };

  // The registry version an installed workshop could move to, if any.
  const updateFor = (
    item: IInstalledWorkshop
  ): { version: string; run: () => void } | undefined => {
    const entry = entriesByName.get(item.name);
    const version = entry ? latestVersion(entry).version : '';

    if (!entry || !version || version === item.version) {
      return undefined;
    }

    return { version, run: () => install(entry) };
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
        {features.enabled('registries') ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            title="Change the registries in the settings"
            onClick={() =>
              void commands.execute('settingeditor:open', {
                query: 'Workshop'
              })
            }
          >
            Manage registries
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
          {installed.map(item => (
            <InstalledCard
              key={item.path}
              item={item}
              open={manager.workshop?.path === item.path}
              onOpen={() => open(item.path)}
              onRestart={() => void restart(item)}
              onRemove={
                features.enabled('remove') ? () => void remove(item) : undefined
              }
              update={updateFor(item)}
            />
          ))}
        </div>
      )}
      {showAvailable ? (
        <AvailableSection
          registries={registries}
          shown={shown}
          noMatch={filtering && shown.length === 0 && notInstalled.length > 0}
          noRegistries={noRegistries}
          platform={platform}
          onInstall={install}
        />
      ) : null}
    </div>
  );
}

function AvailableSection({
  registries,
  shown,
  noMatch,
  noRegistries,
  platform,
  onInstall
}: {
  registries: ILoadedRegistry[];
  shown: IRegistryEntry[];

  /** Whether the search or tags are hiding every workshop. */
  noMatch: boolean;

  /** Whether there are no registries to show and the learner can add some. */
  noRegistries: boolean;
  platform: string;
  onInstall: (entry: IRegistryEntry) => void;
}): JSX.Element {
  return (
    <>
      <h2 className="jp-WorkshopBrowser-heading">Available</h2>
      {registries.map(registry =>
        registry.error ? (
          <p key={registry.url} className="jp-WorkshopBrowser-error">
            Unable to read the registry {registry.url}: {registry.error}
          </p>
        ) : null
      )}
      {noRegistries ? (
        <p className="jp-WorkshopBrowser-note">
          No registries are configured. Add registry URLs in the settings to
          browse workshops here.
        </p>
      ) : null}
      {noMatch ? (
        <p className="jp-WorkshopBrowser-note">No workshops match.</p>
      ) : null}
      <div className="jp-WorkshopBrowser-cards">
        {shown.map(entry => (
          <RegistryCard
            key={`${entry.name}`}
            entry={entry}
            platform={platform}
            onInstall={() => onInstall(entry)}
          />
        ))}
      </div>
    </>
  );
}

function RegistryCard({
  entry,
  platform,
  onInstall
}: {
  entry: IRegistryEntry;
  platform: string;
  onInstall: () => void;
}): JSX.Element {
  const version = latestVersion(entry);
  const supported = platform === '' || supportsPlatform(entry, platform);

  return (
    <div
      className={`jp-WorkshopBrowser-card${supported ? '' : ' jp-mod-unsupported'}`}
      data-workshop={entry.name}
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
          onClick={onInstall}
        >
          Install
        </button>
      </div>
    </div>
  );
}

function InstalledCard({
  item,
  open,
  onOpen,
  onRestart,
  onRemove,
  update
}: {
  item: IInstalledWorkshop;
  open: boolean;
  onOpen: () => void;

  /** Put the files back as first opened and forget the progress. */
  onRestart: () => void;

  /** Delete the workshop, when the settings allow removing. */
  onRemove?: () => void;

  /** The registry version to move to, when it differs from the installed one. */
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
        <span className="jp-WorkshopBrowser-chip">{item.path}</span>
        {item.source ? (
          <span
            className="jp-WorkshopBrowser-chip"
            title={describeSource(item.source)}
          >
            {item.source.kind}
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
          disabled={open}
          title={open ? 'This workshop is open' : undefined}
          onClick={onOpen}
        >
          {item.started && !open ? 'Resume' : 'Open'}
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
            title="Download this version from the registry, replacing the files"
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

async function loadRegistry(
  manager: IWorkshopManager,
  url: string
): Promise<ILoadedRegistry> {
  try {
    const index: IRegistryIndex = await manager.fetchRegistry(url);

    return { url, title: index.title ?? url, entries: index.workshops };
  } catch (error) {
    return { url, title: url, entries: [], error: errorMessage(error) };
  }
}
