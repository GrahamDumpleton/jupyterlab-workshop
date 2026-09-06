import { expect, galata, test } from '@jupyterlab/galata';
import * as path from 'path';

const WORKSHOP = 'git-basics';

const EXAMPLE_DIR = path.resolve(__dirname, '../../../examples', WORKSHOP);

const PLUGIN = '@jupyterlab-workshop/labextension:panel';

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
          version: '0.2.0',
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

    const browser = page.locator('#jupyterlab-workshop-browser');

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

    // The uploaded workshop appears once, under Installed, and since the
    // registry lists a newer version its card offers the update.
    const installed = cards.filter({ hasText: WORKSHOPS_DIR });

    await expect(installed).toHaveCount(1);
    await expect(installed).toContainText('not started');
    await expect(
      installed.getByRole('button', { name: 'Update to 0.2.0' })
    ).toHaveCount(1);
    await expect(
      cards.filter({ hasText: 'Git from the command line' })
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

    // Opening from the installed card shows the trust dialog and the panel,
    // and the card shows it is busy until then.
    await installed.getByRole('button', { name: 'Open' }).click();

    const dialog = page.locator('.jp-Dialog');

    await expect(dialog.locator('.jp-WorkshopTrust')).toBeVisible();
    await expect(
      installed.getByRole('button', { name: 'Opening…' })
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Trust', exact: true }).click();
    await expect(
      page.locator('#jupyterlab-workshop-panel .jp-WorkshopPanel-title')
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

    const panel = page.locator('#jupyterlab-workshop-panel');

    await expect(panel.locator('.jp-WorkshopPanel-title')).toHaveText(
      'Git from the command line'
    );
    await expect(
      panel.locator('.jp-WorkshopPanel-action.jp-mod-execute').nth(1)
    ).toContainText('git init -b main sandbox');

    // The parameters are gone from the address so a reload is harmless.
    expect(page.url()).not.toContain('workshop=');

    // With progress recorded, a link with a bare restart asks first and
    // carrying on keeps the page, while restart=force starts over.
    const pageSelect = panel.locator('.jp-WorkshopPanel-pageSelect');
    const relaunch = async (search: string): Promise<void> => {
      await page
        .evaluate((query: string) => {
          window.location.assign(`${window.location.pathname}${query}`);
        }, search)
        .catch(() => undefined);
    };

    const title = panel.locator('.jp-WorkshopPanel-title');
    const trust = dialog.locator('.jp-WorkshopTrust');
    const trustIfAsked = async (): Promise<void> => {
      await trust.or(title).first().waitFor({ timeout: 60000 });

      if (await trust.isVisible()) {
        await dialog
          .getByRole('button', { name: 'Trust', exact: true })
          .click();
      }

      await expect(title).toHaveText('Git from the command line');
    };

    await panel
      .locator('.jp-WorkshopPanel-footer button', { hasText: 'Next' })
      .click();
    await expect(pageSelect).toHaveValue('1');

    // The state file is saved a moment after the page changes; the link
    // must find it to know there is progress to ask about.
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `api/contents/${WORKSHOPS_DIR}/${WORKSHOP}/_workshop/state.json?content=1`
        );

        return response.ok() ? String((await response.json()).content) : '';
      })
      .toContain('02-first-commit');

    await relaunch(`?workshop=${WORKSHOPS_DIR}/${WORKSHOP}&restart`);
    await expect(dialog).toContainText('Restart the workshop?', {
      timeout: 60000
    });
    await dialog.getByRole('button', { name: 'Carry on' }).click();
    await trustIfAsked();
    await expect(pageSelect).toHaveValue('1');

    await relaunch(`?workshop=${WORKSHOPS_DIR}/${WORKSHOP}&restart=force`);
    await trustIfAsked();
    await expect(pageSelect).toHaveValue('0');
    expect(page.url()).not.toContain('restart');
  });

  test('starts in the browser from a registry launch link', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });

    // The link names a registry file under the root. In a fresh workspace,
    // as on Binder, the browser takes the launcher's place and both
    // sidebars collapse; a new workspace name keeps the earlier tests'
    // layout record out of the way.
    await page
      .evaluate((search: string) => {
        const name = `link-${Date.now().toString(36)}`;
        const path = window.location.pathname.replace(
          /\/lab(\/workspaces\/[^/]+)?/,
          `/lab/workspaces/${name}`
        );

        window.location.assign(`${path}${search}`);
      }, `?registry=${REGISTRY_FILE}`)
      .catch(() => undefined);

    const browser = page.locator('#jupyterlab-workshop-browser');

    await expect(browser).toBeVisible({ timeout: 60000 });
    await expect(
      browser.locator('.jp-WorkshopBrowser-card', {
        hasText: 'Pandas for beginners'
      })
    ).toHaveCount(1);

    // The installed workshop is listed once, not again under Available.
    await expect(
      browser.locator('.jp-WorkshopBrowser-card', {
        hasText: 'Git from the command line'
      })
    ).toHaveCount(1);
    await expect(page.locator('#jp-main-dock-panel .jp-Launcher')).toHaveCount(
      0
    );
    expect(await page.sidebar.isOpen('left')).toBe(false);
    expect(await page.sidebar.isOpen('right')).toBe(false);
    expect(page.url()).not.toContain('registry=');

    // Opening a workshop closes the browser and reveals the instructions.
    await browser
      .locator('.jp-WorkshopBrowser-card', { hasText: WORKSHOPS_DIR })
      .getByRole('button', { name: 'Open' })
      .click();

    const dialog = page.locator('.jp-Dialog');

    await expect(dialog.locator('.jp-WorkshopTrust')).toBeVisible();
    await dialog.getByRole('button', { name: 'Trust', exact: true }).click();
    await expect(
      page.locator('#jupyterlab-workshop-panel .jp-WorkshopPanel-title')
    ).toHaveText('Git from the command line');
    await expect(browser).toHaveCount(0);
    expect(await page.sidebar.isOpen('right')).toBe(true);

    // The layout's width applies even though the sidebar was collapsed
    // when the workshop opened. The layout finishes after its widgets
    // open, so the width is polled rather than read at once.
    await expect(
      page.locator('#jp-main-dock-panel .jp-MarkdownViewer')
    ).toBeVisible();
    await expect(page.locator('.jp-Terminal').first()).toBeVisible();

    const rightShare = async (): Promise<number> => {
      const right = (await page.locator('#jp-right-stack').boundingBox())
        ?.width;
      const split = (await page.locator('#jp-main-split-panel').boundingBox())
        ?.width;

      return (right ?? 0) / (split ?? 1);
    };

    await expect.poll(rightShare).toBeGreaterThan(0.2);
    expect(await rightShare()).toBeLessThan(0.3);
  });
});

test.describe('locked-down browser', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      [PLUGIN]: {
        defaultWorkshop: '',
        registries: [REGISTRY_FILE],
        workshopsDirectory: WORKSHOPS_DIR,
        disabledFeatures: [
          'open-directory',
          'open-url',
          'registries',
          'remove',
          'author'
        ]
      }
    }
  });

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

  test('hides the disabled features and restarts a workshop', async ({
    page
  }) => {
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      void exposed.jupyterapp.commands.execute('workshop:browse', {});
    });

    const browser = page.locator('#jupyterlab-workshop-browser');

    await expect(browser).toBeVisible();

    // The ways of bringing in other workshops are gone, but the registry
    // is still listed and the installed workshop still opens.
    const cards = browser.locator('.jp-WorkshopBrowser-card');

    await expect(cards.filter({ hasText: 'Pandas for beginners' })).toHaveCount(
      1
    );
    for (const name of [
      'Add from URL…',
      'Open a directory…',
      'Manage registries',
      'Remove'
    ]) {
      await expect(browser.getByRole('button', { name })).toHaveCount(0);
    }

    const installed = cards.filter({ hasText: WORKSHOPS_DIR });

    await expect(installed).toHaveCount(1);
    await installed.getByRole('button', { name: 'Open' }).click();

    const dialog = page.locator('.jp-Dialog');

    await expect(dialog.locator('.jp-WorkshopTrust')).toBeVisible();
    await dialog.getByRole('button', { name: 'Trust', exact: true }).click();

    const panel = page.locator('#jupyterlab-workshop-panel');

    await expect(panel.locator('.jp-WorkshopPanel-title')).toHaveText(
      'Git from the command line'
    );

    // The header keeps only the buttons the settings allow.
    for (const title of [
      'Edit this workshop',
      'Open another workshop',
      'Open a workshop from a URL'
    ]) {
      await expect(panel.locator(`button[title="${title}"]`)).toHaveCount(0);
    }
    await expect(panel.locator('button[title="Browse workshops"]')).toHaveCount(
      1
    );
    await expect(
      panel.locator('button[title="Close this workshop"]')
    ).toHaveCount(1);

    // Move to page two and add a file, then restart: the file goes, the
    // progress is forgotten and the workshop reopens at page one.
    const pageSelect = panel.locator('.jp-WorkshopPanel-pageSelect');

    await panel
      .locator('.jp-WorkshopPanel-footer button', { hasText: 'Next' })
      .click();
    await expect(pageSelect).toHaveValue('1');

    const added = `${WORKSHOPS_DIR}/${WORKSHOP}/added.txt`;

    await page.contents.uploadContent('added later', 'text', added);
    expect(await page.contents.fileExists(added)).toBe(true);

    await panel.locator('button[title="Restart this workshop"]').click();
    await expect(dialog).toContainText('Restart workshop');
    await dialog.getByRole('button', { name: 'Restart' }).click();

    await expect(pageSelect).toHaveValue('0');
    await expect
      .poll(() => page.contents.fileExists(added), { timeout: 15000 })
      .toBe(false);
    expect(
      await page.contents.fileExists(
        `${WORKSHOPS_DIR}/${WORKSHOP}/_workshop/snapshots/pristine.tar`
      )
    ).toBe(true);

    // The last page offers Finish in place of Next. Finishing shows the
    // dialog, and browsing from it closes the workshop for the browser.
    const options = await pageSelect.locator('option').count();

    await pageSelect.selectOption(String(options - 1));
    await expect(
      panel.locator('.jp-WorkshopPanel-footer button', { hasText: 'Next' })
    ).toHaveCount(0);
    await panel
      .locator('.jp-WorkshopPanel-footer button', { hasText: 'Finish' })
      .click();
    await expect(dialog).toContainText('Finished: Git from the command line');
    await expect(dialog).toContainText('everyday git commands');
    await expect(dialog.getByRole('button', { name: 'Shut down' })).toHaveCount(
      0
    );
    await dialog.getByRole('button', { name: 'Keep reading' }).click();
    await expect(panel.locator('.jp-WorkshopPanel-finished')).toContainText(
      'Finished'
    );
    // Only the finished page counts: page one was left with its
    // requirements unmet and the pages in between were never visited.
    await expect(panel.locator('.jp-WorkshopPanel-progress')).toHaveAttribute(
      'title',
      new RegExp(`^1 of ${options}`)
    );

    // Browsing from the dialog closes the workshop's preview and terminal
    // with it, so the browser fills a fresh window with both sidebars
    // collapsed.
    await expect(
      page.locator('#jp-main-dock-panel .jp-MarkdownViewer')
    ).toHaveCount(1);
    await panel.locator('.jp-WorkshopPanel-finished a').click();
    await dialog.getByRole('button', { name: 'Browse workshops' }).click();
    await expect(browser).toBeVisible();
    await expect(panel.locator('.jp-WorkshopPanel-title')).toHaveCount(0);
    await expect(
      page.locator('#jp-main-dock-panel .jp-MarkdownViewer')
    ).toHaveCount(0);
    await expect(page.locator('.jp-Terminal')).toHaveCount(0);
    expect(await page.sidebar.isOpen('right')).toBe(false);
  });
});
