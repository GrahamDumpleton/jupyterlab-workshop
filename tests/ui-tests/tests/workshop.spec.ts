import { expect, test } from '@jupyterlab/galata';
import * as path from 'path';

const WORKSHOP = 'git-basics';

const EXAMPLE_DIR = path.resolve(__dirname, '../../../examples', WORKSHOP);

const PANEL = '#educates-workshop-panel';

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
    };
  };
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
    page.locator('#educates-workshop-panel .jp-WorkshopPanel-title')
  ).toBeAttached();
}

test.describe('workshop panel', () => {
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
  });

  test('degrades actions when the workshop is restricted', async ({
    page,
    tmpPath
  }) => {
    const workshopPath = `${tmpPath}/${WORKSHOP}`;

    await openWorkshop(page, workshopPath, 'Restricted');
    await page.sidebar.openTab('educates-workshop-panel');

    const panel = page.locator(PANEL);

    await expect(panel.locator('.jp-WorkshopPanel-trust')).toHaveText(
      'restricted'
    );

    // Commands are typed into the terminal but not run.
    const actions = panel.locator('.jp-WorkshopPanel-action');

    await expect(actions.nth(1)).toContainText('git init -b main demo');
    await expect(actions.nth(1).locator('.jp-WorkshopPanel-badge')).toHaveText(
      'types only'
    );
    await actions.nth(1).click();
    await expect(actions.nth(1)).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-Terminal').first()).toBeVisible();

    // The terminal renders on a canvas, so the typed text cannot be read
    // back; give the command time to have run if it were going to, then
    // check that nothing was created.
    await page.waitForTimeout(3000);
    expect(await page.contents.directoryExists(`${workshopPath}/demo`)).toBe(
      false
    );

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

  test('walks through the start of git-basics', async ({ page, tmpPath }) => {
    const workshopPath = `${tmpPath}/${WORKSHOP}`;

    // Open the uploaded workshop through the command the panel uses.
    await openWorkshop(page, workshopPath);

    await page.sidebar.openTab('educates-workshop-panel');

    const panel = page.locator(PANEL);

    await expect(panel.locator('.jp-WorkshopPanel-title')).toHaveText(
      'Git from the command line'
    );
    await expect(panel.locator('.jp-WorkshopPanel-pageTitle')).toHaveText(
      'Create a repository'
    );

    // Run the first two terminal actions: git --version and git init.
    const actions = panel.locator('.jp-WorkshopPanel-action');

    await expect(actions.first()).toContainText('git --version');
    await actions.first().click();
    await expect(actions.first()).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-Terminal').first()).toBeVisible();

    await expect(actions.nth(1)).toContainText('git init -b main demo');
    await actions.nth(1).click();
    await expect(actions.nth(1)).toHaveClass(/jp-mod-status-ok/);

    await expect
      .poll(() => page.contents.directoryExists(`${workshopPath}/demo`), {
        timeout: 20000
      })
      .toBe(true);

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
      await page.contents.fileExists(`${workshopPath}/demo/README.md`)
    ).toBe(true);
    await expect(page.locator('.jp-FileEditor')).toBeVisible();
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

    // Inline roles render as buttons, and editor-insert appends through the
    // open editor and saves.
    await panel
      .locator('.jp-WorkshopPanel-footer button', { hasText: 'Next' })
      .click();
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
        }, `${workshopPath}/demo/README.md`)
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
    await page.sidebar.openTab('educates-workshop-panel');
    await expect(
      page.locator(PANEL).locator('.jp-WorkshopPanel-pageTitle')
    ).toHaveText('Edit and diff');
  });
});
