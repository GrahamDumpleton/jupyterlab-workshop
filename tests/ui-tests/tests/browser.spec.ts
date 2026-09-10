import { expect, galata, test } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';
import * as path from 'path';
import * as zlib from 'zlib';

const WORKSHOP = 'git-basics';

const EXAMPLE_DIR = path.resolve(__dirname, '../../../examples', WORKSHOP);

const PLUGIN = '@jupyterlab-workshop/labextension:panel';

/** Fixed paths under the test server root, removed after each test. */
const COLLECTION_FILE = 'test-collection.json';

const SECOND_FILE = 'second/collection.json';

const CATALOG_FILE = 'test-catalog.json';

const WELCOME_FILE = 'test-welcome.md';

const ARCHIVE_FILE = 'pandas-intro-2.0.0.tar.gz';

const GIT_ARCHIVE_FILE = 'git-basics-0.2.0.tar.gz';

const CLASH_ARCHIVE_FILE = 'git-basics-9.0.0.tar.gz';

const WORKSHOPS_DIR = 'test-workshops';

/** The archive URL the server fetches a test workshop from: its own files. */
function filesUrl(page: Page, name: string): string {
  return `${new URL(page.url()).origin}/files/${name}`;
}

const COLLECTION = {
  version: 1,
  title: 'Test collection',
  description: 'Two workshops for the tests.',
  publisher: { name: 'Test Publisher', url: 'https://example.org' },
  tags: ['test'],
  ordered: true,
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
          source: { archive: `<archive:${GIT_ARCHIVE_FILE}>` }
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
          source: { archive: `<archive:${ARCHIVE_FILE}>` }
        }
      ]
    }
  ]
};

/** A second collection that also offers a `git-basics`. */
const SECOND = {
  version: 1,
  title: 'Second collection',
  description: 'Another course with its own git workshop.',
  icon: 'icon.svg',
  workshops: [
    {
      name: 'git-basics',
      title: 'Git, the other way',
      description: 'A different workshop with the same name.',
      tags: ['git'],
      platforms: ['linux', 'macos'],
      capabilities: ['terminal'],
      versions: [
        {
          version: '9.0.0',
          source: { archive: `<archive:${CLASH_ARCHIVE_FILE}>` }
        }
      ]
    }
  ]
};

const CATALOG = {
  version: 1,
  title: 'Test catalog',
  description: 'Collections for the tests.',
  collections: [
    {
      url: SECOND_FILE,
      title: 'Second collection',
      description: 'Another course with its own git workshop.',
      icon: 'second/icon.svg'
    }
  ]
};

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#36c"/></svg>';

const MANIFEST = (name: string, title: string, version: string): string =>
  [
    'apiVersion: jupyterlab-workshop/v1alpha1',
    `name: ${name}`,
    `title: ${title}`,
    `version: ${version}`,
    'pages:',
    '  - pages/01.md',
    ''
  ].join('\n');

interface IExposedApp {
  jupyterapp: {
    commands: { execute(id: string, args: object): Promise<unknown> };
    shell: {
      widgets(area: string): Iterable<{ id: string; node: HTMLElement }>;
    };
  };
}

/**
 * The share of the main area's height a widget takes, its tab bar aside.
 */
function mainShare(page: Page, id: string): Promise<number | null> {
  return page.evaluate((target: string) => {
    const exposed = window as unknown as IExposedApp;
    const dock = document.getElementById('jp-main-dock-panel');

    for (const widget of exposed.jupyterapp.shell.widgets('main')) {
      if (widget.id === target && dock) {
        return (
          widget.node.getBoundingClientRect().height /
          dock.getBoundingClientRect().height
        );
      }
    }

    return null;
  }, id);
}

/**
 * A gzipped tar holding a workshop, built by hand since the tests have
 * no tar library: one ustar header per file, then the padded content.
 */
function workshopArchive(name: string, title: string, version: string): Buffer {
  const files: Record<string, string> = {
    [`${name}/workshop.yaml`]: MANIFEST(name, title, version),
    [`${name}/pages/01.md`]: `---\ntitle: Start\n---\n\n# ${title}\n`
  };
  const blocks: Buffer[] = [];

  for (const [file, text] of Object.entries(files)) {
    const content = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(512, 0);

    header.write(file, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');

    let sum = 0;

    for (const byte of header) {
      sum += byte;
    }

    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    blocks.push(header, content);

    const padding = (512 - (content.length % 512)) % 512;

    if (padding > 0) {
      blocks.push(Buffer.alloc(padding, 0));
    }
  }

  blocks.push(Buffer.alloc(1024, 0));

  return zlib.gzipSync(Buffer.concat(blocks));
}

/** The collection JSON with archive placeholders pointed at the server. */
function withArchives(page: Page, collection: object): string {
  return JSON.stringify(collection).replace(
    /<archive:([^>]+)>/g,
    (_match, name: string) => filesUrl(page, name)
  );
}

async function uploadFixtures(page: Page): Promise<void> {
  await page.contents.uploadContent(
    withArchives(page, COLLECTION),
    'text',
    COLLECTION_FILE
  );
  await page.contents.uploadContent(
    withArchives(page, SECOND),
    'text',
    SECOND_FILE
  );
  await page.contents.uploadContent(ICON, 'text', 'second/icon.svg');
  await page.contents.uploadContent(
    JSON.stringify(CATALOG),
    'text',
    CATALOG_FILE
  );
  await page.contents.uploadContent(
    '# Welcome to the tests\n\nHello **there**, and mind the session.\n',
    'text',
    WELCOME_FILE
  );
  await page.contents.uploadContent(
    workshopArchive('pandas-intro', 'Pandas for beginners', '2.0.0').toString(
      'base64'
    ),
    'base64',
    ARCHIVE_FILE
  );
  await page.contents.uploadContent(
    workshopArchive('git-basics', 'Git, the other way', '9.0.0').toString(
      'base64'
    ),
    'base64',
    CLASH_ARCHIVE_FILE
  );
  await page.contents.uploadContent(
    workshopArchive(
      'git-basics',
      'Git from the command line',
      '0.2.0'
    ).toString('base64'),
    'base64',
    GIT_ARCHIVE_FILE
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
}

async function removeFixtures(page: Page): Promise<void> {
  for (const file of [
    COLLECTION_FILE,
    CATALOG_FILE,
    WELCOME_FILE,
    ARCHIVE_FILE,
    CLASH_ARCHIVE_FILE,
    GIT_ARCHIVE_FILE
  ]) {
    if (await page.contents.fileExists(file)) {
      await page.contents.deleteFile(file);
    }
  }

  for (const directory of ['second', WORKSHOPS_DIR]) {
    if (await page.contents.directoryExists(directory)) {
      await page.contents.deleteDirectory(directory);
    }
  }
}

async function openBrowser(page: Page): Promise<void> {
  await page.evaluate(() => {
    const exposed = window as unknown as IExposedApp;

    void exposed.jupyterapp.commands.execute('workshop:browse', {});
  });
  await expect(page.locator('#jupyterlab-workshop-browser')).toBeVisible();
}

async function trustWorkshop(page: Page, title: string): Promise<void> {
  const dialog = page.locator('.jp-Dialog');

  await expect(dialog.locator('.jp-WorkshopTrust')).toBeVisible({
    timeout: 60000
  });
  await dialog.getByRole('button', { name: 'Trust', exact: true }).click();
  await expect(
    page.locator('#jupyterlab-workshop-panel .jp-WorkshopPanel-title')
  ).toHaveText(title);
}

test.use({
  mockSettings: {
    ...galata.DEFAULT_SETTINGS,
    [PLUGIN]: {
      defaultWorkshop: '',
      collections: [COLLECTION_FILE],
      workshopsDirectory: WORKSHOPS_DIR
    }
  }
});

test.describe('workshop browser', () => {
  test.beforeEach(async ({ page }) => {
    await uploadFixtures(page);
  });

  test.afterEach(async ({ page }) => {
    await removeFixtures(page);
  });

  test('lists collection and installed workshops and opens one', async ({
    page
  }) => {
    await openBrowser(page);

    const browser = page.locator('#jupyterlab-workshop-browser');

    // The collection is a group headed by its title and description, and
    // its entries show as cards with their metadata and a source label.
    const group = browser.locator('.jp-WorkshopBrowser-group');

    await expect(group).toHaveCount(1);
    await expect(group.locator('.jp-WorkshopBrowser-groupTitle')).toContainText(
      'Test collection'
    );
    await expect(
      group.locator('.jp-WorkshopBrowser-groupDescription')
    ).toHaveText('Two workshops for the tests.');
    await expect(
      group.locator('.jp-WorkshopSourceIcon.jp-mod-tile')
    ).toHaveText('T');

    const cards = browser.locator('.jp-WorkshopBrowser-card');
    const pandas = cards.filter({ hasText: 'Pandas for beginners' });

    await expect(pandas).toHaveCount(1);
    await expect(pandas.locator('.jp-WorkshopBrowser-chip')).toContainText([
      'Test collection',
      'linux',
      'kernel-exec'
    ]);

    // The uploaded workshop appears once, under Installed, and since the
    // collection lists a newer version its card offers the update.
    const installed = cards.filter({ hasText: WORKSHOPS_DIR });

    await expect(installed).toHaveCount(1);
    await expect(installed).toContainText('not started');
    await expect(
      installed.getByRole('button', { name: 'Update to 0.2.0' })
    ).toHaveCount(1);

    // The collection is ordered, so the cards carry their step in it, and
    // the uploaded git-basics, first and unfinished, is the one up next.
    await expect(
      installed.locator('.jp-WorkshopBrowser-chip.jp-mod-step')
    ).toHaveText('1 of 2');
    await expect(
      installed.locator('.jp-WorkshopBrowser-chip.jp-mod-next')
    ).toHaveText('Up next');
    await expect(
      pandas.locator('.jp-WorkshopBrowser-chip.jp-mod-step')
    ).toHaveText('2 of 2');
    await expect(
      pandas.locator('.jp-WorkshopBrowser-chip.jp-mod-next')
    ).toHaveCount(0);
    await expect(
      cards.filter({ hasText: 'Git from the command line' })
    ).toHaveCount(1);

    // Search and tags narrow the collection list.
    await browser.locator('.jp-WorkshopBrowser-search').fill('pandas');
    await expect(
      cards.filter({ hasText: 'Git from the command line' })
    ).toHaveCount(1);
    await expect(pandas).toHaveCount(1);
    await browser.locator('.jp-WorkshopBrowser-search').fill('');
    await browser
      .locator('.jp-WorkshopBrowser-tag', { hasText: 'data' })
      .click();
    await expect(pandas).toHaveCount(1);
    await browser
      .locator('.jp-WorkshopBrowser-tag', { hasText: 'data' })
      .click();

    // Collapsing a group hides its cards and is remembered.
    await group.locator('.jp-WorkshopBrowser-groupToggle').click();
    await expect(pandas).toHaveCount(0);
    await group.locator('.jp-WorkshopBrowser-groupToggle').click();
    await expect(pandas).toHaveCount(1);

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

    // The browser and the launcher have both gone, and the layout's
    // terminal has the share it asked for, 0.4, rather than the half it
    // gets when a closing tab's share is split evenly.
    await expect(page.locator('.jp-Terminal')).toBeVisible();
    await expect(browser).toHaveCount(0);
    await expect(page.locator('.jp-Launcher')).toHaveCount(0);
    await expect
      .poll(() => mainShare(page, 'jupyterlab-workshop-terminal-git'))
      .toBeLessThan(0.45);
  });

  test('installs from a collection, recording it, and suffixes a clash', async ({
    page
  }) => {
    await openBrowser(page);

    const browser = page.locator('#jupyterlab-workshop-browser');
    const cards = browser.locator('.jp-WorkshopBrowser-card');

    // Installing downloads the archive from the server's own files and
    // lists the workshop under Installed without opening it.
    await cards
      .filter({ hasText: 'Pandas for beginners' })
      .getByRole('button', { name: 'Install' })
      .click();
    await expect(
      cards
        .filter({ hasText: WORKSHOPS_DIR })
        .filter({ hasText: 'Pandas for beginners' })
    ).toHaveCount(1);
    await expect(
      browser.locator('.jp-WorkshopBrowser-group .jp-WorkshopBrowser-card', {
        hasText: 'Pandas for beginners'
      })
    ).toHaveCount(0);
    await expect(page.locator('#jupyterlab-workshop-panel')).toBeHidden();

    const record = await page.request.get(
      `api/contents/${WORKSHOPS_DIR}/pandas-intro/_workshop/source.json?content=1`
    );

    expect(record.ok()).toBe(true);
    expect(String((await record.json()).content)).toContain(COLLECTION_FILE);

    // The uploaded git-basics recorded no collection, but only this
    // collection lists its name, so Installed follows the collection's
    // order, git-basics before pandas-intro, rather than the titles.
    await expect(
      cards
        .filter({ hasText: WORKSHOPS_DIR })
        .locator('.jp-WorkshopBrowser-cardTitle')
    ).toHaveText([/Git from the command line/, /Pandas for beginners/]);

    // Replace the uploaded git-basics, which no collection is recorded
    // for, with the first collection's own, so the second collection's
    // git-basics is a real clash: it stays listed, and installing it
    // lands in a directory with the collection's hash appended.
    await cards
      .filter({ hasText: WORKSHOPS_DIR })
      .filter({ hasText: 'Git from the command line' })
      .getByRole('button', { name: 'Remove' })
      .click();
    await page
      .locator('.jp-Dialog')
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(
      cards.filter({ hasText: 'Git from the command line' })
    ).toHaveCount(1);
    await cards
      .filter({ hasText: 'Git from the command line' })
      .getByRole('button', { name: 'Install' })
      .click();
    await expect(
      cards
        .filter({ hasText: WORKSHOPS_DIR })
        .filter({ hasText: 'Git from the command line' })
    ).toHaveCount(1);

    await page.evaluate((file: string) => {
      const exposed = window as unknown as IExposedApp;

      void exposed.jupyterapp.commands.execute('workshop:collections', {});

      return file;
    }, SECOND_FILE);

    const dialog = page.locator('.jp-Dialog');
    const sources = dialog.locator('.jp-WorkshopSources');

    await expect(sources).toBeVisible();
    await sources.locator('.jp-WorkshopSources-input').fill(SECOND_FILE);
    await sources
      .getByRole('button', { name: 'Subscribe', exact: true })
      .click();
    await expect(
      sources.locator('.jp-WorkshopSources-row', {
        hasText: 'Second collection'
      })
    ).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Close' }).click();

    const second = browser.locator('.jp-WorkshopBrowser-group', {
      hasText: 'Second collection'
    });

    await expect(second).toHaveCount(1);
    await expect(second.locator('.jp-WorkshopSourceIcon img')).toHaveCount(1);

    const other = second.locator('.jp-WorkshopBrowser-card', {
      hasText: 'Git, the other way'
    });

    await expect(other).toHaveCount(1);
    await other.getByRole('button', { name: 'Install' }).click();
    await expect(
      cards
        .filter({ hasText: WORKSHOPS_DIR })
        .filter({ hasText: 'Git, the other way' })
    ).toHaveCount(1);

    const listing = await page.request.get(
      `api/contents/${WORKSHOPS_DIR}?content=1`
    );
    const names = ((await listing.json()).content as { name: string }[])
      .map(item => item.name)
      .sort();

    expect(names).toContain('git-basics');
    expect(names).toContain('pandas-intro');
    expect(names.some(name => /^git-basics-[0-9a-f]{7}$/.test(name))).toBe(
      true
    );

    // Both git workshops are now installed, each matched to its own
    // collection, so nothing is left to offer and the Available section
    // is not shown at all.
    const installed = browser.locator('.jp-WorkshopBrowser-card', {
      hasText: WORKSHOPS_DIR
    });

    await expect(installed).toHaveCount(3);
    await expect(
      browser.locator('.jp-WorkshopBrowser-heading', { hasText: 'Available' })
    ).toHaveCount(0);
    await expect(browser.locator('.jp-WorkshopBrowser-group')).toHaveCount(0);
    await expect(
      installed
        .filter({ hasText: 'Git, the other way' })
        .locator('.jp-WorkshopBrowser-chip.jp-mod-source')
    ).toHaveText('Second collection');

    // Open starts the installed workshop from its card.
    await installed
      .filter({ hasText: 'Git, the other way' })
      .getByRole('button', { name: 'Open' })
      .click();
    await trustWorkshop(page, 'Git, the other way');
  });

  test('leaves a name two collections offer unmatched', async ({ page }) => {
    await openBrowser(page);

    const browser = page.locator('#jupyterlab-workshop-browser');
    const uploaded = browser
      .locator('.jp-WorkshopBrowser-card')
      .filter({ hasText: WORKSHOPS_DIR });

    // With one collection listing the name, the uploaded git-basics is
    // taken to be that collection's and offered its newer version.
    await expect(uploaded).toHaveCount(1);
    await expect(
      uploaded.locator('.jp-WorkshopBrowser-chip.jp-mod-source')
    ).toHaveText('Test collection');
    await expect(
      uploaded.getByRole('button', { name: 'Update to 0.2.0' })
    ).toHaveCount(1);

    // Subscribing to a second collection that also offers a git-basics
    // makes the name ambiguous: the browser stops guessing, so the card
    // names no collection and offers no update.
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      void exposed.jupyterapp.commands.execute('workshop:collections', {});
    });

    const dialog = page.locator('.jp-Dialog');
    const sources = dialog.locator('.jp-WorkshopSources');

    await expect(sources).toBeVisible();
    await sources.locator('.jp-WorkshopSources-input').fill(SECOND_FILE);
    await sources
      .getByRole('button', { name: 'Subscribe', exact: true })
      .click();
    await expect(
      sources.locator('.jp-WorkshopSources-row', {
        hasText: 'Second collection'
      })
    ).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Close' }).click();

    await expect(
      browser.locator('.jp-WorkshopBrowser-group', {
        hasText: 'Second collection'
      })
    ).toHaveCount(1);
    await expect(uploaded).toHaveCount(1);
    await expect(
      uploaded.locator('.jp-WorkshopBrowser-chip.jp-mod-source')
    ).toHaveCount(0);
    await expect(uploaded.getByRole('button', { name: /^Update/ })).toHaveCount(
      0
    );
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
    // must find the new page recorded in it to carry on from there. The
    // file lists every page id from its first save, so only the current
    // page field proves the save after Next has landed.
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `api/contents/${WORKSHOPS_DIR}/${WORKSHOP}/_workshop/state.json?content=1`
        );

        return response.ok() ? String((await response.json()).content) : '';
      })
      .toContain('"currentPage": "02-first-commit"');

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

  test('installs a named workshop of a collection from a launch link', async ({
    page
  }) => {
    await page
      .evaluate((search: string) => {
        window.location.assign(`${window.location.pathname}${search}`);
      }, `?collection=${COLLECTION_FILE}&workshop=pandas-intro`)
      .catch(() => undefined);

    await trustWorkshop(page, 'Pandas for beginners');
    expect(page.url()).not.toContain('collection=');

    const record = await page.request.get(
      `api/contents/${WORKSHOPS_DIR}/pandas-intro/_workshop/source.json?content=1`
    );

    expect(record.ok()).toBe(true);
    expect(String((await record.json()).content)).toContain(COLLECTION_FILE);
  });

  test('starts in the browser from a collection launch link and keeps it', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });

    // The link names a collection file under the root. In a fresh
    // workspace, as on Binder, the browser takes the launcher's place and
    // both sidebars collapse; a new workspace name keeps the earlier
    // tests' layout record out of the way.
    await page
      .evaluate((search: string) => {
        const name = `link-${Date.now().toString(36)}`;
        const path = window.location.pathname.replace(
          /\/lab(\/workspaces\/[^/]+)?/,
          `/lab/workspaces/${name}`
        );

        window.location.assign(`${path}${search}`);
      }, `?collection=${SECOND_FILE}`)
      .catch(() => undefined);

    const browser = page.locator('#jupyterlab-workshop-browser');

    await expect(browser).toBeVisible({ timeout: 60000 });

    // Both the configured collection and the link's are grouped.
    await expect(
      browser.locator('.jp-WorkshopBrowser-group', {
        hasText: 'Test collection'
      })
    ).toHaveCount(1);
    await expect(
      browser.locator('.jp-WorkshopBrowser-group', {
        hasText: 'Second collection'
      })
    ).toHaveCount(1);
    await expect(page.locator('#jp-main-dock-panel .jp-Launcher')).toHaveCount(
      0
    );
    expect(await page.sidebar.isOpen('left')).toBe(false);
    expect(await page.sidebar.isOpen('right')).toBe(false);
    expect(page.url()).not.toContain('collection=');

    // The dialog shows where each came from, and Subscribe moves the
    // link's collection into the settings.
    await browser.getByRole('button', { name: 'Collections…' }).click();

    const dialog = page.locator('.jp-Dialog');
    const row = dialog.locator('.jp-WorkshopSources-row', {
      hasText: 'Second collection'
    });

    await expect(row).toContainText('from this session');
    await row.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(row).toContainText('from your settings');
    await expect(
      row.getByRole('button', { name: 'Subscribe', exact: true })
    ).toHaveCount(0);

    // Unsubscribing takes the group away again.
    await row.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(row).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(
      browser.locator('.jp-WorkshopBrowser-group', {
        hasText: 'Second collection'
      })
    ).toHaveCount(0);

    // Opening a workshop closes the browser and reveals the instructions.
    await browser
      .locator('.jp-WorkshopBrowser-card', { hasText: WORKSHOPS_DIR })
      .getByRole('button', { name: 'Open' })
      .click();

    await trustWorkshop(page, 'Git from the command line');
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

    await expect.poll(rightShare).toBeGreaterThan(0.23);
    expect(await rightShare()).toBeLessThan(0.27);
  });

  test('offers the collections of a catalog from a launch link', async ({
    page
  }) => {
    await page
      .evaluate((search: string) => {
        window.location.assign(`${window.location.pathname}${search}`);
      }, `?catalog=${CATALOG_FILE}`)
      .catch(() => undefined);

    const browser = page.locator('#jupyterlab-workshop-browser');

    await expect(browser).toBeVisible({ timeout: 60000 });

    // The catalog's collection that is not subscribed to is offered, with
    // the catalog's word on it and its icon; subscribing lists its workshops.
    const offered = browser.locator('.jp-WorkshopBrowser-suggestion');

    await expect(offered).toHaveCount(1);
    await expect(offered).toContainText('Second collection');
    await expect(offered).toContainText('from Test catalog');
    await expect(offered.locator('.jp-WorkshopSourceIcon img')).toHaveCount(1);
    await offered
      .getByRole('button', { name: 'Subscribe', exact: true })
      .click();

    await expect(
      browser.locator('.jp-WorkshopBrowser-group', {
        hasText: 'Second collection'
      })
    ).toHaveCount(1);
    await expect(offered).toHaveCount(0);

    // The dialog's Catalogs tab lists the catalog, and the collections
    // tab marks the new collection as subscribed.
    await browser.getByRole('button', { name: 'Collections…' }).click();

    const dialog = page.locator('.jp-Dialog');
    const catalogRow = dialog.locator(
      '.jp-WorkshopSources-catalogs .jp-WorkshopSources-row'
    );

    await expect(catalogRow).toContainText('subscribed');
    await dialog.getByRole('tab', { name: 'Catalogs' }).click();
    await expect(
      dialog.locator('.jp-WorkshopSources-row', { hasText: 'Test catalog' })
    ).toContainText('from this session');
    await dialog.getByRole('button', { name: 'Close' }).click();
  });
});

test.describe('welcome message', () => {
  test.beforeEach(async ({ page }) => {
    await uploadFixtures(page);
  });

  test.afterEach(async ({ page }) => {
    await removeFixtures(page);
  });

  test('shows a welcome message from a launch link', async ({ page }) => {
    await page
      .evaluate((search: string) => {
        window.location.assign(`${window.location.pathname}${search}`);
      }, `?welcome=${WELCOME_FILE}`)
      .catch(() => undefined);

    // The file's heading is the dialog's title and the rest its body,
    // rendered as Markdown.
    const dialog = page.locator('.jp-Dialog');

    await expect(dialog.locator('.jp-Dialog-header')).toHaveText(
      'Welcome to the tests',
      { timeout: 60000 }
    );
    await expect(dialog.locator('.jp-WorkshopWelcome')).toContainText(
      'Hello there, and mind the session.'
    );
    await expect(dialog.locator('.jp-WorkshopWelcome strong')).toHaveText(
      'there'
    );
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    // A link that only names a welcome message leaves the launcher as
    // it was, and the parameter is gone from the address once handled.
    await expect(page.locator('#jupyterlab-workshop-browser')).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('welcome'))
      .toBeNull();

    // The palette command shows the message again.
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      void exposed.jupyterapp.commands.execute('workshop:welcome', {});
    });
    await expect(dialog.locator('.jp-Dialog-header')).toHaveText(
      'Welcome to the tests'
    );
    await dialog.getByRole('button', { name: 'Close' }).click();
  });
});

test.describe('locked-down browser', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      [PLUGIN]: {
        defaultWorkshop: '',
        collections: [COLLECTION_FILE],
        workshopsDirectory: WORKSHOPS_DIR,
        disabledFeatures: [
          'open-directory',
          'open-url',
          'collections',
          'catalogs',
          'remove',
          'author'
        ]
      }
    }
  });

  test.beforeEach(async ({ page }) => {
    await uploadFixtures(page);
  });

  test.afterEach(async ({ page }) => {
    await removeFixtures(page);
  });

  test('hides the disabled features and restarts a workshop', async ({
    page
  }) => {
    await openBrowser(page);

    const browser = page.locator('#jupyterlab-workshop-browser');

    // The ways of bringing in other workshops are gone, but the collection
    // is still listed and the installed workshop still opens.
    const cards = browser.locator('.jp-WorkshopBrowser-card');

    await expect(cards.filter({ hasText: 'Pandas for beginners' })).toHaveCount(
      1
    );
    for (const name of [
      'Add from URL…',
      'Open a directory…',
      'Collections…',
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

    // The workshop declares a workspace, so the learner's file goes
    // there, Restart refills that directory, and no pristine snapshot of
    // the whole workshop is ever taken.
    const added = `${WORKSHOPS_DIR}/${WORKSHOP}/work/added.txt`;

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
      await page.contents.directoryExists(`${WORKSHOPS_DIR}/${WORKSHOP}/work`)
    ).toBe(true);
    expect(
      await page.contents.fileExists(
        `${WORKSHOPS_DIR}/${WORKSHOP}/_workshop/snapshots/pristine.tar`
      )
    ).toBe(false);
  });
});

/** A collection for Install all: two good archives, a bad hash, one for Lite only. */
const BULK_FILE = 'bulk-collection.json';

const BULK = {
  version: 1,
  title: 'Bulk collection',
  description: 'Four workshops to install at once.',
  ordered: true,
  workshops: [
    {
      name: 'pandas-intro',
      title: 'Pandas for beginners',
      versions: [
        { version: '2.0.0', source: { archive: `<archive:${ARCHIVE_FILE}>` } }
      ]
    },
    {
      name: 'git-basics',
      title: 'Git, the other way',
      versions: [
        {
          version: '9.0.0',
          source: { archive: `<archive:${CLASH_ARCHIVE_FILE}>` }
        }
      ]
    },
    {
      name: 'broken',
      title: 'Broken hash',
      versions: [
        {
          version: '1.0.0',
          source: { archive: `<archive:${GIT_ARCHIVE_FILE}>` },
          sha256: '0'.repeat(64)
        }
      ]
    },
    {
      name: 'lite-only',
      title: 'Only on Lite',
      platforms: ['lite'],
      versions: [
        { version: '1.0.0', source: { archive: `<archive:${ARCHIVE_FILE}>` } }
      ]
    }
  ]
};

test.describe('install all', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      [PLUGIN]: {
        defaultWorkshop: '',
        collections: [BULK_FILE],
        workshopsDirectory: WORKSHOPS_DIR
      }
    }
  });

  test.beforeEach(async ({ page }) => {
    await uploadFixtures(page);
    await page.contents.uploadContent(
      withArchives(page, BULK),
      'text',
      BULK_FILE
    );

    // The uploaded git-basics would count as installed by name; this
    // collection starts with nothing installed.
    await page.contents.deleteDirectory(WORKSHOPS_DIR);
  });

  test.afterEach(async ({ page }) => {
    await page.contents.deleteFile(BULK_FILE);
    await removeFixtures(page);
  });

  test('installs the chosen workshops, reports the rest, and removes them all', async ({
    page
  }) => {
    await openBrowser(page);

    const browser = page.locator('#jupyterlab-workshop-browser');
    const group = browser.locator('.jp-WorkshopBrowser-group');
    const cards = browser.locator('.jp-WorkshopBrowser-card');
    const dialog = page.locator('.jp-Dialog');

    // The heading offers Install all, and the dialog lists every entry
    // with the Lite-only one unticked and the count underneath. Cancel
    // is the default, so Enter installs nothing.
    await group.getByRole('button', { name: 'Install all…' }).click();
    await expect(dialog).toContainText(
      'Install every workshop of "Bulk collection"?'
    );

    const boxes = dialog.locator('input[type="checkbox"]');

    await expect(boxes).toHaveCount(4);
    await expect(boxes.nth(3)).not.toBeChecked();
    await expect(dialog.locator('.jp-WorkshopBulk-count')).toHaveText(
      '3 workshops to install, 1 not for this platform.'
    );
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(cards.filter({ hasText: WORKSHOPS_DIR })).toHaveCount(0);

    // Installing runs the three ticked ones in order; the bad hash fails
    // and the summary says so, offering to retry it.
    await group.getByRole('button', { name: 'Install all…' }).click();
    await dialog.getByRole('button', { name: 'Install' }).click();
    await expect(dialog).toContainText('Install all from "Bulk collection"', {
      timeout: 60000
    });
    await expect(dialog).toContainText('Installed (2)');
    await expect(dialog).toContainText('Failed (1)');
    await expect(dialog).toContainText('hash did not match the collection');
    await expect(
      dialog.getByRole('button', { name: 'Retry remaining' })
    ).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Close' }).click();

    const installed = cards.filter({ hasText: WORKSHOPS_DIR });

    await expect(installed).toHaveCount(2);
    await expect(installed.locator('.jp-WorkshopBrowser-cardTitle')).toHaveText(
      [/Pandas for beginners/, /Git, the other way/]
    );
    await expect(
      group.locator('.jp-WorkshopBrowser-card', { hasText: 'Broken hash' })
    ).toHaveCount(1);
    await expect(
      group.locator('.jp-WorkshopBrowser-card', { hasText: 'Only on Lite' })
    ).toHaveCount(1);

    const record = await page.request.get(
      `api/contents/${WORKSHOPS_DIR}/pandas-intro/_workshop/source.json?content=1`
    );

    expect(record.ok()).toBe(true);
    expect(String((await record.json()).content)).toContain(BULK_FILE);

    // Remove all sits behind the heading menu and asks first, listing
    // the directories; confirming clears what the collection installed.
    await group
      .getByRole('button', { name: 'More actions for this collection' })
      .click();
    await group
      .getByRole('menuitem', { name: /^Remove all 2 installed workshops/ })
      .click();
    await expect(dialog).toContainText(
      'Remove every workshop of "Bulk collection"?'
    );
    await expect(dialog).toContainText(`${WORKSHOPS_DIR}/pandas-intro`);
    await dialog.getByRole('button', { name: 'Remove all' }).click();
    await expect(installed).toHaveCount(0);
    await expect(group.locator('.jp-WorkshopBrowser-card')).toHaveCount(4);
  });

  test.describe('with install-all disabled', () => {
    test.use({
      mockSettings: {
        ...galata.DEFAULT_SETTINGS,
        [PLUGIN]: {
          defaultWorkshop: '',
          collections: [BULK_FILE],
          workshopsDirectory: WORKSHOPS_DIR,
          disabledFeatures: ['install-all']
        }
      }
    });

    test('keeps single installs but hides the bulk actions', async ({
      page
    }) => {
      await openBrowser(page);

      const browser = page.locator('#jupyterlab-workshop-browser');
      const group = browser.locator('.jp-WorkshopBrowser-group');

      await expect(
        group.getByRole('button', { name: 'Install', exact: true })
      ).toHaveCount(4);
      await expect(
        group.getByRole('button', { name: 'Install all…' })
      ).toHaveCount(0);
      await expect(
        group.getByRole('button', { name: 'More actions for this collection' })
      ).toHaveCount(0);
    });
  });
});

/** An ordered collection of two one-page workshops, both in the checkout. */
const SEQUENCE_FILE = 'sequence.json';

const SEQUENCE = {
  version: 1,
  title: 'Sequence',
  ordered: true,
  workshops: [
    {
      name: 'first-steps',
      title: 'First steps',
      versions: [
        { version: '1.0', source: { archive: 'https://example.org/first.tgz' } }
      ]
    },
    {
      name: 'second-steps',
      title: 'Second steps',
      versions: [
        {
          version: '1.0',
          source: { archive: 'https://example.org/second.tgz' }
        }
      ]
    }
  ]
};

test.describe('ordered collection', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      [PLUGIN]: {
        defaultWorkshop: '',
        collections: [SEQUENCE_FILE],
        workshopsDirectory: WORKSHOPS_DIR
      }
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.contents.uploadContent(
      JSON.stringify(SEQUENCE),
      'text',
      SEQUENCE_FILE
    );

    for (const entry of SEQUENCE.workshops) {
      await page.contents.uploadContent(
        [
          'apiVersion: jupyterlab-workshop/v1alpha1',
          `name: ${entry.name}`,
          `title: ${entry.title}`,
          'gating: off',
          'pages: [pages/01.md]',
          ''
        ].join('\n'),
        'text',
        `${WORKSHOPS_DIR}/${entry.name}/workshop.yaml`
      );
      await page.contents.uploadContent(
        ['---', 'title: The only page', '---', '', '# The only page', ''].join(
          '\n'
        ),
        'text',
        `${WORKSHOPS_DIR}/${entry.name}/pages/01.md`
      );
    }
  });

  test.afterEach(async ({ page }) => {
    await page.contents.deleteFile(SEQUENCE_FILE);
    await page.contents.deleteDirectory(WORKSHOPS_DIR);
  });

  test('numbers the workshops and offers the next one on finishing', async ({
    page
  }) => {
    await openBrowser(page);

    const browser = page.locator('#jupyterlab-workshop-browser');
    const cards = browser.locator('.jp-WorkshopBrowser-card');
    const first = cards.filter({ hasText: 'First steps' });
    const second = cards.filter({ hasText: 'Second steps' });

    // Both are checkout directories matched by name, listed in the
    // collection's order with their step in it; the first, not yet
    // finished, is the one up next.
    await expect(cards.first()).toContainText('First steps');
    await expect(
      first.locator('.jp-WorkshopBrowser-chip.jp-mod-step')
    ).toHaveText('1 of 2');
    await expect(
      second.locator('.jp-WorkshopBrowser-chip.jp-mod-step')
    ).toHaveText('2 of 2');
    await expect(
      first.locator('.jp-WorkshopBrowser-chip.jp-mod-next')
    ).toHaveText('Up next');
    await expect(
      second.locator('.jp-WorkshopBrowser-chip.jp-mod-next')
    ).toHaveCount(0);

    // Finishing the first names the second and opens it.
    await first.getByRole('button', { name: 'Open' }).click();
    await trustWorkshop(page, 'First steps');
    await page
      .locator('#jupyterlab-workshop-panel')
      .getByRole('button', { name: 'Finish' })
      .click();

    const dialog = page.locator('.jp-Dialog');

    await expect(dialog).toContainText('Next in Sequence: Second steps.');
    await dialog.getByRole('button', { name: 'Next workshop' }).click();
    await trustWorkshop(page, 'Second steps');

    // With the first finished, the second is now the one up next.
    await openBrowser(page);
    await expect(
      first.locator('.jp-WorkshopBrowser-chip.jp-mod-next')
    ).toHaveCount(0);
    await expect(
      second.locator('.jp-WorkshopBrowser-chip.jp-mod-next')
    ).toHaveText('Up next');
  });
});
