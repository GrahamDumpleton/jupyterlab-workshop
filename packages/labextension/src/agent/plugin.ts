import {
  ILabShell,
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  MainAreaWidget,
  showErrorMessage,
  WidgetTracker
} from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { ILauncher } from '@jupyterlab/launcher';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Terminal } from '@jupyterlab/terminal';
import { UUID } from '@lumino/coreutils';

import { BRIDGE_CLIENT_ID } from '../authoring/bridge';
import { BROWSER_ID, WorkshopBrowser } from '../browser/widget';
import type { LibraryService } from '../library/service';
import { PANEL_ID } from '../panel/widget';
import { requestAPI } from '../request';
import { PANEL_PLUGIN_ID, readSetting } from '../settings';
import {
  CommandIDs,
  IFeaturePolicy,
  IPlatformInfo,
  IWorkshopManager
} from '../tokens';
import type { ConversationKind } from './connection';
import { AUTHOR_TITLE, AuthorPanel } from './panel';

/** The kind a command argument names; a workshop unless it says course. */
function kindOf(value: unknown): ConversationKind {
  return value === 'course' ? 'course' : 'workshop';
}

/** The command the layout restorer reopens Workshop Author panels with. */
const RESTORE_COMMAND = 'jupyterlab-workshop:author-restore';

/**
 * Workshop Author: an AI agent that writes and revises the library
 * owner's own workshops and courses, in a conversation in the main area.
 * It is offered only where the server has an agent installed, in a
 * workshop library, and when neither `ai-authoring` nor `personal` is
 * disabled.
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

    // The browser lists the library's workshops and courses, so one the
    // agent has just created shows there without a reload.
    const refreshBrowser = (): void => {
      for (const widget of shell.widgets('main')) {
        if (widget.id === BROWSER_ID && widget instanceof WorkshopBrowser) {
          widget.refresh();
        }
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

    // The conversation for a workshop or a course, or for a draft of a
    // new one: the panel already open for it, or a new one.
    const openPanel = async (
      path: string,
      draft = '',
      kind: ConversationKind = 'workshop'
    ): Promise<AuthorPanel> => {
      const existing = tracker.find(
        panel =>
          !panel.isDisposed &&
          (draft ? panel.draft === draft : !panel.draft && panel.path === path)
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
        draft,
        kind,
        serverSettings,
        open: () => ({
          path,
          draft,
          kind,
          directory: directoryCache,
          client: BRIDGE_CLIENT_ID,
          model: aiCache.model,
          effort: aiCache.effort
        }),
        openTerminal,
        contents: app.serviceManager.contents,
        reveal: () => {
          if (!panel.isAttached) {
            shell.add(panel, 'main');
          }

          shell.activateById(panel.id);
        },
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

      // Once a draft's workshop or course is created, its own panel takes
      // over the conversation, and the draft's panel goes. A workshop
      // promoted into a course hands over the same way, to the course's
      // conversation with the workshop named as the place to carry on.
      panel.created.connect((_, created) => {
        void openPanel(created.path, '', created.kind).then(next => {
          if (created.inside) {
            next.prefill(`About ${created.inside}: `);
          }

          panel.dispose();
          refreshBrowser();
        });
      });

      void tracker.add(panel);
      shell.add(panel, 'main');
      shell.activateById(panel.id);

      return panel;
    };

    let directoryCache = 'workshops';
    let aiCache = { model: '', effort: '' };

    app.commands.addCommand(CommandIDs.createWithAI, {
      label: args =>
        args.isLauncher
          ? AUTHOR_TITLE
          : kindOf(args.kind) === 'course'
            ? 'Workshop: Create Course with AI…'
            : 'Workshop: Create Workshop with AI…',
      caption: args =>
        kindOf(args.kind) === 'course'
          ? 'Describe a course and have an AI agent set up its repository in your library and design it with you'
          : 'Describe a workshop and have an AI agent write it in your library',
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

        // Nothing is created yet: the agent drafts the workshop or course
        // with the person and proposes a plan, and it is made only when
        // they press Create on it.
        const panel = await openPanel('', UUID.uuid4(), kindOf(args.kind));

        if (typeof args.topic === 'string' && args.topic.trim()) {
          panel.send(args.topic.trim());
        }
      }
    });

    app.commands.addCommand(CommandIDs.editWithAI, {
      label: args =>
        kindOf(args.kind) === 'course' ? 'Edit course with AI' : 'Edit with AI',
      caption: args =>
        kindOf(args.kind) === 'course'
          ? 'Design and revise this course in a conversation with Workshop Author'
          : 'Revise this workshop in a conversation with Workshop Author',
      isVisible: enabled,
      isEnabled: args => enabled() && typeof args.path === 'string',
      execute: async args => {
        const path =
          typeof args.path === 'string' ? PathExt.normalize(args.path) : '';
        const course =
          typeof args.course === 'string' ? PathExt.normalize(args.course) : '';

        await checked;

        if (!path || !enabled()) {
          return;
        }

        // A course's own conversation, from Edit course with AI.
        if (kindOf(args.kind) === 'course') {
          await openPanel(path, '', 'course');

          return;
        }

        // A workshop in a course is written in the course's conversation,
        // which opens with that workshop named as the starting point for
        // the person to say what to do with it.
        if (course) {
          const panel = await openPanel(course, '', 'course');
          const inside = path.startsWith(`${course}/`)
            ? path.slice(course.length + 1)
            : path;

          panel.prefill(`About ${inside}: `);

          return;
        }

        await openPanel(path);
      }
    });

    // Restores a workshop's or course's panel by its path, and a draft's
    // by its id, each with its kind.
    app.commands.addCommand(RESTORE_COMMAND, {
      label: AUTHOR_TITLE,
      execute: async args => {
        await checked;

        if (!enabled()) {
          return;
        }

        if (typeof args.draft === 'string' && args.draft) {
          await openPanel('', args.draft, kindOf(args.kind));
        } else if (typeof args.path === 'string' && args.path) {
          await openPanel(PathExt.normalize(args.path), '', kindOf(args.kind));
        }
      }
    });

    if (restorer) {
      void restorer.restore(tracker, {
        command: RESTORE_COMMAND,
        args: panel =>
          panel.draft
            ? { draft: panel.draft, kind: panel.kind }
            : { path: panel.path, kind: panel.kind },
        name: panel => (panel.draft ? `draft:${panel.draft}` : panel.path)
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
      palette?.addItem({
        command: CommandIDs.createWithAI,
        category: 'Workshop',
        args: { kind: 'course' }
      });
    });

    features.changed.connect(() => {
      app.commands.notifyCommandChanged(CommandIDs.createWithAI);
      app.commands.notifyCommandChanged(CommandIDs.editWithAI);
    });
  }
};

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
