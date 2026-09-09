import { expect, test } from '@jupyterlab/galata';
import * as path from 'path';

const WORKSHOP = 'git-basics';

const EXAMPLE_DIR = path.resolve(__dirname, '../../../examples', WORKSHOP);

const PANEL = '#jupyterlab-workshop-panel';

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
    shell: { widgets(area: string): Iterable<IExposedWidget> };
  };
}

/** A main-area widget, as far as the tests look at one. */
interface IExposedWidget {
  id: string;
  content?: {
    session?: { send(message: { type: string; content: string[] }): void };
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
    page.locator('#jupyterlab-workshop-panel .jp-WorkshopPanel-title')
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
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);

    await expect(panel.locator('.jp-WorkshopPanel-trust')).toHaveText(
      'restricted'
    );

    // Commands are typed into the terminal but not run.
    const actions = panel.locator('.jp-WorkshopPanel-action.jp-mod-execute');

    await expect(actions.nth(1)).toContainText('git init -b main demo');
    await expect(actions.nth(1).locator('.jp-WorkshopPanel-badge')).toHaveText(
      'types only'
    );
    await actions.nth(1).click();
    await expect(actions.nth(1)).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-Terminal').first()).toBeVisible();

    // Frontend-only checks still run; code checks are off.
    const verify = panel.locator('.jp-WorkshopPanel-verify');

    await verify.first().getByRole('button', { name: 'Check' }).click();
    await expect(verify.first()).toHaveClass(/jp-mod-verify-fail/);

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

  test('shows what the manifest says about the workshop', async ({
    page,
    tmpPath
  }) => {
    await openWorkshop(page, `${tmpPath}/${WORKSHOP}`);

    const panel = page.locator(PANEL);
    const dialog = page.locator('.jp-Dialog');

    await panel.locator('button[title="About this workshop"]').click();
    await expect(dialog.locator('.jp-WorkshopAbout')).toBeVisible();
    await expect(dialog.locator('.jp-Dialog-header')).toHaveText(
      'Git from the command line'
    );

    const details = dialog.locator('.jp-WorkshopAbout-details');

    await expect(details).toContainText('Graham Dumpleton');
    await expect(details).toContainText('Linux, macOS, Windows');
    await expect(
      details.getByRole('link', { name: /\/issues$/ })
    ).toHaveAttribute(
      'href',
      'https://github.com/GrahamDumpleton/jupyterlab-workshop/issues'
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('retries a triggered check while its command finishes', async ({
    page,
    tmpPath
  }) => {
    // A check triggered by a command fires as soon as the command is
    // typed, so it must keep trying while the command does its work.
    const slow = `${tmpPath}/slow`;

    await page.contents.uploadContent(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: slow',
        'title: Slow',
        'capabilities: [terminal]',
        'pages: [pages/01.md]',
        ''
      ].join('\n'),
      'text',
      `${slow}/workshop.yaml`
    );
    await page.contents.uploadContent(
      [
        '---',
        'title: Slow',
        '---',
        '',
        '```{execute}',
        ':id: make',
        'sleep 3 && touch made.txt',
        '```',
        '',
        '```{verify}',
        ':id: made',
        ':label: The file exists',
        ':substrate: contents',
        ':trigger: after:make',
        'exists made.txt',
        '```',
        ''
      ].join('\n'),
      'text',
      `${slow}/pages/01.md`
    );

    await openWorkshop(page, slow);
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);
    const action = panel.locator('.jp-WorkshopPanel-action.jp-mod-execute');
    const check = panel.locator('.jp-WorkshopPanel-verify');

    await action.click();
    await expect(action).toHaveClass(/jp-mod-status-ok/);

    // The first attempt fails and the check keeps going rather than
    // reporting a failure, then passes once the file appears.
    await expect(check).toContainText('Checking');
    await expect(check).not.toHaveClass(/jp-mod-verify-fail/);
    await expect(check).toHaveClass(/jp-mod-verify-pass/, { timeout: 15000 });

    await page.contents.deleteDirectory(slow);
  });

  test('substitutes a changed variable into a timed check', async ({
    page,
    tmpPath
  }) => {
    // A form on the page changes a variable the check names, so the
    // timer must check the new file, not the one it started with.
    const timed = `${tmpPath}/timed`;

    await page.contents.uploadContent(
      [
        'apiVersion: jupyterlab-workshop/v1alpha1',
        'name: timed',
        'title: Timed',
        'variables:',
        '  - { name: note, type: text, default: first }',
        'pages: [pages/01.md]',
        ''
      ].join('\n'),
      'text',
      `${timed}/workshop.yaml`
    );
    await page.contents.uploadContent(
      [
        '---',
        'title: Timed',
        '---',
        '',
        '```{form}',
        ':id: which',
        '- { name: note, type: text, label: Note, required: true }',
        '```',
        '',
        '```{verify}',
        ':id: present',
        ':label: The note {{ note }}.txt exists',
        ':substrate: contents',
        ':trigger: interval 1s',
        'exists {{ note }}.txt',
        '```',
        ''
      ].join('\n'),
      'text',
      `${timed}/pages/01.md`
    );
    await page.contents.uploadContent('second', 'text', `${timed}/second.txt`);

    await openWorkshop(page, timed);
    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);
    const form = panel.locator('.jp-WorkshopPanel-form');
    const check = panel.locator('.jp-WorkshopPanel-verify');

    // The timer checks for first.txt, which is not there. A failing
    // triggered check is retried for a while before the failure stands,
    // and the timer keeps starting it over, so only that it has not
    // passed is certain.
    await expect(check).toContainText('first.txt');
    await expect(check).not.toHaveClass(/jp-mod-verify-pass/);

    // Renaming the note through the form points the timer at second.txt.
    await form.getByLabel('Note').fill('second');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toHaveClass(/jp-mod-status-ok/);
    await expect(check).toContainText('second.txt');
    await expect(check).toHaveClass(/jp-mod-verify-pass/, { timeout: 15000 });

    await page.contents.deleteDirectory(timed);
  });

  test('walks through the start of git-basics', async ({ page, tmpPath }) => {
    const workshopPath = `${tmpPath}/${WORKSHOP}`;

    // Sidebars have a minimum width, so a quarter of the window only
    // measures as a quarter when the window is wide enough.
    await page.setViewportSize({ width: 1600, height: 900 });

    // Open the uploaded workshop through the command the panel uses.
    await openWorkshop(page, workshopPath);

    // The manifest layout collapses the left sidebar, shows the
    // instructions on the right at a quarter of the width, and replaces the
    // launcher with the README preview above a terminal.
    await expect(
      page.locator('#jp-main-dock-panel .jp-MarkdownViewer')
    ).toBeVisible();
    await expect(page.locator('#jp-main-dock-panel .jp-Launcher')).toHaveCount(
      0
    );
    await expect(page.locator('.jp-Terminal').first()).toBeVisible();
    expect(await page.sidebar.isOpen('left')).toBe(false);
    expect(await page.sidebar.isOpen('right')).toBe(true);

    const rightWidth = (await page.locator('#jp-right-stack').boundingBox())
      ?.width;
    const splitWidth = (
      await page.locator('#jp-main-split-panel').boundingBox()
    )?.width;

    expect(rightWidth).toBeDefined();
    expect(splitWidth).toBeDefined();
    expect((rightWidth ?? 0) / (splitWidth ?? 1)).toBeGreaterThan(0.2);
    expect((rightWidth ?? 0) / (splitWidth ?? 1)).toBeLessThan(0.3);

    await page.sidebar.openTab('jupyterlab-workshop-panel');

    const panel = page.locator(PANEL);

    await expect(panel.locator('.jp-WorkshopPanel-title')).toHaveText(
      'Git from the command line'
    );
    await expect(panel.locator('.jp-WorkshopPanel-pageTitle')).toHaveText(
      'Create a repository'
    );

    // Soft gating lists what the page still needs.
    const gate = panel.locator('.jp-WorkshopPanel-gate');

    await expect(gate).toContainText('Fill in the form "identity"');
    await expect(gate).toContainText('Pass the check "repo-created"');

    // The form stores its values as variables used by later commands.
    const form = panel.locator('.jp-WorkshopPanel-form');

    await form.getByLabel('Name').fill('Test Learner');
    await form.getByLabel('Email').fill('not-an-email');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.locator('.jp-WorkshopPanel-formProblem')).toHaveText(
      'Enter an email address'
    );
    await form.getByLabel('Email').fill('learner@example.com');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toHaveClass(/jp-mod-status-ok/);
    await expect(
      panel.locator('.jp-WorkshopPanel-action.jp-mod-execute').nth(3)
    ).toContainText('git config user.name "Test Learner"');
    await expect(gate).not.toContainText('form "identity"');

    // Run the first two terminal actions: git --version and git init.
    const actions = panel.locator('.jp-WorkshopPanel-action.jp-mod-execute');

    await expect(actions.first()).toContainText('git --version');
    await actions.first().click();
    await expect(actions.first()).toHaveClass(/jp-mod-status-ok/);
    await expect(page.locator('.jp-Terminal').first()).toBeVisible();

    // The tab keeps the workshop's name for the terminal when the shell
    // sets a title, as a prompt does; the shell's text goes into the
    // caption. The title is set by hand here, since not every shell
    // does, and sent to the session as one line rather than typed, so
    // it cannot interleave with a line the extension is sending.
    const tab = page.locator('.lm-DockPanel-tabBar .lm-TabBar-tab', {
      has: page.locator('.lm-TabBar-tabLabel', { hasText: /^git$/ })
    });

    await expect(tab).toHaveCount(1);
    await page.evaluate(() => {
      const exposed = window as unknown as IExposedApp;
      const terminal = Array.from(
        exposed.jupyterapp.shell.widgets('main')
      ).find(widget => widget.id === 'jupyterlab-workshop-terminal-git');

      terminal?.content?.session?.send({
        type: 'stdin',
        content: ["printf '\\033]0;shell says hi\\007'\n"]
      });
    });
    await expect(tab).toHaveAttribute('title', /shell says hi/);
    await expect(tab.locator('.lm-TabBar-tabLabel')).toHaveText('git');

    await expect(actions.nth(1)).toContainText('git init -b main demo');
    await actions.nth(1).click();
    await expect(actions.nth(1)).toHaveClass(/jp-mod-status-ok/);

    await expect
      .poll(() => page.contents.directoryExists(`${workshopPath}/demo`), {
        timeout: 20000
      })
      .toBe(true);

    // Move into the repository and set the identity, so later commits work.
    await actions.nth(2).click();
    await expect(actions.nth(2)).toHaveClass(/jp-mod-status-ok/);
    await actions.nth(3).click();
    await expect(actions.nth(3)).toHaveClass(/jp-mod-status-ok/);

    // The contents check runs after git init and passes; the gate clears.
    const repoCheck = panel.locator('.jp-WorkshopPanel-verify');

    await expect(repoCheck).toHaveClass(/jp-mod-verify-pass/, {
      timeout: 20000
    });
    await expect(gate).toHaveCount(0);

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

    // The editor tabs beside the README preview the layout opened rather
    // than splitting the terminal's pane.
    await expect(
      page
        .locator('#jp-main-dock-panel .lm-DockPanel-tabBar', {
          has: page.locator('.lm-TabBar-tab', { hasText: 'README.md' })
        })
        .first()
        .locator('.lm-TabBar-tab')
    ).toHaveCount(2);
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

    // Commit, and the kernel check picks the commit up from the terminal
    // output. The quiz gives feedback on a wrong answer and then passes.
    const commitActions = panel.locator(
      '.jp-WorkshopPanel-action.jp-mod-execute'
    );

    await commitActions.nth(1).click();
    await expect(commitActions.nth(1)).toHaveClass(/jp-mod-status-ok/);
    await commitActions.nth(3).click();
    await expect(commitActions.nth(3)).toHaveClass(/jp-mod-status-ok/);

    const commitCheck = panel.locator('.jp-WorkshopPanel-verify');

    await expect(commitCheck).toHaveClass(/jp-mod-verify-pass/, {
      timeout: 60000
    });

    // The passing check cascades to the checkpoint on the page.
    await expect
      .poll(
        () =>
          page.contents.fileExists(
            `${workshopPath}/_workshop/snapshots/after-first-commit.tar`
          ),
        { timeout: 20000 }
      )
      .toBe(true);
    await expect(commitCheck).toContainText('1 commit(s) so far');

    const quiz = panel.locator('.jp-WorkshopPanel-quiz');

    await quiz.getByLabel('git commit').check();
    await quiz.getByRole('button', { name: 'Submit' }).click();
    await expect(quiz.locator('.jp-WorkshopPanel-quizFeedback')).toHaveText(
      'git commit records what is already staged.'
    );
    await expect(quiz).toContainText('2 attempts left');
    await quiz.getByLabel('git add').check();
    await quiz.getByRole('button', { name: 'Submit' }).click();
    await expect(quiz).toHaveClass(/jp-mod-status-ok/);
    await expect(quiz.locator('.jp-WorkshopPanel-quizFeedback')).toHaveText(
      'git add stages changes; git commit records what is staged.'
    );
    await expect(gate).toHaveCount(0);

    // Leaving the page with its requirements met marks it done. Inline
    // roles render as buttons, and editor-insert appends through the open
    // editor and saves.
    await panel
      .locator('.jp-WorkshopPanel-footer button', { hasText: 'Next' })
      .click();
    await expect(
      panel.locator('.jp-WorkshopPanel-pageSelect option', {
        hasText: 'Your first commit ✓'
      })
    ).toHaveCount(1);
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
    await page.sidebar.openTab('jupyterlab-workshop-panel');
    await expect(
      page.locator(PANEL).locator('.jp-WorkshopPanel-pageTitle')
    ).toHaveText('Edit and diff');
  });
});
