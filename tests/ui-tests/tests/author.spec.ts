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
    commands: {
      execute(id: string, args: object): Promise<unknown>;
      isEnabled(id: string): boolean;
    };
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

test.describe('Workshop Author attachments', () => {
  const LIBRARY = 'test-author-attach';

  useLibrary(LIBRARY);

  test('attaches pasted and chosen files and long pasted text to a message', async ({
    page
  }) => {
    await openBrowser(page);
    await page
      .locator('#jupyterlab-workshop-browser')
      .locator('.jp-WorkshopBrowser-card', { hasText: 'My demo' })
      .getByRole('button', { name: 'Edit with AI' })
      .click();

    const author = page.locator('.jp-WorkshopAgent');
    const input = author.locator('.jp-WorkshopAgent-input');
    const chips = author.locator(
      '.jp-WorkshopAgent-composer .jp-WorkshopAgent-attachment'
    );

    await expect(input).toBeEnabled();

    // A file on the clipboard is attached rather than pasted; the words
    // typed stay in the box.
    await input.fill('look at this');
    await input.evaluate(element => {
      const transfer = new DataTransfer();

      transfer.items.add(
        new File(['\x89PNG\r\n\x1a\n' + '\0'.repeat(8)], 'shot.png', {
          type: 'image/png'
        })
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true
        })
      );
    });

    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('shot.png');
    await expect(input).toHaveValue('look at this');

    // Long pasted text becomes a file too, and short text is pasted.
    await input.evaluate(element => {
      const paste = (text: string): void => {
        const transfer = new DataTransfer();

        transfer.setData('text/plain', text);
        element.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true
          })
        );
      };

      paste('line\n'.repeat(60));
      paste('short');
    });

    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toContainText('pasted-text-1.txt');
    await expect(input).toHaveValue('look at this');

    // A file that is not an image, PDF or text is refused.
    await author.getByLabel('Files to attach').setInputFiles({
      name: 'tool.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('MZ')
    });

    await expect(author.locator('.jp-WorkshopAgent-attachError')).toContainText(
      'tool.exe cannot be attached'
    );
    await expect(chips).toHaveCount(2);

    // One chosen with the button is attached, and a chip can be removed.
    await author.getByLabel('Files to attach').setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Notes\n')
    });

    await expect(chips).toHaveCount(3);
    await chips.nth(1).getByRole('button', { name: 'Remove' }).click();
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toContainText('notes.md');

    // Sent, the message shows what went with it, the agent was given the
    // files, and the composer is clear.
    await input.press('Enter');

    const sent = author.locator('.jp-WorkshopAgent-user');

    await expect(sent).toContainText('look at this');
    await expect(sent.locator('.jp-WorkshopAgent-attachment')).toHaveCount(2);
    await expect(
      sent.locator('.jp-WorkshopAgent-attachment').nth(1)
    ).toContainText('notes.md');
    await expect(
      author.locator('.jp-WorkshopAgent-assistant').first()
    ).toContainText('Attached: shot.png (image/png, 17 bytes) at ');
    await expect(chips).toHaveCount(0);

    expect(
      await page.contents.fileExists(
        `${LIBRARY}/personal/demo/_workshop/attachments/notes.md`
      )
    ).toBe(true);

    // After a reload the chips are still shown with the message.
    await page.waitForTimeout(2000);
    await page.reload({ waitForIsReady: false });
    await page.evaluate(async () => {
      await (window as unknown as { jupyterapp: { restored: Promise<void> } })
        .jupyterapp.restored;
    });

    const restored = page.locator('.jp-WorkshopAgent');

    await expect(
      restored.locator('.jp-WorkshopAgent-user .jp-WorkshopAgent-attachment')
    ).toHaveCount(2, { timeout: 30000 });
  });
});

test.describe('Workshop Author playing a workshop', () => {
  const LIBRARY = 'test-author-play';

  useLibrary(LIBRARY);

  test('a play-through that passes closes the workshop and returns to the conversation', async ({
    page
  }) => {
    test.setTimeout(120000);

    await openBrowser(page);
    await page
      .locator('.jp-WorkshopBrowser-card', { hasText: 'My demo' })
      .getByRole('button', { name: 'Edit with AI' })
      .click();

    const author = page.locator('.jp-WorkshopAgent');
    const input = author.locator('.jp-WorkshopAgent-input');

    await expect(input).toBeEnabled();
    await author.getByRole('button', { name: 'Open workshop' }).click();
    await expect(page.locator('.jp-WorkshopPanel-pageTitle')).toBeVisible();

    // The agent plays the workshop, as it does to check a version.
    await input.fill('/tool run_workshop {}');
    await input.press('Enter');
    await expect(
      author.locator('.jp-WorkshopAgent-tool.jp-mod-ok')
    ).toHaveCount(1, { timeout: 60000 });

    // It reached the end with nothing failed, so the workshop was left as
    // Finish leaves it, and the conversation is back in front.
    const open = await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.isEnabled('workshop:run-all');
    });

    expect(open).toBe(false);
    await expect(page.locator('#jupyterlab-workshop-panel')).toBeHidden();
    await expect(
      page.locator('.lm-TabBar-tab.lm-mod-current', {
        hasText: 'Workshop Author'
      })
    ).toHaveCount(1);
    await expect(input).toBeVisible();
  });
});

test.describe('Workshop Author asking for permission', () => {
  const LIBRARY = 'test-author-ask';

  useLibrary(LIBRARY);

  test('comes to the front for a request, and lets one go when the agent stops waiting', async ({
    page
  }) => {
    test.setTimeout(120000);

    await openBrowser(page);
    await page
      .locator('.jp-WorkshopBrowser-card', { hasText: 'My demo' })
      .getByRole('button', { name: 'Edit with AI' })
      .click();

    const author = page.locator('.jp-WorkshopAgent');
    const input = author.locator('.jp-WorkshopAgent-input');
    const current = page.locator('.lm-TabBar-tab.lm-mod-current', {
      hasText: 'Workshop Author'
    });

    await expect(input).toBeEnabled();

    // The request arrives while another tab is in front.
    await input.fill('/slow\n/ask');
    await input.press('Enter');
    await page.locator('.lm-TabBar-tab', { hasText: 'Workshops' }).click();
    await expect(current).toHaveCount(0);

    const request = author.locator('.jp-WorkshopAgent-permission').last();

    await expect(current).toHaveCount(1, { timeout: 30000 });
    await expect(request).toBeInViewport();
    await request.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(request).toContainText('Allowed.');

    // A request the agent stops waiting for no longer offers an answer.
    await expect(author.getByRole('button', { name: 'Send' })).toBeVisible();
    await input.fill('/drop');
    await input.press('Enter');

    const dropped = author.locator('.jp-WorkshopAgent-permission').last();

    await expect(dropped).toContainText('pypi.org over the network');
    await expect(dropped).toContainText('No longer waiting.');
    await expect(
      dropped.getByRole('button', { name: 'Allow', exact: true })
    ).toHaveCount(0);
  });
});

test.describe('Workshop Author asking questions', () => {
  const LIBRARY = 'test-author-question';

  useLibrary(LIBRARY);

  test('answers the agent by choosing, or in your own words', async ({
    page
  }) => {
    await openBrowser(page);
    await page
      .locator('.jp-WorkshopBrowser-card', { hasText: 'My demo' })
      .getByRole('button', { name: 'Edit with AI' })
      .click();

    const author = page.locator('.jp-WorkshopAgent');
    const input = author.locator('.jp-WorkshopAgent-input');

    await expect(input).toBeEnabled();
    await input.fill('/question');
    await input.press('Enter');

    // The questions come as a card of choices, not a permission request.
    const card = author.locator('.jp-WorkshopAgent-question');
    const submit = card.getByRole('button', { name: 'Submit' });

    await expect(card).toContainText('Who is the workshop for?');
    await expect(author.locator('.jp-WorkshopAgent-permission')).toHaveCount(0);
    await expect(submit).toBeDisabled();

    await card.getByRole('radio', { name: /Experienced/ }).check();
    await expect(submit).toBeDisabled();

    await card.getByRole('checkbox', { name: /Routing/ }).check();
    await card
      .getByLabel('Other answer to: Which topics should it cover?')
      .fill('Deployment');
    await submit.click();

    await expect(card).toContainText('Answered.');
    await expect(
      author.locator('.jp-WorkshopAgent-assistant').last()
    ).toHaveText(
      'Who is the workshop for? Experienced; Which topics should it cover? Routing, Deployment'
    );
  });
});

test.describe('Workshop Author creating a workshop', () => {
  const LIBRARY = 'test-author-create';

  useLibrary(LIBRARY);

  test('drafts a workshop with the agent and creates it from the plan', async ({
    page
  }) => {
    await openBrowser(page);
    await page
      .locator('#jupyterlab-workshop-browser')
      .getByRole('button', { name: 'Create Workshop with AI…' })
      .click();

    // A draft: nothing exists yet, and there is no workshop to open.
    const draft = page.locator('.jp-WorkshopAgent');
    const input = draft.locator('.jp-WorkshopAgent-input');

    await expect(draft.locator('.jp-WorkshopAgent-path')).toHaveText(
      'New workshop, not created yet'
    );
    await expect(
      draft.getByRole('button', { name: 'Open workshop' })
    ).toHaveCount(0);
    await expect(input).toBeEnabled();

    // The agent proposes a plan, shown as a card with Create.
    const plan = {
      title: 'Git basics',
      name: 'git-basics',
      audience: 'newcomers',
      summary: 'The first steps with git, for someone who has never used it.',
      outline: ['Make a repository', 'Make the first commit'],
      quizzes: true,
      gating: true
    };

    await input.fill(`/tool propose_workshop ${JSON.stringify(plan)}`);
    await input.press('Enter');

    const card = draft.locator('.jp-WorkshopAgent-proposal');

    await expect(card.locator('h3')).toHaveText('Git basics');
    await expect(card).toContainText('personal/git-basics');
    await expect(card).toContainText('People new to the subject');
    expect(
      await page.contents.fileExists(
        `${LIBRARY}/personal/git-basics/workshop.yaml`
      )
    ).toBe(false);

    // Create makes the workshop, and its own panel carries on with what
    // was said and the plan as the brief.
    await card.getByRole('button', { name: 'Create' }).click();

    const author = page.locator('.jp-WorkshopAgent');

    await expect(author.locator('.jp-WorkshopAgent-path')).toHaveText(
      `${LIBRARY}/personal/git-basics`
    );
    await expect(author).toHaveCount(1);
    await expect(
      author.locator('.jp-WorkshopAgent-proposal .jp-WorkshopAgent-answer')
    ).toHaveText('The plan agreed.');
    await expect(author.locator('.jp-WorkshopAgent-user').last()).toContainText(
      'Write the workshop we agreed'
    );
    expect(
      await page.contents.fileExists(
        `${LIBRARY}/personal/git-basics/workshop.yaml`
      )
    ).toBe(true);
  });

  test('discards a draft, leaving nothing behind', async ({ page }) => {
    await openBrowser(page);
    await page
      .locator('#jupyterlab-workshop-browser')
      .getByRole('button', { name: 'Create Workshop with AI…' })
      .click();

    const draft = page.locator('.jp-WorkshopAgent');

    await expect(draft.locator('.jp-WorkshopAgent-input')).toBeEnabled();
    await draft.getByRole('button', { name: 'Discard draft' }).click();
    await page
      .locator('.jp-Dialog')
      .getByRole('button', { name: 'Discard' })
      .click();

    await expect(draft).toHaveCount(0);
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
