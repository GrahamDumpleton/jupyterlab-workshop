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

  test('walks through the start of git-basics', async ({ page, tmpPath }) => {
    const workshopPath = `${tmpPath}/${WORKSHOP}`;

    // Open the uploaded workshop through the command the panel uses.
    await page.evaluate(async (target: string) => {
      const exposed = window as unknown as IExposedApp;

      await exposed.jupyterapp.commands.execute('workshop:open', {
        path: target
      });
    }, workshopPath);

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
