import {
  IRegistryEntry,
  IRegistryIndex,
  latestVersion,
  registryTags,
  searchRegistry,
  supportsPlatform
} from '@educates/workshop-core';
import { Dialog, showDialog, showErrorMessage } from '@jupyterlab/apputils';
import { ReactWidget, UseSignal, refreshIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { ISignal, Signal } from '@lumino/signaling';
import React, { useEffect, useMemo, useState } from 'react';

import { workshopIcon } from '../icons';
import {
  CommandIDs,
  IInstalledWorkshop,
  IWorkshopManager,
  errorMessage
} from '../tokens';
import { describeSource } from '../trust/summary';

/** Id of the browser widget. */
export const BROWSER_ID = 'educates-workshop-browser';

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
    const { manager, commands, readSettings } = this._options;

    return (
      <UseSignal signal={this._refreshRequested}>
        {() => (
          <BrowserContent
            manager={manager}
            commands={commands}
            readSettings={readSettings}
            refreshSignal={this._refreshRequested}
          />
        )}
      </UseSignal>
    );
  }

  private _options: WorkshopBrowser.IOptions;
  private _refreshRequested = new Signal<this, void>(this);
}

export namespace WorkshopBrowser {
  export interface IOptions {
    manager: IWorkshopManager;
    commands: CommandRegistry;

    /** Current values of the settings the browser depends on. */
    readSettings: () => Promise<IBrowserSettings>;
  }
}

interface IContentProps extends WorkshopBrowser.IOptions {
  refreshSignal: ISignal<WorkshopBrowser, void>;
}

function BrowserContent(props: IContentProps): JSX.Element {
  const { manager, commands, readSettings, refreshSignal } = props;
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
  const shown = useMemo(
    () => searchRegistry(entries, query, tags),
    [entries, query, tags]
  );
  const installedByName = useMemo(
    () => new Map(installed.map(item => [item.name, item])),
    [installed]
  );
  const platform = manager.platform?.os ?? '';

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
        <input
          type="search"
          className="jp-WorkshopBrowser-search"
          placeholder="Search workshops"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="jp-Button jp-mod-styled"
          onClick={() => void commands.execute(CommandIDs.openUrl)}
        >
          Add from URL…
        </button>
        <button
          type="button"
          className="jp-Button jp-mod-styled"
          onClick={() => void commands.execute(CommandIDs.open)}
        >
          Open a directory…
        </button>
        <button
          type="button"
          className="jp-Button jp-mod-styled"
          title="Change the registries in the settings"
          onClick={() =>
            void commands.execute('settingeditor:open', { query: 'Workshop' })
          }
        >
          Manage registries
        </button>
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-minimal jp-WorkshopBrowser-refresh"
          title="Refresh"
          onClick={() => setVersion(value => value + 1)}
        >
          <refreshIcon.react tag="span" width="16px" height="16px" />
        </button>
      </div>
      {allTags.length > 0 ? (
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
            : `No workshops are installed under ${directory || 'the JupyterLab root'} yet. Install one below, add one from a URL, or open a directory.`}
        </p>
      ) : (
        <div className="jp-WorkshopBrowser-cards">
          {installed.map(item => (
            <InstalledCard
              key={item.path}
              item={item}
              open={manager.workshop?.path === item.path}
              onOpen={() => open(item.path)}
              onRemove={() => void remove(item)}
            />
          ))}
        </div>
      )}
      <h2 className="jp-WorkshopBrowser-heading">Available</h2>
      {registries.map(registry =>
        registry.error ? (
          <p key={registry.url} className="jp-WorkshopBrowser-error">
            Unable to read the registry {registry.url}: {registry.error}
          </p>
        ) : null
      )}
      {registries.length === 0 && !loading ? (
        <p className="jp-WorkshopBrowser-note">
          No registries are configured. Add registry URLs in the settings to
          browse workshops here.
        </p>
      ) : null}
      {shown.length === 0 && entries.length > 0 ? (
        <p className="jp-WorkshopBrowser-note">No workshops match.</p>
      ) : null}
      <div className="jp-WorkshopBrowser-cards">
        {shown.map(entry => (
          <RegistryCard
            key={`${entry.name}`}
            entry={entry}
            platform={platform}
            installed={installedByName.get(entry.name)}
            onInstall={() => install(entry)}
            onOpen={path => open(path)}
          />
        ))}
      </div>
    </div>
  );
}

function RegistryCard({
  entry,
  platform,
  installed,
  onInstall,
  onOpen
}: {
  entry: IRegistryEntry;
  platform: string;
  installed?: IInstalledWorkshop;
  onInstall: () => void;
  onOpen: (path: string) => void;
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
        {installed ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled jp-mod-accept"
            onClick={() => onOpen(installed.path)}
          >
            {installed.started ? 'Resume' : 'Open'}
          </button>
        ) : null}
        <button
          type="button"
          className={`jp-Button jp-mod-styled${installed ? '' : ' jp-mod-accept'}`}
          onClick={onInstall}
        >
          {installed ? 'Reinstall' : 'Install'}
        </button>
      </div>
    </div>
  );
}

function InstalledCard({
  item,
  open,
  onOpen,
  onRemove
}: {
  item: IInstalledWorkshop;
  open: boolean;
  onOpen: () => void;
  onRemove: () => void;
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
          onClick={onOpen}
        >
          {open ? 'Open now' : item.started ? 'Resume' : 'Open'}
        </button>
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-warn"
          onClick={onRemove}
        >
          Remove
        </button>
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
