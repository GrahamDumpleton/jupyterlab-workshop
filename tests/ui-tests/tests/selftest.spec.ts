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

const POINT_WORKSHOP = 'point-at-panel';

const POINT_MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: ${POINT_WORKSHOP}
title: Pointing at the panel
version: 0.1.0
description: Actions that point at parts of the instructions panel.
pages:
  - pages/01-first.md
  - pages/02-second.md
`;

const ELSEWHERE_WORKSHOP = 'somewhere-else';

/** A workshop to be in, so that the run has to open the one it tests. */
const ELSEWHERE_MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: ${ELSEWHERE_WORKSHOP}
title: Somewhere else
version: 0.1.0
description: A page of prose and nothing to run.
pages:
  - pages/01-only.md
`;

const ELSEWHERE_PAGE = `# Somewhere else

Nothing to do here.
`;

/**
 * The first tour names what is on screen and the second a selector
 * that matches nothing, which nobody is there to step through to.
 */
const POINT_FIRST_PAGE = `# The panel

\`\`\`{highlight}
:id: footer
:selector: .jp-WorkshopPanel-footer
:duration: 200ms
\`\`\`

\`\`\`{tour}
:id: good-tour
- selector: .jp-WorkshopPanel-header
  text: The header.
- selector: .jp-WorkshopPanel-footer
  text: The footer.
\`\`\`

\`\`\`{tour}
:id: bad-tour
- selector: .jp-WorkshopPanel-header
  text: The header.
- selector: .jp-NothingLikeThis
  text: Not there.
\`\`\`
`;

/**
 * The first action of the page points at its own box, which is in the
 * panel only once the panel has drawn this page.
 */
const POINT_SECOND_PAGE = `# The next page

\`\`\`{highlight}
:id: own-box
:selector: [data-action-id=own-box]
:duration: 200ms
\`\`\`
`;

test.describe('self-test of actions that point at the panel', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    const target = `${tmpPath}/${POINT_WORKSHOP}`;

    await page.contents.uploadContent(
      POINT_MANIFEST,
      'text',
      `${target}/workshop.yaml`
    );
    await page.contents.uploadContent(
      POINT_FIRST_PAGE,
      'text',
      `${target}/pages/01-first.md`
    );
    await page.contents.uploadContent(
      POINT_SECOND_PAGE,
      'text',
      `${target}/pages/02-second.md`
    );
    await page.contents.uploadContent(
      ELSEWHERE_MANIFEST,
      'text',
      `${tmpPath}/${ELSEWHERE_WORKSHOP}/workshop.yaml`
    );
    await page.contents.uploadContent(
      ELSEWHERE_PAGE,
      'text',
      `${tmpPath}/${ELSEWHERE_WORKSHOP}/pages/01-only.md`
    );

    // Trust the workshop under test, then leave it for another, so the
    // run opens it and goes straight on to its first action.
    await openWorkshop(page, target);
    await openWorkshop(page, `${tmpPath}/${ELSEWHERE_WORKSHOP}`);
    await expect(
      page.locator('#jupyterlab-workshop-panel .jp-WorkshopPanel-title')
    ).toHaveText('Somewhere else');
  });

  test('waits for the panel to draw each page, and checks the selectors of a tour', async ({
    page,
    tmpPath
  }) => {
    test.setTimeout(120000);

    const report = (await page.evaluate((path: string) => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:run-all', { path });
    }, `${tmpPath}/${POINT_WORKSHOP}`)) as IReport & {
      results: { id: string; message: string }[];
    };

    const byId = new Map(report.results.map(item => [item.id, item]));

    // The panel has drawn the page by the time its first action runs.
    expect(byId.get('footer')?.status).toBe('ok');
    expect(byId.get('own-box')?.status).toBe('ok');

    // A tour is not stepped through, but what it points at is looked for.
    expect(byId.get('good-tour')?.status).toBe('skipped');
    expect(byId.get('bad-tour')?.status).toBe('error');
    expect(byId.get('bad-tour')?.message).toBe(
      'Nothing on screen matches ".jp-NothingLikeThis" (step 2)'
    );

    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(1);
  });
});

const ATTEMPT_WORKSHOP = 'wrong-answers';

const ATTEMPT_MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: ${ATTEMPT_WORKSHOP}
title: Wrong answers
version: 0.1.0
description: A check with attempts that say what it should say.
capabilities:
  - write-files
pages:
  - pages/01-greeting.md
`;

/**
 * The first attempt holds no actions and tests what the check says
 * before anything is done, the second does the same of a check that
 * gives a message of its own, the third writes the wrong text, and the
 * fourth expects the check to say something it does not.
 */
const ATTEMPT_PAGE = `# A greeting

\`\`\`\`{attempt}
:id: nothing-yet
:check: greeting
:expect: does not exist yet
\`\`\`\`

\`\`\`\`{attempt}
:id: own-words
:check: written
:expect: Click the action above
\`\`\`\`

\`\`\`\`{attempt}
:id: wrong-text
:check: greeting
:expect: does not contain "Hello"

\`\`\`{file-write}
:id: write-wrong
:path: greeting.txt
Goodbye
\`\`\`
\`\`\`\`

\`\`\`\`{attempt}
:id: wrong-expectation
:check: greeting
:expect: is spelled wrongly
\`\`\`\`

\`\`\`{file-write}
:id: write-right
:path: greeting.txt
Hello
\`\`\`

\`\`\`\`{attempt}
:id: right-answer
:check: greeting
:result: pass
\`\`\`\`

\`\`\`{verify}
:id: greeting
:label: The file says Hello
:substrate: contents
contains greeting.txt Hello
\`\`\`

\`\`\`{verify}
:id: written
:label: The file has been written
:substrate: contents
:message: The file is not there yet. Click the action above to write it.
exists greeting.txt
\`\`\`
`;

test.describe('self-test of what a check says on a wrong answer', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    const target = `${tmpPath}/${ATTEMPT_WORKSHOP}`;

    await page.contents.uploadContent(
      ATTEMPT_MANIFEST,
      'text',
      `${target}/workshop.yaml`
    );
    await page.contents.uploadContent(
      ATTEMPT_PAGE,
      'text',
      `${target}/pages/01-greeting.md`
    );
    await openWorkshop(page, target);
  });

  test('runs each attempt against its check, and keeps attempts from the learner', async ({
    page
  }) => {
    test.setTimeout(120000);

    const panel = page.locator('#jupyterlab-workshop-panel');

    // The learner is shown the page's own action and check, and nothing
    // of the attempts or of what they hold.
    await expect(panel.locator('[data-action-id="write-right"]')).toBeVisible();
    await expect(panel.locator('[data-action-id="write-wrong"]')).toHaveCount(
      0
    );
    await expect(panel.locator('.jp-WorkshopPanel-attempt')).toHaveCount(0);

    const report = (await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:run-all', {});
    })) as IReport & { results: { id: string; message: string }[] };

    const byId = new Map(report.results.map(item => [item.id, item]));

    // An attempt passes when the check fails saying what was expected,
    // and its message is what the check said.
    expect(byId.get('nothing-yet')?.status).toBe('ok');
    expect(byId.get('nothing-yet')?.message).toBe(
      'The check said: greeting.txt does not exist yet'
    );

    // A check with a message of its own says that, and not the reason
    // made from its predicate.
    expect(byId.get('own-words')?.status).toBe('ok');
    expect(byId.get('own-words')?.message).toBe(
      'The check said: The file is not there yet. Click the action above to write it.'
    );

    expect(byId.get('wrong-text')?.status).toBe('ok');
    expect(byId.get('wrong-text')?.message).toBe(
      'The check said: greeting.txt does not contain "Hello"'
    );

    // One that expects other words fails, and quotes the check.
    expect(byId.get('wrong-expectation')?.status).toBe('error');
    expect(byId.get('wrong-expectation')?.message).toContain(
      'said "greeting.txt does not contain "Hello"", which does not contain "is spelled wrongly"'
    );

    // An attempt can expect a pass, and the page then goes on as usual.
    expect(byId.get('right-answer')?.status).toBe('ok');
    expect(byId.get('greeting')?.status).toBe('ok');
    expect(byId.get('written')?.status).toBe('ok');

    // What an attempt holds is not reported as a step of its own.
    expect(byId.has('write-wrong')).toBe(false);
    expect(report.passed).toBe(7);
    expect(report.failed).toBe(1);

    // An author is shown the attempts, each with its actions to click.
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      void exposed.jupyterapp.commands.execute('workshop:author-mode', {});
    });

    await expect(panel.locator('.jp-WorkshopPanel-attempt')).toHaveCount(5);
    await expect(
      panel.locator('.jp-WorkshopPanel-attempt', { hasText: 'wrong' }).first()
    ).toContainText('"greeting" should fail');
  });
});

const NOTEBOOK_WORKSHOP = 'notebook-checks';

const NOTEBOOK_MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: ${NOTEBOOK_WORKSHOP}
title: Checks in a notebook's kernel
version: 0.1.0
description: Checks that run beside the learner's cells in one kernel.
capabilities:
  - write-files
  - kernel-exec
  - auto-run
layout: notebook
layouts:
  notebook:
    main: { tabs: ['notebook:never-made.ipynb'] }
pages:
  - pages/01-build.md
  - pages/02-back.md
`;

/**
 * The notebook is made on entering the page and kept from then on. The
 * check is fired by the first cell, when the name it reads does not
 * exist yet, so it raises in the learner's kernel just as the second
 * cell is queued: that cell must still run, and the check pass once it
 * has. The last check prints before a closing False, which decides.
 */
const NOTEBOOK_PAGE = `# Build it up

\`\`\`{notebook-create}
:id: create
:path: work.ipynb
:auto: page-enter
:existing: keep
- code: first = 1
  tags: [one]
\`\`\`

\`\`\`{cell-run}
:id: run-one
:path: work.ipynb
:cell: one
\`\`\`

\`\`\`{cell-insert}
:id: insert-two
:path: work.ipynb
:tags: [two]
:run: true
second = 2
\`\`\`

\`\`\`{cell-insert}
:id: insert-blank
:path: work.ipynb
# Write your answer below

\`\`\`

\`\`\`{verify}
:id: both
:substrate: learner-kernel
:path: work.ipynb
:trigger: cell-executed one; cell-executed two
first == 1 and second == 2
\`\`\`

\`\`\`{verify}
:id: printed
:substrate: learner-kernel
:path: work.ipynb
print("Not decorated yet")
False
\`\`\`
`;

/** Going back to the first page must not put the starting notebook back. */
const NOTEBOOK_BACK_PAGE = `# Still there

\`\`\`{verify}
:id: still-defined
:substrate: learner-kernel
:path: work.ipynb
second == 2
\`\`\`
`;

test.describe("self-test of checks in a notebook's kernel", () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    const target = `${tmpPath}/${NOTEBOOK_WORKSHOP}`;

    await page.contents.uploadContent(
      NOTEBOOK_MANIFEST,
      'text',
      `${target}/workshop.yaml`
    );
    await page.contents.uploadContent(
      NOTEBOOK_PAGE,
      'text',
      `${target}/pages/01-build.md`
    );
    await page.contents.uploadContent(
      NOTEBOOK_BACK_PAGE,
      'text',
      `${target}/pages/02-back.md`
    );
    await openWorkshop(page, target);
  });

  test("a check that raises leaves the learner's cells alone, and the last expression decides", async ({
    page,
    tmpPath
  }) => {
    test.setTimeout(180000);

    const report = (await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:run-all', {});
    })) as IReport & {
      results: { id: string; page: string; message: string }[];
    };

    const byId = new Map(report.results.map(item => [item.id, item]));
    const detail = JSON.stringify(report.results);

    // The cell queued behind the failing check ran, so the check passed
    // on a later attempt rather than never.
    expect(byId.get('insert-two')?.status, detail).toBe('ok');
    expect(byId.get('both')?.status, detail).toBe('ok');

    // What was printed is the message, not the verdict.
    expect(byId.get('printed')?.status, detail).toBe('error');
    expect(byId.get('printed')?.message).toBe('Not decorated yet');
    expect(report.failed, detail).toBe(1);

    // The opening layout named a notebook that was never there, which
    // only the report can say.
    expect(byId.get('layout')).toMatchObject({
      page: '(workshop)',
      status: 'skipped'
    });
    expect(byId.get('layout')?.message).toContain('notebook:never-made.ipynb');

    // Back on the first page the notebook is made again on its own, and
    // keeps the cell the learner added instead of starting over.
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:previous-page', {});
    });

    const panel = page.locator('#jupyterlab-workshop-panel');

    await expect(panel.locator('[data-action-id="create"]')).toHaveClass(
      /jp-mod-status-ok/,
      { timeout: 30000 }
    );

    const saved = await page.request.get(
      `api/contents/${tmpPath}/${NOTEBOOK_WORKSHOP}/work/work.ipynb?content=1`
    );
    const cells = (await saved.json()).content.cells as { source: string }[];

    // The blank line that ends the body of the last insert is kept, so
    // the cell has an empty line under its comment.
    expect(cells.map(cell => cell.source)).toEqual([
      'first = 1',
      'second = 2',
      '# Write your answer below\n'
    ]);
  });
});

const RESULTS_WORKSHOP = 'notebook-results';

const RESULTS_MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: ${RESULTS_WORKSHOP}
title: Checks and the notebook's results
version: 0.1.0
description: Checks that read what the learner's cells gave.
capabilities:
  - write-files
  - kernel-exec
  - auto-run
pages:
  - pages/01-results.md
`;

/**
 * The learner's cell gives 44, which the kernel keeps in Out and in the
 * name _. Each check ends in an expression, whose value must not take
 * the place of the 44: the same check asked twice passes twice, and _
 * is still 44 after both, and after code run with its result shown. The
 * last check cannot be compiled, and names its own first line.
 */
const RESULTS_PAGE = `# What the cell gave

\`\`\`{notebook-create}
:id: create
:path: sums.ipynb
:auto: page-enter
- code: 40 + 4
  tags: [sum]
\`\`\`

\`\`\`{cell-run}
:id: run-sum
:path: sums.ipynb
:cell: sum
\`\`\`

\`\`\`{verify}
:id: seen-once
:substrate: learner-kernel
:path: sums.ipynb
44 in Out.values()
\`\`\`

\`\`\`{verify}
:id: seen-again
:substrate: learner-kernel
:path: sums.ipynb
44 in Out.values()
\`\`\`

\`\`\`{kernel-execute}
:id: shown
:path: sums.ipynb
:silent: false
"a result of the workshop's own"
\`\`\`

\`\`\`{verify}
:id: underscore
:substrate: learner-kernel
:path: sums.ipynb
_ == 44 and len(Out) == 1
\`\`\`

\`\`\`{verify}
:id: broken
:substrate: learner-kernel
:path: sums.ipynb
44 in in Out
\`\`\`
`;

test.describe("self-test of checks that read the notebook's results", () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    const target = `${tmpPath}/${RESULTS_WORKSHOP}`;

    await page.contents.uploadContent(
      RESULTS_MANIFEST,
      'text',
      `${target}/workshop.yaml`
    );
    await page.contents.uploadContent(
      RESULTS_PAGE,
      'text',
      `${target}/pages/01-results.md`
    );
    await openWorkshop(page, target);
  });

  test("a check that ends in an expression leaves the learner's Out and _ as they were", async ({
    page
  }) => {
    test.setTimeout(180000);

    const report = (await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:run-all', {});
    })) as IReport & {
      results: { id: string; message: string }[];
    };

    const byId = new Map(report.results.map(item => [item.id, item]));
    const detail = JSON.stringify(report.results);

    // The first check did not put its own True where the 44 was.
    expect(byId.get('seen-once')?.status, detail).toBe('ok');
    expect(byId.get('seen-again')?.status, detail).toBe('ok');

    // Nor did code run with its result shown, and nothing was added.
    expect(byId.get('shown')?.status, detail).toBe('ok');
    expect(byId.get('underscore')?.status, detail).toBe('ok');

    // The line named is a line of the check as the author wrote it.
    expect(byId.get('broken')?.status, detail).toBe('error');
    expect(byId.get('broken')?.message, detail).toMatch(/line 1\)$/);
    expect(report.failed, detail).toBe(1);
  });
});

const LAST_CELL_WORKSHOP = 'notebook-last-cell';

const LAST_CELL_MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: ${LAST_CELL_WORKSHOP}
title: Checks and the learner's last cell
version: 0.1.0
description: Checks asked after cells that end oddly.
capabilities:
  - write-files
  - kernel-exec
  - auto-run
pages:
  - pages/01-last-cell.md
`;

/**
 * Each check ends in an expression and follows a cell of the learner's
 * that IPython would read when deciding whether to show a value: one
 * with an open bracket, one with an open quote, and one ending in a
 * semicolon. The check's value must come back all the same, a True as
 * a pass and a False as a failure with what was printed. The last cell
 * ends in a semicolon again, and its own value must still be hidden.
 */
const LAST_CELL_PAGE = `# After a cell that ends oddly

\`\`\`{notebook-create}
:id: create
:path: odd.ipynb
:auto: page-enter
- code: "total = (3 + 4"
  tags: [bracket]
- code: 'name = "Amara'
  tags: [quote]
- code: "7;"
  tags: [semicolon]
- code: "8;"
  tags: [again]
\`\`\`

\`\`\`{cell-run}
:id: run-bracket
:path: odd.ipynb
:cell: bracket
\`\`\`

\`\`\`{verify}
:id: after-bracket
:substrate: learner-kernel
:path: odd.ipynb
print("The check ran")
True
\`\`\`

\`\`\`{cell-run}
:id: run-quote
:path: odd.ipynb
:cell: quote
\`\`\`

\`\`\`{verify}
:id: after-quote
:substrate: learner-kernel
:path: odd.ipynb
True
\`\`\`

\`\`\`{cell-run}
:id: run-semicolon
:path: odd.ipynb
:cell: semicolon
\`\`\`

\`\`\`{verify}
:id: after-semicolon
:substrate: learner-kernel
:path: odd.ipynb
True
\`\`\`

\`\`\`{verify}
:id: said-why
:substrate: learner-kernel
:path: odd.ipynb
print("Not there yet")
False
\`\`\`

\`\`\`{cell-run}
:id: run-again
:path: odd.ipynb
:cell: again
\`\`\`

\`\`\`{verify}
:id: still-hidden
:substrate: learner-kernel
:path: odd.ipynb
len(Out) == 0
\`\`\`
`;

test.describe('self-test of checks after a cell that ends oddly', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    const target = `${tmpPath}/${LAST_CELL_WORKSHOP}`;

    await page.contents.uploadContent(
      LAST_CELL_MANIFEST,
      'text',
      `${target}/workshop.yaml`
    );
    await page.contents.uploadContent(
      LAST_CELL_PAGE,
      'text',
      `${target}/pages/01-last-cell.md`
    );
    await openWorkshop(page, target);
  });

  test("a check's closing expression decides whatever the learner's last cell was", async ({
    page
  }) => {
    test.setTimeout(180000);

    const report = (await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:run-all', {});
    })) as IReport & {
      results: { id: string; message: string }[];
    };

    const byId = new Map(report.results.map(item => [item.id, item]));
    const detail = JSON.stringify(report.results);

    // The cells with an open bracket and an open quote fail as cells,
    // and the checks after them give their own verdict, not a TokenError.
    expect(byId.get('run-bracket')?.status, detail).toBe('error');
    expect(byId.get('after-bracket')?.status, detail).toBe('ok');
    expect(byId.get('after-bracket')?.message, detail).toBe('The check ran');
    expect(byId.get('run-quote')?.status, detail).toBe('error');
    expect(byId.get('after-quote')?.status, detail).toBe('ok');

    // After a cell ending in a semicolon a True still passes, and a
    // False still fails rather than passing on what it printed.
    expect(byId.get('run-semicolon')?.status, detail).toBe('ok');
    expect(byId.get('after-semicolon')?.status, detail).toBe('ok');
    expect(byId.get('said-why')?.status, detail).toBe('error');
    expect(byId.get('said-why')?.message, detail).toBe('Not there yet');

    // The learner's own semicolon goes on hiding the value of a cell.
    expect(byId.get('run-again')?.status, detail).toBe('ok');
    expect(byId.get('still-hidden')?.status, detail).toBe('ok');
    expect(report.failed, detail).toBe(3);
  });
});

const OPEN_WORKSHOP = 'open-in-any-viewer';

const OPEN_MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: ${OPEN_WORKSHOP}
title: Files open in one viewer or another
version: 0.1.0
description: Checks that a file is open, whatever it is open in.
capabilities:
  - write-files
layouts:
  data:
    main:
      areas:
        - { tabs: ['file:spending.csv'] }
        - { size: 0.4, tabs: ['markdown:notes.md'] }
pages:
  - pages/01-open.md
`;

/**
 * The editor is not the viewer JupyterLab opens a CSV, a JSON or a
 * notebook file in by default, and the preview is not the one it opens a
 * Markdown file in, so each of these is open in a viewer other than the
 * default for its type. The file-open predicate must find them all the
 * same, and notebook-open must not take a notebook open as text for an
 * open notebook.
 */
const OPEN_PAGE = `# Open in any viewer

\`\`\`{file-write}
:id: write-csv
:path: spending.csv
item,amount
bread,3
\`\`\`

\`\`\`{file-write}
:id: write-notes
:path: notes.md
# Notes
\`\`\`

\`\`\`{verify}
:id: not-yet
:substrate: ui
file-open spending.csv
\`\`\`

\`\`\`{layout}
:id: show
:name: data
\`\`\`

\`\`\`{verify}
:id: csv-in-editor
:substrate: ui
file-open spending.csv
\`\`\`

\`\`\`{verify}
:id: markdown-in-preview
:substrate: ui
file-open notes.md
\`\`\`

\`\`\`{file-write}
:id: write-json
:path: data.json
{"bread": 3}
\`\`\`

\`\`\`{file-open}
:id: open-json
:path: data.json
\`\`\`

\`\`\`{verify}
:id: json-in-editor
:substrate: ui
file-open data.json
\`\`\`

\`\`\`{file-write}
:id: write-notebook
:path: plain.ipynb
{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}
\`\`\`

\`\`\`{file-open}
:id: open-notebook-as-text
:path: plain.ipynb
\`\`\`

\`\`\`{verify}
:id: notebook-as-file
:substrate: ui
file-open plain.ipynb
\`\`\`

\`\`\`{verify}
:id: notebook-as-notebook
:substrate: ui
notebook-open plain.ipynb
\`\`\`
`;

test.describe('self-test of checks that a file is open', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    const target = `${tmpPath}/${OPEN_WORKSHOP}`;

    await page.contents.uploadContent(
      OPEN_MANIFEST,
      'text',
      `${target}/workshop.yaml`
    );
    await page.contents.uploadContent(
      OPEN_PAGE,
      'text',
      `${target}/pages/01-open.md`
    );
    await openWorkshop(page, target);
  });

  test('a file counts as open in whichever viewer it is open in', async ({
    page
  }) => {
    test.setTimeout(120000);

    const report = (await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:run-all', {});
    })) as IReport & {
      results: { id: string; message: string }[];
    };

    const byId = new Map(report.results.map(item => [item.id, item]));
    const detail = JSON.stringify(report.results);

    // A file that exists but that nothing has opened is not open.
    expect(byId.get('not-yet')?.status, detail).toBe('error');
    expect(byId.get('not-yet')?.message, detail).toBe(
      'spending.csv is not open'
    );

    // The layout put the CSV file in the editor, not the table viewer,
    // and the Markdown file in the preview, not the editor.
    expect(byId.get('show')?.status, detail).toBe('ok');
    expect(byId.get('csv-in-editor')?.status, detail).toBe('ok');
    expect(byId.get('markdown-in-preview')?.status, detail).toBe('ok');

    // An action opens a file in the editor too.
    expect(byId.get('json-in-editor')?.status, detail).toBe('ok');

    // A notebook open as text is an open file, and not an open notebook.
    expect(byId.get('notebook-as-file')?.status, detail).toBe('ok');
    expect(byId.get('notebook-as-notebook')?.status, detail).toBe('error');
    expect(report.failed, detail).toBe(2);
  });
});

const CHANGED_WORKSHOP = 'changed-on-disk';

const CHANGED_MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: ${CHANGED_WORKSHOP}
title: Files the kernel changed
version: 0.1.0
description: Actions that write a file a kernel has written since it was opened.
capabilities:
  - write-files
  - kernel-exec
  - auto-run
pages:
  - pages/01-changed.md
`;

/**
 * The report is open in the editor each time code in the learner's
 * kernel writes it, so the editor holds a copy older than the one on
 * disk. JupyterLab asks which to keep when such an editor is saved, a
 * dialog that stops the self-test, so each action that writes the file
 * must first bring the editor up to date. The last two steps run code
 * in the hidden kernel, which must write its file into the workspace.
 */
const CHANGED_PAGE = `# Changed on disk

\`\`\`{notebook-create}
:id: create
:path: writer.ipynb
:auto: page-enter
- code: "1 + 1"
\`\`\`

\`\`\`{file-write}
:id: first
:path: report.txt
:open: true
written by the action
\`\`\`

\`\`\`{kernel-execute}
:id: kernel-first
:path: writer.ipynb
with open("report.txt", "w") as file:
    file.write("changed by the kernel\\n")
\`\`\`

\`\`\`{file-write}
:id: overwrite
:path: report.txt
changed by the action
\`\`\`

\`\`\`{verify}
:id: overwritten
:substrate: contents
contains report.txt changed by the action
\`\`\`

\`\`\`{kernel-execute}
:id: kernel-second
:path: writer.ipynb
with open("report.txt", "w") as file:
    file.write("kernel once more\\n")
\`\`\`

\`\`\`{file-write}
:id: append
:path: report.txt
:mode: append
appended by the action
\`\`\`

\`\`\`{verify}
:id: appended
:substrate: contents
contains report.txt kernel once more
contains report.txt appended by the action
\`\`\`

\`\`\`{kernel-execute}
:id: kernel-third
:path: writer.ipynb
with open("report.txt", "w") as file:
    file.write("kernel a third time\\n")
\`\`\`

\`\`\`{editor-insert}
:id: insert
:path: report.txt
:line: end
inserted by the action
\`\`\`

\`\`\`{verify}
:id: inserted
:substrate: contents
contains report.txt kernel a third time
contains report.txt inserted by the action
\`\`\`

\`\`\`{kernel-execute}
:id: hidden-write
with open("hidden.txt", "w") as file:
    file.write("from the hidden kernel\\n")
\`\`\`

\`\`\`{verify}
:id: hidden-written
:substrate: contents
contains hidden.txt from the hidden kernel
\`\`\`
`;

test.describe('self-test of actions on a file a kernel changed', () => {
  test.beforeEach(async ({ page, tmpPath }) => {
    const target = `${tmpPath}/${CHANGED_WORKSHOP}`;

    await page.contents.uploadContent(
      CHANGED_MANIFEST,
      'text',
      `${target}/workshop.yaml`
    );
    await page.contents.uploadContent(
      CHANGED_PAGE,
      'text',
      `${target}/pages/01-changed.md`
    );
    await openWorkshop(page, target);
  });

  test('an action writes an open file the kernel changed without asking which to keep', async ({
    page
  }) => {
    test.setTimeout(180000);

    const report = (await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;

      return exposed.jupyterapp.commands.execute('workshop:run-all', {});
    })) as IReport & {
      results: { id: string; message: string }[];
    };

    const byId = new Map(report.results.map(item => [item.id, item]));
    const detail = JSON.stringify(report.results);

    // An overwrite replaces what the kernel wrote, with no dialog.
    expect(byId.get('overwrite')?.status, detail).toBe('ok');
    expect(byId.get('overwritten')?.status, detail).toBe('ok');

    // An append and an insert keep what the kernel wrote and add to it.
    expect(byId.get('append')?.status, detail).toBe('ok');
    expect(byId.get('appended')?.status, detail).toBe('ok');
    expect(byId.get('insert')?.status, detail).toBe('ok');
    expect(byId.get('inserted')?.status, detail).toBe('ok');

    // Code given no notebook runs in the workspace.
    expect(byId.get('hidden-write')?.status, detail).toBe('ok');
    expect(byId.get('hidden-written')?.status, detail).toBe('ok');
    expect(report.failed, detail).toBe(0);
    await expect(page.locator('.jp-Dialog')).toHaveCount(0);
  });
});
