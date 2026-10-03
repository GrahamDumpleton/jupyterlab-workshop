import { parseManifest } from '../format/manifest';
import { pageInventory } from '../format/inventory';
import {
  IDirectiveNode,
  IProseNode,
  collectDirectives,
  parsePage
} from '../format/page';
import { progressList, progressVariables } from '../format/progress';
import { lintWorkshop } from '../lint/rules';
import { ASSUMED_PROGRESS, evaluateExpression } from '../variables/expressions';

const B3 = '```';
const B4 = '````';

const MANIFEST = `
apiVersion: jupyterlab-workshop/v1alpha1
name: demo
title: Demo
capabilities:
  - terminal
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

const SOLUTION = `---
id: sum
---

${B3}{verify}
:id: check
:substrate: contents
exists answer.txt
${B3}

${B4}{hint}
:id: solution
:title: Show me a solution
:unlock: "check" in failed_checks
:locked: Try the check first
This writes the answer.

${B3}{execute}
:id: write-answer
echo 42 > answer.txt
${B3}

Then run the check again.
${B4}

${B3}{execute}
:id: after
ls
${B3}
`;

describe('a hint holding directives', () => {
  const page = parse(SOLUTION);
  const hint = page.nodes[1] as IDirectiveNode;

  it('parses its body into prose and directives', () => {
    const held = hint.nodes ?? [];

    expect(held.map(node => node.kind)).toEqual([
      'prose',
      'directive',
      'prose'
    ]);
    expect((held[0] as IProseNode).html).toContain('This writes the answer.');
    expect((held[1] as IDirectiveNode).name).toBe('execute');
    expect((held[1] as IDirectiveNode).body).toBe('echo 42 > answer.txt');
  });

  it('gives a held directive its line on the page', () => {
    expect((hint.nodes?.[1] as IDirectiveNode).line).toBe(18);
  });

  it('lists held directives after the hint, in document order', () => {
    expect(collectDirectives(page.nodes).map(node => node.id)).toEqual([
      'check',
      'solution',
      'write-answer',
      'after'
    ]);
  });

  it('numbers directives without an id through a hint', () => {
    const numbered = parse(
      `${B4}{hint}\n${B3}{execute}\nls\n${B3}\n${B4}\n\n${B3}{execute}\npwd\n${B3}\n`
    );

    expect(collectDirectives(numbered.nodes).map(node => node.id)).toEqual([
      '01-1',
      '01-2',
      '01-3'
    ]);
  });

  it('parses a hint inside a hint', () => {
    const nested = parse(
      `${B4}${B3}{hint}\n:id: outer\nFirst.\n\n${B4}{hint}\n:id: inner\n${B3}{execute}\n:id: deep\nls\n${B3}\n${B4}\n${B4}${B3}\n`
    );

    expect(collectDirectives(nested.nodes).map(node => node.id)).toEqual([
      'outer',
      'inner',
      'deep'
    ]);
  });

  it('puts held directives in the inventory', () => {
    expect(pageInventory(page).map(entry => entry.id)).toEqual([
      'check',
      'solution',
      'write-answer',
      'after'
    ]);
  });

  it('passes lint', () => {
    expect(rules(SOLUTION)).toEqual([]);
  });
});

describe('progress variables', () => {
  const directives = collectDirectives(parse(SOLUTION).nodes);

  it('names the list each directive type can be in', () => {
    expect(progressList('verify')).toBe('passed_checks');
    expect(progressList('quiz')).toBe('passed_checks');
    expect(progressList('hint')).toBe('opened_hints');
    expect(progressList('execute')).toBe('done_actions');
    expect(progressList('form')).toBe('done_actions');
  });

  it('are empty lists when nothing has happened', () => {
    expect(progressVariables(directives, () => undefined, [])).toEqual({
      passed_checks: '',
      failed_checks: '',
      opened_hints: '',
      done_actions: ''
    });
  });

  it('sort directives by what each last did', () => {
    const status: Record<string, string> = {
      check: 'error',
      'write-answer': 'ok',
      after: 'error',
      solution: 'ok'
    };

    expect(
      progressVariables(directives, id => status[id], ['solution', 'gone'])
    ).toEqual({
      passed_checks: '',
      failed_checks: 'check',
      opened_hints: 'solution',
      done_actions: 'write-answer'
    });
    expect(progressVariables(directives, () => 'ok', []).passed_checks).toBe(
      'check'
    );
  });

  it('are read as lists by conditions', () => {
    const values = { failed_checks: 'check, other', opened_hints: '' };
    const value = (source: string) => evaluateExpression(source, values).value;

    expect(value('"check" in failed_checks')).toBe(true);
    expect(value('"chec" in failed_checks')).toBe(false);
    expect(value('"solution" in opened_hints')).toBe(false);
    expect(value('"solution" not in opened_hints')).toBe(true);
  });

  it('can be assumed, so every membership test holds', () => {
    const value = (source: string) =>
      evaluateExpression(source, { ...ASSUMED_PROGRESS, track: 'pip' }).value;

    expect(value('"check" in failed_checks')).toBe(true);
    expect(value('"check" in passed_checks')).toBe(true);
    expect(value('"anything" in opened_hints and track == "pip"')).toBe(true);
    expect(value('"anything" in done_actions and track == "conda"')).toBe(
      false
    );
  });
});

describe('hint lint', () => {
  it('refuses a check, quiz or form inside a hint', () => {
    const source = `${B4}{hint}\n${B3}{verify}\n:substrate: contents\nexists a.txt\n${B3}\n${B4}\n`;

    expect(rules(source)).toContain('hint-content');
  });

  it('refuses an automatic action inside a hint', () => {
    const source = `${B4}{hint}\n${B3}{execute}\n:auto: page-enter\nls\n${B3}\n${B4}\n`;

    expect(rules(source)).toContain('hint-auto');
  });

  it('refuses a cascade into a hint from outside it', () => {
    const source = `${B3}{execute}\n:cascade: held\nls\n${B3}\n\n${B4}{hint}\n${B3}{execute}\n:id: held\npwd\n${B3}\n${B4}\n`;

    expect(rules(source)).toContain('hint-cascade');
  });

  it('allows a cascade within one hint', () => {
    const source = `${B4}{hint}\n${B3}{execute}\n:cascade: held\nls\n${B3}\n\n${B3}{execute}\n:id: held\npwd\n${B3}\n${B4}\n`;

    expect(rules(source)).toEqual([]);
  });

  it('reports an unlock condition that cannot be read', () => {
    expect(rules(`${B3}{hint}\n:unlock: "a" in\nText.\n${B3}\n`)).toContain(
      'invalid-condition'
    );
  });

  it('warns about a locked note with no unlock condition', () => {
    expect(rules(`${B3}{hint}\n:locked: Later\nText.\n${B3}\n`)).toEqual([
      'hint-locked'
    ]);
  });

  it('reports an unknown id tested against a progress list', () => {
    expect(
      rules(`${B3}{hint}\n:unlock: "nope" in failed_checks\nText.\n${B3}\n`)
    ).toEqual(['unknown-action-id']);
  });

  it('warns about an id tested against a list it is never in', () => {
    const source = `${B3}{execute}\n:id: step\nls\n${B3}\n\n${B3}{hint}\n:when: "step" in passed_checks\nText.\n${B3}\n`;

    expect(rules(source)).toEqual(['progress-list']);
    expect(rules(source.replace('passed_checks', 'done_actions'))).toEqual([]);
  });
});
