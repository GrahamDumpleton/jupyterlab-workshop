import { expect, galata, test } from '@jupyterlab/galata';
import type { Page } from '@playwright/test';

const PLUGIN = '@jupyterlab-workshop/labextension:panel';

const MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: demo
title: My demo
pages:
  - pages/01.md
`;

interface IExposedApp {
  jupyterapp: {
    commands: { execute(id: string, args: object): Promise<unknown> };
  };
}

// The server is started with the fake agent provider (see
// jupyter_server_test_config.py), which answers by rule: it echoes a
// message, asks permission for `/ask`, streams slowly for `/slow`.
//
// Each group of tests has a library of its own, since tests run in
// parallel against one server and its conversations last as long as it.
function useLibrary(library: string, disabledFeatures: string[] = []): void {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      [PLUGIN]: {
        defaultWorkshop: '',
        collections: [],
        workshopsDirectory: library,
        disabledFeatures
      }
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.contents.uploadContent(
      JSON.stringify({ version: 1 }),
      'text',
      `${library}/library.json`
    );
    await page.contents.uploadContent(
      MANIFEST,
      'text',
      `${library}/personal/demo/workshop.yaml`
    );
    await page.contents.uploadContent(
      '# Start\n',
      'text',
      `${library}/personal/demo/pages/01.md`
    );
  });

  test.afterEach(async ({ page }) => {
    if (await page.contents.directoryExists(library)) {
      await page.contents.deleteDirectory(library);
    }
  });
}

async function openBrowser(page: Page): Promise<void> {
  await page.evaluate(() => {
    const exposed = window as unknown as IExposedApp;

    void exposed.jupyterapp.commands.execute('workshop:browse', {});
  });
  await expect(page.locator('#jupyterlab-workshop-browser')).toBeVisible();
}

test.describe('Workshop Author conversation', () => {
  const LIBRARY = 'test-author-chat';

  useLibrary(LIBRARY);

  test('holds a conversation about one of your own workshops', async ({
    page
  }) => {
    await openBrowser(page);

    const browser = page.locator('#jupyterlab-workshop-browser');
    const card = browser.locator('.jp-WorkshopBrowser-card', {
      hasText: 'My demo'
    });

    await expect(
      browser.getByRole('button', { name: 'Create Workshop with AI…' })
    ).toBeVisible();
    await card.getByRole('button', { name: 'Edit with AI' }).click();

    const author = page.locator('.jp-WorkshopAgent');
    const input = author.locator('.jp-WorkshopAgent-input');

    await expect(author.locator('.jp-WorkshopAgent-path')).toHaveText(
      `${LIBRARY}/personal/demo`
    );
    await expect(input).toBeEnabled();

    // A message streams back.
    await input.fill('hello there');
    await input.press('Enter');

    await expect(author.locator('.jp-WorkshopAgent-user')).toHaveText(
      'hello there'
    );
    await expect(author.locator('.jp-WorkshopAgent-assistant')).toHaveText(
      'You said: hello there'
    );

    // The bar under the message box shows the model, the context used and
    // where the agent stands; the model and effort can be changed.
    const model = author.getByLabel('Model');

    await expect(model).toHaveValue('default');
    await expect(author.locator('.jp-WorkshopAgent-context')).toContainText(
      '% context'
    );
    await expect(author.locator('.jp-WorkshopAgent-barStatus')).toHaveText(
      'Ready'
    );
    await expect(author.getByLabel('Effort')).toHaveCount(0);

    await model.selectOption('careful');
    await expect(model).toHaveValue('careful');

    const effort = author.getByLabel('Effort');

    await effort.selectOption('high');
    await expect(effort).toHaveValue('high');

    // A permission request waits for an answer.
    await input.fill('/ask');
    await input.press('Enter');

    const permission = author.locator('.jp-WorkshopAgent-permission');

    await expect(permission).toContainText('echo hello');
    await permission
      .getByRole('button', { name: 'Allow', exact: true })
      .click();
    await expect(permission).toContainText('Allowed.');
    await expect(
      author.locator('.jp-WorkshopAgent-assistant').last()
    ).toHaveText('Allowed.');

    // Publishing a new gist asks every time, so it offers no Always allow.
    await input.fill('/ask mcp__workshop__publish_gist {"directory": "."}');
    await input.press('Enter');

    const publish = permission.last();

    await expect(publish).toContainText(
      'Publishes demo to a new secret GitHub gist'
    );
    await expect(
      publish.getByRole('button', { name: 'Always allow' })
    ).toHaveCount(0);
    await publish.getByRole('button', { name: 'Deny' }).click();
    await expect(publish).toContainText('Denied.');
    await expect(
      author.locator('.jp-WorkshopAgent-assistant').last()
    ).toHaveText('Denied.');

    // A long reply can be stopped.
    await input.fill('/slow');
    await input.press('Enter');
    await author.getByRole('button', { name: 'Stop' }).click();

    await expect(author.locator('.jp-WorkshopAgent-note')).toHaveText(
      'Stopped.'
    );
    await expect(author.getByRole('button', { name: 'Send' })).toBeVisible();

    // Closing the tab ends the panel, not the conversation: Edit with AI
    // brings it back with what was said.
    await page
      .locator('.lm-TabBar-tab', { hasText: 'Workshop Author' })
      .locator('.lm-TabBar-tabCloseIcon')
      .click();
    await expect(author).toHaveCount(0);
    await page.locator('.lm-TabBar-tab', { hasText: 'Workshops' }).click();
    await card.getByRole('button', { name: 'Edit with AI' }).click();
    await expect(author.locator('.jp-WorkshopAgent-user').first()).toHaveText(
      'hello there'
    );

    // The conversation lives in the server: a reload shows it again. The
    // layout restorer saves after a short debounce, and the restored panel
    // takes the place of the launcher Galata would wait for.
    await page.waitForTimeout(2000);
    await page.reload({ waitForIsReady: false });
    await page.evaluate(async () => {
      await (window as unknown as { jupyterapp: { restored: Promise<void> } })
        .jupyterapp.restored;
    });

    const restored = page.locator('.jp-WorkshopAgent');

    await expect(restored.locator('.jp-WorkshopAgent-user').first()).toHaveText(
      'hello there',
      { timeout: 30000 }
    );
    await expect(restored.locator('.jp-WorkshopAgent-note')).toHaveText(
      'Stopped.'
    );

    // Compacting marks the place in the conversation where the summary
    // took over.
    await restored.getByRole('button', { name: 'Compact' }).click();
    await expect(restored.locator('.jp-WorkshopAgent-compacted')).toHaveText(
      'Conversation compacted'
    );
    await expect(restored.locator('.jp-WorkshopAgent-barStatus')).toHaveText(
      'Ready'
    );

    // A new conversation, once confirmed, starts with nothing said.
    await restored.getByRole('button', { name: 'New conversation' }).click();
    await page
      .locator('.jp-Dialog')
      .getByRole('button', { name: 'New conversation' })
      .click();
    await expect(restored.locator('.jp-WorkshopAgent-user')).toHaveCount(0);
    await expect(restored.locator('.jp-WorkshopAgent-hint')).toBeVisible();
    await expect(
      restored.getByRole('button', { name: 'New conversation' })
    ).toBeDisabled();
  });
});

test.describe('Workshop Author creating a workshop', () => {
  const LIBRARY = 'test-author-create';

  useLibrary(LIBRARY);

  test('creates a workshop in My workshops from a description', async ({
    page
  }) => {
    await openBrowser(page);
    await page
      .locator('#jupyterlab-workshop-browser')
      .getByRole('button', { name: 'Create Workshop with AI…' })
      .click();

    const dialog = page.locator('.jp-Dialog');

    await dialog.locator('textarea').fill('Git basics for beginners');
    await dialog.getByRole('button', { name: 'Create' }).click();

    const author = page.locator('.jp-WorkshopAgent');

    await expect(author.locator('.jp-WorkshopAgent-path')).toHaveText(
      `${LIBRARY}/personal/git-basics-for-beginners`
    );
    await expect(author.locator('.jp-WorkshopAgent-user')).toContainText(
      'Git basics for beginners'
    );
    expect(
      await page.contents.fileExists(
        `${LIBRARY}/personal/git-basics-for-beginners/workshop.yaml`
      )
    ).toBe(true);
  });
});

test.describe('Workshop Author switched off', () => {
  useLibrary('test-author-off', ['ai-authoring']);

  test('offers nothing of it in the library', async ({ page }) => {
    await openBrowser(page);

    const browser = page.locator('#jupyterlab-workshop-browser');

    await expect(
      browser.locator('.jp-WorkshopBrowser-card', { hasText: 'My demo' })
    ).toBeVisible();
    await expect(
      browser.getByRole('button', { name: 'Create Workshop with AI…' })
    ).toHaveCount(0);
    await expect(
      browser.getByRole('button', { name: 'Edit with AI' })
    ).toHaveCount(0);
  });
});
