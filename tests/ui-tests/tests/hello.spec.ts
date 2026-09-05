import { expect, test } from '@jupyterlab/galata';
import * as path from 'path';

const WORKSHOP = 'hello-jupyterlab';

const EXAMPLE_DIR = path.resolve(__dirname, '../../../examples', WORKSHOP);

const PANEL = '#educates-workshop-panel';

interface IExposedApp {
  jupyterapp: {
    commands: { execute(id: string, args: object): Promise<unknown> };
  };
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
    await page.evaluate(async (target: string) => {
      const exposed = window as unknown as IExposedApp;

      await exposed.jupyterapp.commands.execute('workshop:open', {
        path: target
      });
    }, `${tmpPath}/${WORKSHOP}`);
    await page.sidebar.openTab('educates-workshop-panel');
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

    // Marking the page done shows in the footer and the page list.
    await panel.locator('.jp-WorkshopPanel-action.jp-mod-mark-done').click();
    await expect(panel.locator('.jp-WorkshopPanel-doneButton')).toHaveText(
      /Done/
    );
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
