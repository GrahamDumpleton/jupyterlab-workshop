import {
  ILabShell,
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, InputDialog } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStateDB } from '@jupyterlab/statedb';

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
import { CommandIDs, IActionRegistry, IWorkshopManager } from './tokens';

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
  optional: [IStateDB],
  activate: (
    app: JupyterFrontEnd,
    stateDB: IStateDB | null
  ): IWorkshopManager => {
    return new WorkshopManager({
      contents: app.serviceManager.contents,
      serverSettings: app.serviceManager.serverSettings,
      stateDB
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

    app.commands.addCommand(CommandIDs.close, {
      label: 'Close Workshop',
      isEnabled: () => manager.workshop !== null,
      execute: () => manager.close()
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
  if (!settingRegistry) {
    return '';
  }

  try {
    const settings = await settingRegistry.load(panelPlugin.id);
    const value = settings.get('defaultWorkshop').composite;

    return typeof value === 'string' ? value : '';
  } catch (error) {
    console.error('Failed to load workshop settings', error);

    return '';
  }
}

export default [managerPlugin, actionsPlugin, panelPlugin];
