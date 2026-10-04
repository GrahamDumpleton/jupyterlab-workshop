import { attemptProblem, parseAttempt } from '../checks/attempt';
import { pageInventory } from '../format/inventory';
import { parseManifest } from '../format/manifest';
import { IDirectiveNode, collectDirectives, parsePage } from '../format/page';
import { lintWorkshop } from '../lint/rules';

const B3 = '```';
const B4 = '````';

const MANIFEST = `
apiVersion: jupyterlab-workshop/v1alpha1
name: demo
title: Demo
capabilities:
  - write-files
pages: [pages/01.md]
`;

/** Rules about capabilities, which these pages are not written to test. */
const CAPABILITY_RULES = ['unused-capability', 'undeclared-capability'];

function parse(source: string) {
  return parsePage(source, { path: 'pages/01.md', variables: {} });
}

function rules(source: string): string[] {
  return lintWorkshop({
    manifest: parseManifest(MANIFEST),
    pages: [parse(source)]
  })
    .map(message => message.rule)
    .filter(rule => !CAPABILITY_RULES.includes(rule));
}

const CHECK = `${B3}{verify}
:id: greeting
:substrate: contents
contains greeting.txt Hello
${B3}
`;

const PAGE = `---
id: greet
---

${B4}{attempt}
:id: wrong-greeting
:check: greeting
:expect: does not contain "Hello"
A note to whoever reads the source.

${B3}{file-write}
:id: write-wrong
:path: greeting.txt
Goodbye
${B3}
${B4}

${B3}{file-write}
:id: write-right
:path: greeting.txt
Hello
${B3}

${CHECK}`;

describe('parseAttempt', () => {
  it('reads the check, and expects a failure unless told otherwise', () => {
    expect(parseAttempt({ check: 'greeting', expect: 'not there' })).toEqual({
      attempt: { check: 'greeting', result: 'fail', expect: 'not there' }
    });
  });

  it('lets an attempt that should pass leave out what the check says', () => {
    expect(parseAttempt({ check: 'greeting', result: 'pass' })).toEqual({
      attempt: { check: 'greeting', result: 'pass', expect: '' }
    });
  });

  it('refuses an attempt with no check', () => {
    expect(parseAttempt({ expect: 'x' }).error).toContain('"check"');
  });

  it('refuses a failing attempt that does not say what the check says', () => {
    expect(parseAttempt({ check: 'greeting' }).error).toContain('"expect"');
  });

  it('refuses a result that is neither fail nor pass', () => {
    expect(
      parseAttempt({ check: 'greeting', expect: 'x', result: 'maybe' }).error
    ).toContain('"maybe"');
  });
});

describe('attemptProblem', () => {
  const wrong = {
    check: 'greeting',
    result: 'fail' as const,
    expect: 'not  there'
  };
  const right = { check: 'greeting', result: 'pass' as const, expect: '' };

  it('accepts a failure whose message contains the text', () => {
    expect(
      attemptProblem(wrong, {
        status: 'error',
        message: 'The file is\nnot there yet'
      })
    ).toBeNull();
  });

  it('reports a failure that says something else, with what it said', () => {
    const problem = attemptProblem(wrong, {
      status: 'error',
      message: 'The file is empty'
    });

    expect(problem).toContain('"The file is empty"');
    expect(problem).toContain('does not contain');
  });

  it('reports a check that passed when it was to fail', () => {
    expect(
      attemptProblem(wrong, { status: 'ok', message: 'Correct' })
    ).toContain('was expected to fail');
  });

  it('accepts a pass, with any message, when a pass is expected', () => {
    expect(attemptProblem(right, { status: 'ok', message: 'Good' })).toBeNull();
    expect(attemptProblem(right, { status: 'ok' })).toBeNull();
  });

  it('reports a check that failed when it was to pass', () => {
    expect(attemptProblem(right, { status: 'error', message: 'No' })).toContain(
      'was expected to pass'
    );
  });

  it('reports a check that did not run', () => {
    expect(
      attemptProblem(wrong, { status: 'skipped', message: 'Not allowed' })
    ).toContain('did not run');
  });
});

describe('an attempt on a page', () => {
  const page = parse(PAGE);
  const attempt = page.nodes[0] as IDirectiveNode;

  it('parses its body into the directives it holds', () => {
    const held = collectDirectives(attempt.nodes ?? []);

    expect(attempt.name).toBe('attempt');
    expect(held.map(node => node.id)).toEqual(['write-wrong']);
    expect(held[0].body).toBe('Goodbye');
  });

  it('is left out of the page inventory, with what it holds', () => {
    expect(pageInventory(page).map(entry => entry.id)).toEqual([
      'write-right',
      'greeting'
    ]);
  });

  it('lints clean', () => {
    expect(rules(PAGE)).toEqual([]);
  });
});

describe('lint of attempts', () => {
  const attempt = (options: string, body = ''): string =>
    `${B4}{attempt}\n:id: try\n${options}\n${body}${B4}\n\n${CHECK}`;

  it('reports an attempt whose options cannot be read', () => {
    expect(rules(attempt(':check: greeting'))).toEqual(['attempt-options']);
  });

  it('reports a check that is not on the page', () => {
    expect(rules(attempt(':check: missing\n:expect: x'))).toEqual([
      'attempt-check'
    ]);
  });

  it('reports a check that is not a verify', () => {
    const source = `${attempt(':check: note\n:expect: x')}\n${B3}{toast}\n:id: note\nHello\n${B3}\n`;

    expect(rules(source)).toEqual(['attempt-check']);
  });

  it('reports a check, a hint or an action for a person inside one', () => {
    const body = `${B3}{tour}\n:id: look\n- selector: body\n  text: Look\n${B3}\n`;

    expect(rules(attempt(':check: greeting\n:expect: x', body))).toEqual([
      'attempt-content'
    ]);
  });

  it('reports an action inside one that runs on its own or cascades', () => {
    const body = `${B3}{file-write}\n:id: write\n:path: a.txt\n:auto: page-enter\nA\n${B3}\n`;

    expect(rules(attempt(':check: greeting\n:expect: x', body))).toContain(
      'attempt-auto'
    );
  });

  it('reports a cascade from the page into an attempt', () => {
    const body = `${B3}{file-write}\n:id: write\n:path: a.txt\nA\n${B3}\n`;
    const source = `${B3}{file-write}\n:id: first\n:path: b.txt\n:cascade: write\nB\n${B3}\n\n${attempt(':check: greeting\n:expect: x', body)}`;

    expect(rules(source)).toContain('attempt-cascade');
  });
});
