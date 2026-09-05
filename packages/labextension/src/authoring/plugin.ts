import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { ILauncher } from '@jupyterlab/launcher';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITerminalTracker } from '@jupyterlab/terminal';

import { ITerminalSessions, TerminalSessions } from '../actions/terminal';
import { PANEL_ID } from '../panel/widget';
import { CommandIDs, IWorkshopManager } from '../tokens';
import { BridgeListener } from './bridge';
import { addAuthoringCommands } from './commands';
import { Recorder } from './recorder';

const PALETTE_CATEGORY = 'Workshop';

/** Commands that only tools use, kept out of the palette. */
const HIDDEN: ReadonlySet<string> = new Set([
  CommandIDs.openSource,
  CommandIDs.editAction,
  CommandIDs.deleteAction,
  CommandIDs.applyFix,
  CommandIDs.runPage,
  CommandIDs.bridgeOpen,
  CommandIDs.bridgeStatus,
  CommandIDs.bridgeRun
]);

/**
 * Author mode: commands for editing a workshop from JupyterLab, the
 * session recorder, and the bridge that lets tools outside the browser
 * drive the extension.
 */
export const authoringPlugin: JupyterFrontEndPlugin<void> = {
  id: '@educates/jupyterlab-workshop:authoring',
  description: 'Edit, record and lint workshops from JupyterLab.',
  autoStart: true,
  requires: [IWorkshopManager, ILabShell, IDocumentManager, ITerminalSessions],
  optional: [
    IEditorTracker,
    ITerminalTracker,
    ISettingRegistry,
    ICommandPalette,
    ILauncher
  ],
  activate: (
    app: JupyterFrontEnd,
    manager: IWorkshopManager,
    shell: ILabShell,
    docManager: IDocumentManager,
    terminals: TerminalSessions,
    editorTracker: IEditorTracker | null,
    terminalTracker: ITerminalTracker | null,
    settingRegistry: ISettingRegistry | null,
    palette: ICommandPalette | null,
    launcher: ILauncher | null
  ): void => {
    const recorder = new Recorder({
      app,
      manager,
      terminals,
      docManager,
      terminalTracker
    });

    addAuthoringCommands({
      app,
      manager,
      shell,
      docManager,
      editorTracker,
      settingRegistry,
      recorder,
      panelId: PANEL_ID
    });

    new BridgeListener({
      app,
      manager,
      serverSettings: app.serviceManager.serverSettings
    });

    if (palette) {
      for (const command of [
        CommandIDs.authorMode,
        CommandIDs.newWorkshop,
        CommandIDs.editPage,
        CommandIDs.editManifest,
        CommandIDs.newPage,
        CommandIDs.managePages,
        CommandIDs.insertAction,
        CommandIDs.capture,
        CommandIDs.runPageActions,
        CommandIDs.runPageChecks,
        CommandIDs.showLint,
        CommandIDs.trustPreview,
        CommandIDs.publish,
        CommandIDs.record,
        CommandIDs.recordPageBreak
      ]) {
        if (!HIDDEN.has(command)) {
          palette.addItem({ command, category: PALETTE_CATEGORY });
        }
      }
    }

    if (launcher) {
      launcher.add({
        command: CommandIDs.newWorkshop,
        category: 'Workshops',
        rank: 2
      });
    }
  }
};
