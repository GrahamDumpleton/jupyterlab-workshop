import {
  ICatalog,
  ICollectionEntry,
  ILibrary,
  needsUpgrade,
  normalizeWorkshopsDirectory,
  collectionTags,
  latestVersion,
  normalizeLocation,
  resolveLocation,
  searchCollection,
  supportsFrontend,
  supportsPlatform
} from '@jupyterlab-workshop/core';
import {
  Dialog,
  InputDialog,
  showDialog,
  showErrorMessage
} from '@jupyterlab/apputils';
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

import { showPublishDialog, showPublishedDialog } from '../authoring/dialogs';
import { workshopIcon } from '../icons';
import { ILibraryCourseInfo } from '../library/scan';
import { LibraryService } from '../library/service';
import { planMigration, runMigration } from '../library/migrate';
import {
  CommandIDs,
  IFeaturePolicy,
  IInstalledWorkshop,
  ILibraryUpgradePlan,
  IWorkshopManager,
  errorMessage,
  isDownloaded
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

    /**
     * The workshop library, when the extension has one. In a library the
     * browser shows the owner's own workshops and courses as well, and
     * outside one it can offer to make the directory a library.
     */
    library?: LibraryService | null;
  }
}

interface IContentProps extends WorkshopBrowser.IOptions {
  refreshSignal: ISignal<WorkshopBrowser, void>;
}

function BrowserContent(props: IContentProps): JSX.Element {
  const {
    manager,
    commands,
    features,
    store,
    readSettings,
    refreshSignal,
    library = null
  } = props;
  const [collections, setCollections] = useState<ILoadedCollection[]>([]);
  const [catalogs, setCatalogs] = useState<ILoadedCatalog[]>([]);
  const [installed, setInstalled] = useState<IInstalledWorkshop[]>([]);
  const [directory, setDirectory] = useState('workshops');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [platform, setPlatform] = useState(manager.platform?.os ?? '');
  const [frontend, setFrontend] = useState(manager.frontend);
  const [instance, setInstance] = useState(manager.platform?.instance_id ?? '');
  const [registry, setRegistry] = useState<ILibrary | null>(null);
  const [courses, setCourses] = useState<ILibraryCourseInfo[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [, setCommandsVersion] = useState(0);

  // Workshop Author's commands become available once its plugin has asked
  // the server whether an agent is installed, so redraw when they change.
  useEffect(() => {
    const redraw = (
      _: CommandRegistry,
      change: CommandRegistry.ICommandChangedArgs
    ): void => {
      if (
        change.id === CommandIDs.createWithAI ||
        change.id === CommandIDs.editWithAI
      ) {
        setCommandsVersion(value => value + 1);
      }
    };

    commands.commandChanged.connect(redraw);

    return () => {
      commands.commandChanged.disconnect(redraw);
    };
  }, [commands]);

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

      // Whether the workshops directory is a library, and its courses.
      // A registry that cannot be read is shown as a problem, and the
      // directory is then listed as a plain one.
      let loadedRegistry: ILibrary | null = null;
      let loadedCourses: ILibraryCourseInfo[] = [];
      let loadedLibraryError: string | null = null;

      if (library) {
        try {
          loadedRegistry = await library.read(settings.workshopsDirectory);

          if (loadedRegistry) {
            loadedCourses = await library.courses(
              loadedRegistry,
              settings.workshopsDirectory
            );
          }
        } catch (error) {
          loadedLibraryError = errorMessage(error);
        }
      }

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
      // platforms and frontends are dimmed, Install all leaves them
      // unticked, and a card knows whether its progress was made under
      // this running JupyterLab.
      let info = manager.platform;

      if (!info) {
        try {
          info = await manager.backend.platform();
        } catch (error) {
          console.warn('Unable to read the platform', error);
        }
      }

      if (!cancelled) {
        setCollections(loadedCollections);
        setCatalogs(loadedCatalogs);
        setInstalled(orderInstalled(list, loadedCollections));
        setDirectory(settings.workshopsDirectory);
        setPlatform(info?.os ?? '');
        setFrontend(info?.frontend ?? manager.frontend);
        setInstance(info?.instance_id ?? '');
        setRegistry(loadedRegistry);
        setCourses(loadedCourses);
        setLibraryError(loadedLibraryError);
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [manager, readSettings, store, library, version]);

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
  // The installed workshops of each subscribed collection, in the order
  // `orderInstalled` already gave them, and the rest: those with no
  // subscribed collection, an ambiguous name, or a recorded collection
  // that is not subscribed. A collection with nothing installed has no
  // group here, since Available lists it.
  const { installedGroups, otherInstalled, personal, byCourse } =
    useMemo(() => {
      const byCollection = new Map<ILoadedCollection, IInstalledWorkshop[]>();
      const rest: IInstalledWorkshop[] = [];
      const own: IInstalledWorkshop[] = [];
      const inCourses = new Map<string, IInstalledWorkshop[]>();

      for (const item of installed) {
        // A library's own workshops and courses have sections of their own.
        if (item.kind === 'personal') {
          own.push(item);

          continue;
        }

        if (item.kind === 'course') {
          const items = inCourses.get(item.course ?? '') ?? [];

          items.push(item);
          inCourses.set(item.course ?? '', items);

          continue;
        }

        const found = collectionOf(item, collections);

        if (found) {
          const items = byCollection.get(found.collection) ?? [];

          items.push(item);
          byCollection.set(found.collection, items);
        } else {
          rest.push(item);
        }
      }

      return {
        installedGroups: groups
          .filter(group => byCollection.has(group.collection))
          .map(group => ({
            group,
            items: byCollection.get(group.collection) ?? []
          })),
        otherInstalled: rest,
        personal: own,
        byCourse: inCourses
      };
    }, [installed, collections, groups]);

  const allTags = useMemo(
    () => collectionTags(groups.flatMap(group => group.notInstalled)),
    [groups]
  );
  const filtering = query.trim() !== '' || tags.length > 0;
  const anyNotInstalled = groups.some(group => group.notInstalled.length > 0);
  const installedUrls = useMemo(
    () => new Set(installedGroups.map(({ group }) => group.collection.url)),
    [installedGroups]
  );
  // A collection whose workshops are all installed but under no heading
  // of its own, as when a name two collections list was matched to
  // neither, is still shown under Available, or it would be nowhere.
  const anyUnplaced = groups.some(
    group =>
      group.notInstalled.length === 0 &&
      !installedUrls.has(group.collection.url)
  );
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
      anyUnplaced ||
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

  // Outside a library the note says which directory is listed; in a
  // library, where installs go is the library's business, not a name
  // a learner needs.
  const installedWhere =
    registry !== null
      ? ''
      : ` under ${normalizeWorkshopsDirectory(directory) || 'the JupyterLab root'}`;

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
          platform,
          frontend
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

  // Progress made under a JupyterLab that has since restarted needs a
  // restart unless the workshop says it can be continued; progress with
  // no recorded instance predates the record and counts the same way.
  const isStale = (item: IInstalledWorkshop): boolean =>
    item.started &&
    !item.resumable &&
    instance !== '' &&
    item.instanceId !== instance;

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

  const renderInstalledCard = (
    item: IInstalledWorkshop,
    showCollection: boolean
  ): JSX.Element => {
    const found = collectionFor(item);
    const next = found
      ? upNext(found.collection, installed, collections)
      : undefined;

    return (
      <InstalledCard
        key={item.path}
        item={item}
        collection={found?.collection}
        showCollection={showCollection}
        step={sequenceStep(found)}
        upNext={found?.entry !== undefined && next === found.entry}
        open={manager.workshop?.path === item.path}
        busy={busy === `open:${item.path}`}
        stale={isStale(item)}
        onOpen={() => open(item.path)}
        onContinue={() => open(item.path)}
        onRestart={() => void restart(item)}
        onRemove={
          features.enabled('remove') ? () => void remove(item) : undefined
        }
        onMove={
          item.kind === 'personal' && !isDownloaded(item) && canMove
            ? () => void moveToCourse(item)
            : undefined
        }
        onShowFiles={
          item.kind === 'personal' && canShowFiles(item.path)
            ? () =>
                void commands.execute(CommandIDs.showFiles, {
                  path: item.path
                })
            : undefined
        }
        onPublish={
          item.kind === 'personal' && !isDownloaded(item) && canPublish
            ? () => void publishWorkshop(item)
            : undefined
        }
        onEditWithAI={
          (item.kind === 'personal' || item.kind === 'course') &&
          commands.isVisible(CommandIDs.editWithAI)
            ? () =>
                // A workshop in a course is written in the course's
                // conversation, so the command is told which course.
                void commands.execute(CommandIDs.editWithAI, {
                  path: item.path,
                  course:
                    item.kind === 'course'
                      ? courses.find(course => course.name === item.course)
                          ?.path
                      : undefined
                })
            : undefined
        }
        update={updateFor(item)}
      />
    );
  };

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
    // A directory the browser did not download may hold work that is
    // nowhere else, so only its progress goes and the dialog says so.
    // One of the owner's own is theirs to delete, so for it the dialog
    // offers both: cleaning up the progress, or deleting the directory.
    const personal = !isDownloaded(item) && item.kind === 'personal';
    const body = isDownloaded(item)
      ? `The directory ${item.path} and any progress recorded in it will be deleted.`
      : personal
        ? `${item.path} is your own workshop, so its files have no other copy. Clean up deletes only the progress recorded in it and keeps the workshop; Delete deletes the directory and everything in it.`
        : `The progress recorded in ${item.path} will be deleted. The directory and its files stay, since the browser did not download them.`;
    const result = await showDialog({
      title: `Remove workshop "${item.title}"?`,
      body,
      buttons: personal
        ? [
            Dialog.cancelButton(),
            Dialog.okButton({ label: 'Clean up' }),
            Dialog.warnButton({ label: 'Delete' })
          ]
        : [Dialog.cancelButton(), Dialog.warnButton({ label: 'Remove' })]
    });

    if (!result.button.accept) {
      return;
    }

    try {
      await manager.removeInstalled(item, result.button.label === 'Delete');
      setVersion(value => value + 1);
    } catch (error) {
      await showErrorMessage(
        'Unable to remove the workshop',
        errorMessage(error)
      );
    }
  };

  // Whether the library keeps its workshops in the previous layout and
  // waits to be upgraded, when nothing is listed and nothing offered.
  const upgradeNeeded = registry !== null && needsUpgrade(registry);

  // The courses one of the owner's workshops can move into: those that
  // are there, on a server, since the move happens in the server.
  const joinable = courses.filter(course => !course.missing);
  const canMove =
    manager.backend.kind === 'server' && !upgradeNeeded && joinable.length > 0;

  const moveToCourse = async (item: IInstalledWorkshop): Promise<void> => {
    if (manager.workshop?.path === item.path) {
      await showErrorMessage(
        'Unable to move the workshop',
        'The workshop is open; close it first.'
      );

      return;
    }

    const chosen = await InputDialog.getItem({
      title: `Move "${item.title}" into a course`,
      label:
        'The workshop moves into the course, whole, with its progress and gist record, joins the design and the index, and is committed there. Its own repository ends with the move.',
      items: joinable.map(course => course.name),
      okLabel: 'Move'
    });
    const course = joinable.find(entry => entry.name === chosen.value);

    if (!chosen.button.accept || !course) {
      return;
    }

    try {
      // A course of several parts asks which one; one part needs no asking.
      const collections = await manager.backend.courseCollections(
        directory,
        course.name
      );
      let collection: string | null = collections[0]?.name ?? null;

      if (collections.length > 1) {
        const labels = collections.map(
          entry => `${entry.title} (${entry.name})`
        );
        const picked = await InputDialog.getItem({
          title: `Which part of ${course.name}?`,
          label: 'The collection the workshop joins, at the end of its order.',
          items: labels,
          okLabel: 'Move'
        });

        if (!picked.button.accept || !picked.value) {
          return;
        }

        collection = collections[labels.indexOf(picked.value)]?.name ?? null;
      }

      const report = await manager.backend.promoteWorkshop(
        directory,
        item.path,
        course.path,
        collection
      );

      setVersion(value => value + 1);

      if (!report.committed) {
        await showDialog({
          title: 'Moved, but not committed',
          body: `${item.title} is now at ${report.path}. The move was not committed in the course: ${report.commit_note}. Commit it yourself, or ask Workshop Author to.`,
          buttons: [Dialog.okButton()]
        });
      }
    } catch (error) {
      await showErrorMessage(
        'Unable to move the workshop',
        errorMessage(error)
      );
    }
  };

  // Publishing goes through the server, which holds the GitHub login;
  // every publish asks first, and nothing is public without asking.
  const canPublish = manager.backend.kind === 'server' && !upgradeNeeded;

  // The owner's directories sit out of sight under the library, so a
  // card and a course heading offer the way into them in the file browser.
  const canShowFiles = (path: string): boolean =>
    commands.isEnabled(CommandIDs.showFiles, { path });

  const publishWorkshop = async (item: IInstalledWorkshop): Promise<void> => {
    const choice = await showPublishDialog({
      subject: `"${item.title}"`,
      targets: ['gist', 'github']
    });

    if (!choice) {
      return;
    }

    try {
      if (choice.target === 'gist') {
        const result = await manager.backend.publishGist(item.path, {
          public: choice.public
        });

        await showPublishedDialog({
          title: result.created ? 'Gist created' : 'Gist updated',
          url: result.url,
          lead: `${item.title} is a ${result.public ? 'public' : 'secret'} gist at`,
          notes: [
            'The address is the source for Open Workshop from URL and for a launch link; the gist is recorded in the workshop, so publishing again updates it.'
          ]
        });
      } else {
        const result = await manager.backend.publishGitHub(item.path, {
          public: choice.public
        });

        await showPublishedDialog({
          title: result.created ? 'Repository created' : 'Pushed',
          url: result.url,
          lead: `${item.title} is ${result.public ? 'public' : 'private'} at`,
          notes: result.notes
        });
      }
    } catch (error) {
      await showErrorMessage('Unable to publish', errorMessage(error));
    }
  };

  const publishCourse = async (course: ILibraryCourseInfo): Promise<void> => {
    const choice = await showPublishDialog({
      subject: `the course "${course.name}"`,
      targets: ['github']
    });

    if (!choice) {
      return;
    }

    try {
      const result = await manager.backend.publishGitHub(course.path, {
        public: choice.public
      });

      await showPublishedDialog({
        title: result.created ? 'Repository created' : 'Pushed',
        url: result.url,
        lead: `The course ${course.name} is ${result.public ? 'public' : 'private'} at`,
        notes: result.notes
      });
    } catch (error) {
      await showErrorMessage('Unable to publish', errorMessage(error));
    }
  };

  // Workshop Author writes the owner's own workshops, so only in a
  // library, and only one in this release's layout.
  const canAuthorWithAI =
    registry !== null &&
    !upgradeNeeded &&
    commands.isVisible(CommandIDs.createWithAI);

  // A plain workshops directory on a server can become a library, unless
  // the subscriptions are locked, since the registry would hold them.
  const canMakeLibrary =
    library !== null &&
    library.enabled &&
    registry === null &&
    libraryError === null &&
    !loading &&
    features.enabled('collections') &&
    manager.backend.kind === 'server';

  const makeLibrary = async (): Promise<void> => {
    if (!library) {
      return;
    }

    const ids = new Map(
      collections.map(item => [item.url, item.index?.id] as const)
    );
    const plan = await planMigration({
      contents: library.contents,
      directory,
      installed,
      collections: await store.userList('collection'),
      catalogs: await store.userList('catalog'),
      ids,
      openPath: manager.workshop?.path ?? null
    });
    const where =
      normalizeWorkshopsDirectory(directory) || 'the JupyterLab root';
    const result = await showDialog({
      title: 'Make this a workshop library?',
      body: (
        <div className="jp-WorkshopBrowser-migration">
          <p>
            {where} becomes a workshop library: a library.json registry there
            holds your subscriptions, workshops from a collection go under
            installed/collections/, other downloads under installed/workshops/,
            your own workshops under personal/workshops/ and your courses under
            personal/courses/.
          </p>
          {plan.moves.length > 0 ? (
            <>
              <p>These downloaded workshops move:</p>
              <ul>
                {plan.moves.map(move => (
                  <li key={move.from}>
                    {move.title}: {move.from} to {move.to}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {plan.skipped.length > 0 ? (
            <>
              <p>These stay where they are:</p>
              <ul>
                {plan.skipped.map(item => (
                  <li key={item.path}>
                    {item.title}, because {item.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p>Anything else in the directory is left as it is.</p>
        </div>
      ),
      buttons: [
        Dialog.cancelButton(),
        Dialog.okButton({ label: 'Make library' })
      ]
    });

    if (!result.button.accept) {
      return;
    }

    try {
      const failed = await runMigration(library.contents, plan, planned =>
        library.create(planned, directory)
      );

      if (failed.length > 0) {
        await showErrorMessage(
          'Some workshops were not moved',
          failed.map(item => `${item.title}: ${item.reason}`).join('\n')
        );
      }
    } catch (error) {
      await showErrorMessage(
        'Unable to make the workshop library',
        errorMessage(error)
      );
    }

    setVersion(value => value + 1);
  };

  const unlink = async (course: ILibraryCourseInfo): Promise<void> => {
    const result = await showDialog({
      title: `Unlink the course "${course.name}"?`,
      body: `The link ${course.path} and its entry in the library go. Nothing at ${course.target ?? 'its target'} is touched.`,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Unlink' })]
    });

    if (!result.button.accept) {
      return;
    }

    try {
      await manager.backend.unlinkCourse(directory, course.name);
    } catch (error) {
      await showErrorMessage(
        'Unable to unlink the course',
        errorMessage(error)
      );
    }

    setVersion(value => value + 1);
  };

  // A library made by an earlier release keeps its workshops in the
  // previous layout; the server moves them to this one, after showing
  // what moves. Nothing else is offered for such a library meanwhile.
  const upgrade = async (): Promise<void> => {
    let plan: ILibraryUpgradePlan | null;

    try {
      plan = await manager.backend.libraryUpgrade(directory);
    } catch (error) {
      await showErrorMessage(
        'Unable to read the workshop library',
        errorMessage(error)
      );

      return;
    }

    if (plan === null) {
      setVersion(value => value + 1);

      return;
    }

    const result = await showDialog({
      title: 'Upgrade this workshop library?',
      body: (
        <div className="jp-WorkshopBrowser-migration">
          <p>
            The library keeps its workshops in the layout of an earlier release.
            Upgrading moves them to where this release keeps them: your own
            workshops under personal/workshops/, your courses under
            personal/courses/, and what you installed under installed/. Progress
            goes with each workshop.
          </p>
          {plan.moves.length > 0 ? (
            <ul>
              {plan.moves.map(move => (
                <li key={move.from}>
                  {move.from} to {move.to} ({move.contents})
                </li>
              ))}
            </ul>
          ) : null}
          {plan.environments.length > 0 ? (
            <>
              <p>
                These workshops have isolated environments, which hold the paths
                they were made at, so each is removed and made again when its
                workshop is next opened:
              </p>
              <ul>
                {plan.environments.map(path => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ),
      buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Upgrade' })]
    });

    if (!result.button.accept) {
      return;
    }

    try {
      await manager.backend.upgradeLibrary(directory);
    } catch (error) {
      await showErrorMessage(
        'Unable to upgrade the workshop library',
        errorMessage(error)
      );
    }

    setVersion(value => value + 1);
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
        {canAuthorWithAI ? (
          <>
            <button
              type="button"
              className="jp-Button jp-mod-styled"
              title="Describe a workshop and have Workshop Author, an AI agent, write it in My workshops"
              onClick={() => void commands.execute(CommandIDs.createWithAI)}
            >
              Create Workshop with AI…
            </button>
            <button
              type="button"
              className="jp-Button jp-mod-styled"
              title="Describe a course, a repository of workshops in parts, and have Workshop Author set it up in My courses and design it with you"
              onClick={() =>
                void commands.execute(CommandIDs.createWithAI, {
                  kind: 'course'
                })
              }
            >
              Create Course with AI…
            </button>
          </>
        ) : null}
        {canMakeLibrary ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            title="Keep your own workshops, your courses and what you install apart, with your subscriptions in the directory"
            onClick={() => void makeLibrary()}
          >
            Make this a workshop library…
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
      {libraryError !== null ? (
        <p className="jp-WorkshopBrowser-error">{libraryError}</p>
      ) : null}
      {upgradeNeeded ? (
        <div className="jp-WorkshopBrowser-upgrade">
          <p className="jp-WorkshopBrowser-upgradeText">
            This workshop library was made by an earlier release and keeps its
            workshops in the previous layout, so they are not listed until it is
            upgraded.
          </p>
          {manager.backend.kind === 'server' ? (
            <button
              type="button"
              className="jp-Button jp-mod-styled jp-mod-accept"
              onClick={() => void upgrade()}
            >
              Upgrade library…
            </button>
          ) : (
            <p className="jp-WorkshopBrowser-upgradeText">
              Start it with jupyter workshop library to upgrade it.
            </p>
          )}
        </div>
      ) : null}
      {registry !== null && features.enabled('personal') ? (
        <>
          <h2 className="jp-WorkshopBrowser-heading">My workshops</h2>
          {personal.length === 0 ? (
            <p className="jp-WorkshopBrowser-note">
              {loading
                ? 'Looking for your workshops…'
                : 'Workshops you make for yourself will appear here.'}
            </p>
          ) : (
            <InstalledGroup
              section="personal"
              title="Your own workshops"
              count={personal.length}
            >
              {personal.map(item => renderInstalledCard(item, false))}
            </InstalledGroup>
          )}
        </>
      ) : null}
      {registry !== null && courses.length > 0 ? (
        <>
          <h2 className="jp-WorkshopBrowser-heading">My courses</h2>
          {courses.map(course => {
            const items = byCourse.get(course.name) ?? [];

            return (
              <InstalledGroup
                key={course.name}
                section="course"
                collapseKey={course.name}
                title={course.name}
                count={items.length}
                note={
                  course.missing
                    ? `Missing: ${course.target ?? course.path} is not there any more.`
                    : items.length === 0
                      ? `No workshops found in ${course.path} yet.`
                      : undefined
                }
                headerActions={
                  course.missing ? (
                    course.linked ? (
                      <button
                        type="button"
                        className="jp-Button jp-mod-styled jp-mod-warn"
                        onClick={() => void unlink(course)}
                      >
                        Unlink
                      </button>
                    ) : null
                  ) : (
                    <>
                      {commands.isVisible(CommandIDs.editWithAI) ? (
                        <button
                          type="button"
                          className="jp-Button jp-mod-styled"
                          title="Design and revise this course in a conversation with Workshop Author, an AI agent"
                          onClick={() =>
                            void commands.execute(CommandIDs.editWithAI, {
                              path: course.path,
                              kind: 'course'
                            })
                          }
                        >
                          Edit course with AI
                        </button>
                      ) : null}
                      {canShowFiles(course.path) ? (
                        <button
                          type="button"
                          className="jp-Button jp-mod-styled"
                          title="Show the course's repository in the file browser"
                          onClick={() =>
                            void commands.execute(CommandIDs.showFiles, {
                              path: course.path
                            })
                          }
                        >
                          Show files
                        </button>
                      ) : null}
                      {canPublish ? (
                        <button
                          type="button"
                          className="jp-Button jp-mod-styled"
                          title="Push the course to GitHub, creating a private repository the first time; asks first"
                          onClick={() => void publishCourse(course)}
                        >
                          Publish to GitHub…
                        </button>
                      ) : null}
                    </>
                  )
                }
              >
                {renderCourseCards(items, item =>
                  renderInstalledCard(item, false)
                )}
              </InstalledGroup>
            );
          })}
        </>
      ) : null}
      <h2 className="jp-WorkshopBrowser-heading">Installed</h2>
      {installedGroups.length === 0 && otherInstalled.length === 0 ? (
        <p className="jp-WorkshopBrowser-note">
          {loading
            ? 'Looking for installed workshops…'
            : `No workshops are installed${installedWhere} yet.${installHints}`}
        </p>
      ) : (
        <>
          {installedGroups.map(({ group, items }) => (
            <InstalledGroup
              key={group.collection.url}
              group={group}
              count={items.length}
              onRemoveAll={
                features.enabled('install-all') && features.enabled('remove')
                  ? () => removeAllFor(group)
                  : undefined
              }
            >
              {items.map(item => renderInstalledCard(item, false))}
            </InstalledGroup>
          ))}
          {otherInstalled.length > 0 ? (
            <InstalledGroup count={otherInstalled.length}>
              {otherInstalled.map(item => renderInstalledCard(item, true))}
            </InstalledGroup>
          ) : null}
        </>
      )}
      {showAvailable ? (
        <AvailableSection
          groups={groups}
          installedUrls={installedUrls}
          catalogs={catalogs}
          suggestions={suggestions}
          filtering={filtering}
          nothingSubscribed={nothingSubscribed}
          canSubscribeCollections={store.canChange('collection')}
          canSubscribeCatalogs={store.canChange('catalog')}
          platform={platform}
          frontend={frontend}
          busy={busy}
          onInstall={install}
          onInstallAll={
            features.enabled('install-all') ? installAllFor : undefined
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
  installedUrls,
  catalogs,
  suggestions,
  filtering,
  nothingSubscribed,
  canSubscribeCollections,
  canSubscribeCatalogs,
  platform,
  frontend,
  busy,
  onInstall,
  onInstallAll,
  onManage,
  onSubscribe
}: {
  groups: IGroup[];

  /** The locations of the collections that have a heading under Installed. */
  installedUrls: Set<string>;
  catalogs: ILoadedCatalog[];
  suggestions: ISuggestion[];

  /** Whether the search or tags are in force. */
  filtering: boolean;

  /** Whether there is no collection or catalog subscription. */
  nothingSubscribed: boolean;
  canSubscribeCollections: boolean;
  canSubscribeCatalogs: boolean;
  platform: string;
  frontend: string;

  /** The busy key of the card being installed, if any. */
  busy: string | null;
  onInstall: (collection: string, entry: ICollectionEntry) => void;

  /** Install every workshop of a group, when the settings allow it. */
  onInstallAll?: (group: IGroup) => void;
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
        // A collection with nothing left to install has its heading under
        // Installed, so here it would only repeat itself, unless it has
        // no heading there either, or a read error to show.
        (group.notInstalled.length > 0 ||
          group.collection.error ||
          !installedUrls.has(group.collection.url)) &&
        (!filtering || group.shown.length > 0) ? (
          <CollectionGroup
            key={group.collection.url}
            group={group}
            platform={platform}
            frontend={frontend}
            busy={busy}
            onInstall={entry => onInstall(group.collection.url, entry)}
            onInstallAll={onInstallAll ? () => onInstallAll(group) : undefined}
            onSubscribe={
              group.collection.origin === 'session' && canSubscribeCollections
                ? () => onSubscribe(group.collection.url)
                : undefined
            }
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
  frontend,
  busy,
  onInstall,
  onInstallAll,
  onSubscribe
}: {
  group: IGroup;
  platform: string;
  frontend: string;
  busy: string | null;
  onInstall: (entry: ICollectionEntry) => void;
  onInstallAll?: () => void;

  /**
   * Subscribe to the collection, given when a launch link added it for
   * this session only and the settings may be changed; the heading then
   * offers Subscribe in place of Install all until it is taken.
   */
  onSubscribe?: () => void;
}): JSX.Element {
  const { collection } = group;
  const [collapsed, setCollapsed] = useState(() =>
    readCollapsed('available', collection.url)
  );
  const toggle = (): void => {
    setCollapsed(current => {
      writeCollapsed('available', collection.url, !current);

      return !current;
    });
  };
  const count = group.notInstalled.length;

  // A bulk run holds the whole group: its cards' Install buttons wait
  // for it, so a single install cannot race the run for a directory.
  const groupBusy = busy === `install-all:${normalizeLocation(collection.url)}`;
  // A collection here for the session only is subscribed to before its
  // workshops are installed as a set, so that what is installed still
  // has its collection, and its order, at the next start.
  const canSubscribe = onSubscribe !== undefined && !collection.error;
  const canInstallAll =
    !canSubscribe &&
    onInstallAll !== undefined &&
    !collection.error &&
    count > 1;

  return (
    <section
      className={`jp-WorkshopBrowser-group jp-mod-available${collapsed ? ' jp-mod-collapsed' : ''}`}
      data-collection={collection.url}
    >
      <GroupHeader
        collection={collection}
        count={count === 1 ? '1 workshop' : `${count} workshops`}
        collapsed={collapsed}
        onToggle={toggle}
        actions={
          canSubscribe || canInstallAll ? (
            <>
              {canSubscribe ? (
                <button
                  type="button"
                  className="jp-Button jp-mod-styled jp-mod-accept"
                  title="Remember this collection for future sessions"
                  onClick={onSubscribe}
                >
                  Subscribe
                </button>
              ) : null}
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
            </>
          ) : null
        }
      />
      {!collapsed && !collection.error && count === 0 ? (
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
              frontend={frontend}
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

/**
 * The installed workshops of one subscribed collection under its
 * heading, or, with no group, the rest under a plain "Other workshops"
 * heading. The cards are the children, rendered by the browser, which
 * holds everything a card's buttons need.
 */
function InstalledGroup({
  group,
  count,
  onRemoveAll,
  section = 'installed',
  collapseKey,
  title = 'Other workshops',
  note,
  headerActions,
  children
}: {
  /** The collection the workshops belong to; none for the rest. */
  group?: IGroup;

  /** How many workshops the group holds. */
  count: number;

  /** Remove every workshop installed from the collection, when allowed. */
  onRemoveAll?: () => void;

  /** The section the group is in, which keeps its collapse state apart. */
  section?: GroupSection;

  /** What the collapse state is kept under, when not the collection. */
  collapseKey?: string;

  /** The heading when there is no collection. */
  title?: string;

  /** A line shown in place of the cards, such as why there are none. */
  note?: string;

  /** Buttons for the heading beside its menu. */
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  const collection = group?.collection;
  const location = collapseKey ?? collection?.url ?? '';
  const [collapsed, setCollapsed] = useState(() =>
    readCollapsed(section, location)
  );
  const toggle = (): void => {
    setCollapsed(current => {
      writeCollapsed(section, location, !current);

      return !current;
    });
  };

  // "n of m installed" tells a learner the collection has more; without
  // a readable index there is no m to give.
  const total = collection?.error
    ? undefined
    : collection?.index?.workshops.length;
  const countText =
    total !== undefined
      ? `${count} of ${total} installed`
      : count === 1
        ? '1 installed'
        : `${count} installed`;
  const removable = group?.removable ?? 0;
  const canRemoveAll = onRemoveAll !== undefined && removable > 0;

  return (
    <section
      className={`jp-WorkshopBrowser-group jp-mod-installed${collapsed ? ' jp-mod-collapsed' : ''}`}
      data-collection={collection ? collection.url : undefined}
    >
      <GroupHeader
        collection={collection}
        title={title}
        count={countText}
        collapsed={collapsed}
        onToggle={toggle}
        actions={
          headerActions || canRemoveAll ? (
            <>
              {headerActions}
              {canRemoveAll ? (
                <GroupMenu
                  items={[
                    {
                      label: `Remove all ${removable === 1 ? 'installed workshop' : `${removable} installed workshops`}…`,
                      warn: true,
                      run: onRemoveAll ?? ((): void => undefined)
                    }
                  ]}
                />
              ) : null}
            </>
          ) : null
        }
      />
      {!collapsed && note !== undefined ? (
        <p className="jp-WorkshopBrowser-note">{note}</p>
      ) : null}
      {!collapsed ? (
        <div className="jp-WorkshopBrowser-cards">{children}</div>
      ) : null}
    </section>
  );
}

/**
 * The heading of a group in either section: a collapse toggle, then the
 * collection's icon, title, description, publisher and location, or a
 * plain title when there is no collection, and the section's actions.
 */
function GroupHeader({
  collection,
  title,
  count,
  collapsed,
  onToggle,
  actions
}: {
  collection?: ILoadedCollection;

  /** The title shown when there is no collection. */
  title?: string;

  /** The count shown beside the title. */
  count: string;
  collapsed: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}): JSX.Element {
  const index = collection?.index;
  const icon =
    collection && index?.icon
      ? resolveLocation(collection.url, index.icon)
      : undefined;
  const Caret = collapsed ? caretRightIcon : caretDownIcon;

  return (
    <div className="jp-WorkshopBrowser-groupHeader">
      <button
        type="button"
        className="jp-WorkshopBrowser-groupToggle"
        aria-expanded={!collapsed}
        title={collapsed ? 'Show the workshops' : 'Hide the workshops'}
        onClick={onToggle}
      >
        <Caret.react tag="span" width="16px" height="16px" />
      </button>
      {collection ? (
        <SourceIcon
          icon={icon}
          title={collection.title}
          size={GROUP_ICON_SIZE}
        />
      ) : null}
      <div className="jp-WorkshopBrowser-groupText">
        <h3 className="jp-WorkshopBrowser-groupTitle">
          {collection ? (
            index?.homepage ? (
              <a href={index.homepage} target="_blank" rel="noreferrer">
                {collection.title}
              </a>
            ) : (
              collection.title
            )
          ) : (
            title
          )}
          <span className="jp-WorkshopBrowser-groupCount">{count}</span>
        </h3>
        {index?.description ? (
          <p className="jp-WorkshopBrowser-groupDescription">
            {index.description}
          </p>
        ) : null}
        {collection ? (
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
        ) : null}
        {collection?.error ? (
          <p className="jp-WorkshopBrowser-error">
            Unable to read this collection: {collection.error}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="jp-WorkshopBrowser-groupActions">{actions}</div>
      ) : null}
    </div>
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
  frontend,
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
  frontend: string;

  /** Whether this workshop is being installed right now. */
  busy: boolean;

  /** Whether a bulk run on the collection holds the button. */
  disabled: boolean;
  onInstall: () => void;
}): JSX.Element {
  const version = latestVersion(entry);
  const onPlatform =
    platform === '' || supportsPlatform(entry, platform, frontend);
  const onFrontend = frontend === '' || supportsFrontend(entry, frontend);
  const supported = onPlatform && onFrontend;

  return (
    <div
      className={`jp-WorkshopBrowser-card${supported ? '' : ' jp-mod-unsupported'}`}
      data-workshop={entry.name}
      data-collection={collection.url}
    >
      <div className="jp-WorkshopBrowser-cardTitle">
        {entry.homepage ? (
          <a
            className="jp-WorkshopBrowser-cardLink"
            href={entry.homepage}
            target="_blank"
            rel="noreferrer"
            title={entry.homepage}
          >
            {entry.title}
          </a>
        ) : (
          entry.title
        )}
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
        {entry.frontends.map(name => (
          <span
            key={name}
            className={`jp-WorkshopBrowser-chip jp-mod-platform${name === frontend ? ' jp-mod-current' : ''}`}
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
            Not written for {onPlatform ? frontend : platform}
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
  showCollection,
  step,
  upNext,
  open,
  busy,
  stale,
  onOpen,
  onContinue,
  onRestart,
  onRemove,
  onMove,
  onShowFiles,
  onPublish,
  onEditWithAI,
  update
}: {
  item: IInstalledWorkshop;

  /** The subscribed collection it came from, when known. */
  collection?: ILoadedCollection;

  /**
   * Whether to name the collection on the card: under a heading that
   * already names it the chip is noise, among the rest it is the only
   * sign of where a workshop came from.
   */
  showCollection: boolean;

  /** Its place in the sequence, when the collection is ordered. */
  step?: ISequenceStep;
  upNext: boolean;
  open: boolean;

  /** Whether this workshop is being opened right now. */
  busy: boolean;

  /**
   * Whether the progress was made under a JupyterLab that has since
   * restarted and the workshop is not resumable, so Restart comes first
   * and Continue is the override.
   */
  stale: boolean;
  onOpen: () => void;

  /** Carry on with stale progress, knowing what was lost. */
  onContinue: () => void;

  /** Put the files back as first opened and forget the progress. */
  onRestart: () => void;

  /** Delete the workshop, when the settings allow removing. */
  onRemove?: () => void;

  /** Move one of the owner's own workshops into one of their courses. */
  onMove?: () => void;

  /** Show the workshop's directory in the file browser, for the owner's own. */
  onShowFiles?: () => void;

  /** Publish one of the owner's own workshops, as a gist or to GitHub. */
  onPublish?: () => void;

  /** Revise the workshop with Workshop Author, for the owner's own. */
  onEditWithAI?: () => void;

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
        {!showCollection ? null : collection ? (
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
        {stale && !open ? (
          <span
            className="jp-WorkshopBrowser-chip jp-mod-stale"
            title="The JupyterLab this progress was made under has restarted"
          >
            needs restart
          </span>
        ) : null}
      </div>
      <div className="jp-WorkshopBrowser-cardActions">
        {stale && !open ? (
          <>
            <button
              type="button"
              className="jp-Button jp-mod-styled jp-mod-accept"
              disabled={busy}
              title="Put the files back as they were when first opened and forget the progress"
              onClick={onRestart}
            >
              Restart
            </button>
            <button
              type="button"
              className="jp-Button jp-mod-styled"
              disabled={busy}
              title="Asks before carrying on where you left off: terminals, running programs and notebook kernels from earlier pages are gone, so the rest of the workshop may not work"
              onClick={onContinue}
            >
              {busy ? 'Opening…' : 'Continue'}
            </button>
          </>
        ) : (
          <>
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
          </>
        )}
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
        {onEditWithAI ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            title="Revise this workshop in a conversation with Workshop Author, an AI agent"
            onClick={onEditWithAI}
          >
            Edit with AI
          </button>
        ) : null}
        {onMove ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            title="Move this workshop into one of your courses, whole, joining its design and index"
            onClick={onMove}
          >
            Move to course…
          </button>
        ) : null}
        {onShowFiles ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            title="Show the workshop's directory in the file browser"
            onClick={onShowFiles}
          >
            Show files
          </button>
        ) : null}
        {onPublish ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled"
            title="Publish this workshop as a gist or to a GitHub repository; asks first, secret or private unless you say otherwise"
            onClick={onPublish}
          >
            Publish…
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

/**
 * A course's workshop cards. A course whose own index groups its
 * workshops shows each collection under its title, in the index's
 * order, a workshop listed in two appearing in both, then those no
 * index lists yet; any other course shows its workshops by title.
 */
function renderCourseCards(
  items: readonly IInstalledWorkshop[],
  render: (item: IInstalledWorkshop) => JSX.Element
): React.ReactNode {
  const places = items.flatMap(item =>
    (item.sections ?? []).map(place => ({ item, place }))
  );

  if (!places.some(({ place }) => place.title !== null)) {
    return items.map(render);
  }

  places.sort(
    (a, b) =>
      a.place.index - b.place.index || a.place.position - b.place.position
  );

  const nodes: React.ReactNode[] = [];
  let current = -1;

  for (const { item, place } of places) {
    if (place.index !== current) {
      current = place.index;
      nodes.push(
        <h3
          key={`section:${place.index}`}
          className="jp-WorkshopBrowser-section"
        >
          {place.title ?? 'Not in a collection'}
        </h3>
      );
    }

    nodes.push(
      <React.Fragment key={`${place.index}:${item.path}`}>
        {render(item)}
      </React.Fragment>
    );
  }

  return nodes;
}

/** Which section a group's collapse state belongs to. */
type GroupSection = 'available' | 'installed' | 'personal' | 'course';

/**
 * The storage key of a group's collapse state. The Available keys predate
 * the Installed groups and keep their form; an Installed group, and the
 * group of the rest with no location, have keys of their own, so
 * collapsing one section's group leaves the other's open.
 */
function collapsedKey(section: GroupSection, url: string): string {
  // A course's key is its name, which is not a location.
  if (section === 'personal' || section === 'course') {
    return `${COLLAPSED_KEY}${section}:${url}`;
  }

  const location = url === '' ? '' : normalizeLocation(url);

  return section === 'installed'
    ? `${COLLAPSED_KEY}installed:${location}`
    : COLLAPSED_KEY + location;
}

function readCollapsed(section: GroupSection, url: string): boolean {
  try {
    return window.localStorage.getItem(collapsedKey(section, url)) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(
  section: GroupSection,
  url: string,
  collapsed: boolean
): void {
  try {
    const key = collapsedKey(section, url);

    if (collapsed) {
      window.localStorage.setItem(key, '1');
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable; the state then lasts the session.
  }
}
