import {
  ILabShell,
  ILayoutRestorer,
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
import { ServerConnection } from '@jupyterlab/services';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';
import { Widget } from '@lumino/widgets';

import {
  DownloadAction,
  EditorHighlightAction,
  EditorInsertAction,
  EditorReplaceAction,
  EditorSelectAction,
  FileBrowserRevealAction,
  FileOpenAction,
  FileWriteAction,
  IFileActionContext,
  UploadPromptAction
} from './actions/files';
import {
  ChoiceAction,
  EnvSetAction,
  MarkDoneAction,
  NextPageAction
} from './actions/flow';
import {
  CopyAction,
  DialogAction,
  HighlightAction,
  ToastAction,
  TooltipAction,
  TourAction
} from './actions/guidance';
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
import { ActionRegistry } from './actions/registry';
import {
  ExecuteAction,
  ExecuteCaptureAction,
  InterruptAction,
  SendKeyAction,
  TerminalClearAction,
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
import { LayoutManager } from './layout';
import { WorkshopManager } from './manager';
import { ActionLogWidget, LOG_ID } from './panel/log';
import { showVariablesDialog } from './panel/variables';
import { PANEL_ID, WorkshopPanel } from './panel/widget';
import {
  CommandIDs,
  IActionRegistry,
  IFetchRequest,
  IWorkshopManager,
  errorMessage
} from './tokens';
import { trustPrompts } from './trust/dialogs';
import { TrustStore, policyFromSettings } from './trust/store';

export { IActionRegistry, IWorkshopManager } from './tokens';

const PLUGIN_PREFIX = '@educates/jupyterlab-workshop';

const PALETTE_CATEGORY = 'Workshop';

/**
 * Provides the workshop manager that loads workshops and tracks pages.
 */
const managerPlugin: JupyterFrontEndPlugin<IWorkshopManager> = {
  id: `${PLUGIN_PREFIX}:manager`,
  description: 'Loads workshops and tracks the current page.',
  autoStart: true,
  provides: IWorkshopManager,
  optional: [IStateDB, ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    stateDB: IStateDB | null,
    settingRegistry: ISettingRegistry | null
  ): IWorkshopManager => {
    const trustStore = new TrustStore(stateDB);

    // Keep the administrator policy in step with the settings.
    if (settingRegistry) {
      const apply = (settings: ISettingRegistry.ISettings): void => {
        trustStore.policy = policyFromSettings({
          defaultTrustLevel: settings.get('defaultTrustLevel').composite,
          trustPolicy: settings.get('trustPolicy').composite
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

    return new WorkshopManager({
      contents: app.serviceManager.contents,
      serverSettings: app.serviceManager.serverSettings,
      stateDB,
      trustStore,
      prompts: trustPrompts,
      settings: settingRegistry
    });
  }
};

/**
 * Provides the action registry with the built-in actions registered.
 */
const actionsPlugin: JupyterFrontEndPlugin<IActionRegistry> = {
  id: `${PLUGIN_PREFIX}:actions`,
  description: 'Implements workshop actions against JupyterLab.',
  autoStart: true,
  provides: IActionRegistry,
  requires: [IWorkshopManager, ILabShell, IDocumentManager],
  optional: [IEditorTracker, ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    manager: IWorkshopManager,
    shell: ILabShell,
    docManager: IDocumentManager,
    editorTracker: IEditorTracker | null,
    settingRegistry: ISettingRegistry | null
  ): IActionRegistry => {
    const terminals = new TerminalSessions({ app, shell, manager });
    const kernel = new WorkshopKernel(app, manager);
    const layouts = new LayoutManager({
      app,
      shell,
      manager,
      terminals,
      docManager,
      panelId: PANEL_ID
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
    const registry = new ActionRegistry();

    const implementations = [
      new ExecuteAction(terminals, manager),
      new ExecuteCaptureAction(kernel, manager),
      new TerminalOpenAction(terminals, shell, manager),
      new TerminalClearAction(terminals, manager),
      new TerminalTypeAction(terminals, manager),
      new SendKeyAction(terminals, manager),
      new InterruptAction(terminals, manager),
      new FileWriteAction(files),
      new FileOpenAction(files),
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
      new ChoiceAction(manager),
      new EnvSetAction(manager),
      new MarkDoneAction(manager),
      new NextPageAction(manager)
    ];

    for (const implementation of implementations) {
      registry.register(implementation);
    }

    manager.registry = registry;

    // Keep open terminals in step with the variables.
    manager.environmentChanged.connect(() => terminals.refreshEnvironment());

    // Shut the hidden kernel down when the workshop closes.
    let openPath: string | null = null;

    manager.changed.connect(() => {
      const path = manager.workshop?.path ?? null;

      if (path !== openPath) {
        openPath = path;
        void kernel.shutdown();
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
  requires: [IWorkshopManager, IActionRegistry, ILabShell],
  optional: [ISettingRegistry, ICommandPalette, ILayoutRestorer],
  activate: (
    app: JupyterFrontEnd,
    manager: IWorkshopManager,
    registry: IActionRegistry,
    shell: ILabShell,
    settingRegistry: ISettingRegistry | null,
    palette: ICommandPalette | null,
    restorer: ILayoutRestorer | null
  ): void => {
    const panel = new WorkshopPanel({ manager, commands: app.commands });

    shell.add(panel, 'left', { rank: 600 });

    if (restorer) {
      restorer.add(panel, PANEL_ID);
    }

    // Commands.
    app.commands.addCommand(CommandIDs.open, {
      label: 'Open Workshop…',
      caption: 'Open a workshop directory relative to the JupyterLab root',
      execute: async (args): Promise<void> => {
        let path = typeof args.path === 'string' ? args.path : '';

        if (!path) {
          const result = await InputDialog.getText({
            title: 'Open Workshop',
            label: 'Workshop directory (relative to the JupyterLab root)',
            text: manager.workshop?.path ?? ''
          });

          if (!result.button.accept || !result.value) {
            return;
          }

          path = result.value;
        }

        await manager.open(path);
        shell.activateById(panel.id);
      }
    });

    app.commands.addCommand(CommandIDs.openUrl, {
      label: 'Open Workshop from URL…',
      caption:
        'Download a workshop from a git repository or archive URL and open it',
      execute: async (args): Promise<void> => {
        let url = typeof args.url === 'string' ? args.url : '';
        const ref = typeof args.ref === 'string' ? args.ref : undefined;
        const subdir =
          typeof args.subdir === 'string' ? args.subdir : undefined;

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

        const directory = await readSetting(
          settingRegistry,
          'workshopsDirectory',
          'workshops'
        );
        const path = await fetchWorkshop(manager, {
          url,
          ref,
          subdir,
          directory
        });

        if (path) {
          await manager.open(path);
          shell.activateById(panel.id);
        }
      }
    });

    app.commands.addCommand(CommandIDs.close, {
      label: 'Close Workshop',
      isEnabled: () => manager.workshop !== null,
      execute: () => manager.close()
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
      isEnabled: () => manager.workshop !== null,
      execute: async (): Promise<void> => {
        const plan = manager.uninstallPlan();
        const title = manager.workshop?.manifest.title ?? '';

        if (!plan) {
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

    app.commands.addCommand(CommandIDs.markDone, {
      label: 'Workshop: Mark Page Done',
      isEnabled: () => manager.currentPage !== null,
      execute: () => manager.markDone()
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

    if (palette) {
      for (const command of Object.values(CommandIDs)) {
        palette.addItem({ command, category: PALETTE_CATEGORY });
      }
    }

    // Apply the manifest's layout whenever a workshop is opened.
    let openPath: string | null = null;

    manager.changed.connect(() => {
      const workshop = manager.workshop;
      const path = workshop?.path ?? null;

      if (path === openPath) {
        return;
      }

      openPath = path;

      if (workshop?.manifest.layout) {
        void registry.run({
          type: 'layout',
          id: 'layout',
          argument: '',
          options: { name: workshop.manifest.layout },
          body: ''
        });
      }
    });

    // Once JupyterLab has restored its layout, reopen the previous workshop
    // or fall back to the configured default.
    void app.restored.then(async () => {
      const restored = await (manager as WorkshopManager).restore?.();

      if (restored) {
        return;
      }

      const defaultWorkshop = await readDefaultWorkshop(settingRegistry);

      if (defaultWorkshop) {
        await manager.open(defaultWorkshop);
      }
    });
  }
};

async function readDefaultWorkshop(
  settingRegistry: ISettingRegistry | null
): Promise<string> {
  return readSetting(settingRegistry, 'defaultWorkshop', '');
}

async function readSetting(
  settingRegistry: ISettingRegistry | null,
  key: string,
  fallback: string
): Promise<string> {
  if (!settingRegistry) {
    return fallback;
  }

  try {
    const settings = await settingRegistry.load(panelPlugin.id);
    const value = settings.get(key).composite;

    return typeof value === 'string' ? value : fallback;
  } catch (error) {
    console.error('Failed to load workshop settings', error);

    return fallback;
  }
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
      error instanceof ServerConnection.ResponseError &&
      error.response.status === 409
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

export default [managerPlugin, actionsPlugin, panelPlugin];
