import {
  ILintMessage,
  IDirectiveDraft,
  RecordedEvent,
  addManifestCapability,
  appendBlock,
  applyFix,
  directiveExtent,
  draftBlocks,
  draftFromRecording,
  draftManifest,
  insertBlock,
  newPagePath,
  newPageSource,
  parseDirectiveContent,
  parseDirectiveInfo,
  pathStem,
  removeDirective,
  replaceDirective,
  serializeDirective,
  setFrontmatter,
  setManifestPages,
  splitFrontmatter
} from '@educates/workshop-core';
import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import {
  Dialog,
  InputDialog,
  Notification,
  showDialog,
  showErrorMessage
} from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { FileEditor, IEditorTracker } from '@jupyterlab/fileeditor';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ReadonlyJSONObject, ReadonlyJSONValue } from '@lumino/coreutils';

import { readTextFile, writeTextFile } from '../actions/contents';
import { requestAPI } from '../request';
import { runCurrentPage, summarize } from '../selftest';
import { readSetting } from '../settings';
import { WORKSHOP_STATE_DIR } from '../state';
import {
  CommandIDs,
  IActionResult,
  IWorkshopManager,
  errorMessage
} from '../tokens';
import { showTrustDialog } from '../trust/dialogs';
import { asTrustLevel } from '../trust/store';
import {
  IActionFormValue,
  IPageEntry,
  showActionFormDialog,
  showCaptureDialog,
  showNewWorkshopDialog,
  showPageManagerDialog,
  showPublishResult,
  showRecordingDialog
} from './dialogs';
import { LINT_ID, LintWidget } from './lint';
import { Recorder } from './recorder';

/** Widget factory name of the JupyterLab text editor. */
const EDITOR_FACTORY = 'Editor';

const MANIFEST_FILE = 'workshop.yaml';

/** What the authoring commands need. */
export interface IAuthoringContext {
  app: JupyterFrontEnd;
  manager: IWorkshopManager;
  shell: ILabShell;
  docManager: IDocumentManager;
  editorTracker: IEditorTracker | null;
  settingRegistry: ISettingRegistry | null;
  recorder: Recorder;

  /** Id of the instructions panel, activated after opening a workshop. */
  panelId: string;
}

/**
 * Register the author mode commands.
 */
export function addAuthoringCommands(context: IAuthoringContext): void {
  const { app, manager, shell, recorder } = context;
  const commands = app.commands;
  const contents = app.serviceManager.contents;
  const serverSettings = app.serviceManager.serverSettings;
  const isOpen = (): boolean => manager.workshop !== null;
  const isAuthoring = (): boolean => manager.authoring;

  // Files are written through an open editor when there is one, so the
  // editor never sees the file change under it.
  const writeSource = async (path: string, source: string): Promise<void> => {
    const widget = context.docManager.findWidget(path, EDITOR_FACTORY);

    if (widget && !widget.isDisposed) {
      await widget.context.ready;
      widget.context.model.sharedModel.setSource(source);
      await widget.context.save();

      return;
    }

    await writeTextFile(contents, path, source);
  };

  const workshopFile = (relative: string): string => {
    const workshop = manager.workshop;

    if (!workshop) {
      throw new Error('No workshop is open');
    }

    return PathExt.join(workshop.path, relative);
  };

  const readManifestSource = (): Promise<string> =>
    readTextFile(contents, workshopFile(MANIFEST_FILE));

  const openSource = async (relative: string, line?: number): Promise<void> => {
    const widget = context.docManager.openOrReveal(
      workshopFile(relative),
      EDITOR_FACTORY,
      undefined,
      { mode: 'split-right' }
    );

    if (!widget || line === undefined) {
      return;
    }

    await widget.context.ready;

    if (widget.content instanceof FileEditor) {
      const editor = widget.content.editor;

      editor.setCursorPosition({ line: Math.max(0, line - 1), column: 0 });
      editor.focus();
    }
  };

  // The page an insert goes into: the page open in the active editor at
  // its cursor, otherwise the end of the page the panel shows.
  const insertTarget = (): { path: string; line: number | null } | null => {
    const workshop = manager.workshop;

    if (!workshop) {
      return null;
    }

    const current = context.editorTracker?.currentWidget;

    if (current && !current.isDisposed) {
      const prefix = workshop.path === '' ? '' : `${workshop.path}/`;
      const path = current.context.path;

      if (
        path.startsWith(prefix) &&
        workshop.manifest.pages.includes(path.slice(prefix.length))
      ) {
        return {
          path: path.slice(prefix.length),
          line: current.content.editor.getCursorPosition().line + 1
        };
      }
    }

    const page = manager.currentPage;

    return page ? { path: page.path, line: null } : null;
  };

  const insertDirective = async (
    draft: IDirectiveDraft,
    target: { path: string; line: number | null }
  ): Promise<void> => {
    const workshop = manager.workshop;

    if (!workshop) {
      return;
    }

    const source = await readTextFile(contents, workshopFile(target.path));
    const text = serializeDirective(draft);
    const next =
      target.line === null
        ? appendBlock(source, text)
        : insertBlock(source, target.line, text);

    await writeSource(workshopFile(target.path), next);
    await manager.reload();
  };

  const status = (): ReadonlyJSONObject => {
    const workshop = manager.workshop;

    return {
      workshop: workshop?.path ?? null,
      title: workshop?.manifest.title ?? null,
      page: manager.currentPage?.id ?? null,
      pages: manager.visiblePages.map(page => page.id),
      authoring: manager.authoring,
      recording: recorder.recording,
      trust: manager.trust,
      error: manager.error,
      lint: {
        errors: manager.lint.filter(item => item.level === 'error').length,
        warnings: manager.lint.filter(item => item.level === 'warning').length
      }
    };
  };

  commands.addCommand(CommandIDs.authorMode, {
    label: 'Workshop: Author Mode',
    caption:
      'Edit the open workshop: a toolbar for pages and actions, live reload of the files, and lint',
    isEnabled: isOpen,
    isToggled: isAuthoring,
    execute: async (): Promise<void> => {
      await manager.setAuthoring(!manager.authoring);

      if (manager.authoring) {
        recorder.enable();
      } else if (!recorder.recording) {
        recorder.disable();
      }
    }
  });

  commands.addCommand(CommandIDs.newWorkshop, {
    label: 'Workshop: New Workshop…',
    caption: 'Scaffold a workshop directory and open it in author mode',
    execute: async (args): Promise<void> => {
      const directory = await readSetting(
        context.settingRegistry,
        'workshopsDirectory',
        'workshops'
      );
      const request = args.directory
        ? {
            directory: String(args.directory),
            name: String(args.name ?? ''),
            title: String(args.title ?? ''),
            template: String(args.template ?? 'starter'),
            platforms: stringList(args.platforms) ?? ['linux', 'macos'],
            capabilities: stringList(args.capabilities) ?? undefined,
            gating: String(args.gating ?? 'soft'),
            ci: args.ci === true
          }
        : await showNewWorkshopDialog(`${directory}/new-workshop`);

      if (!request) {
        return;
      }

      try {
        const created = await requestAPI<{ path: string; files: string[] }>(
          'init',
          serverSettings,
          { method: 'POST', body: JSON.stringify(request) }
        );

        await manager.open(created.path);
        await manager.setAuthoring(true);
        recorder.enable();
        shell.activateById(context.panelId);
      } catch (error) {
        await showErrorMessage(
          'Unable to create the workshop',
          errorMessage(error)
        );
      }
    }
  });

  commands.addCommand(CommandIDs.editPage, {
    label: 'Workshop: Edit Page Source',
    isEnabled: () => manager.currentPage !== null,
    execute: async (): Promise<void> => {
      const page = manager.currentPage;

      if (page) {
        await openSource(page.path);
      }
    }
  });

  commands.addCommand(CommandIDs.editManifest, {
    label: 'Workshop: Edit Manifest',
    isEnabled: isOpen,
    execute: () => openSource(MANIFEST_FILE)
  });

  commands.addCommand(CommandIDs.openSource, {
    label: 'Workshop: Open Source File',
    isEnabled: isOpen,
    execute: async (args): Promise<void> => {
      const path = typeof args.path === 'string' ? args.path : MANIFEST_FILE;
      const line = typeof args.line === 'number' ? args.line : undefined;

      await openSource(path, line);
    }
  });

  commands.addCommand(CommandIDs.newPage, {
    label: 'Workshop: New Page…',
    isEnabled: isOpen,
    execute: async (args): Promise<string | undefined> => {
      const workshop = manager.workshop;

      if (!workshop) {
        return undefined;
      }

      let title = typeof args.title === 'string' ? args.title.trim() : '';

      if (title === '') {
        const result = await InputDialog.getText({
          title: 'New page',
          label: 'Title of the page'
        });

        if (!result.button.accept || !result.value?.trim()) {
          return undefined;
        }

        title = result.value.trim();
      }

      const path = newPagePath(title, workshop.manifest.pages);
      const manifest = await readManifestSource();

      await writeTextFile(contents, workshopFile(path), newPageSource(title));
      await writeSource(
        workshopFile(MANIFEST_FILE),
        setManifestPages(manifest, [...workshop.manifest.pages, path])
      );
      await manager.reload();
      manager.goToPage(pathStem(path));

      return path;
    }
  });

  commands.addCommand(CommandIDs.managePages, {
    label: 'Workshop: Manage Pages…',
    isEnabled: isOpen,
    execute: async (): Promise<void> => {
      const workshop = manager.workshop;

      if (!workshop) {
        return;
      }

      const entries: IPageEntry[] = workshop.pages.map(page => ({
        path: page.path,
        title: page.title,
        optional: page.frontmatter.optional,
        requires: page.frontmatter.requires.join(', '),
        checkpoint: page.frontmatter.checkpoint,
        isNew: false,
        removed: false
      }));
      const edited = await showPageManagerDialog(entries);

      if (!edited) {
        return;
      }

      // New pages get files; changed pages get their front matter
      // rewritten; the manifest lists whatever remains, in order.
      const paths: string[] = [];
      const taken = workshop.manifest.pages.slice();

      for (const entry of edited) {
        if (entry.removed) {
          continue;
        }

        const requires = entry.requires
          .split(',')
          .map(item => item.trim())
          .filter(item => item !== '');

        if (entry.isNew) {
          const path = newPagePath(entry.title, taken);

          taken.push(path);
          await writeTextFile(
            contents,
            workshopFile(path),
            setFrontmatter(newPageSource(entry.title), {
              optional: entry.optional,
              requires,
              checkpoint: entry.checkpoint
            })
          );
          paths.push(path);

          continue;
        }

        const before = entries.find(item => item.path === entry.path);
        const changed =
          before &&
          (before.title !== entry.title ||
            before.optional !== entry.optional ||
            before.requires !== entry.requires ||
            before.checkpoint !== entry.checkpoint);

        if (changed) {
          const source = await readTextFile(contents, workshopFile(entry.path));
          const { data } = splitFrontmatter(source);

          await writeSource(
            workshopFile(entry.path),
            setFrontmatter(source, {
              title:
                entry.title !== before.title || data.title !== undefined
                  ? entry.title
                  : undefined,
              optional: entry.optional,
              requires,
              checkpoint: entry.checkpoint
            })
          );
        }

        paths.push(entry.path);
      }

      const manifest = await readManifestSource();

      await writeSource(
        workshopFile(MANIFEST_FILE),
        setManifestPages(manifest, paths)
      );
      await manager.reload();
    }
  });

  commands.addCommand(CommandIDs.insertAction, {
    label: 'Workshop: Insert Action…',
    caption:
      'Add an action at the cursor of the page being edited, or at the end of the current page',
    isEnabled: isOpen,
    execute: async (args): Promise<void> => {
      const provided: unknown = args.draft;
      const explicit = isDraft(provided) ? provided : null;
      const target =
        typeof args.page === 'string'
          ? {
              path: args.page,
              line: typeof args.line === 'number' ? args.line : null
            }
          : insertTarget();

      if (!target) {
        return;
      }

      const draft = explicit ?? (await showActionFormDialog(null));

      if (!draft) {
        return;
      }

      await insertDirective(draft, target);
    }
  });

  commands.addCommand(CommandIDs.editAction, {
    label: 'Workshop: Edit Action…',
    isEnabled: isOpen,
    execute: async (args): Promise<void> => {
      const page = typeof args.page === 'string' ? args.page : '';
      const line = typeof args.line === 'number' ? args.line : 0;

      if (!page || !line) {
        return;
      }

      const source = await readTextFile(contents, workshopFile(page));
      const current = directiveAt(source, line);

      if (!current) {
        await showErrorMessage(
          'Unable to edit the action',
          `Line ${line} of ${page} no longer starts a directive; the file may have changed.`
        );

        return;
      }

      const provided: unknown = args.draft;
      const edited = isDraft(provided)
        ? { ...provided, name: current.name }
        : await showActionFormDialog(current);

      if (!edited) {
        return;
      }

      await writeSource(
        workshopFile(page),
        replaceDirective(source, line, serializeDirective(edited))
      );
      await manager.reload();
    }
  });

  commands.addCommand(CommandIDs.deleteAction, {
    label: 'Workshop: Delete Action…',
    isEnabled: isOpen,
    execute: async (args): Promise<void> => {
      const page = typeof args.page === 'string' ? args.page : '';
      const line = typeof args.line === 'number' ? args.line : 0;

      if (!page || !line) {
        return;
      }

      const source = await readTextFile(contents, workshopFile(page));
      const current = directiveAt(source, line);

      if (!current) {
        return;
      }

      if (args.confirm !== false) {
        const result = await showDialog({
          title: `Delete this ${current.name} action?`,
          body: `The block starting on line ${line} of ${page} is removed from the file.`,
          buttons: [
            Dialog.cancelButton(),
            Dialog.warnButton({ label: 'Delete' })
          ]
        });

        if (!result.button.accept) {
          return;
        }
      }

      await writeSource(workshopFile(page), removeDirective(source, line));
      await manager.reload();
    }
  });

  commands.addCommand(CommandIDs.capture, {
    label: 'Workshop: Capture from Session…',
    caption:
      'Add what was just done in the session (commands, saved files, cells run) to the current page',
    isEnabled: isOpen,
    execute: async (): Promise<void> => {
      const page = manager.currentPage;

      if (!page) {
        return;
      }

      const picked = await showCaptureDialog(recorder.recent);

      if (!picked || picked.length === 0) {
        return;
      }

      await appendEvents(page.path, picked);
    }
  });

  const appendEvents = async (
    pagePath: string,
    events: RecordedEvent[]
  ): Promise<void> => {
    const drafted = draftBlocks(events);
    const source = await readTextFile(contents, workshopFile(pagePath));
    let next = source;

    for (const block of drafted.blocks) {
      next = appendBlock(next, block);
    }

    await writeSource(workshopFile(pagePath), next);
    await declareCapabilities(drafted.capabilities);
    await manager.reload();
  };

  const declareCapabilities = async (capabilities: string[]): Promise<void> => {
    if (capabilities.length === 0) {
      return;
    }

    const manifest = await readManifestSource();
    let next = manifest;

    for (const capability of capabilities) {
      next = addManifestCapability(next, capability);
    }

    if (next !== manifest) {
      await writeSource(workshopFile(MANIFEST_FILE), next);
    }
  };

  const reportRun = (
    results: { status: IActionResult['status'] }[],
    what: string
  ): void => {
    const report = summarize('', results as never);
    const message = `${what}: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`;

    if (report.failed > 0) {
      Notification.warning(message, { autoClose: 6000 });
    } else {
      Notification.success(message, { autoClose: 4000 });
    }
  };

  commands.addCommand(CommandIDs.runPageActions, {
    label: 'Workshop: Run Page Actions',
    caption: 'Run every action of the current page in order, skipping checks',
    isEnabled: () => manager.currentPage !== null,
    execute: async (): Promise<void> => {
      reportRun(await runCurrentPage(manager, 'actions'), 'Page actions');
    }
  });

  commands.addCommand(CommandIDs.runPageChecks, {
    label: 'Workshop: Run Page Checks',
    caption: 'Run every check, quiz and form of the current page',
    isEnabled: () => manager.currentPage !== null,
    execute: async (): Promise<void> => {
      reportRun(await runCurrentPage(manager, 'checks'), 'Page checks');
    }
  });

  commands.addCommand(CommandIDs.runPage, {
    label: 'Workshop: Run Page',
    isEnabled: isOpen,
    execute: async (args): Promise<ReadonlyJSONValue> => {
      const page = typeof args.page === 'string' ? args.page : '';
      const only =
        args.only === 'actions' || args.only === 'checks' ? args.only : 'all';

      if (page) {
        const index = manager.visiblePages.findIndex(item => item.id === page);

        if (index < 0) {
          throw new Error(`No visible page "${page}"`);
        }

        manager.goTo(index, true);
      }

      const results = await runCurrentPage(manager, only);

      return summarize(
        manager.workshop?.path ?? '',
        results
      ) as unknown as ReadonlyJSONValue;
    }
  });

  let lintWidget: LintWidget | null = null;

  commands.addCommand(CommandIDs.showLint, {
    label: 'Workshop: Show Lint',
    caption: 'List the problems in the open workshop with fixes where possible',
    isEnabled: isOpen,
    execute: (): void => {
      if (!lintWidget || lintWidget.isDisposed) {
        lintWidget = new LintWidget({ manager, commands });
      }

      if (!lintWidget.isAttached) {
        shell.add(lintWidget, 'main', { mode: 'split-bottom' });
      }

      shell.activateById(LINT_ID);
    }
  });

  commands.addCommand(CommandIDs.applyFix, {
    label: 'Workshop: Apply Lint Fix',
    isEnabled: isOpen,
    execute: async (args): Promise<void> => {
      const workshop = manager.workshop;
      const message = args.message as unknown as ILintMessage | undefined;

      if (!workshop || !message?.fix) {
        return;
      }

      const edit = applyFix(message, {
        manifest: await readManifestSource(),
        pages: workshop.sources
      });

      if (!edit) {
        Notification.warning('The fix no longer applies; lint again.', {
          autoClose: 4000
        });

        return;
      }

      await writeSource(workshopFile(edit.path), edit.source);
      await manager.reload();
      Notification.success(edit.description, { autoClose: 3000 });
    }
  });

  commands.addCommand(CommandIDs.trustPreview, {
    label: 'Workshop: Preview Trust Dialog',
    caption: 'Show the dialog learners see when they open this workshop',
    isEnabled: isOpen,
    execute: async (): Promise<void> => {
      const workshop = manager.workshop;

      if (!workshop) {
        return;
      }

      const level =
        asTrustLevel(
          await readSetting(context.settingRegistry, 'defaultTrustLevel', '')
        ) ?? 'restricted';

      await showTrustDialog(workshop.trust, level, true);
    }
  });

  commands.addCommand(CommandIDs.publish, {
    label: 'Workshop: Publish…',
    caption: 'Build the archive, its hash and a registry entry under dist/',
    isEnabled: isOpen,
    execute: async (args): Promise<ReadonlyJSONValue> => {
      const workshop = manager.workshop;

      if (!workshop) {
        return null;
      }

      try {
        const result = await requestAPI<{
          archive: string;
          sha256: string;
          entryPath: string;
        }>('publish', serverSettings, {
          method: 'POST',
          body: JSON.stringify({ workshop: workshop.path })
        });

        if (args.silent !== true) {
          await showPublishResult(result);
        }

        return result as unknown as ReadonlyJSONValue;
      } catch (error) {
        await showErrorMessage('Unable to publish', errorMessage(error));

        return null;
      }
    }
  });

  commands.addCommand(CommandIDs.record, {
    label: 'Workshop: Record Session',
    caption:
      'Record terminal commands, saved files and cells run into draft pages',
    isToggled: () => recorder.recording,
    execute: async (): Promise<void> => {
      if (!recorder.recording) {
        recorder.start();
        Notification.info(
          'Recording. Work in the session; use "Record: New Page" to split pages, then run this command again to stop.',
          { autoClose: 6000 }
        );

        return;
      }

      const recording = recorder.stop();

      if (!manager.authoring) {
        recorder.disable();
      }

      const steps = recording.events.filter(
        event => event.kind !== 'page-break'
      ).length;

      if (steps === 0) {
        Notification.info('Nothing was recorded.', { autoClose: 3000 });

        return;
      }

      const directory = await readSetting(
        context.settingRegistry,
        'workshopsDirectory',
        'workshops'
      );
      const stamp = recording.started.replace(/[:.]/g, '-');
      const choice = await showRecordingDialog(
        steps,
        manager.workshop !== null,
        `${directory}/recorded-${stamp.slice(0, 16)}`
      );

      if (choice.mode === 'discard') {
        return;
      }

      try {
        if (choice.mode === 'append' && manager.workshop) {
          const workshop = manager.workshop;
          const draft = draftFromRecording(recording, {
            existingPages: workshop.manifest.pages
          });

          for (const page of draft.pages) {
            await writeTextFile(contents, workshopFile(page.path), page.source);
          }

          await writeTextFile(
            contents,
            workshopFile(`${WORKSHOP_STATE_DIR}/recordings/${stamp}.json`),
            JSON.stringify(recording, null, 2)
          );

          const manifest = await readManifestSource();

          await writeSource(
            workshopFile(MANIFEST_FILE),
            setManifestPages(manifest, [
              ...workshop.manifest.pages,
              ...draft.pages.map(page => page.path)
            ])
          );
          await declareCapabilities(draft.capabilities);
          await manager.reload();

          if (draft.pages[0]) {
            manager.goToPage(pathStem(draft.pages[0].path));
          }
        } else {
          const target = choice.directory.replace(/^\/+|\/+$/g, '');
          const name = PathExt.basename(target);
          const draft = draftFromRecording(recording);
          const files: [string, string][] = [
            [MANIFEST_FILE, draftManifest(name, choice.title || name, draft)],
            ...draft.pages.map((page): [string, string] => [
              page.path,
              page.source
            ]),
            [
              `${WORKSHOP_STATE_DIR}/recordings/${stamp}.json`,
              JSON.stringify(recording, null, 2)
            ]
          ];

          for (const [relative, content] of files) {
            await writeTextFile(
              contents,
              PathExt.join(target, relative),
              content
            );
          }

          await manager.open(target);
          await manager.setAuthoring(true);
          recorder.enable();
          shell.activateById(context.panelId);
        }
      } catch (error) {
        await showErrorMessage(
          'Unable to write the recording',
          errorMessage(error)
        );
      }
    }
  });

  commands.addCommand(CommandIDs.recordPageBreak, {
    label: 'Workshop: Record: New Page…',
    isEnabled: () => recorder.recording,
    execute: async (args): Promise<void> => {
      let title = typeof args.title === 'string' ? args.title : '';

      if (!title) {
        const result = await InputDialog.getText({
          title: 'New page',
          label: 'Title of the page the next steps go on'
        });

        if (!result.button.accept || !result.value) {
          return;
        }

        title = result.value;
      }

      recorder.pageBreak(title);
    }
  });

  // The bridge commands answer tools outside the browser.
  commands.addCommand(CommandIDs.bridgeOpen, {
    label: 'Workshop: Open in Author Mode (bridge)',
    execute: async (args): Promise<ReadonlyJSONValue> => {
      const path = typeof args.path === 'string' ? args.path : '';

      if (!path) {
        throw new Error('A path is required');
      }

      await manager.open(path);

      if (!manager.workshop) {
        throw new Error(manager.error ?? `Unable to open ${path}`);
      }

      await manager.setAuthoring(true);
      recorder.enable();
      shell.activateById(context.panelId);

      return status();
    }
  });

  commands.addCommand(CommandIDs.bridgeStatus, {
    label: 'Workshop: Session Status (bridge)',
    execute: (): ReadonlyJSONValue => status()
  });

  commands.addCommand(CommandIDs.bridgeRun, {
    label: 'Workshop: Run Action (bridge)',
    isEnabled: isOpen,
    execute: async (args): Promise<ReadonlyJSONValue> => {
      const type = typeof args.type === 'string' ? args.type : '';

      if (!type) {
        throw new Error('An action type is required');
      }

      const options = stringRecord(args.options);
      const result = await manager.runRequest(
        {
          type,
          id: `bridge-${Date.now().toString(36)}`,
          argument: typeof args.argument === 'string' ? args.argument : '',
          options,
          body: typeof args.body === 'string' ? args.body : ''
        },
        'click'
      );

      return {
        status: result.status,
        message: result.message ?? '',
        captured: result.captured ?? {}
      };
    }
  });

  // Turn the recorder on with author mode when a workshop restores that way.
  manager.changed.connect(() => {
    if (manager.authoring && !recorder.listening) {
      recorder.enable();
    }
  });
}

/**
 * Read the directive that starts on a line of a page source as the form
 * edits it, or null when the line does not start one.
 */
export function directiveAt(
  source: string,
  line: number
): IActionFormValue | null {
  const extent = directiveExtent(source, line);

  if (!extent) {
    return null;
  }

  const lines = source.split('\n').slice(extent.start - 1, extent.end);
  const info = parseDirectiveInfo(lines[0].replace(/^[`~]+/, ''));

  if (!info) {
    return null;
  }

  const content = parseDirectiveContent(lines.slice(1, -1).join('\n'));

  return {
    name: info.name,
    argument: info.argument,
    options: content.options,
    body: content.body
  };
}

function isDraft(value: unknown): value is IDirectiveDraft {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IDirectiveDraft).name === 'string' &&
    typeof (value as IDirectiveDraft).body === 'string' &&
    typeof (value as IDirectiveDraft).options === 'object'
  );
}

function stringRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};

  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      record[key] = String(item);
    }
  }

  return record;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : null;
}
