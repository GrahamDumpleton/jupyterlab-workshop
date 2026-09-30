import { unclosedFence } from '../format/fences';
import { parseManifest } from '../format/manifest';
import { parsePage } from '../format/page';
import { lintWorkshop } from '../lint/rules';
import { ILintMessage } from '../lint/types';

const MANIFEST = `
apiVersion: jupyterlab-workshop/v1alpha1
name: demo
title: Demo
capabilities:
  - terminal
  - write-files
pages: [pages/01.md]
`;

const B3 = '```';
const B4 = '````';
const B5 = '`````';

function lint(page: string): ILintMessage[] {
  return lintWorkshop({
    manifest: parseManifest(MANIFEST),
    pages: [parsePage(page, { path: 'pages/01.md', variables: {} })]
  }).filter(message => message.rule !== 'unused-capability');
}

function problems(page: string): string[] {
  return lint(page).map(
    message => `${message.rule}:${message.line ?? 0}:${message.message}`
  );
}

describe('unclosedFence', () => {
  it('finds the fence left open by a shorter closer', () => {
    expect(unclosedFence(`text\n${B4}python\ncode\n${B3}\n`)).toEqual({
      line: 1,
      marker: B4,
      info: 'python'
    });
  });

  it('is clean when every fence is closed, whatever the indentation', () => {
    expect(
      unclosedFence(`- item\n\n  ${B3}text\n  quoted\n  ${B3}\n\n${B3}\n${B3}`)
    ).toBeNull();
  });

  it('does not close a backtick fence with tildes or an opener', () => {
    expect(unclosedFence(`${B3}\n~~~\n${B4}text\n`)).toEqual({
      line: 0,
      marker: B3,
      info: ''
    });
  });

  it('ignores a backtick run followed by a code span', () => {
    expect(unclosedFence('``` not a `fence`')).toBeNull();
  });
});

describe('nested-fence', () => {
  it('reports a when holding an execute with the same fence', () => {
    const found = problems(`# Page

${B3}{when} can_attach == "yes"
Attach.

${B3}{execute}
:id: attach
gdb -p 1
${B3}

More.
${B3}

${B3}{when} can_attach == "no"
Read the dump.
${B3}
`);

    expect(found).toEqual([
      `nested-fence:3:The "when" directive at line 3 ends at line 9, at the fence meant to close the block opened at line 6. A directive that holds a fenced block needs a longer fence: four backticks for the directive, three for the block.`,
      `nested-fence:14:The "when" directive at line 14 is inside the code block opened at line 12, so it is shown as text. The block is probably the closing fence of a directive that ended early. A directive that holds a fenced block needs a longer fence: four backticks for the directive, three for the block.`
    ]);
  });

  it('reports a hint quoting a code block with the same fence', () => {
    const found = problems(`${B3}{hint}
The output looks like this:

${B3}
Hello
${B3}
${B3}

${B3}{execute}
ls
${B3}
`);

    expect(found).toEqual([
      `nested-fence:6:The empty code block at line 6 is probably the closing fence of a directive that ended at the fence of a block inside it. A directive that holds a fenced block needs a longer fence: four backticks for the directive, three for the block. Remove the block if it is meant to be empty.`
    ]);
  });

  it('reports a hint whose quoted block has a language', () => {
    const found = problems(`${B3}{hint}
Text

${B3}text
output
${B3}
${B3}

Tail.

${B3}{execute}
:id: a
ls
${B3}

End.
`);

    expect(found.map(item => item.split(':').slice(0, 2).join(':'))).toEqual([
      'nested-fence:1',
      'nested-fence:11'
    ]);
  });

  it('reports the leftover block running to the end of the page', () => {
    const found = problems(`${B3}{hint}
Text

${B3}text
output
${B3}
${B3}

Tail.
`);

    expect(found.map(item => item.split(':').slice(0, 2).join(':'))).toEqual([
      'nested-fence:1',
      'unclosed-fence:7'
    ]);
  });

  it('counts front matter lines', () => {
    const found = problems(`---
title: One
---

${B3}{hint}
${B3}
Quoted
${B3}
${B3}
`);

    expect(found.map(item => item.split(':').slice(0, 2).join(':'))).toEqual([
      'nested-fence:8'
    ]);
  });

  it('is clean when the outer fence is longer', () => {
    expect(
      problems(`${B4}{hint}
Text

${B3}
output
${B3}
${B4}

${B4}{when} x == "yes"
:id: branch

${B3}{execute}
ls
${B3}
${B4}
`)
    ).toEqual([]);
  });

  it('is clean two deep with five, four and three', () => {
    expect(
      problems(`${B5}{when} x == "yes"

${B4}{hint}
Look:

${B3}
output
${B3}
${B4}

${B4}{when} y == "yes"

${B3}{execute}
ls
${B3}
${B4}
${B5}
`)
    ).toEqual([]);
  });

  it('is clean for quoted directives in a longer block and for empty bodies', () => {
    expect(
      problems(`${B4}markdown
${B3}{execute}
ls
${B3}
${B4}

${B3}text
${B3}

Prose with a colon:
:not-an-option: at the start of a line.
`)
    ).toEqual([]);
  });
});

describe('unclosed-fence', () => {
  it('reports a directive with no closing fence', () => {
    expect(
      problems(`${B3}{execute}
ls
`)
    ).toEqual([
      'unclosed-fence:1:The "execute" directive at line 1 has no closing fence'
    ]);
  });

  it('reports a shorter block left open inside a directive', () => {
    expect(
      problems(`${B4}{hint}
Text

${B3}
output
${B4}
`)
    ).toEqual([
      'unclosed-fence:4:The block opened at line 4 inside the "hint" directive at line 1 has no closing fence'
    ]);
  });
});

describe('nested line numbers', () => {
  it('places a directive inside a when at its line in the page', () => {
    const page = parsePage(
      `---
title: One
---

${B4}{when} x == "yes"
:id: branch

${B3}{execute}
ls
${B3}
${B4}
`,
      { path: 'pages/01.md', variables: {} }
    );
    const when = page.nodes[0];

    expect(when.kind).toBe('when');

    if (when.kind === 'when') {
      expect(when.line).toBe(5);
      expect(when.nodes[0]).toMatchObject({ kind: 'directive', line: 8 });
    }
  });
});
