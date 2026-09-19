import { expect, test } from '@jupyterlab/galata';

const WORKSHOP = 'settle-check';

interface IExposedApp {
  jupyterapp: {
    commands: { execute(id: string, args: object): Promise<unknown> };
  };
}

/** What the self-test command returns, as far as the test looks at it. */
interface IReport {
  results: { id: string; status: string; seconds: number }[];
  passed: number;
  failed: number;
  skipped: number;
}

/** What the progress command returns, as far as the test looks at it. */
interface IStatus {
  running: boolean;
  report: IReport | null;
}

const MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: ${WORKSHOP}
title: Checks that need a moment
version: 0.1.0
description: A command writes files a few seconds after it returns.
capabilities:
  - terminal
  - write-files
pages:
  - pages/01-wait.md
`;

/**
 * The command backgrounds its writes, so the prompt is back before the
 * files exist: a check run once fails, one given time to settle passes.
 * The first verify is fired by its trigger when the command completes,
 * so the self-test waits on that run; nothing prints the second one's
 * trigger text, so the self-test runs it itself.
 */
const PAGE = `# Wait for it

\`\`\`{execute}
:id: write-later
:session: shell
:title: Write two files, one after the other
(sleep 3; echo ready > ready.txt; sleep 3; echo later > later.txt) &
\`\`\`

\`\`\`{verify}
:id: first-file
:label: The first file has arrived
:substrate: contents
:trigger: after:write-later
exists ready.txt
\`\`\`

\`\`\`{verify}
:id: second-file
:label: The second file has arrived
:substrate: contents
:trigger: terminal-output "never printed"
exists later.txt
\`\`\`
`;

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

  await expect(
    page.locator('#jupyterlab-workshop-panel .jp-WorkshopPanel-title')
  ).toBeAttached();
}

const AUTO_WORKSHOP = 'auto-chain';

const AUTO_MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: ${AUTO_WORKSHOP}
title: Runs on its own
version: 0.1.0
description: A page whose actions fire on entering it and cascade.
capabilities:
  - write-files
  - auto-run
pages:
  - pages/01-auto.md
`;

/**
 * The toast fires on entering the page and cascades into the write,
 * which the highlight follows; the self-test must record those runs
 * rather than make each happen a second time.
 */
const AUTO_PAGE = `# On its own

\`\`\`{toast}
:id: auto-start
:auto: page-enter
:cascade: true
This appeared on its own.
\`\`\`

\`\`\`{file-write}
:id: auto-write
:path: automation.txt
Written by a cascade.
\`\`\`

\`\`\`{toast}
:id: auto-highlight
:auto: after:auto-write
The cascade wrote a file.
\`\`\`

\`\`\`{toast}
:id: by-hand
Only a click runs this one.
\`\`\`
`;

test.describe('self-test', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    await page.contents.uploadContent(
      MANIFEST,
      'text',
      `${tmpPath}/${WORKSHOP}/workshop.yaml`
    );
    await page.contents.uploadContent(
      PAGE,
      'text',
      `${tmpPath}/${WORKSHOP}/pages/01-wait.md`
    );
    await openWorkshop(page, `${tmpPath}/${WORKSHOP}`);
  });

  test('gives a triggered verify time to settle', async ({ page }) => {
    test.setTimeout(120000);

    const report = (await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:run-all', {});
    })) as IReport;

    const byId = new Map(report.results.map(item => [item.id, item]));

    expect(report.failed).toBe(0);
    expect(report.passed).toBe(3);
    expect(byId.get('first-file')?.status).toBe('ok');
    expect(byId.get('second-file')?.status).toBe('ok');

    // Both checks failed at first and passed on a later attempt, so each
    // took longer than a single run of a contents predicate.
    expect(byId.get('first-file')?.seconds).toBeGreaterThan(1);
    expect(byId.get('second-file')?.seconds).toBeGreaterThan(1);
  });

  test('a paced run in the background highlights each action and reports through progress', async ({
    page
  }) => {
    test.setTimeout(120000);

    const progress = (): Promise<IStatus> =>
      page.evaluate(() => {
        const exposed = window as unknown as IExposedApp;

        return exposed.jupyterapp.commands.execute(
          'workshop:self-test-progress',
          {}
        );
      }) as Promise<IStatus>;

    const started = await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:run-all', {
        background: true,
        startDelay: 1,
        stepDelay: 2
      });
    });

    expect(started).toEqual({ started: true });
    expect((await progress()).running).toBe(true);

    // The first action is scrolled to and pulsed during its pause,
    // before it runs.
    await expect(
      page.locator('[data-action-id="write-later"].jp-mod-pulse')
    ).toBeVisible({ timeout: 10000 });

    await expect
      .poll(async () => (await progress()).running, { timeout: 90000 })
      .toBe(false);

    const report = (await progress()).report;

    expect(report?.failed).toBe(0);
    expect(report?.passed).toBe(3);
  });
});

test.describe('self-test of automatic actions', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    const target = `${tmpPath}/${AUTO_WORKSHOP}`;

    await page.contents.uploadContent(
      AUTO_MANIFEST,
      'text',
      `${target}/workshop.yaml`
    );
    await page.contents.uploadContent(
      AUTO_PAGE,
      'text',
      `${target}/pages/01-auto.md`
    );
    await openWorkshop(page, target);
  });

  test('records what the page ran on its own instead of running it again', async ({
    page
  }) => {
    test.setTimeout(120000);

    const report = (await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:run-all', {
        stepDelay: 1
      });
    })) as IReport & { results: { id: string; message: string }[] };

    expect(report.failed, JSON.stringify(report.results)).toBe(0);
    expect(report.passed).toBe(4);

    const byId = new Map(report.results.map(item => [item.id, item]));

    expect(byId.get('auto-start')?.message).toBe('Ran on its own');
    expect(byId.get('auto-write')?.message).toBe('Ran on its own');
    expect(byId.get('auto-highlight')?.message).toBe('Ran on its own');
    expect(byId.get('by-hand')?.message).toBe('');
  });
});
