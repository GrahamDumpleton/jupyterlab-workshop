import { expect, galata, test } from '@jupyterlab/galata';
import * as path from 'path';

const WORKSHOP = 'git-basics';

const EXAMPLE_DIR = path.resolve(__dirname, '../../../examples', WORKSHOP);

const PLUGIN = '@educates/jupyterlab-workshop:panel';

/** Fixed paths under the test server root, removed after each test. */
const REGISTRY_FILE = 'test-registry.json';

const WORKSHOPS_DIR = 'test-workshops';

const REGISTRY = {
  version: 1,
  title: 'Test registry',
  workshops: [
    {
      name: 'git-basics',
      title: 'Git from the command line',
      description: 'Learn git from the terminal.',
      tags: ['git', 'cli'],
      platforms: ['linux', 'macos', 'windows'],
      capabilities: ['terminal', 'write-files:workspace'],
      versions: [
        {
          version: '0.1.0',
          source: { git: 'https://github.com/example/workshops', subdir: 'git' }
        }
      ]
    },
    {
      name: 'pandas-intro',
      title: 'Pandas for beginners',
      description: 'Data frames from the start.',
      tags: ['python', 'data'],
      platforms: ['linux'],
      capabilities: ['kernel-exec'],
      versions: [
        {
          version: '2.0.0',
          source: { archive: 'https://example.org/pandas-intro-2.0.0.tar.gz' }
        }
      ]
    }
  ]
};

interface IExposedApp {
  jupyterapp: {
    commands: { execute(id: string, args: object): Promise<unknown> };
  };
}

test.use({
  mockSettings: {
    ...galata.DEFAULT_SETTINGS,
    [PLUGIN]: {
      defaultWorkshop: '',
      registries: [REGISTRY_FILE],
      workshopsDirectory: WORKSHOPS_DIR
    }
  }
});

test.describe('workshop browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.contents.uploadContent(
      JSON.stringify(REGISTRY),
      'text',
      REGISTRY_FILE
    );
    await page.contents.uploadDirectory(
      EXAMPLE_DIR,
      `${WORKSHOPS_DIR}/${WORKSHOP}`
    );

    for (const name of ['_workshop', 'scratch', 'demo']) {
      const directory = `${WORKSHOPS_DIR}/${WORKSHOP}/${name}`;

      if (await page.contents.directoryExists(directory)) {
        await page.contents.deleteDirectory(directory);
      }
    }
  });

  test.afterEach(async ({ page }) => {
    await page.contents.deleteFile(REGISTRY_FILE);

    if (await page.contents.directoryExists(WORKSHOPS_DIR)) {
      await page.contents.deleteDirectory(WORKSHOPS_DIR);
    }
  });

  test('lists registry and installed workshops and opens one', async ({
    page
  }) => {
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      void exposed.jupyterapp.commands.execute('workshop:browse', {});
    });

    const browser = page.locator('#educates-workshop-browser');

    await expect(browser).toBeVisible();

    // Both registry entries show as cards with their metadata.
    const cards = browser.locator('.jp-WorkshopBrowser-card');

    await expect(cards.filter({ hasText: 'Pandas for beginners' })).toHaveCount(
      1
    );
    await expect(
      cards
        .filter({ hasText: 'Pandas for beginners' })
        .locator('.jp-WorkshopBrowser-chip')
    ).toContainText(['linux', 'kernel-exec']);

    // The uploaded workshop appears under Installed and the registry card
    // for the same name offers to open rather than install.
    const installed = cards.filter({ hasText: WORKSHOPS_DIR });

    await expect(installed).toHaveCount(1);
    await expect(installed).toContainText('not started');
    await expect(
      cards.filter({ has: page.getByRole('button', { name: 'Reinstall' }) })
    ).toHaveCount(1);

    // Search and tags narrow the registry list.
    await browser.locator('.jp-WorkshopBrowser-search').fill('pandas');
    await expect(
      cards.filter({ hasText: 'Git from the command line' })
    ).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Pandas for beginners' })).toHaveCount(
      1
    );
    await browser.locator('.jp-WorkshopBrowser-search').fill('');
    await browser
      .locator('.jp-WorkshopBrowser-tag', { hasText: 'cli' })
      .click();
    await expect(cards.filter({ hasText: 'Pandas for beginners' })).toHaveCount(
      0
    );

    // Opening from the installed card shows the trust dialog and the panel.
    await installed.getByRole('button', { name: 'Open' }).click();

    const dialog = page.locator('.jp-Dialog');

    await expect(dialog.locator('.jp-WorkshopTrust')).toBeVisible();
    await dialog.getByRole('button', { name: 'Trust', exact: true }).click();
    await expect(
      page.locator('#educates-workshop-panel .jp-WorkshopPanel-title')
    ).toHaveText('Git from the command line');
  });

  test('opens a workshop from a launch link with variables', async ({
    page
  }) => {
    // The launch link names a directory under the root and a variable.
    // Galata's goto waits for the launcher to be clickable, which the
    // trust dialog prevents, so the navigation is done by the page itself.
    const query = `?workshop=${WORKSHOPS_DIR}/${WORKSHOP}&var.repo_dir=sandbox`;

    await page
      .evaluate((search: string) => {
        window.location.assign(`${window.location.pathname}${search}`);
      }, query)
      .catch(() => undefined);

    const dialog = page.locator('.jp-Dialog');

    await expect(dialog.locator('.jp-WorkshopTrust')).toBeVisible({
      timeout: 60000
    });
    await dialog.getByRole('button', { name: 'Trust', exact: true }).click();

    const panel = page.locator('#educates-workshop-panel');

    await expect(panel.locator('.jp-WorkshopPanel-title')).toHaveText(
      'Git from the command line'
    );
    await expect(
      panel.locator('.jp-WorkshopPanel-action.jp-mod-execute').nth(1)
    ).toContainText('git init -b main sandbox');

    // The parameters are gone from the address so a reload is harmless.
    expect(page.url()).not.toContain('workshop=');
  });
});
