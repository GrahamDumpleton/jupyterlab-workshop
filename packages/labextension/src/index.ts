import { ICollectionIndex } from '@jupyterlab-workshop/core';
import {
  ILabShell,
  ILayoutRestorer,
  IRouter,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  ICommandPalette,
  InputDialog,
  Notification,
  showDialog,
  showErrorMessage
} from '@jupyterlab/apputils';
import { Contents, ServerConnection } from '@jupyterlab/services';
import { PathExt, URLExt } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import {
  FileBrowser,
  FileDialog,
  IDefaultFileBrowser
} from '@jupyterlab/filebrowser';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { ILauncher } from '@jupyterlab/launcher';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import { ReadonlyJSONValue } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';

import {
  DownloadAction,
  EditorHighlightAction,
  EditorInsertAction,
  EditorReplaceAction,
  EditorSelectAction,
  FileBrowserRevealAction,
  FileCloseAction,
  FileOpenAction,
  FileWriteAction,
  IFileActionContext,
  UploadPromptAction
} from './actions/files';
import { ChoiceAction, EnvSetAction, NextPageAction } from './actions/flow';
import {
  CopyAction,
  DialogAction,
  HighlightAction,
  ToastAction,
  TooltipAction,
  TourAction
} from './actions/guidance';
import {
  CheckpointAction,
  FormAction,
  ICheckActionContext,
  QuizAction,
  RestoreAction,
  VerifyAction
} from './actions/checks';
import { WorkshopKernel } from './actions/kernel';
import {
  CellInsertAction,
  CellRunAction,
  CellSelectAction,
  ConsoleOpenAction,
  INotebookActionContext,
  KernelControlAction,
  KernelExecuteAction,
  NotebookCreateAction,
  NotebookOpenAction,
  OutputClearAction
} from './actions/notebook';
import { getIfExists } from './actions/contents';
import { EnvironmentCreateAction } from './actions/environment';
import { ActionRegistry } from './actions/registry';
import { IShellRunner, KernelShell, LiteShell } from './actions/shell';
import {
  ExecuteAction,
  ExecuteCaptureAction,
  ITerminalSessions,
  InterruptAction,
  SendKeyAction,
  TerminalClearAction,
  TerminalCloseAction,
  TerminalOpenAction,
  TerminalSessions,
  TerminalTypeAction
} from './actions/terminal';
import {
  ActivateAction,
  CommandAction,
  LauncherOpenAction,
  LayoutAction,
  PanelCloseAction,
  SettingsSetAction
} from './actions/ui';
import { AnalyticsRecorder } from './analytics';
import { authoringPlugin } from './authoring/plugin';
import { ServerBackend } from './backend';
import { closeWorkshopWidgets } from './cleanup';
import { featuresPlugin } from './features';
import { showCollectionsDialog } from './browser/dialog';
import { installEntry } from './browser/install';
import { loadCollection, nextAfter } from './browser/match';
import { SourceStore } from './browser/sources';
import {
  BROWSER_ID,
  IBrowserSettings,
  WorkshopBrowser
} from './browser/widget';
import { closePlaceholders, isPlaceholderMain, LayoutManager } from './layout';
import { LiteBackend } from './lite/backend';
import { isJupyterLite } from './lite/detect';
import { WorkshopManager, normalizeWorkshopPath } from './manager';
import { ActionLogWidget, LOG_ID } from './panel/log';
import { ISelfTestProgress, runAll } from './selftest';
import { INextStep, showFinishDialog } from './panel/finish';
import { showVariablesDialog } from './panel/variables';
import { PANEL_ID, WorkshopPanel } from './panel/widget';
import { STATE_FILE, WORKSHOP_STATE_DIR } from './state';
import {
  CommandIDs,
  ConflictError,
  IActionRegistry,
  IFeaturePolicy,
  IFetchRequest,
  IWorkshopManager,
  errorMessage
} from './tokens';
import { readFlag, readSetting } from './settings';
import { trustPrompts } from './trust/dialogs';
import { TrustStore, policyFromSettings } from './trust/store';
import { TriggerBus } from './verify/triggers';

export { IActionRegistry, IFeaturePolicy, IWorkshopManager } from './tokens';

const PLUGIN_PREFIX = '@jupyterlab-workshop/labextension';

const PALETTE_CATEGORY = 'Workshop';

/**
 * Provides the workshop manager that loads workshops and tracks pages.
 */
const managerPlugin: JupyterFrontEndPlugin<IWorkshopManager> = {
  id: `${PLUGIN_PREFIX}:manager`,
  description: 'Loads workshops and tracks the current page.',
  autoStart: true,
  provides: IWorkshopManager,
  requires: [IFeaturePolicy],
  optional: [IStateDB, ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    features: IFeaturePolicy,
    stateDB: IStateDB | null,
    settingRegistry: ISettingRegistry | null
  ): IWorkshopManager => {
    const trustStore = new TrustStore(stateDB);

    // Keep the administrator policy in step with the settings.
    if (settingRegistry) {
      const apply = (settings: ISettingRegistry.ISettings): void => {
        trustStore.policy = policyFromSettings({
          defaultTrustLevel: settings.get('defaultTrustLevel').composite,
          trustPolicy: settings.get('trustPolicy').composite,
          analytics: settings.get('analytics').composite
        });
      };

      settingRegistry
        .load(panelPlugin.id)
        .then(settings => {
          apply(settings);
          settings.changed.connect(apply);
        })
        .catch(error => {
          console.error('Failed to load workshop trust settings', error);
        });
    }

    // JupyterLite has no server, so its backend does the work in the
    // browser; everything else talks to the server extension.
    const backend = isJupyterLite(app)
      ? new LiteBackend({ app })
      : new ServerBackend(app.serviceManager.serverSettings);
    const manager = new WorkshopManager({
      contents: app.serviceManager.contents,
      backend,
      stateDB,
      trustStore,
      prompts: trustPrompts,
      settings: settingRegistry,
      features
    });

    // Progress events go to the workshop's events file and any sink.
    new AnalyticsRecorder({ manager, trustStore });

    return manager;
  }
};

/**
 * Provides the workshop terminals, shared by the actions and the recorder.
 */
const terminalsPlugin: JupyterFrontEndPlugin<TerminalSessions> = {
  id: `${PLUGIN_PREFIX}:terminals`,
  description: 'Manages the terminals workshop actions run in.',
  autoStart: true,
  provides: ITerminalSessions,
  requires: [IWorkshopManager, ILabShell],
  activate: (
    app: JupyterFrontEnd,
    manager: IWorkshopManager,
    shell: ILabShell
  ): TerminalSessions => new TerminalSessions({ app, shell, manager })
};

/**
 * Provides the action registry with the built-in actions registered.
 */
const actionsPlugin: JupyterFrontEndPlugin<IActionRegistry> = {
  id: `${PLUGIN_PREFIX}:actions`,
  description: 'Implements workshop actions against JupyterLab.',
  autoStart: true,
  provides: IActionRegistry,
  requires: [IWorkshopManager, ILabShell, IDocumentManager, ITerminalSessions],
  optional: [IEditorTracker, ISettingRegistry, IStateDB],
  activate: (
    app: JupyterFrontEnd,
    manager: IWorkshopManager,
    shell: ILabShell,
    docManager: IDocumentManager,
    terminals: TerminalSessions,
    editorTracker: IEditorTracker | null,
    settingRegistry: ISettingRegistry | null,
    stateDB: IStateDB | null
  ): IActionRegistry => {
    const kernel = new WorkshopKernel(app, manager);

    // Commands run without a terminal go through the kernel on a server
    // and through the terminal extension's headless shell in JupyterLite.
    const runner: IShellRunner =
      manager.backend.kind === 'lite'
        ? new LiteShell(app.commands)
        : new KernelShell(kernel);
    const layouts = new LayoutManager({
      app,
      shell,
      manager,
      terminals,
      docManager,
      stateDB,
      panelId: PANEL_ID
    });

    app.commands.addCommand(CommandIDs.applyLayout, {
      label: 'Workshop: Reset Layout',
      caption: 'Arrange the JupyterLab panels as the open workshop asks',
      isEnabled: () => manager.workshop?.manifest.layout !== undefined,
      execute: async (): Promise<void> => {
        const name = manager.workshop?.manifest.layout;

        if (name) {
          await layouts.apply(name);
        }
      }
    });
    const files: IFileActionContext = {
      app,
      docManager,
      editorTracker,
      manager,
      terminals
    };
    const notebooks: INotebookActionContext = {
      app,
      docManager,
      manager,
      terminals,
      kernel
    };
    const checks: ICheckActionContext = {
      app,
      docManager,
      manager,
      terminals,
      kernel,
      notebooks,
      shell: runner
    };
    const registry = new ActionRegistry();

    const implementations = [
      new ExecuteAction(terminals, manager),
      new ExecuteCaptureAction(runner, manager),
      new TerminalOpenAction(terminals, shell, manager),
      new TerminalClearAction(terminals, manager),
      new TerminalCloseAction(terminals),
      new TerminalTypeAction(terminals, manager),
      new SendKeyAction(terminals, manager),
      new InterruptAction(terminals, manager),
      new FileWriteAction(files),
      new FileOpenAction(files),
      new FileCloseAction(files),
      new EditorInsertAction(files),
      new EditorReplaceAction(files),
      new EditorSelectAction(files),
      new EditorHighlightAction(files),
      new FileBrowserRevealAction(files),
      new DownloadAction(files),
      new UploadPromptAction(files),
      new NotebookOpenAction(notebooks),
      new NotebookCreateAction(notebooks),
      new CellInsertAction(notebooks),
      new CellRunAction(notebooks, 'one'),
      new CellRunAction(notebooks, 'all'),
      new CellRunAction(notebooks, 'to'),
      new CellSelectAction(notebooks, false),
      new CellSelectAction(notebooks, true),
      new KernelControlAction(notebooks, 'restart'),
      new KernelControlAction(notebooks, 'interrupt'),
      new KernelControlAction(notebooks, 'select'),
      new KernelExecuteAction(notebooks),
      new ConsoleOpenAction(notebooks),
      new OutputClearAction(notebooks),
      new CommandAction(app),
      new LayoutAction(layouts),
      new ActivateAction(shell, 'panel-open'),
      new ActivateAction(shell, 'focus'),
      new PanelCloseAction(shell),
      new SettingsSetAction(settingRegistry),
      new LauncherOpenAction(app),
      new HighlightAction(),
      new TooltipAction(),
      new TourAction(),
      new ToastAction(),
      new DialogAction(),
      new CopyAction(),
      new VerifyAction(checks),
      new QuizAction(),
      new FormAction(),
      new CheckpointAction(manager),
      new RestoreAction(manager),
      new ChoiceAction(manager),
      new EnvSetAction(manager),
      new NextPageAction(manager),
      new EnvironmentCreateAction(manager)
    ];

    for (const implementation of implementations) {
      registry.register(implementation);
    }

    manager.registry = registry;

    // Keep open terminals in step with the variables.
    manager.environmentChanged.connect(() => terminals.refreshEnvironment());

    // Verifies re-run on the events they listen for.
    new TriggerBus({ app, manager, terminals });

    // When the workshop changes, shut the hidden kernel down, check the
    // tools a newly opened workshop requires, and arrange the panels as its
    // layout asks (the first time it is opened here, from a launch link, or
    // after a restart). Each opening has its own session id, so a restart
    // of the same workshop counts as a new one.
    let openSession = '';

    manager.changed.connect(() => {
      const workshop = manager.workshop;
      const session = manager.sessionId;

      if (session !== openSession) {
        openSession = session;
        void kernel.shutdown();

        if (workshop) {
          void runPreflight(manager);
          layouts.applyOnOpen(workshop).catch(error => {
            console.warn('Unable to apply the workshop layout', error);
          });
        }
      }
    });

    return registry;
  }
};

/**
 * Adds the instructions panel to the left sidebar and the commands that
 * drive it.
 */
const panelPlugin: JupyterFrontEndPlugin<void> = {
  id: `${PLUGIN_PREFIX}:panel`,
  description: 'Shows workshop instructions in the left sidebar.',
  autoStart: true,
  requires: [
    IWorkshopManager,
    IActionRegistry,
    ILabShell,
    IDocumentManager,
    IFeaturePolicy,
    ITerminalSessions
  ],
  optional: [
    ISettingRegistry,
    ICommandPalette,
    ILayoutRestorer,
    IDefaultFileBrowser,
    ILauncher,
    IRouter
  ],
  activate: (
    app: JupyterFrontEnd,
    manager: IWorkshopManager,
    registry: IActionRegistry,
    shell: ILabShell,
    docManager: IDocumentManager,
    features: IFeaturePolicy,
    terminals: TerminalSessions,
    settingRegistry: ISettingRegistry | null,
    palette: ICommandPalette | null,
    restorer: ILayoutRestorer | null,
    fileBrowser: FileBrowser | null,
    launcher: ILauncher | null,
    router: IRouter | null
  ): void => {
    const panel = new WorkshopPanel({
      manager,
      commands: app.commands,
      features
    });

    // Disabling a feature greys out its commands everywhere at once.
    features.changed.connect(() => app.commands.notifyCommandChanged());

    // Leaving a workshop takes its documents and terminals off the screen
    // too, so the next thing opened does not land among them.
    const cleanup = { shell, docManager, terminals };
    const closeWorkshop = async (): Promise<void> => {
      const path = manager.workshop?.path;

      if (path !== undefined) {
        await closeWorkshopWidgets(cleanup, path);
      }

      await manager.close();
    };

    // Start on the right; a saved layout or the setting may move it.
    shell.add(panel, 'right', { rank: 600 });

    if (restorer) {
      restorer.add(panel, PANEL_ID);
    }

    void readSetting(settingRegistry, 'panelSide', 'right').then(side => {
      if (side === 'left' && !panel.isDisposed) {
        shell.add(panel, 'left', { rank: 600 });
      }
    });

    // Commands.
    const workshopsDirectory = (): Promise<string> =>
      readSetting(settingRegistry, 'workshopsDirectory', 'workshops');

    // With opening directories disabled, the installed workshops (those
    // under the workshops directory) stay openable, from the browser or
    // a launch link, and anything else is refused.
    const mayOpenDirectory = async (path: string): Promise<boolean> => {
      if (features.enabled('open-directory')) {
        return true;
      }

      const target = normalizeWorkshopPath(path);
      const installed = await manager.installed(await workshopsDirectory());

      return installed.some(item => item.path === target);
    };

    const openWorkshopAt = async (path: string): Promise<void> => {
      if (!(await mayOpenDirectory(path))) {
        await showErrorMessage(
          'Not available',
          'Opening other workshop directories is disabled here.'
        );

        return;
      }

      // Refuse early with a clear message rather than a parse error.
      const manifest = await getIfExists(
        app.serviceManager.contents,
        PathExt.join(path, 'workshop.yaml'),
        false
      );

      if (!manifest) {
        await showErrorMessage(
          'Not a workshop',
          `${path || 'The JupyterLab root'} has no workshop.yaml file.`
        );

        return;
      }

      await manager.open(path);
      shell.activateById(panel.id);
    };

    app.commands.addCommand(CommandIDs.open, {
      label: 'Open Workshop…',
      caption: 'Choose a workshop directory to open',
      isEnabled: () => features.enabled('open-directory'),
      execute: async (args): Promise<void> => {
        let path = typeof args.path === 'string' ? args.path : '';

        if (!path && !features.enabled('open-directory')) {
          return;
        }

        if (!path) {
          const result = await FileDialog.getExistingDirectory({
            manager: docManager,
            title: 'Open Workshop',
            label: 'Choose a directory containing a workshop.yaml file',
            defaultPath: manager.workshop?.path
          });
          const chosen = result.value?.[0];

          if (!result.button.accept || !chosen) {
            return;
          }

          path = chosen.path;
        }

        await openWorkshopAt(path);
      }
    });

    app.commands.addCommand(CommandIDs.openPath, {
      label: 'Open Workshop Path…',
      caption: 'Open a workshop directory by typing its path',
      isEnabled: () => features.enabled('open-directory'),
      execute: async (): Promise<void> => {
        if (!features.enabled('open-directory')) {
          return;
        }

        const result = await InputDialog.getText({
          title: 'Open Workshop',
          label: 'Workshop directory (relative to the JupyterLab root)',
          text: manager.workshop?.path ?? ''
        });

        if (!result.button.accept || result.value === null) {
          return;
        }

        await openWorkshopAt(result.value.trim());
      }
    });

    // Right-clicking a directory in the file browser offers to open it.
    const selectedDirectory = (): Contents.IModel | null => {
      if (!fileBrowser) {
        return null;
      }

      for (const item of fileBrowser.selectedItems()) {
        return item.type === 'directory' ? item : null;
      }

      return null;
    };

    app.commands.addCommand(CommandIDs.openSelected, {
      label: 'Open as Workshop',
      caption: 'Open the selected directory as a workshop',
      isVisible: () =>
        features.enabled('open-directory') && selectedDirectory() !== null,
      execute: async (): Promise<void> => {
        const item = selectedDirectory();

        if (item) {
          await openWorkshopAt(item.path);
        }
      }
    });

    app.contextMenu.addItem({
      command: CommandIDs.openSelected,
      selector: '.jp-DirListing-item[data-isdir="true"]',
      rank: 5
    });

    app.commands.addCommand(CommandIDs.openUrl, {
      label: 'Open Workshop from URL…',
      caption:
        'Download a workshop from a git repository or archive URL and open it',
      isEnabled: () => features.enabled('open-url'),
      execute: async (args): Promise<void> => {
        let url = typeof args.url === 'string' ? args.url : '';
        const ref = typeof args.ref === 'string' ? args.ref : undefined;
        const subdir =
          typeof args.subdir === 'string' ? args.subdir : undefined;
        const sha256 =
          typeof args.sha256 === 'string' ? args.sha256 : undefined;
        const archive = args.archive === true;
        const name = typeof args.name === 'string' ? args.name : undefined;
        const collection =
          typeof args.collection === 'string' ? args.collection : undefined;
        const variables = isStringRecord(args.variables)
          ? args.variables
          : undefined;
        const launch = args.launch === true;

        // The browser installs without opening: the workshop is listed
        // under Installed, where Open starts it.
        const open = args.open !== false;

        // With URLs disabled, only the sources the subscribed collections
        // list may be fetched: the browser's Install and Update still work.
        if (!features.enabled('open-url')) {
          if (!url || !(await sourceListed(url, ref, subdir))) {
            if (url) {
              await showErrorMessage(
                'Not available',
                'Opening workshops from other URLs is disabled here.'
              );
            }

            return;
          }
        }

        if (!url) {
          const result = await InputDialog.getText({
            title: 'Open Workshop from URL',
            label:
              'Repository URL (a GitHub tree URL may name a branch and directory) or archive URL',
            placeholder: 'https://github.com/owner/repo/tree/main/workshop'
          });

          if (!result.button.accept || !result.value) {
            return;
          }

          url = result.value.trim();
        }

        const directory = await workshopsDirectory();
        const path = await fetchWorkshop(manager, {
          url,
          ref,
          subdir,
          sha256,
          archive,
          directory,
          name,
          collection
        });

        if (path && open) {
          await manager.open(path, { variables, launch });
          shell.activateById(panel.id);
        }
      }
    });

    // The browser lists the subscribed collections and the installed
    // workshops in the main area. A launch link can add a collection or
    // a catalog for the session.
    const store = new SourceStore({ settingRegistry, features });
    const readBrowserSettings = async (): Promise<IBrowserSettings> => ({
      workshopsDirectory: await workshopsDirectory()
    });

    // Whether a source is one a subscribed collection lists.
    const sourceListed = async (
      url: string,
      ref: string | undefined,
      subdir: string | undefined
    ): Promise<boolean> => {
      for (const subscribed of await store.list('collection')) {
        let index: ICollectionIndex;

        try {
          index = await manager.fetchCollection(subscribed.url);
        } catch (error) {
          console.warn(
            `Unable to read the collection ${subscribed.url}`,
            error
          );

          continue;
        }

        for (const entry of index.workshops) {
          for (const version of entry.versions) {
            const source = version.source;
            const listed =
              source.archive !== undefined
                ? source.archive === url
                : source.git === url &&
                  (source.subdir ?? '') === (subdir ?? '') &&
                  (ref === undefined || (source.ref ?? '') === ref);

            if (listed) {
              return true;
            }
          }
        }
      }

      return false;
    };
    let browser: WorkshopBrowser | null = null;

    // Start a session in the browser: in a fresh workspace it takes the
    // launcher's place and both sidebars collapse until a workshop opens.
    const startBrowsing = async (): Promise<void> => {
      const fresh = isPlaceholderMain(shell);

      await app.commands.execute(CommandIDs.browse);

      if (fresh) {
        closePlaceholders(shell);
        shell.collapseLeft();
        shell.collapseRight();
      }
    };

    app.commands.addCommand(CommandIDs.browse, {
      label: 'Browse Workshops',
      caption: 'Find, install, resume and remove workshops',
      icon: args => (args.isLauncher ? panel.title.icon : undefined),
      isEnabled: () => features.enabled('browse'),
      execute: (): void => {
        if (!browser || browser.isDisposed) {
          browser = new WorkshopBrowser({
            manager,
            commands: app.commands,
            features,
            store,
            readSettings: readBrowserSettings
          });
        }

        if (!browser.isAttached) {
          shell.add(browser, 'main');
        } else {
          browser.refresh();
        }

        shell.activateById(BROWSER_ID);
      }
    });

    if (launcher && features.enabled('browse')) {
      launcher.add({
        command: CommandIDs.browse,
        category: 'Workshops',
        rank: 1,
        args: { isLauncher: true }
      });
    }

    app.commands.addCommand(CommandIDs.collections, {
      label: 'Workshop: Collections…',
      caption:
        'See, subscribe to and unsubscribe from workshop collections and catalogs',
      isEnabled: () =>
        store.canChange('collection') || store.canChange('catalog'),
      execute: async (args): Promise<void> => {
        await showCollectionsDialog({
          manager,
          store,
          tab: args.tab === 'catalog' ? 'catalog' : 'collection'
        });
        browser?.refresh();
      }
    });

    // A `restart` on a launch link starts the workshop over before it
    // opens: without asking when forced or when there is no progress to
    // lose, otherwise only if the learner agrees.
    const confirmLinkRestart = async (
      path: string,
      mode: 'ask' | 'force'
    ): Promise<boolean> => {
      if (mode === 'force') {
        return true;
      }

      const started = await getIfExists(
        app.serviceManager.contents,
        PathExt.join(path, WORKSHOP_STATE_DIR, STATE_FILE),
        false
      );

      if (!started) {
        return true;
      }

      const result = await showDialog({
        title: 'Restart the workshop?',
        body: 'This link starts the workshop over. The files in the workshop directory will be put back as they were when it was first opened, anything added since will be deleted, and all progress will be forgotten. Cancel to carry on where you left off.',
        buttons: [
          Dialog.cancelButton({ label: 'Carry on' }),
          Dialog.warnButton({ label: 'Restart' })
        ]
      });

      return result.button.accept;
    };

    // A launch link such as `/lab?workshop=<url>&ref=<ref>&var.x=y`
    // fetches (or opens, for a path) the workshop and applies the values;
    // `/lab?collection=<url>` or `/lab?catalog=<url>` adds it for the
    // session and opens the browser; `/lab?collection=<url>&workshop=<name>`
    // installs that workshop of the collection and opens it.
    app.commands.addCommand(CommandIDs.launch, {
      label: 'Open Workshop from Launch Link',
      execute: (args): void => {
        const search =
          typeof args.search === 'string'
            ? args.search
            : window.location.search;
        const request = parseLaunchLink(search);
        const sources = parseSourceLink(search);

        if (!request && !sources.collection && !sources.catalog) {
          return;
        }

        // The router waits for this command and the layout restore needs
        // the routing to finish, so the work is deferred rather than
        // awaited here, and the URL is only rewritten once restored.
        const launch = async (): Promise<void> => {
          await app.restored;

          if (router) {
            const location = router.current;
            const remaining = stripLaunchParams(location.search ?? '');

            router.navigate(`${location.path}${remaining}${location.hash}`, {
              skipRouting: true
            });
          }

          if (sources.collection) {
            await store.addForSession('collection', sources.collection);
          }

          if (sources.catalog) {
            await store.addForSession('catalog', sources.catalog);
          }

          if (!request) {
            await startBrowsing();

            return;
          }

          // A bare name with a collection is looked up in that collection
          // and installed from it, so the install records where it came
          // from as the browser's Install button would.
          if (request.collection !== undefined) {
            const index = await manager.fetchCollection(request.collection);
            const entry = index.workshops.find(
              item => item.name === request.url
            );

            if (!entry) {
              Notification.error(
                `The collection ${request.collection} has no workshop named ${request.url}.`
              );

              return;
            }

            const installed = await manager.installed(
              await workshopsDirectory()
            );

            await installEntry(
              app.commands,
              request.collection,
              entry,
              installed,
              { variables: request.variables, launch: true }
            );

            return;
          }

          if (request.path !== undefined) {
            if (!(await mayOpenDirectory(request.path))) {
              Notification.error(
                'Opening other workshop directories is disabled here.'
              );

              return;
            }

            if (
              request.restart &&
              (await confirmLinkRestart(request.path, request.restart))
            ) {
              await closeWorkshopWidgets(cleanup, request.path);
              await manager.restart(request.path);
            }

            await manager.open(request.path, {
              variables: request.variables,
              launch: true
            });
            shell.activateById(panel.id);

            return;
          }

          await app.commands.execute(CommandIDs.openUrl, {
            url: request.url,
            ref: request.ref,
            subdir: request.subdir,
            sha256: request.sha256,
            variables: request.variables,
            launch: true
          });
        };

        launch().catch(error => {
          console.error(
            'Unable to open the workshop from the launch link',
            error
          );
        });
      }
    });

    if (router) {
      router.register({
        command: CommandIDs.launch,
        pattern: /(\?|&)(workshop|collection|catalog)=/,
        rank: 20
      });
    }

    app.commands.addCommand(CommandIDs.exportEvents, {
      label: 'Workshop: Export Progress Events',
      caption:
        'Download the events file recording pages, actions and check results',
      isEnabled: () => manager.workshop !== null,
      execute: async (): Promise<void> => {
        const workshop = manager.workshop;

        if (!workshop) {
          return;
        }

        const path = PathExt.join(
          workshop.path,
          WORKSHOP_STATE_DIR,
          'events.jsonl'
        );
        const exists = await getIfExists(
          app.serviceManager.contents,
          path,
          false
        );

        if (!exists) {
          await showErrorMessage(
            'No events yet',
            'Nothing has been recorded for this workshop so far.'
          );

          return;
        }

        const url = await app.serviceManager.contents.getDownloadUrl(path);

        window.open(url, '_blank', 'noopener');
      }
    });

    app.commands.addCommand(CommandIDs.createEnvironment, {
      label: 'Workshop: Create Environment',
      caption:
        'Create the isolated Python environment the workshop declares and register its kernel',
      isEnabled: () =>
        manager.workshop?.manifest.environment?.requirements !== undefined,
      execute: () =>
        manager.runRequest(
          {
            type: 'environment-create',
            id: 'environment-create',
            argument: '',
            options: {},
            body: ''
          },
          'click'
        )
    });

    app.commands.addCommand(CommandIDs.close, {
      label: 'Close Workshop',
      isEnabled: () => manager.workshop !== null && features.enabled('close'),
      execute: () => closeWorkshop()
    });

    app.commands.addCommand(CommandIDs.trust, {
      label: 'Workshop: Change Trust Level…',
      isEnabled: () => manager.workshop !== null,
      execute: () => manager.reviewTrust()
    });

    app.commands.addCommand(CommandIDs.reset, {
      label: 'Workshop: Reset Progress…',
      isEnabled: () => manager.workshop !== null,
      execute: async (): Promise<void> => {
        const result = await showDialog({
          title: 'Reset workshop progress?',
          body: 'Page progress, action results, captured variables and the action log will be forgotten and the workshop will reopen at its first page.',
          buttons: [
            Dialog.cancelButton(),
            Dialog.warnButton({ label: 'Reset' })
          ]
        });

        if (result.button.accept) {
          await manager.reset();
        }
      }
    });

    app.commands.addCommand(CommandIDs.uninstall, {
      label: 'Workshop: Remove…',
      isEnabled: () => manager.workshop !== null && features.enabled('remove'),
      execute: async (): Promise<void> => {
        const plan = manager.uninstallPlan();
        const title = manager.workshop?.manifest.title ?? '';

        if (!plan || !features.enabled('remove')) {
          return;
        }

        const result = await showDialog({
          title: `Remove workshop "${title}"?`,
          body: new UninstallBody(plan.steps),
          buttons: [
            Dialog.cancelButton(),
            Dialog.warnButton({ label: 'Remove' })
          ]
        });

        if (!result.button.accept) {
          return;
        }

        try {
          const path = manager.workshop?.path;

          if (path !== undefined) {
            await closeWorkshopWidgets(cleanup, path);
          }

          await manager.uninstall();
          Notification.success(`Removed workshop "${title}"`, {
            autoClose: 4000
          });
        } catch (error) {
          await showErrorMessage(
            'Unable to remove the workshop',
            errorMessage(error)
          );
        }
      }
    });

    // Restart puts the files back from the snapshot taken when the
    // workshop was first opened. A path restarts an installed workshop
    // that is not open, as the browser's Restart button asks.
    app.commands.addCommand(CommandIDs.restart, {
      label: 'Workshop: Restart…',
      caption:
        'Put the files back as they were when the workshop was first opened and forget all progress',
      isEnabled: () => manager.workshop !== null,
      execute: async (args): Promise<void> => {
        const path = typeof args.path === 'string' ? args.path : undefined;
        const title =
          typeof args.title === 'string'
            ? args.title
            : (manager.workshop?.manifest.title ?? '');

        if (path === undefined && !manager.workshop) {
          return;
        }

        const result = await showDialog({
          title: `Restart workshop "${title}"?`,
          body: 'The files in the workshop directory will be put back as they were when the workshop was first opened, anything added since will be deleted, and all progress will be forgotten.',
          buttons: [
            Dialog.cancelButton(),
            Dialog.warnButton({ label: 'Restart' })
          ]
        });

        if (!result.button.accept) {
          return;
        }

        try {
          const target = path ?? manager.workshop?.path;

          if (target !== undefined) {
            await closeWorkshopWidgets(cleanup, target);
          }

          const outcome = await manager.restart(path);

          if (!outcome.files) {
            Notification.warning(
              'Progress was forgotten but the files were kept: the workshop was first opened before a snapshot of them was taken.',
              { autoClose: 8000 }
            );
          }
        } catch (error) {
          console.error('Unable to restart the workshop', error);
          await showErrorMessage(
            'Unable to restart the workshop',
            errorMessage(error)
          );
        }
      }
    });

    app.commands.addCommand(CommandIDs.nextPage, {
      label: 'Workshop: Next Page',
      isEnabled: () => manager.workshop !== null,
      execute: () => manager.next()
    });

    app.commands.addCommand(CommandIDs.previousPage, {
      label: 'Workshop: Previous Page',
      isEnabled: () => manager.workshop !== null,
      execute: () => manager.previous()
    });

    // The workshop that follows the open one in its ordered collection,
    // for the Finish dialog to offer: the installed copy is opened, and
    // one not installed yet is installed and then opened.
    const nextStep = async (): Promise<INextStep | undefined> => {
      const workshop = manager.workshop;

      if (!workshop) {
        return undefined;
      }

      const installed = await manager.installed(await workshopsDirectory());
      const current = installed.find(item => item.path === workshop.path);

      if (!current) {
        return undefined;
      }

      const subscribed = await store.list('collection');
      const collections = await Promise.all(
        subscribed.map(item => loadCollection(manager, item))
      );
      const next = nextAfter(current, installed, collections);

      if (!next) {
        return undefined;
      }

      const target = next.installed;

      return {
        title: next.entry.title,
        collection: next.collection.title,
        installed: target !== undefined,
        run: async (): Promise<void> => {
          await closeWorkshop();

          if (target) {
            await openWorkshopAt(target.path);
          } else {
            await installEntry(
              app.commands,
              next.collection.url,
              next.entry,
              installed,
              { open: true }
            );
          }
        }
      };
    };

    // Finish marks the last page done and offers what to do next; the
    // panel's "What next?" link reopens the dialog after that.
    app.commands.addCommand(CommandIDs.finish, {
      label: 'Workshop: Finish…',
      caption: 'Mark the last page done and choose what to do next',
      isEnabled: () =>
        manager.currentPage !== null &&
        manager.pageIndex === manager.visiblePages.length - 1,
      execute: async (): Promise<void> => {
        if (!manager.workshop) {
          return;
        }

        manager.finish();
        await showFinishDialog({
          manager,
          features,
          commands: app.commands,
          next: await nextStep(),
          close: closeWorkshop,
          browse: async (): Promise<void> => {
            await closeWorkshop();
            await startBrowsing();
          }
        });
      }
    });

    app.commands.addCommand(CommandIDs.variables, {
      label: 'Workshop: Variables…',
      isEnabled: () => manager.workshop !== null,
      execute: () => showVariablesDialog(manager)
    });

    app.commands.addCommand(CommandIDs.stopChain, {
      label: 'Workshop: Stop Running Actions',
      isEnabled: () => manager.chainRunning,
      execute: () => manager.stopChain()
    });

    let logWidget: ActionLogWidget | null = null;

    app.commands.addCommand(CommandIDs.showLog, {
      label: 'Workshop: Show Action Log',
      execute: () => {
        if (!logWidget || logWidget.isDisposed) {
          logWidget = new ActionLogWidget(manager);
        }

        if (!logWidget.isAttached) {
          shell.add(logWidget, 'main', { mode: 'split-right' });
        }

        shell.activateById(LOG_ID);
      }
    });

    // The self-test harness opens a workshop and runs everything in it.
    // It polls the progress command while the run is going so that a
    // run it has to abandon still reports what happened up to then.
    let selfTestProgress: ISelfTestProgress = { results: [], current: null };

    app.commands.addCommand(CommandIDs.runAll, {
      label: 'Workshop: Run Every Action (self-test)',
      caption:
        'Run every action, check, quiz and form of the open workshop in order and report the results',
      isEnabled: () => manager.workshop !== null,
      execute: async (args): Promise<unknown> => {
        const path = typeof args.path === 'string' ? args.path : '';
        const actionTimeoutMs =
          typeof args.actionTimeout === 'number' && args.actionTimeout > 0
            ? args.actionTimeout * 1000
            : undefined;

        if (path && manager.workshop?.path !== path) {
          await manager.open(path);
        }

        selfTestProgress = { results: [], current: null };

        const report = await runAll(manager, {
          actionTimeoutMs,
          onProgress: progress => {
            selfTestProgress = progress;
          }
        });

        return report as unknown as ReadonlyJSONValue;
      }
    });

    app.commands.addCommand(CommandIDs.selfTestProgress, {
      label: 'Workshop: Self-test Progress',
      caption: 'Report how far the running self-test has got',
      execute: (): ReadonlyJSONValue =>
        selfTestProgress as unknown as ReadonlyJSONValue
    });

    // Only the commands this plugin registers go in the palette; the
    // authoring plugin adds its own. The context menu command only makes
    // sense with a selection, the self-test is for the harness and the
    // launch command for URLs, so those stay out.
    if (palette) {
      for (const command of [
        CommandIDs.open,
        CommandIDs.openPath,
        CommandIDs.openUrl,
        CommandIDs.browse,
        CommandIDs.collections,
        CommandIDs.close,
        CommandIDs.nextPage,
        CommandIDs.previousPage,
        CommandIDs.finish,
        CommandIDs.variables,
        CommandIDs.showLog,
        CommandIDs.stopChain,
        CommandIDs.trust,
        CommandIDs.reset,
        CommandIDs.restart,
        CommandIDs.uninstall,
        CommandIDs.applyLayout,
        CommandIDs.exportEvents,
        CommandIDs.createEnvironment
      ]) {
        palette.addItem({ command, category: PALETTE_CATEGORY });
      }
    }

    // Once JupyterLab has restored its layout, reopen the previous workshop
    // or fall back to the configured default, or to the browser when the
    // settings ask for it. A launch link in the URL takes precedence and
    // is handled by the router.
    void app.restored.then(async () => {
      const search = window.location.search;

      const sources = parseSourceLink(search);

      if (parseLaunchLink(search) || sources.collection || sources.catalog) {
        return;
      }

      const restored = await (manager as WorkshopManager).restore?.();

      if (restored) {
        return;
      }

      const defaultWorkshop = await readDefaultWorkshop(settingRegistry);

      if (defaultWorkshop) {
        await manager.open(defaultWorkshop);

        return;
      }

      if (await readFlag(settingRegistry, 'browseOnStart', false)) {
        await startBrowsing();
      }
    });
  }
};

async function readDefaultWorkshop(
  settingRegistry: ISettingRegistry | null
): Promise<string> {
  return readSetting(settingRegistry, 'defaultWorkshop', '');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(item => typeof item === 'string')
  );
}

/** What a launch link asks for. */
interface ILaunchRequest {
  /** A local directory to open, when the workshop parameter is not a URL. */
  path?: string;

  /**
   * The collection to install from, when the workshop parameter is a
   * bare name and the link also names a collection; `url` then holds
   * the name.
   */
  collection?: string;
  url: string;
  ref?: string;
  subdir?: string;
  sha256?: string;
  variables: Record<string, string>;

  /**
   * Whether to restart a workshop that is already present before opening
   * it: `ask` confirms first when it has recorded progress, `force` never
   * asks. Only a directory can be restarted; a download replaces its
   * files anyway.
   */
  restart?: 'ask' | 'force';
}

/** Query parameters a launch link uses. */
const LAUNCH_PARAMS: ReadonlySet<string> = new Set([
  'workshop',
  'ref',
  'subdir',
  'sha256',
  'collection',
  'catalog',
  'restart'
]);

/** The sources a launch link adds for the session. */
export interface ISourceLink {
  collection?: string;
  catalog?: string;
}

/**
 * The collection and catalog a launch link names, from its `collection`
 * and `catalog` query parameters.
 */
export function parseSourceLink(search: string): ISourceLink {
  const params = URLExt.queryStringToObject(search);
  const collection = params.collection?.trim() ?? '';
  const catalog = params.catalog?.trim() ?? '';

  return {
    collection: collection === '' ? undefined : collection,
    catalog: catalog === '' ? undefined : catalog
  };
}

/**
 * Parse the query string of a launch link, or return null when it has no
 * `workshop` parameter.
 */
export function parseLaunchLink(search: string): ILaunchRequest | null {
  const params = URLExt.queryStringToObject(search);
  const workshop = params.workshop?.trim() ?? '';

  if (workshop === '') {
    return null;
  }

  const variables: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith('var.') && key.length > 4 && value !== undefined) {
      variables[key.slice(4)] = value;
    }
  }

  const isUrl = /^https?:\/\//i.test(workshop);
  const collection = params.collection?.trim() ?? '';

  // A bare name alongside a collection is one of its workshops rather
  // than a directory.
  const fromCollection =
    !isUrl && collection !== '' && /^[a-z0-9][a-z0-9-]*$/.test(workshop);

  // A bare `restart` asks when there is progress; `restart=force` never
  // does. The key is looked for in the raw string, since a bare key has
  // no value for the parser to keep.
  const restart = /(\?|&)restart(=|&|$)/.test(search)
    ? params.restart === 'force'
      ? 'force'
      : 'ask'
    : undefined;

  return {
    path: isUrl || fromCollection ? undefined : workshop,
    collection: fromCollection ? collection : undefined,
    url: workshop,
    ref: params.ref || undefined,
    subdir: params.subdir || undefined,
    sha256: params.sha256 || undefined,
    variables,
    restart
  };
}

function stripLaunchParams(search: string): string {
  const params = URLExt.queryStringToObject(search);
  const kept: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    if (
      !LAUNCH_PARAMS.has(key) &&
      !key.startsWith('var.') &&
      value !== undefined
    ) {
      kept[key] = value;
    }
  }

  return Object.keys(kept).length > 0 ? URLExt.objectToQueryString(kept) : '';
}

/**
 * Download a workshop, offering to replace an existing directory, and
 * return the path it landed in or an empty string when nothing was
 * downloaded.
 */
async function fetchWorkshop(
  manager: IWorkshopManager,
  request: IFetchRequest
): Promise<string> {
  const notification = Notification.emit(
    `Downloading workshop from ${request.url}`,
    'in-progress',
    { autoClose: false }
  );

  try {
    const result = await manager.fetch(request);

    Notification.update({
      id: notification,
      message: `Downloaded workshop "${result.name}"`,
      type: 'success',
      autoClose: 4000
    });

    return result.path;
  } catch (error) {
    Notification.dismiss(notification);

    // A conflict means a directory of that name exists already.
    if (
      error instanceof ConflictError ||
      (error instanceof ServerConnection.ResponseError &&
        error.response.status === 409)
    ) {
      const result = await showDialog({
        title: 'Replace existing workshop?',
        body: `${error.message}. Replace it with a fresh download? Progress recorded in it will be lost.`,
        buttons: [
          Dialog.cancelButton(),
          Dialog.warnButton({ label: 'Replace' })
        ]
      });

      if (result.button.accept) {
        return fetchWorkshop(manager, { ...request, overwrite: true });
      }

      return '';
    }

    await showErrorMessage(
      'Unable to download the workshop',
      errorMessage(error)
    );

    return '';
  }
}

/**
 * Ask the backend which required tools are installed and record the result.
 */
async function runPreflight(manager: IWorkshopManager): Promise<void> {
  const workshop = manager.workshop;

  if (!workshop || workshop.manifest.requires.tools.length === 0) {
    manager.setPreflight(null);

    return;
  }

  const tools = workshop.manifest.requires.tools;
  const platform = manager.platform?.os ?? '';

  try {
    // Running each tool for its version only happens once trusted.
    const results = await manager.backend.preflight(
      tools.map(tool => ({
        name: tool.name,
        version: tool.version ?? '',
        optional: tool.optional
      })),
      manager.trust === 'trusted'
    );

    if (manager.workshop !== workshop) {
      return;
    }

    manager.setPreflight(
      results.map(result => {
        const tool = tools.find(item => item.name === result.name);

        return {
          ...result,
          hint: tool?.hint[platform] ?? tool?.hint.default ?? tool?.hint.any
        };
      })
    );
  } catch (error) {
    console.warn('Preflight check failed', error);
  }
}

/**
 * Dialog body listing what removing a workshop will do.
 */
class UninstallBody extends Widget {
  constructor(steps: string[]) {
    super();

    const list = document.createElement('ul');

    for (const step of steps) {
      const item = document.createElement('li');

      item.textContent = step;
      list.appendChild(item);
    }

    this.node.appendChild(list);
  }
}

export default [
  featuresPlugin,
  managerPlugin,
  terminalsPlugin,
  actionsPlugin,
  panelPlugin,
  authoringPlugin
];
