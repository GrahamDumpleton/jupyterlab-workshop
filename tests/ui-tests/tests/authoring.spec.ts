import { expect, test } from '@jupyterlab/galata';
import * as path from 'path';

const WORKSHOP = 'git-basics';

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
        ): Promise<{ content: unknown }>;
      };
    };
  };
}

test.describe('author mode', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    await page.contents.uploadDirectory(EXAMPLE_DIR, `${tmpPath}/${WORKSHOP}`);

    for (const name of ['_workshop', 'scratch', 'demo']) {
      const directory = `${tmpPath}/${WORKSHOP}/${name}`;

      if (await page.contents.directoryExists(directory)) {
        await page.contents.deleteDirectory(directory);
      }
    }
  });

  test('edits pages and actions through the files and shows lint', async ({
    page,
    tmpPath
  }) => {
    const workshopPath = `${tmpPath}/${WORKSHOP}`;
    const readFile = (target: string): Promise<string> =>
      page.evaluate(async (file: string) => {
        const exposed = window as unknown as IExposedApp;
        const model = await exposed.jupyterapp.serviceManager.contents.get(
          file,
          { content: true }
        );

        return String(model.content);
      }, target);
    const execute = (id: string, args: object): Promise<unknown> =>
      page.evaluate(
        ([command, commandArgs]) => {
          const exposed = window as unknown as IExposedApp;

          return exposed.jupyterapp.commands.execute(
            command as string,
            commandArgs as object
          );
        },
        [id, args] as [string, object]
      );

    // Open the workshop, then switch to author mode: the toolbar appears
    // and the workshop is trusted from now on.
    await page.evaluate((target: string) => {
      const exposed = window as unknown as IExposedApp;

      void exposed.jupyterapp.commands.execute('workshop:open', {
        path: target
      });
    }, workshopPath);

    const dialog = page.locator('.jp-Dialog');

    await expect(dialog.locator('.jp-WorkshopTrust')).toBeVisible();
    await dialog
      .getByRole('button', { name: 'Restricted', exact: true })
      .click();
    await expect(page.locator(`${PANEL} .jp-WorkshopPanel-title`)).toHaveText(
      'Git from the command line'
    );

    await execute('workshop:author-mode', {});
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);

    await expect(panel.locator('.jp-WorkshopPanel-author')).toBeVisible();
    await expect(panel.locator('.jp-WorkshopPanel-trust')).toHaveText(
      'trusted'
    );
    await expect(
      panel
        .locator('.jp-WorkshopPanel-gutterButton', { hasText: 'edit' })
        .first()
    ).toBeVisible();

    // A new page is written to disk, listed in the manifest and shown.
    await execute('workshop:new-page', { title: 'Extra steps' });

    await expect(panel.locator('.jp-WorkshopPanel-pageTitle')).toHaveText(
      'Extra steps'
    );
    expect(
      await page.contents.fileExists(`${workshopPath}/pages/06-extra-steps.md`)
    ).toBe(true);

    expect(await readFile(`${workshopPath}/workshop.yaml`)).toContain(
      '  - pages/06-extra-steps.md'
    );

    // Inserting an action appends it to the page file and the panel picks
    // it up from the file.
    await execute('workshop:insert-action', {
      draft: {
        name: 'execute',
        options: { session: 'git', id: 'extra-status' },
        body: 'git status'
      }
    });

    const inserted = panel.locator('[data-action-id="extra-status"]');

    await expect(inserted).toContainText('git status');

    // Editing rewrites the block in place, by its line.
    const pageSource = await readFile(
      `${workshopPath}/pages/06-extra-steps.md`
    );
    const line =
      pageSource
        .split('\n')
        .findIndex(text => text.startsWith('```{execute}')) + 1;

    await execute('workshop:edit-action', {
      page: 'pages/06-extra-steps.md',
      line,
      draft: {
        name: 'execute',
        options: { session: 'git', id: 'extra-status' },
        body: 'git log --oneline'
      }
    });

    await expect(inserted).toContainText('git log --oneline');
    await expect(inserted).not.toContainText('git status');

    // The lint panel lists findings for the open workshop.
    await execute('workshop:lint', {});

    const lint = page.locator('#jupyterlab-workshop-lint');

    await expect(lint).toBeVisible();
    await expect(lint.locator('.jp-WorkshopLint-summary')).toContainText(
      'Git from the command line'
    );

    // The Record button flips to Stop while recording and a page-break
    // button appears; stopping with nothing recorded flips it back.
    const record = panel.locator('.jp-WorkshopPanel-record');
    const pageBreak = panel.locator('.jp-WorkshopPanel-authorButton', {
      hasText: '+ Page'
    });

    await record.click();
    await expect(record).toHaveText('■ Stop');
    await expect(record).toHaveClass(/jp-mod-recording/);
    await expect(pageBreak).toBeVisible();

    await record.click();
    await expect(record).toHaveText('● Record');
    await expect(record).not.toHaveClass(/jp-mod-recording/);
    await expect(pageBreak).toHaveCount(0);

    // Leaving author mode hides the toolbar; reopening does not prompt.
    await execute('workshop:author-mode', {});
    await expect(panel.locator('.jp-WorkshopPanel-author')).toHaveCount(0);
  });
});

interface IBridgeAnswer {
  status: number;
  client: string | null;
  message: string;
}

test.describe('strict gating in author mode', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    await page.contents.uploadDirectory(EXAMPLE_DIR, `${tmpPath}/${WORKSHOP}`);

    const manifest = await page.evaluate(async (file: string) => {
      const exposed = window as unknown as IExposedApp;
      const model = await exposed.jupyterapp.serviceManager.contents.get(file, {
        content: true
      });

      return String(model.content);
    }, `${tmpPath}/${WORKSHOP}/workshop.yaml`);

    await page.contents.uploadContent(
      manifest.replace('gating: soft', 'gating: strict'),
      'text',
      `${tmpPath}/${WORKSHOP}/workshop.yaml`
    );
  });

  test('shows the gate but lets the author move on', async ({
    page,
    tmpPath
  }) => {
    await page.evaluate((target: string) => {
      const exposed = window as unknown as IExposedApp;

      void exposed.jupyterapp.commands.execute('workshop:open', {
        path: target
      });
    }, workshopPath(tmpPath));

    const dialog = page.locator('.jp-Dialog');

    await expect(dialog.locator('.jp-WorkshopTrust')).toBeVisible();
    await dialog.getByRole('button', { name: 'Trust', exact: true }).click();
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);
    const gate = panel.locator('.jp-WorkshopPanel-gate');
    const next = panel
      .locator('.jp-WorkshopPanel-footer')
      .getByRole('button', { name: 'Next' });

    // A learner is held on the first page until its requirements pass.
    await expect(panel.locator('.jp-WorkshopPanel-pageTitle')).toHaveText(
      'Create a repository'
    );
    await expect(gate).toContainText('Before moving on:');
    await expect(gate).toHaveClass(/jp-mod-blocked/);
    await expect(next).toBeDisabled();

    // In author mode the gate is still shown, marked as not enforced,
    // and Next moves on.
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:author-mode', {});
    });
    await expect(panel.locator('.jp-WorkshopPanel-author')).toBeVisible();
    await expect(gate).toContainText(
      'Before moving on (not enforced in author mode):'
    );
    await expect(gate).toHaveClass(/jp-mod-blocked/);
    await expect(next).toBeEnabled();
    await next.click();
    await expect(panel.locator('.jp-WorkshopPanel-pageTitle')).toHaveText(
      'Your first commit'
    );

    // Leaving author mode brings the gate back on the page the author is
    // on.
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:author-mode', {});
    });
    await expect(panel.locator('.jp-WorkshopPanel-author')).toHaveCount(0);
    await expect(gate).toContainText('Before moving on:');
    await expect(next).toBeDisabled();
  });
});

function workshopPath(tmpPath: string): string {
  return `${tmpPath}/${WORKSHOP}`;
}

test.describe('bridge targets', () => {
  test('a request aimed at a tab runs only there', async ({ page }) => {
    // Status is answered by any tab, so a request with no target, one
    // aimed at this tab and one aimed at another show the filter alone.
    const ask = (
      target: string,
      command = 'workshop:bridge-status'
    ): Promise<IBridgeAnswer> =>
      page.evaluate(
        async ({ target, command }): Promise<IBridgeAnswer> => {
          const app = (
            window as unknown as {
              jupyterapp: {
                serviceManager: {
                  serverSettings: { baseUrl: string; token: string };
                };
              };
            }
          ).jupyterapp;
          const settings = app.serviceManager.serverSettings;
          const xsrf = /_xsrf=([^;]+)/.exec(document.cookie)?.[1];
          const headers: Record<string, string> = {
            'Content-Type': 'application/json'
          };

          if (xsrf) {
            headers['X-XSRFToken'] = xsrf;
          }

          if (settings.token) {
            headers['Authorization'] = `token ${settings.token}`;
          }

          const response = await fetch(
            `${settings.baseUrl}jupyterlab-workshop/bridge`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                command,
                args: {},
                timeout: 3,
                ...(target ? { target } : {})
              })
            }
          );
          const body = (await response.json()) as {
            result?: { client?: string };
            message?: string;
          };

          return {
            status: response.status,
            client: body.result?.client ?? null,
            message: body.message ?? ''
          };
        },
        { target, command }
      );

    const open = await ask('');

    expect(open.status).toBe(200);
    expect(open.client).toBeTruthy();

    const mine = await ask(open.client ?? '');

    expect(mine).toMatchObject({ status: 200, client: open.client });

    // A command that needs author mode, aimed at this tab without it, is
    // refused at once rather than left to time out.
    const refused = await ask(open.client ?? '', 'workshop:bridge-reset');

    expect(refused.status).toBe(400);
    expect(refused.message).toContain('open_workshop');

    const elsewhere = await ask('another-tab');

    expect(elsewhere.status).toBe(504);
  });
});
