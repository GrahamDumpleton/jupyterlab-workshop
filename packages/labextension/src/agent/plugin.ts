import {
  ILabShell,
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  ICommandPalette,
  MainAreaWidget,
  showDialog,
  showErrorMessage,
  WidgetTracker
} from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { ILauncher } from '@jupyterlab/launcher';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Terminal } from '@jupyterlab/terminal';
import { Widget } from '@lumino/widgets';
import {
  joinLibraryPath,
  normalizeWorkshopsDirectory,
  PERSONAL_DIRECTORY,
  slugify
} from '@jupyterlab-workshop/core';

import { BRIDGE_CLIENT_ID } from '../authoring/bridge';
import type { LibraryService } from '../library/service';
import { PANEL_ID } from '../panel/widget';
import { requestAPI } from '../request';
import { PANEL_PLUGIN_ID, readSetting } from '../settings';
import {
  CommandIDs,
  errorMessage,
  IFeaturePolicy,
  IPlatformInfo,
  IWorkshopManager
} from '../tokens';
import { AUTHOR_TITLE, AuthorPanel } from './panel';

/**
 * Workshop Author: an AI agent that writes and revises the library
 * owner's own workshops, in a conversation in the main area. It is
 * offered only where the server has an agent installed, in a workshop
 * library, and when neither `ai-authoring` nor `personal` is disabled.
 */
export const agentPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab-workshop/labextension:agent',
  description: 'Write and revise your own workshops with an AI agent.',
  autoStart: true,
  requires: [IWorkshopManager, IFeaturePolicy, ILabShell],
  optional: [ILayoutRestorer, ILauncher, ISettingRegistry, ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    manager: IWorkshopManager,
    features: IFeaturePolicy,
    shell: ILabShell,
    restorer: ILayoutRestorer | null,
    launcher: ILauncher | null,
    settingRegistry: ISettingRegistry | null,
    palette: ICommandPalette | null
  ): void => {
    const serverSettings = app.serviceManager.serverSettings;
    const tracker = new WidgetTracker<AuthorPanel>({
      namespace: 'jupyterlab-workshop-author'
    });
    let installed = false;

    const enabled = (): boolean =>
      installed &&
      features.enabled('ai-authoring') &&
      features.enabled('personal') &&
      features.enabled('library');

    // Whether the server has an agent at all; in JupyterLite there is no
    // server to ask, and nothing is offered. The commands wait for the
    // answer, since the layout restorer may run them before it arrives.
    const checked: Promise<void> = requestAPI<Partial<IPlatformInfo>>(
      'platform',
      serverSettings
    )
      .then(platform => {
        installed = platform.agent === true;
      })
      .catch(() => {
        installed = false;
      })
      .then(() => {
        app.commands.notifyCommandChanged(CommandIDs.createWithAI);
        app.commands.notifyCommandChanged(CommandIDs.editWithAI);
      });

    const library = (): LibraryService | null =>
      (manager as { library?: LibraryService | null }).library ?? null;

    const workshopsDirectory = (): Promise<string> =>
      readSetting(settingRegistry, 'workshopsDirectory', 'workshops');

    // Whether the workshops directory is a library: Workshop Author
    // writes into its personal tree, and works on nothing else.
    const inLibrary = async (): Promise<boolean> => {
      const service = library();

      try {
        return (
          service !== null &&
          (await service.read(await workshopsDirectory())) !== null
        );
      } catch {
        return false;
      }
    };

    const openTerminal = async (
      cwd: string,
      command: string
    ): Promise<void> => {
      const session = await app.serviceManager.terminals.startNew(
        cwd ? { cwd } : {}
      );
      const widget = new MainAreaWidget({ content: new Terminal(session, {}) });

      widget.title.label = AUTHOR_TITLE;
      widget.title.closable = true;
      shell.add(widget, 'main', { mode: 'split-bottom' });
      shell.activateById(widget.id);

      session.send({ type: 'stdin', content: [`${command}\r`] });
    };

    // The conversation for a workshop: the panel already open for it, or
    // a new one.
    const openPanel = async (path: string): Promise<AuthorPanel> => {
      const existing = tracker.find(
        panel => panel.path === path && !panel.isDisposed
      );

      if (existing) {
        // A panel taken out of the main area is put back before showing.
        if (!existing.isAttached) {
          shell.add(existing, 'main');
        }

        shell.activateById(existing.id);

        return existing;
      }

      const panel = new AuthorPanel({
        path,
        serverSettings,
        open: () => ({
          path,
          directory: directoryCache,
          client: BRIDGE_CLIENT_ID,
          model: aiCache.model,
          effort: aiCache.effort
        }),
        openTerminal,
        openWorkshop: async () => {
          await manager.open(path);

          if (manager.workshop?.path === path) {
            await manager.setAuthoring(true);
            shell.activateById(PANEL_ID);
          }
        }
      });

      // The settings are read before the socket opens, so the open message
      // can carry them without waiting.
      directoryCache = await workshopsDirectory();
      aiCache = await readAi(settingRegistry);

      void tracker.add(panel);
      shell.add(panel, 'main');
      shell.activateById(panel.id);

      return panel;
    };

    let directoryCache = 'workshops';
    let aiCache = { model: '', effort: '' };

    app.commands.addCommand(CommandIDs.createWithAI, {
      label: args =>
        args.isLauncher ? AUTHOR_TITLE : 'Workshop: Create Workshop with AI…',
      caption:
        'Describe a workshop and have an AI agent write it in your library',
      isVisible: enabled,
      isEnabled: enabled,
      execute: async args => {
        await checked;

        if (!enabled()) {
          return;
        }

        if (!(await inLibrary())) {
          await showErrorMessage(
            AUTHOR_TITLE,
            'Workshop Author writes into a workshop library. Start one with `jupyter workshop library`.'
          );

          return;
        }

        const request =
          typeof args.topic === 'string'
            ? { topic: args.topic, name: String(args.name ?? '') }
            : await askForWorkshop();

        if (!request) {
          return;
        }

        const directory = normalizeWorkshopsDirectory(
          await workshopsDirectory()
        );
        const name =
          slugify(request.name || firstWords(request.topic)) || 'new-workshop';
        const path = joinLibraryPath(
          joinLibraryPath(directory, PERSONAL_DIRECTORY),
          name
        );

        try {
          await requestAPI('init', serverSettings, {
            method: 'POST',
            body: JSON.stringify({ directory: path, name, template: 'blank' })
          });
        } catch (error) {
          await showErrorMessage(
            'Unable to create the workshop',
            errorMessage(error)
          );

          return;
        }

        const panel = await openPanel(path);

        panel.send(
          `Write this workshop, in the current directory, which has been ` +
            `scaffolded empty for it. What it should teach:\n\n${request.topic}`
        );
      }
    });

    app.commands.addCommand(CommandIDs.editWithAI, {
      label: 'Edit with AI',
      caption: 'Revise this workshop in a conversation with Workshop Author',
      isVisible: enabled,
      isEnabled: args => enabled() && typeof args.path === 'string',
      execute: async args => {
        const path = typeof args.path === 'string' ? args.path : '';

        await checked;

        if (!path || !enabled()) {
          return;
        }

        await openPanel(PathExt.normalize(path));
      }
    });

    if (restorer) {
      void restorer.restore(tracker, {
        command: CommandIDs.editWithAI,
        args: panel => ({ path: panel.path }),
        name: panel => panel.path
      });
    }

    void checked.then(async () => {
      if (!enabled() || !(await inLibrary())) {
        return;
      }

      launcher?.add({
        command: CommandIDs.createWithAI,
        category: 'Workshops',
        rank: 2,
        args: { isLauncher: true }
      });
      palette?.addItem({
        command: CommandIDs.createWithAI,
        category: 'Workshop'
      });
    });

    features.changed.connect(() => {
      app.commands.notifyCommandChanged(CommandIDs.createWithAI);
      app.commands.notifyCommandChanged(CommandIDs.editWithAI);
    });
  }
};

/** Ask what the workshop should teach, and what to call it. */
async function askForWorkshop(): Promise<{
  topic: string;
  name: string;
} | null> {
  const body = new Widget();
  const topic = document.createElement('textarea');
  const name = document.createElement('input');
  const topicLabel = document.createElement('label');
  const nameLabel = document.createElement('label');

  body.addClass('jp-WorkshopAgent-create');
  topicLabel.className = 'jp-WorkshopAgent-createField';
  nameLabel.className = 'jp-WorkshopAgent-createField';
  topic.className = 'jp-WorkshopAgent-createInput';
  name.className = 'jp-WorkshopAgent-createInput';

  topicLabel.textContent = 'What should the workshop teach?';
  topic.rows = 6;
  topic.placeholder =
    'For example: the basics of git for someone who has never used it, with a terminal, ending with a first commit';
  topicLabel.appendChild(topic);

  nameLabel.textContent = 'Directory name (optional)';
  name.placeholder = 'Made from the description when left empty';
  nameLabel.appendChild(name);

  body.node.append(topicLabel, nameLabel);

  const result = await showDialog({
    title: 'Create Workshop with AI',
    body,
    focusNodeSelector: 'textarea',
    buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Create' })]
  });

  if (!result.button.accept || !topic.value.trim()) {
    return null;
  }

  return { topic: topic.value.trim(), name: name.value.trim() };
}

/**
 * The model and effort a new conversation starts with, empty for the
 * agent's defaults.
 */
async function readAi(
  settingRegistry: ISettingRegistry | null
): Promise<{ model: string; effort: string }> {
  if (!settingRegistry) {
    return { model: '', effort: '' };
  }

  try {
    const settings = await settingRegistry.load(PANEL_PLUGIN_ID);
    const value = settings.get('ai').composite as {
      model?: unknown;
      effort?: unknown;
    } | null;

    return {
      model: typeof value?.model === 'string' ? value.model : '',
      effort: typeof value?.effort === 'string' ? value.effort : ''
    };
  } catch {
    return { model: '', effort: '' };
  }
}

/** The first few words of a description, for a directory name. */
function firstWords(text: string): string {
  return text.split(/\s+/).slice(0, 5).join(' ');
}
