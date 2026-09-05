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
  EditorInsertAction,
  FileOpenAction,
  FileWriteAction,
  IFileActionContext
} from './actions/files';
import { CopyAction, HighlightAction, ToastAction } from './actions/guidance';
import { ActionRegistry } from './actions/registry';
import { ExecuteAction, TerminalSessions } from './actions/terminal';
import { WorkshopManager } from './manager';
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
  requires: [IWorkshopManager, ILabShell, IDocumentManager, IEditorTracker],
  activate: (
    app: JupyterFrontEnd,
    manager: IWorkshopManager,
    shell: ILabShell,
    docManager: IDocumentManager,
    editorTracker: IEditorTracker
  ): IActionRegistry => {
    const terminals = new TerminalSessions({ app, shell });
    const context: IFileActionContext = {
      app,
      docManager,
      editorTracker,
      manager,
      terminals
    };
    const registry = new ActionRegistry();

    registry.register(new ExecuteAction(terminals, manager));
    registry.register(new FileWriteAction(context));
    registry.register(new FileOpenAction(context));
    registry.register(new EditorInsertAction(context));
    registry.register(new HighlightAction());
    registry.register(new ToastAction());
    registry.register(new CopyAction());

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
    const panel = new WorkshopPanel({
      manager,
      registry,
      commands: app.commands
    });

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

    if (palette) {
      for (const command of Object.values(CommandIDs)) {
        palette.addItem({ command, category: PALETTE_CATEGORY });
      }
    }

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
