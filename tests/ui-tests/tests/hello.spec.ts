import { expect, test } from '@jupyterlab/galata';
import * as path from 'path';

const WORKSHOP = 'hello-jupyterlab';

const EXAMPLE_DIR = path.resolve(__dirname, '../../../examples', WORKSHOP);

const PANEL = '#jupyterlab-workshop-panel';

interface IExposedApp {
  jupyterapp: {
    commands: { execute(id: string, args: object): Promise<unknown> };
    serviceManager: {
      contents: {
        get(
          path: string,
          options: { content: boolean }
        ): Promise<{ content: INotebookFile }>;
      };
    };
  };
}

/** A saved notebook, as far as the tests look at one. */
interface INotebookFile {
  cells: { cell_type: string; outputs?: unknown[] }[];
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

test.describe('hello-jupyterlab workshop', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    await page.contents.uploadDirectory(EXAMPLE_DIR, `${tmpPath}/${WORKSHOP}`);

    // A development session may have left runtime directories in the
    // example; they must not leak into the test.
    for (const name of ['_workshop', 'scratch', 'demo']) {
      const directory = `${tmpPath}/${WORKSHOP}/${name}`;

      if (await page.contents.directoryExists(directory)) {
        await page.contents.deleteDirectory(directory);
      }
    }
    await openWorkshop(page, `${tmpPath}/${WORKSHOP}`);
    await page.sidebar.openTab('jupyterlab-workshop-panel');
  });

  test('drives notebooks, kernels, variables, tracks and cascades', async ({
    page,
    tmpPath
  }) => {
    const panel = page.locator(PANEL);
    const pageSelect = panel.locator('.jp-WorkshopPanel-pageSelect');
    const goTo = async (title: string): Promise<void> => {
      await pageSelect.selectOption({ label: await optionLabel(page, title) });
      await expect(panel.locator('.jp-WorkshopPanel-pageTitle')).toHaveText(
        title
      );
    };

    await expect(panel.locator('.jp-WorkshopPanel-title')).toHaveText(
      'Hello JupyterLab'
    );

    // Variables render in prose, and the toast action shows a notification.
    await expect(
      panel.locator('.jp-WorkshopPanel-prose').first()
    ).toContainText('Hello Learner.');
    await panel
      .locator('.jp-WorkshopPanel-action.jp-mod-toast')
      .first()
      .click();
    await expect(page.locator('.Toastify__toast')).toContainText(
      'Welcome to the workshop, Learner.'
    );

    // Opening the launcher twice brings one launcher to the front rather
    // than adding a second pane.
    const launcherOpen = panel.locator(
      '.jp-WorkshopPanel-action.jp-mod-launcher-open'
    );
    await launcherOpen.click();
    await expect(launcherOpen).toHaveClass(/jp-mod-status-ok/);
    await launcherOpen.click();
    await expect(launcherOpen).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('#jp-main-dock-panel .jp-Launcher')).toHaveCount(
      1
    );

    // Notebooks: create, run all, insert a tagged cell and run it.
    await goTo('Notebooks');

    const create = panel.locator(
      '.jp-WorkshopPanel-action.jp-mod-notebook-create'
    );

    await create.click();
    await expect(create).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-NotebookPanel .jp-Cell')).toHaveCount(3);

    const runAll = panel.locator(
      '.jp-WorkshopPanel-action.jp-mod-cell-run-all'
    );

    await runAll.click();
    await expect(runAll).toHaveClass(/jp-mod-status-ok/, { timeout: 60000 });
    await expect(
      page.locator('.jp-NotebookPanel .jp-OutputArea-output').first()
    ).toContainText('Hello from a notebook');

    // The contents check sees the execution count in the open notebook
    // without waiting for a save.
    await expect(panel.locator('.jp-WorkshopPanel-verify').first()).toHaveClass(
      /jp-mod-verify-pass/,
      { timeout: 30000 }
    );

    const insert = panel.locator('.jp-WorkshopPanel-action.jp-mod-cell-insert');

    await insert.click();
    await expect(insert).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-NotebookPanel .jp-Cell')).toHaveCount(4);

    const runOne = panel.locator('.jp-WorkshopPanel-action.jp-mod-cell-run');

    await runOne.click();
    await expect(runOne).toHaveClass(/jp-mod-status-ok/, { timeout: 60000 });
    await expect(
      page.locator('.jp-NotebookPanel .jp-OutputArea-output').last()
    ).toContainText('84');

    // Running the cell triggers the check in the notebook's kernel, whose
    // body is a bare expression rather than a print.
    await expect(panel.locator('.jp-WorkshopPanel-verify').last()).toHaveClass(
      /jp-mod-verify-pass/,
      { timeout: 30000 }
    );

    // The run saved the notebook afterwards, so the file has the output
    // of the cell that was just run, not only the cell.
    const saved = await page.evaluate(async (path: string) => {
      const exposed = window as unknown as IExposedApp;
      const model = await exposed.jupyterapp.serviceManager.contents.get(path, {
        content: true
      });

      return model.content.cells
        .filter(cell => cell.cell_type === 'code')
        .map(cell => (cell.outputs ?? []).length);
    }, `${tmpPath}/${WORKSHOP}/scratch/hello.ipynb`);

    expect(saved[saved.length - 1]).toBeGreaterThan(0);

    // Files: writing opens the editor, the editor actions change what it
    // shows, and file-close takes it away again.
    await goTo('Files and the editor');

    const fileWrite = panel.locator(
      '.jp-WorkshopPanel-action.jp-mod-file-write'
    );
    const fileClose = panel.locator(
      '.jp-WorkshopPanel-action.jp-mod-file-close'
    );
    const editorContent = page.locator('.jp-FileEditor .cm-content');
    const runEditorAction = async (id: string): Promise<void> => {
      const action = panel.locator(`[data-action-id="${id}"]`);

      await action.click();
      await expect(action).toHaveClass(/jp-mod-status-ok/);
    };

    await fileWrite.click();
    await expect(fileWrite).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-FileEditor')).toBeVisible();

    await runEditorAction('replace-literal');
    await expect(editorContent).toContainText('shipped with this workshop');
    await runEditorAction('insert-after-title');
    await expect(editorContent.locator('.cm-line').nth(1)).toHaveText(
      'Revised by an editor-insert action.'
    );
    await runEditorAction('replace-expand');
    await expect(editorContent.locator('.cm-line').first()).toHaveText(
      '# Revised notes for Learner'
    );

    // The second occurrence is the one in the last line, and selecting
    // it focuses the editor so the browser selection shows it.
    await runEditorAction('select-second');
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe('action');
    await runEditorAction('highlight-lines');
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toContain('Revised by an editor-insert action.');

    await fileClose.click();
    await expect(fileClose).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-FileEditor')).toHaveCount(0);

    // Copy, rename, create and delete go through the contents API; the
    // directory delete takes the renamed copy with it.
    const workshopDir = `${tmpPath}/${WORKSHOP}`;
    const exists = (path: string): Promise<boolean> =>
      page.contents.fileExists(`${workshopDir}/${path}`);

    await runEditorAction('copy-notes');
    expect(await exists('scratch/archive/notes-copy.md')).toBe(true);
    await runEditorAction('rename-notes');
    expect(await exists('scratch/archive/notes-copy.md')).toBe(false);
    expect(await exists('scratch/archive/notes-old.md')).toBe(true);
    await runEditorAction('create-drafts');
    expect(
      await page.contents.directoryExists(`${workshopDir}/scratch/drafts`)
    ).toBe(true);
    await runEditorAction('delete-archive');
    expect(
      await page.contents.directoryExists(`${workshopDir}/scratch/archive`)
    ).toBe(false);
    expect(await exists('scratch/notes.md')).toBe(true);

    // Kernels: capture output into a variable and see it in the prose.
    await goTo('Kernels');

    const capture = panel.locator(
      '.jp-WorkshopPanel-action.jp-mod-kernel-execute'
    );

    await capture.click();
    await expect(capture).toHaveClass(/jp-mod-status-ok/, { timeout: 60000 });
    await expect(panel.locator('.jp-Workshop-role-var').first()).toHaveText(
      /^3\.\d+/
    );

    // Tracks: choosing pip reveals the pip block and the pip page only.
    await goTo('Variables and tracks');
    await expect(
      pageSelect.locator('option', { hasText: 'Using pip' })
    ).toHaveCount(0);
    await panel
      .locator('.jp-WorkshopPanel-choiceOptions button', { hasText: 'pip' })
      .click();
    await expect(
      panel.locator('.jp-WorkshopPanel-prose', { hasText: 'You chose pip' })
    ).toHaveCount(1);
    await expect(
      panel.locator('.jp-WorkshopPanel-prose', { hasText: 'You chose conda' })
    ).toHaveCount(0);
    await expect(
      pageSelect.locator('option', { hasText: 'Using pip' })
    ).toHaveCount(1);
    await expect(
      pageSelect.locator('option', { hasText: 'Using conda' })
    ).toHaveCount(0);

    // Automation: entering the page runs the chain without clicks.
    await goTo('Automation');

    const autoWrite = panel.locator('[data-action-id="auto-write"]');

    await expect(autoWrite).toHaveClass(/jp-mod-status-ok/, { timeout: 30000 });
    expect(
      await page.contents.fileExists(
        `${tmpPath}/${WORKSHOP}/scratch/automation.txt`
      )
    ).toBe(true);
    await expect(panel.locator('[data-action-id="auto-echo"]')).toHaveClass(
      /jp-mod-status-ok/
    );

    // Moving on marks the page done in the page list.
    await panel
      .locator('.jp-WorkshopPanel-footer button', { hasText: 'Next' })
      .click();
    await expect(
      pageSelect.locator('option', { hasText: 'Automation ✓' })
    ).toHaveCount(1);
  });
});

async function optionLabel(
  page: import('@playwright/test').Page,
  title: string
): Promise<string> {
  const labels = await page
    .locator(`${PANEL} .jp-WorkshopPanel-pageSelect option`)
    .allTextContents();
  const label = labels.find(text => text.includes(title));

  if (!label) {
    throw new Error(`No page titled "${title}" among ${labels.join(', ')}`);
  }

  return label;
}
