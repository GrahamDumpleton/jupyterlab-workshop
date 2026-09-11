import { expect, test } from '@jupyterlab/galata';
import * as path from 'path';

const WORKSHOP = 'git-basics';

const EXAMPLE_DIR = path.resolve(__dirname, '../../../examples', WORKSHOP);

const PANEL = '#jupyterlab-workshop-panel';

/** Enough lines that an append lands below the editor's view. */
const NOTES_LINES: string[] = Array.from(
  { length: 60 },
  (_, index) => `note ${index + 1}`
);

const MORE_LINES: string[] = Array.from(
  { length: 40 },
  (_, index) => `more ${index + 1}`
);

interface IExposedApp {
  jupyterapp: {
    commands: { execute(id: string, args: object): Promise<unknown> };
    restored: Promise<void>;
    serviceManager: {
      contents: {
        get(
          path: string,
          options: { content: boolean }
        ): Promise<{ content: unknown }>;
      };
      kernelspecs: {
        refreshSpecs(): Promise<void>;
        specs: { kernelspecs: Record<string, unknown> } | null;
      };
    };
    shell: { widgets(area: string): Iterable<IExposedWidget> };
  };
}

/** A main-area widget, as far as the tests look at one. */
interface IExposedWidget {
  id: string;
  node: HTMLElement;
  content?: {
    session?: {
      send(message: { type: string; content: unknown[] }): void;
      messageReceived?: {
        connect(
          slot: (
            sender: unknown,
            message: { type: string; content?: unknown[] }
          ) => void
        ): void;
      };
    };
    editor?: { getCursorPosition(): { line: number; column: number } };
  };
}

/** Terminal output collected by a test, kept on the window. */
interface ICapturedOutput {
  __workshopOutput: string[];
}

/** Open a workshop and answer the trust dialog with the given level. */
async function openWorkshop(
  page: import('@playwright/test').Page,
  target: string,
  level: 'Trust' | 'Restricted' | 'Ask each time' = 'Trust'
): Promise<void> {
  // The command waits for the trust dialog, so it must not be awaited.
  await page.evaluate((path: string) => {
    const exposed = window as unknown as IExposedApp;

    void exposed.jupyterapp.commands.execute('workshop:open', { path });
  }, target);

  const dialog = page.locator('.jp-Dialog');

  await expect(dialog.locator('.jp-WorkshopTrust')).toBeVisible();
  await dialog.getByRole('button', { name: level, exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Loading finishes after the dialog closes and may apply a layout that
  // toggles the sidebar; wait for the panel to show the workshop first.
  await expect(
    page.locator('#jupyterlab-workshop-panel .jp-WorkshopPanel-title')
  ).toBeAttached();
}

test.describe('workshop panel', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    await page.contents.uploadDirectory(EXAMPLE_DIR, `${tmpPath}/${WORKSHOP}`);

    // A development session may have left runtime directories in the
    // example; they must not leak into the test.
    for (const name of ['_workshop', 'scratch', 'demo', 'work']) {
      const directory = `${tmpPath}/${WORKSHOP}/${name}`;

      if (await page.contents.directoryExists(directory)) {
        await page.contents.deleteDirectory(directory);
      }
    }
  });

  test('degrades actions when the workshop is restricted', async ({
    page,
    tmpPath
  }) => {
    const workshopPath = `${tmpPath}/${WORKSHOP}`;

    await openWorkshop(page, workshopPath, 'Restricted');
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);

    await expect(panel.locator('.jp-WorkshopPanel-trust')).toHaveText(
      'restricted'
    );

    // Commands are typed into the terminal but not run.
    const actions = panel.locator('.jp-WorkshopPanel-action.jp-mod-execute');

    await expect(actions.nth(1)).toContainText('git init -b main demo');
    await expect(actions.nth(1).locator('.jp-WorkshopPanel-badge')).toHaveText(
      'types only'
    );
    await actions.nth(1).click();
    await expect(actions.nth(1)).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-Terminal').first()).toBeVisible();

    // Frontend-only checks still run; code checks are off.
    const verify = panel.locator('.jp-WorkshopPanel-verify');

    await verify.first().getByRole('button', { name: 'Check' }).click();
    await expect(verify.first()).toHaveClass(/jp-mod-verify-fail/);

    // The terminal renders on a canvas, so the typed text cannot be read
    // back; give the command time to have run if it were going to, then
    // check that nothing was created.
    await page.waitForTimeout(3000);
    expect(
      await page.contents.directoryExists(`${workshopPath}/work/demo`)
    ).toBe(false);

    // Writes ask first and can be declined.
    const write = panel.locator('.jp-WorkshopPanel-action.jp-mod-file-write');

    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      void exposed.jupyterapp.commands.execute('workshop:next-page', {});
    });
    await expect(write.first().locator('.jp-WorkshopPanel-badge')).toHaveText(
      'confirms'
    );
    await write.first().click();

    const dialog = page.locator('.jp-Dialog');

    await expect(dialog.locator('.jp-WorkshopConfirm-detail')).toBeVisible();
    await dialog.getByRole('button', { name: 'Skip' }).click();
    await expect(write.first()).toHaveClass(/jp-mod-status-skipped/);

    // Trusting the workshop from the badge lifts the restrictions.
    await panel.locator('.jp-WorkshopPanel-trust').click();
    await dialog.getByRole('button', { name: 'Trust', exact: true }).click();
    await expect(panel.locator('.jp-WorkshopPanel-trust')).toHaveText(
      'trusted'
    );
    await expect(write.first().locator('.jp-WorkshopPanel-badge')).toHaveCount(
      0
    );
  });

  test('shows what the manifest says about the workshop', async ({
    page,
    tmpPath
  }) => {
    await openWorkshop(page, `${tmpPath}/${WORKSHOP}`);

    const panel = page.locator(PANEL);
    const dialog = page.locator('.jp-Dialog');

    await panel.locator('button[title="About this workshop"]').click();
    await expect(dialog.locator('.jp-WorkshopAbout')).toBeVisible();
    await expect(dialog.locator('.jp-Dialog-header')).toHaveText(
      'Git from the command line'
    );

    const details = dialog.locator('.jp-WorkshopAbout-details');

    await expect(details).toContainText('Graham Dumpleton');
    await expect(details).toContainText('Linux, macOS, Windows');
    await expect(
      details.getByRole('link', { name: /\/issues$/ })
    ).toHaveAttribute(
      'href',
      'https://github.com/GrahamDumpleton/jupyterlab-workshop/issues'
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('gives a bottom region the share the layout asks for', async ({
    page,
    tmpPath
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });

    // The layout is applied while the launcher still holds a share of
    // the main area; the region's size must survive the launcher closing.
    const sized = `${tmpPath}/sized`;

    await page.contents.uploadDirectory(EXAMPLE_DIR, sized);
    await page.contents.uploadContent(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: sized',
        'title: Sized',
        'version: 0.1.0',
        'description: Layout sizing.',
        'capabilities: [terminal]',
        'layout: default',
        'layouts:',
        '  default:',
        '    left: collapsed',
        '    right: { widget: instructions, size: 0.3 }',
        '    main:',
        '      - { area: top, widgets: ["markdown:../README.md"] }',
        '      - { area: bottom, widgets: ["terminal:shell"], size: 0.33 }',
        'pages:',
        '  - pages/01-create-a-repository.md',
        ''
      ].join('\n'),
      'text',
      `${sized}/workshop.yaml`
    );
    await openWorkshop(page, sized);
    await expect(page.locator('.jp-Terminal')).toBeVisible();

    // The terminal's share of the dock, its tab bar aside: a third, not
    // the half it gets when the launcher's share is split evenly.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const exposed = window as unknown as IExposedApp;
          const dock = document.getElementById('jp-main-dock-panel');

          for (const widget of exposed.jupyterapp.shell.widgets('main')) {
            if (widget.id === 'jupyterlab-workshop-terminal-shell' && dock) {
              return (
                widget.node.getBoundingClientRect().height /
                dock.getBoundingClientRect().height
              );
            }
          }

          return null;
        })
      )
      .toBeLessThan(0.4);
  });

  test('keeps the environment across a reset and drops it on restart', async ({
    page,
    tmpPath
  }) => {
    // Creating the environment installs ipykernel with pip, which takes
    // longer than the default test timeout allows.
    test.setTimeout(300000);

    // A workshop with nothing but an environment to create; the
    // requirements are empty so only ipykernel is installed.
    const envy = `${tmpPath}/envy`;

    await page.contents.uploadContent(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: envy',
        'title: Envy',
        'capabilities: [install-packages, kernel-exec]',
        'environment: { requirements: requirements.txt }',
        'pages: [pages/01.md]',
        ''
      ].join('\n'),
      'text',
      `${envy}/workshop.yaml`
    );
    await page.contents.uploadContent(
      '# nothing beyond ipykernel\n',
      'text',
      `${envy}/requirements.txt`
    );
    await page.contents.uploadContent(
      [
        '---',
        'title: Only page',
        '---',
        '',
        'Which python does a command see?',
        '',
        '```{execute-capture}',
        ':id: which-python',
        ':capture: prefix',
        'python -c "import sys; print(sys.prefix)"',
        '```',
        '',
        '```{verify}',
        ':id: venv-active',
        ':label: The environment is active in the kernel',
        'import os',
        'assert os.environ.get("VIRTUAL_ENV", "").endswith("venv"), os.environ.get("VIRTUAL_ENV", "unset")',
        'print(os.environ["VIRTUAL_ENV"])',
        '```',
        ''
      ].join('\n'),
      'text',
      `${envy}/pages/01.md`
    );
    await openWorkshop(page, envy);

    const panel = page.locator(PANEL);
    const banner = panel.locator('.jp-WorkshopPanel-environment');
    const dialog = page.locator('.jp-Dialog');
    const kernels = (): Promise<string[]> =>
      page.evaluate(async () => {
        const exposed = window as unknown as IExposedApp;
        const specs = exposed.jupyterapp.serviceManager.kernelspecs;

        await specs.refreshSpecs();

        return Object.keys(specs.specs?.kernelspecs ?? {});
      });
    const hasVenv = (): Promise<boolean> =>
      page.contents.directoryExists(`${envy}/_workshop/venv`);

    // Create the environment from the banner; pip takes a while.
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Create environment' }).click();
    await expect(banner).toHaveCount(0, { timeout: 180000 });
    expect(await kernels()).toContain('workshop-envy');
    expect(await hasVenv()).toBe(true);

    // Commands and checks now run with the environment first on PATH:
    // the capture's python is the venv's, and the kernel check sees
    // VIRTUAL_ENV through the kernelspec.
    const capture = panel.locator('[data-action-id="which-python"]');

    await capture.click();
    await expect(capture).toHaveClass(/jp-mod-status-ok/, { timeout: 60000 });
    await expect(
      capture.locator('.jp-WorkshopPanel-actionOutput')
    ).toContainText('_workshop/venv');

    const check = panel.locator('[data-action-id="venv-active"]');

    await check.getByRole('button', { name: 'Check' }).click();
    await expect(check).toHaveClass(/jp-mod-verify-pass/, { timeout: 60000 });

    // Terminals get it through the environment file they source.
    await expect
      .poll(async () => {
        const model = await page.evaluate(async (path: string) => {
          const exposed = window as unknown as IExposedApp;

          return exposed.jupyterapp.serviceManager.contents.get(path, {
            content: true
          });
        }, `${envy}/_workshop/env.sh`);

        return String(model.content);
      })
      .toContain('export VIRTUAL_ENV=');

    // Each command waits for its dialog, and then for the workshop to
    // reopen, so the command's promise is the signal that it is done.
    const run = (command: string): Promise<unknown> =>
      page.evaluate((id: string) => {
        const exposed = window as unknown as IExposedApp;

        return exposed.jupyterapp.commands.execute(id, {});
      }, command);

    // Reset Progress keeps it.
    const reset = run('workshop:reset');

    await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
    await reset;
    await expect(dialog).toHaveCount(0);
    await expect(panel.locator('.jp-WorkshopPanel-title')).toHaveText('Envy');
    await expect(banner).toHaveCount(0);
    expect(await hasVenv()).toBe(true);
    expect(await kernels()).toContain('workshop-envy');

    // Restart removes it, kernel included, and offers it again.
    const restart = run('workshop:restart');

    await expect(dialog.locator('.jp-Dialog-body')).toContainText(
      'environment'
    );
    await dialog.getByRole('button', { name: 'Restart', exact: true }).click();
    await restart;
    await expect(dialog).toHaveCount(0);
    await expect(banner).toBeVisible({ timeout: 60000 });
    expect(await hasVenv()).toBe(false);
    expect(await kernels()).not.toContain('workshop-envy');
  });

  test('fills a declared workspace and refills it on restart', async ({
    page,
    tmpPath
  }) => {
    const roomy = `${tmpPath}/roomy`;
    const upload = (text: string, path: string): Promise<unknown> =>
      page.contents.uploadContent(text, 'text', `${roomy}/${path}`);
    const read = (path: string): Promise<string> =>
      page.evaluate(async (target: string) => {
        const exposed = window as unknown as IExposedApp;
        const model = await exposed.jupyterapp.serviceManager.contents.get(
          target,
          { content: true }
        );

        return String(model.content);
      }, `${roomy}/${path}`);

    await upload(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: roomy',
        'title: Roomy',
        'workspace: work',
        'capabilities: [write-files: [workspace], kernel-exec]',
        'pages: [pages/01.md]',
        ''
      ].join('\n'),
      'workshop.yaml'
    );
    await upload('hello\n', 'files/hello.txt');
    await upload('data\n', 'files/data/rows.csv');
    await upload(
      [
        '---',
        'title: First',
        '---',
        '',
        'Work in work/.',
        '',
        '```{file-write}',
        ':id: write-notes',
        ':path: notes.txt',
        ...NOTES_LINES,
        '```',
        '',
        '```{file-write}',
        ':id: append-notes',
        ':path: notes.txt',
        ':mode: append',
        ':open: true',
        ...MORE_LINES,
        '```',
        '',
        '```{file-write}',
        ':id: copy-hello',
        ':path: copy.txt',
        ':from: files/hello.txt',
        '```',
        '',
        '```{execute-capture}',
        ':id: where',
        ':capture: here',
        'python -c "import os; print(os.getcwd())"',
        '```',
        '',
        '```{verify}',
        ':id: notes-exist',
        ':label: The notes are in the workspace',
        ':substrate: contents',
        'exists notes.txt',
        'exists ../pages/01.md',
        '```',
        '',
        '```{file-write}',
        ':id: clobber-page',
        ':path: ../pages/01.md',
        'gone',
        '```',
        ''
      ].join('\n'),
      'pages/01.md'
    );
    await openWorkshop(page, roomy);

    // Opening filled the workspace from files/.
    const panel = page.locator(PANEL);
    const dialog = page.locator('.jp-Dialog');

    expect(await read('work/hello.txt')).toBe('hello\n');
    expect(await read('work/data/rows.csv')).toBe('data\n');
    expect(await page.contents.fileExists(`${roomy}/files/hello.txt`)).toBe(
      true
    );

    // Action paths start at the workspace; from names a shipped file;
    // commands and contents checks start there too.
    const runAction = async (id: string): Promise<void> => {
      const action = panel.locator(`[data-action-id="${id}"]`);

      await action.click();
      await expect(action).toHaveClass(/jp-mod-status-ok/, { timeout: 60000 });
    };

    await runAction('write-notes');
    await runAction('append-notes');

    // An append that opens the file lands on the first appended line,
    // scrolled to the top of the view so the block reads downward.
    await expect(page.locator('.jp-FileEditor')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const exposed = window as unknown as IExposedApp;

          for (const widget of exposed.jupyterapp.shell.widgets('main')) {
            const editor = widget.content?.editor;

            if (editor) {
              return editor.getCursorPosition();
            }
          }

          return null;
        })
      )
      .toEqual({ line: NOTES_LINES.length, column: 0 });
    await expect
      .poll(() =>
        page.evaluate((first: string) => {
          const scroller = document.querySelector(
            '.jp-FileEditor .cm-scroller'
          );
          const line = Array.from(
            scroller?.querySelectorAll('.cm-line') ?? []
          ).find(element => element.textContent === first);

          if (!scroller || !line) {
            return null;
          }

          return (
            line.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top
          );
        }, MORE_LINES[0])
      )
      .toBeLessThan(24);

    await runAction('copy-hello');
    await runAction('where');
    expect(await read('work/notes.txt')).toBe(
      [...NOTES_LINES, ...MORE_LINES, ''].join('\n')
    );
    expect(await read('work/copy.txt')).toBe('hello\n');
    await expect(
      panel.locator('[data-action-id="where"] .jp-WorkshopPanel-actionOutput')
    ).toContainText('/roomy/work');

    const check = panel.locator('[data-action-id="notes-exist"]');

    await check.getByRole('button', { name: 'Check' }).click();
    await expect(check).toHaveClass(/jp-mod-verify-pass/, { timeout: 30000 });

    // A write aimed at a page is refused, badge and all, and the page
    // is untouched.
    const clobber = panel.locator('[data-action-id="clobber-page"]');

    await expect(clobber.locator('.jp-WorkshopPanel-badge')).toHaveText(
      'not allowed'
    );
    await clobber.click();
    await expect(clobber).toHaveClass(/jp-mod-status-error/);
    expect(await read('pages/01.md')).toContain('Work in work/');

    // The learner works, and the author edits a page meanwhile.
    await upload('changed\n', 'work/hello.txt');
    await upload('mine\n', 'work/extra.txt');
    await upload(
      '---\ntitle: Edited\n---\n\nStill work in work/.\n',
      'pages/01.md'
    );

    // Restart refills the workspace and keeps the edited page. The edit
    // changed the workshop's hash, so reopening asks about trust again.
    const restart = page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:restart', {});
    });

    await dialog.getByRole('button', { name: 'Restart', exact: true }).click();
    await expect(dialog.locator('.jp-WorkshopTrust')).toBeVisible({
      timeout: 60000
    });
    await dialog.getByRole('button', { name: 'Trust', exact: true }).click();
    await restart;
    await expect(panel.locator('.jp-WorkshopPanel-pageTitle')).toHaveText(
      'Edited'
    );
    expect(await read('work/hello.txt')).toBe('hello\n');
    expect(await page.contents.fileExists(`${roomy}/work/extra.txt`)).toBe(
      false
    );
    expect(await read('pages/01.md')).toContain('Still work');
  });

  test('moves the file browser out of the workspace before a restart empties it', async ({
    page,
    tmpPath
  }) => {
    const workshopPath = `${tmpPath}/${WORKSHOP}`;
    const run = (id: string, args: object = {}): Promise<unknown> =>
      page.evaluate(
        ([command, options]: [string, object]) => {
          const exposed = window as unknown as IExposedApp;

          return exposed.jupyterapp.commands.execute(command, options);
        },
        [id, args] as [string, object]
      );

    await openWorkshop(page, workshopPath);

    // The file browser is deep in the workspace, as a file-browser-reveal
    // action leaves it.
    await page.contents.createDirectory(`${workshopPath}/work/deeper`);
    await run('filebrowser:go-to-path', {
      path: `${workshopPath}/work/deeper`,
      dontShowBrowser: true
    });
    await expect
      .poll(() => page.filebrowser.getCurrentDirectory())
      .toBe(`${workshopPath}/work/deeper`);

    // Restart deletes that directory. The browser is moved to the
    // workshop directory first, so refreshing it finds nothing missing.
    const restart = run('workshop:restart');
    const dialog = page.locator('.jp-Dialog');

    await dialog.getByRole('button', { name: 'Restart', exact: true }).click();
    await restart;
    await expect(
      page.locator('#jupyterlab-workshop-panel .jp-WorkshopPanel-title')
    ).toHaveText('Git from the command line');
    await run('filebrowser:refresh');
    await expect
      .poll(() => page.filebrowser.getCurrentDirectory())
      .toBe(workshopPath);
    await expect(dialog.filter({ hasText: 'Directory not found' })).toHaveCount(
      0
    );
    expect(
      await page.contents.directoryExists(`${workshopPath}/work/deeper`)
    ).toBe(false);
  });

  test('creates the state directory once and writes the environment files into it', async ({
    page,
    tmpPath
  }) => {
    const workshopPath = `${tmpPath}/${WORKSHOP}`;

    await openWorkshop(page, workshopPath);

    // The environment file the terminals source is there as soon as the
    // workshop is open, and creating the state directory left no untitled
    // directories behind in the workshop.
    await expect
      .poll(() => page.contents.fileExists(`${workshopPath}/_workshop/env.sh`))
      .toBe(true);

    const names = await page.evaluate(async (target: string) => {
      const exposed = window as unknown as IExposedApp;
      const model = await exposed.jupyterapp.serviceManager.contents.get(
        target,
        { content: true }
      );

      return (model.content as { name: string }[]).map(entry => entry.name);
    }, workshopPath);

    expect(names.filter(name => name.startsWith('Untitled'))).toEqual([]);
  });

  test('puts the manifest env into checks and captured commands', async ({
    page,
    tmpPath
  }) => {
    // A workshop whose manifest sets a variable, checked on every code
    // substrate and by a captured command.
    const flavoured = `${tmpPath}/flavoured`;

    await page.contents.uploadContent(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: flavoured',
        'title: Flavoured',
        'capabilities: [kernel-exec]',
        'env: { CHECK_FLAVOUR: plum }',
        'pages: [pages/01.md]',
        ''
      ].join('\n'),
      'text',
      `${flavoured}/workshop.yaml`
    );
    await page.contents.uploadContent(
      [
        'import os, sys',
        '',
        'print(os.environ.get("CHECK_FLAVOUR", "unset"))',
        'sys.exit(0 if os.environ.get("CHECK_FLAVOUR") == "plum" else 1)',
        ''
      ].join('\n'),
      'text',
      `${flavoured}/flavour.py`
    );
    await page.contents.uploadContent(
      [
        '---',
        'title: Only page',
        '---',
        '',
        '```{execute-capture}',
        ':id: capture-flavour',
        ':capture: flavour',
        'echo "$CHECK_FLAVOUR"',
        '```',
        '',
        '```{verify}',
        ':id: kernel-flavour',
        ':label: The kernel check sees it',
        'import os',
        'assert os.environ.get("CHECK_FLAVOUR") == "plum", os.environ.get("CHECK_FLAVOUR", "unset")',
        '```',
        '',
        '```{verify}',
        ':id: shell-flavour',
        ':label: The shell check sees it',
        ':substrate: shell',
        'test "$CHECK_FLAVOUR" = plum',
        '```',
        '',
        '```{verify}',
        ':id: script-flavour',
        ':label: The script check sees it',
        ':substrate: script',
        ':script: flavour.py',
        '```',
        ''
      ].join('\n'),
      'text',
      `${flavoured}/pages/01.md`
    );
    await openWorkshop(page, flavoured);

    const panel = page.locator(PANEL);
    const capture = panel.locator('[data-action-id="capture-flavour"]');

    await capture.click();
    await expect(capture).toHaveClass(/jp-mod-status-ok/, { timeout: 60000 });
    await expect(
      capture.locator('.jp-WorkshopPanel-actionOutput')
    ).toContainText('plum');

    for (const id of ['kernel-flavour', 'shell-flavour', 'script-flavour']) {
      const check = panel.locator(`[data-action-id="${id}"]`);

      await check.getByRole('button', { name: 'Check' }).click();
      await expect(check).toHaveClass(/jp-mod-verify-pass/, { timeout: 60000 });
    }
  });

  test('keeps a form running until open terminals have its values', async ({
    page,
    tmpPath
  }) => {
    const greet = `${tmpPath}/greet`;
    const upload = (text: string, path: string): Promise<unknown> =>
      page.contents.uploadContent(text, 'text', `${greet}/${path}`);
    const read = (): Promise<string> =>
      page.evaluate(async (target: string) => {
        const exposed = window as unknown as IExposedApp;

        try {
          const model = await exposed.jupyterapp.serviceManager.contents.get(
            target,
            { content: true }
          );

          return String(model.content).trim();
        } catch {
          return '';
        }
      }, `${greet}/work/who.txt`);

    await upload(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: greet',
        'title: Greet',
        'capabilities: [terminal]',
        'variables:',
        '  - name: who',
        '    type: text',
        '    default: friend',
        'pages: [pages/01.md]',
        ''
      ].join('\n'),
      'workshop.yaml'
    );
    await upload(
      [
        '---',
        'title: Greet',
        '---',
        '',
        '```{form}',
        ':id: who',
        '- { name: who, type: text, label: Who, required: true }',
        '```',
        '',
        '```{execute}',
        ':session: demo',
        'echo "$WHO" > who.txt',
        ':windows:',
        '"$env:WHO" | Set-Content who.txt',
        '```',
        ''
      ].join('\n'),
      'pages/01.md'
    );

    await openWorkshop(page, greet);

    const panel = page.locator(PANEL);
    const form = panel.locator('.jp-WorkshopPanel-form');
    const action = panel.locator('.jp-WorkshopPanel-action.jp-mod-execute');

    // The command sees the default through the environment.
    await action.click();
    await expect(action).toHaveClass(/jp-mod-status-ok/);
    await expect.poll(read).toBe('friend');

    // Saving the form shows it saved only once the terminal has loaded
    // the new value, so a click that follows at once already sees it.
    await form.getByLabel('Who').fill('Grumpy');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toHaveClass(/jp-mod-status-ok/);
    await action.click();
    await expect.poll(read, { timeout: 15000 }).toBe('Grumpy');
  });

  test('retries a triggered check while its command finishes', async ({
    page,
    tmpPath
  }) => {
    // A check triggered by a command fires as soon as the command is
    // typed, so it must keep trying while the command does its work.
    const slow = `${tmpPath}/slow`;

    await page.contents.uploadContent(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: slow',
        'title: Slow',
        'capabilities: [terminal]',
        'pages: [pages/01.md]',
        ''
      ].join('\n'),
      'text',
      `${slow}/workshop.yaml`
    );
    await page.contents.uploadContent(
      [
        '---',
        'title: Slow',
        '---',
        '',
        '```{execute}',
        ':id: make',
        'sleep 3 && touch made.txt',
        '```',
        '',
        '```{verify}',
        ':id: made',
        ':label: The file exists',
        ':substrate: contents',
        ':trigger: after:make',
        'exists made.txt',
        '```',
        ''
      ].join('\n'),
      'text',
      `${slow}/pages/01.md`
    );

    await openWorkshop(page, slow);
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);
    const action = panel.locator('.jp-WorkshopPanel-action.jp-mod-execute');
    const check = panel.locator('.jp-WorkshopPanel-verify');

    await action.click();
    await expect(action).toHaveClass(/jp-mod-status-ok/);

    // The first attempt fails and the check keeps going rather than
    // reporting a failure, then passes once the file appears.
    await expect(check).toContainText('Checking');
    await expect(check).not.toHaveClass(/jp-mod-verify-fail/);
    await expect(check).toHaveClass(/jp-mod-verify-pass/, { timeout: 15000 });

    await page.contents.deleteDirectory(slow);
  });

  test('substitutes a changed variable into a timed check', async ({
    page,
    tmpPath
  }) => {
    // A form on the page changes a variable the check names, so the
    // timer must check the new file, not the one it started with.
    const timed = `${tmpPath}/timed`;

    await page.contents.uploadContent(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: timed',
        'title: Timed',
        'variables:',
        '  - { name: note, type: text, default: first }',
        'pages: [pages/01.md]',
        ''
      ].join('\n'),
      'text',
      `${timed}/workshop.yaml`
    );
    await page.contents.uploadContent(
      [
        '---',
        'title: Timed',
        '---',
        '',
        '```{form}',
        ':id: which',
        '- { name: note, type: text, label: Note, required: true }',
        '```',
        '',
        '```{verify}',
        ':id: present',
        ':label: The note {{ note }}.txt exists',
        ':substrate: contents',
        ':trigger: interval 1s',
        'exists {{ note }}.txt',
        '```',
        ''
      ].join('\n'),
      'text',
      `${timed}/pages/01.md`
    );
    // The check looks in the workspace, which opening creates and leaves
    // as it finds it.
    await page.contents.uploadContent(
      'second',
      'text',
      `${timed}/work/second.txt`
    );

    await openWorkshop(page, timed);
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);
    const form = panel.locator('.jp-WorkshopPanel-form');
    const check = panel.locator('.jp-WorkshopPanel-verify');

    // The timer checks for first.txt, which is not there. A failing
    // triggered check is retried for a while before the failure stands,
    // and the timer keeps starting it over, so only that it has not
    // passed is certain.
    await expect(check).toContainText('first.txt');
    await expect(check).not.toHaveClass(/jp-mod-verify-pass/);

    // Renaming the note through the form points the timer at second.txt.
    await form.getByLabel('Note').fill('second');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toHaveClass(/jp-mod-status-ok/);
    await expect(check).toContainText('second.txt');
    await expect(check).toHaveClass(/jp-mod-verify-pass/, { timeout: 15000 });

    await page.contents.deleteDirectory(timed);
  });

  test('walks through the start of git-basics', async ({ page, tmpPath }) => {
    const workshopPath = `${tmpPath}/${WORKSHOP}`;

    // Sidebars have a minimum width, so a quarter of the window only
    // measures as a quarter when the window is wide enough.
    await page.setViewportSize({ width: 1600, height: 900 });

    // Open the uploaded workshop through the command the panel uses.
    await openWorkshop(page, workshopPath);

    // The manifest layout collapses the left sidebar, shows the
    // instructions on the right at a quarter of the width, and replaces the
    // launcher with the README preview above a terminal.
    await expect(
      page.locator('#jp-main-dock-panel .jp-MarkdownViewer')
    ).toBeVisible();
    await expect(page.locator('#jp-main-dock-panel .jp-Launcher')).toHaveCount(
      0
    );
    await expect(page.locator('.jp-Terminal').first()).toBeVisible();
    expect(await page.sidebar.isOpen('left')).toBe(false);
    expect(await page.sidebar.isOpen('right')).toBe(true);

    const rightWidth = (await page.locator('#jp-right-stack').boundingBox())
      ?.width;
    const splitWidth = (
      await page.locator('#jp-main-split-panel').boundingBox()
    )?.width;

    expect(rightWidth).toBeDefined();
    expect(splitWidth).toBeDefined();
    expect((rightWidth ?? 0) / (splitWidth ?? 1)).toBeGreaterThan(0.23);
    expect((rightWidth ?? 0) / (splitWidth ?? 1)).toBeLessThan(0.27);

    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);

    await expect(panel.locator('.jp-WorkshopPanel-title')).toHaveText(
      'Git from the command line'
    );
    await expect(panel.locator('.jp-WorkshopPanel-pageTitle')).toHaveText(
      'Create a repository'
    );

    // Soft gating lists what the page still needs.
    const gate = panel.locator('.jp-WorkshopPanel-gate');

    await expect(gate).toContainText('Fill in the form "identity"');
    await expect(gate).toContainText('Pass the check "repo-created"');

    // The form stores its values as variables used by later commands.
    const form = panel.locator('.jp-WorkshopPanel-form');

    await form.getByLabel('Name').fill('Test Learner');
    await form.getByLabel('Email').fill('not-an-email');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.locator('.jp-WorkshopPanel-formProblem')).toHaveText(
      'Enter an email address'
    );
    await form.getByLabel('Email').fill('learner@example.com');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toHaveClass(/jp-mod-status-ok/);
    await expect(
      panel.locator('.jp-WorkshopPanel-action.jp-mod-execute').nth(3)
    ).toContainText('git config user.name "Test Learner"');
    await expect(gate).not.toContainText('form "identity"');

    // Run the first two terminal actions: git --version and git init.
    const actions = panel.locator('.jp-WorkshopPanel-action.jp-mod-execute');

    await expect(actions.first()).toContainText('git --version');
    await actions.first().click();
    await expect(actions.first()).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-Terminal').first()).toBeVisible();

    // The tab keeps the workshop's name for the terminal when the shell
    // sets a title, as a prompt does; the shell's text goes into the
    // caption. The title is set by hand here, since not every shell
    // does, and sent to the session as one line rather than typed, so
    // it cannot interleave with a line the extension is sending.
    const tab = page.locator('.lm-DockPanel-tabBar .lm-TabBar-tab', {
      has: page.locator('.lm-TabBar-tabLabel', { hasText: /^git$/ })
    });

    await expect(tab).toHaveCount(1);
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;
      const terminal = Array.from(
        exposed.jupyterapp.shell.widgets('main')
      ).find(widget => widget.id === 'jupyterlab-workshop-terminal-git');

      terminal?.content?.session?.send({
        type: 'stdin',
        content: ["printf '\\033]0;shell says hi\\007'\n"]
      });
    });
    await expect(tab).toHaveAttribute('title', /shell says hi/);
    await expect(tab.locator('.lm-TabBar-tabLabel')).toHaveText('git');

    await expect(actions.nth(1)).toContainText('git init -b main demo');
    await actions.nth(1).click();
    await expect(actions.nth(1)).toHaveClass(/jp-mod-status-ok/);

    await expect
      .poll(() => page.contents.directoryExists(`${workshopPath}/work/demo`), {
        timeout: 20000
      })
      .toBe(true);

    // Move into the repository and set the identity, so later commits work.
    await actions.nth(2).click();
    await expect(actions.nth(2)).toHaveClass(/jp-mod-status-ok/);
    await actions.nth(3).click();
    await expect(actions.nth(3)).toHaveClass(/jp-mod-status-ok/);

    // The contents check runs after git init and passes; the gate clears.
    const repoCheck = panel.locator('.jp-WorkshopPanel-verify');

    await expect(repoCheck).toHaveClass(/jp-mod-verify-pass/, {
      timeout: 20000
    });
    await expect(gate).toHaveCount(0);

    // Move to the second page and write the README through the editor.
    await panel
      .locator('.jp-WorkshopPanel-footer button', { hasText: 'Next' })
      .click();
    await expect(panel.locator('.jp-WorkshopPanel-pageTitle')).toHaveText(
      'Your first commit'
    );

    const writeAction = panel.locator('.jp-WorkshopPanel-action').first();

    await expect(writeAction).toContainText('# Demo project');
    await writeAction.click();
    await expect(writeAction).toHaveClass(/jp-mod-status-ok/);

    expect(
      await page.contents.fileExists(`${workshopPath}/work/demo/README.md`)
    ).toBe(true);
    await expect(page.locator('.jp-FileEditor')).toBeVisible();

    // The editor tabs beside the README preview the layout opened rather
    // than splitting the terminal's pane.
    await expect(
      page
        .locator('#jp-main-dock-panel .lm-DockPanel-tabBar', {
          has: page.locator('.lm-TabBar-tab', { hasText: 'README.md' })
        })
        .first()
        .locator('.lm-TabBar-tab')
    ).toHaveCount(2);
    await expect(page.locator('.jp-FileEditor .cm-content')).toContainText(
      'Demo project'
    );

    // The highlight action outlines the terminal and shows its callout.
    const highlight = panel.locator(
      '.jp-WorkshopPanel-action.jp-mod-highlight'
    );

    await highlight.click();
    await expect(highlight).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-Workshop-callout')).toHaveText(
      'Commands run in this terminal.'
    );
    await expect(
      page.locator('.jp-Terminal.jp-Workshop-highlight')
    ).toHaveCount(1);

    // Commit, and the kernel check picks the commit up from the terminal
    // output. The quiz gives feedback on a wrong answer and then passes.
    const commitActions = panel.locator(
      '.jp-WorkshopPanel-action.jp-mod-execute'
    );

    await commitActions.nth(1).click();
    await expect(commitActions.nth(1)).toHaveClass(/jp-mod-status-ok/);
    await commitActions.nth(3).click();
    await expect(commitActions.nth(3)).toHaveClass(/jp-mod-status-ok/);

    const commitCheck = panel.locator('.jp-WorkshopPanel-verify');

    await expect(commitCheck).toHaveClass(/jp-mod-verify-pass/, {
      timeout: 60000
    });

    // The passing check cascades to the checkpoint on the page.
    await expect
      .poll(
        () =>
          page.contents.fileExists(
            `${workshopPath}/_workshop/snapshots/after-first-commit.tar`
          ),
        { timeout: 20000 }
      )
      .toBe(true);
    await expect(commitCheck).toContainText('1 commit(s) so far');

    const quiz = panel.locator('.jp-WorkshopPanel-quiz');

    await quiz.getByLabel('git commit').check();
    await quiz.getByRole('button', { name: 'Submit' }).click();
    await expect(quiz.locator('.jp-WorkshopPanel-quizFeedback')).toHaveText(
      'git commit records what is already staged.'
    );
    await expect(quiz).toContainText('2 attempts left');
    await quiz.getByLabel('git add').check();
    await quiz.getByRole('button', { name: 'Submit' }).click();
    await expect(quiz).toHaveClass(/jp-mod-status-ok/);
    await expect(quiz.locator('.jp-WorkshopPanel-quizFeedback')).toHaveText(
      'git add stages changes; git commit records what is staged.'
    );
    await expect(gate).toHaveCount(0);

    // Leaving the page with its requirements met marks it done. Inline
    // roles render as buttons, and editor-insert appends through the open
    // editor and saves.
    await panel
      .locator('.jp-WorkshopPanel-footer button', { hasText: 'Next' })
      .click();
    await expect(
      panel.locator('.jp-WorkshopPanel-pageSelect option', {
        hasText: 'Your first commit ✓'
      })
    ).toHaveCount(1);
    await expect(panel.locator('.jp-Workshop-role-open')).toHaveText(
      'demo/README.md'
    );

    const insertAction = panel.locator(
      '.jp-WorkshopPanel-action.jp-mod-editor-insert'
    );

    await insertAction.click();
    await expect(insertAction).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-FileEditor .cm-content')).toContainText(
      'Learned how git diff shows unstaged changes.'
    );
    await expect
      .poll(() =>
        page.evaluate(async (target: string) => {
          const exposed = window as unknown as IExposedApp;
          const model = await exposed.jupyterapp.serviceManager.contents.get(
            target,
            {
              content: true
            }
          );

          return String(model.content);
        }, `${workshopPath}/work/demo/README.md`)
      )
      .toContain('Learned how git diff shows unstaged changes.');

    // The page survives a reload. The state database saves after a short
    // debounce, so give it a moment before reloading. Galata's default
    // readiness check waits for the launcher, which the restored layout
    // does not show, so wait for the application to be restored instead.
    await page.waitForTimeout(2000);
    await page.reload({ waitForIsReady: false });
    await page.evaluate(async () => {
      const exposed = window as unknown as IExposedApp;

      await exposed.jupyterapp.restored;
    });
    await page.sidebar.openTab('jupyterlab-workshop-panel');
    await expect(
      page.locator(PANEL).locator('.jp-WorkshopPanel-pageTitle')
    ).toHaveText('Edit and diff');
  });
});

test.describe('revealing grown content', () => {
  test('scrolls an opened hint into view, no further than the cap', async ({
    page,
    tmpPath
  }) => {
    const tall = `${tmpPath}/tall`;
    const upload = (text: string, path: string): Promise<unknown> =>
      page.contents.uploadContent(text, 'text', `${tall}/${path}`);
    const prose = Array.from(
      { length: 30 },
      (_, index) =>
        `Paragraph ${index + 1} of the page, long enough to scroll.\n`
    );

    await upload(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: tall',
        'title: Tall',
        'pages: [pages/01.md]',
        ''
      ].join('\n'),
      'workshop.yaml'
    );
    await upload(
      [
        '---',
        'title: First',
        '---',
        '',
        ...prose,
        '```{hint}',
        ':id: short',
        ':title: A short hint',
        'Two lines of help.',
        '',
        'That fit below the fold once revealed.',
        '```',
        '',
        '```{hint}',
        ':id: long',
        ':title: A long hint',
        ...Array.from(
          { length: 40 },
          (_, index) => `Help line ${index + 1}.\n`
        ),
        '```',
        ''
      ].join('\n'),
      'pages/01.md'
    );
    await openWorkshop(page, tall);
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const body = page.locator(`${PANEL} .jp-WorkshopPanel-body`);
    const short = page.locator(`${PANEL} .jp-WorkshopPanel-hint`).nth(0);
    const long = page.locator(`${PANEL} .jp-WorkshopPanel-hint`).nth(1);
    const geometry = async (): Promise<{
      bodyTop: number;
      bodyBottom: number;
      shortBottom: number;
      longTop: number;
      longBottom: number;
    }> => {
      const b = (await body.boundingBox())!;
      const s = (await short.boundingBox())!;
      const l = (await long.boundingBox())!;

      return {
        bodyTop: b.y,
        bodyBottom: b.y + b.height,
        shortBottom: s.y + s.height,
        longTop: l.y,
        longBottom: l.y + l.height
      };
    };

    // Both hints sit at the very bottom of a scrolled page.
    await body.evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });

    // A short hint is revealed in full.
    await short.locator('summary').click();
    await expect
      .poll(async () => {
        const g = await geometry();

        return g.shortBottom <= g.bodyBottom + 1;
      })
      .toBe(true);

    // A long hint is scrolled only until its header reaches the cap, a
    // third of the way down, with the rest left below.
    await long.locator('summary').click();
    await expect
      .poll(async () => {
        const g = await geometry();
        const cap = g.bodyTop + (g.bodyBottom - g.bodyTop) / 3;

        return Math.abs(g.longTop - cap) < 8 && g.longBottom > g.bodyBottom;
      })
      .toBe(true);
  });
});

test.describe('narrow panel', () => {
  // A window this small leaves the panel too narrow for the title and
  // every header button on one line.
  test.use({ viewport: { width: 800, height: 600 } });

  test.beforeEach(async ({ page, tmpPath }) => {
    await page.contents.uploadDirectory(EXAMPLE_DIR, `${tmpPath}/${WORKSHOP}`);
  });

  test('keeps the title in view beside the header tools', async ({
    page,
    tmpPath
  }) => {
    await openWorkshop(page, `${tmpPath}/${WORKSHOP}`);
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const title = page.locator(`${PANEL} .jp-WorkshopPanel-title`);

    await expect(title).toHaveText('Git from the command line');
    await expect(title).toBeVisible();
    expect((await title.boundingBox())?.width ?? 0).toBeGreaterThan(80);
  });
});

test.describe('startup restore', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    await page.contents.uploadDirectory(EXAMPLE_DIR, `${tmpPath}/${WORKSHOP}`);
  });

  test('forgets a workshop whose directory has gone', async ({
    page,
    tmpPath
  }) => {
    const workshopPath = `${tmpPath}/${WORKSHOP}`;

    await openWorkshop(page, workshopPath);
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    // The state database saves after a short debounce; then the
    // directory goes away under it, as when a server starts elsewhere.
    await page.waitForTimeout(2000);
    await page.contents.deleteDirectory(workshopPath);
    await page.reload({ waitForIsReady: false });
    await page.evaluate(async () => {
      const exposed = window as unknown as IExposedApp;

      await exposed.jupyterapp.restored;
    });
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);

    await expect(panel).toContainText('No workshop is open.');
    await expect(panel.locator('.jp-WorkshopPanel-error')).toHaveCount(0);
  });
});

test.describe('startup restore from another server', () => {
  // The state database is per user, not per server, so an entry written
  // by a server with another root must be left alone rather than opened
  // relative to this one.
  test.use({
    mockState: {
      '@jupyterlab-workshop/labextension:state': {
        servers: {
          '/somewhere/else': { workshopPath: 'examples/git-basics' }
        }
      }
    }
  });

  test('ignores the workshop another server had open', async ({ page }) => {
    await page.evaluate(async () => {
      const exposed = window as unknown as IExposedApp;

      await exposed.jupyterapp.restored;
    });
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);

    await expect(panel).toContainText('No workshop is open.');
    await expect(panel.locator('.jp-WorkshopPanel-error')).toHaveCount(0);
  });
});

test.describe('workshop prompt', () => {
  test('waits for the marked prompt and reports the exit status', async ({
    page,
    tmpPath
  }) => {
    // A workshop whose commands span lines, continue a line, and fail.
    const prompted = `${tmpPath}/prompted`;

    await page.contents.uploadContent(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: prompted',
        'title: Prompted',
        'version: 0.1.0',
        'description: Prompt markers.',
        'capabilities: [terminal]',
        'pages:',
        '  - pages/01-prompt.md',
        ''
      ].join('\n'),
      'text',
      `${prompted}/workshop.yaml`
    );
    await page.contents.uploadContent(
      [
        '# Prompt',
        '',
        '```{execute}',
        ':id: quick',
        ':wait: prompt',
        'echo started',
        '```',
        '',
        '```{execute}',
        ':id: spanning',
        ':wait: prompt',
        'echo one \\',
        '  two',
        'echo three',
        '```',
        '',
        '```{execute}',
        ':id: failing',
        ':wait: prompt',
        'false',
        '```',
        '',
        '```{execute}',
        ':id: slow',
        ':wait: prompt',
        'sleep 2; echo finished',
        '```',
        ''
      ].join('\n'),
      'text',
      `${prompted}/pages/01-prompt.md`
    );
    await openWorkshop(page, prompted);
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);
    const quick = panel.locator('[data-action-id="quick"]');

    // The first action opens the terminal, whose output is collected
    // from then on.
    await quick.click();
    await expect(quick).toHaveClass(/jp-mod-status-ok/, { timeout: 30000 });
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;
      const terminal = Array.from(
        exposed.jupyterapp.shell.widgets('main')
      ).find(widget => widget.id === 'jupyterlab-workshop-terminal-workshop');
      const captured: string[] = [];

      (window as unknown as ICapturedOutput).__workshopOutput = captured;
      terminal?.content?.session?.messageReceived?.connect((_, message) => {
        if (message.type === 'stdout' && message.content) {
          captured.push(message.content.map(String).join(''));
        }
      });
    });

    // Three lines, one of them a continuation, draw three prompts.
    const spanning = panel.locator('[data-action-id="spanning"]');

    await spanning.click();
    await expect(spanning).toHaveClass(/jp-mod-status-ok/, {
      timeout: 30000
    });
    await expect(
      spanning.locator('.jp-WorkshopPanel-actionMessage')
    ).toHaveCount(0);

    // A failing command still completes, with its status noted.
    const failing = panel.locator('[data-action-id="failing"]');

    await failing.click();
    await expect(failing).toHaveClass(/jp-mod-status-ok/, { timeout: 30000 });
    await expect(failing.locator('.jp-WorkshopPanel-actionMessage')).toHaveText(
      'The command exited with status 1'
    );

    // Resizing the terminal makes the shell draw its prompt again. That
    // prompt must not pass for the end of the next command, which says
    // when it is done.
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;
      const terminal = Array.from(
        exposed.jupyterapp.shell.widgets('main')
      ).find(widget => widget.id === 'jupyterlab-workshop-terminal-workshop');

      terminal?.content?.session?.send({
        type: 'set_size',
        content: [20, 100, 0, 0]
      });
    });

    const slow = panel.locator('[data-action-id="slow"]');

    await slow.click();
    await expect(slow).toHaveClass(/jp-mod-status-ok/, { timeout: 30000 });

    const output = await page.evaluate(() =>
      (window as unknown as ICapturedOutput).__workshopOutput.join('')
    );

    expect(output).toContain('finished');

    // The prompts carried the marker with the status and a serial number,
    // and the working directory, and no marker command was typed.
    expect(output).toMatch(/\x1b\]7770;workshop;1;\d+\x07/);
    expect(output).toContain('~ $ ');
    expect(output).not.toContain('WORKSHOP_DONE');
  });
});
