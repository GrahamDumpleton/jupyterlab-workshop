import { pageInventory } from '../format/inventory';
import { parsePage } from '../format/page';

const SOURCE = `---
title: Inventory
---

Some prose first.

\`\`\`{execute}
git init
\`\`\`

\`\`\`{execute}
:id: setup
:auto: page-enter
:cascade: true
git config user.name demo
\`\`\`

\`\`\`{file-write}
:path: README.md
hello
\`\`\`

\`\`\`{execute}
:id: build
:cascade: verify-build after 2s
make
\`\`\`

\`\`\`{verify}
:id: verify-build
:trigger: after:build; interval 10s
exists build
\`\`\`

\`\`\`{verify}
:id: click-only
:trigger: click
exists README.md
\`\`\`

\`\`\`\`{when} track == "pip"
\`\`\`{execute}
pip install demo
\`\`\`
\`\`\`\`

\`\`\`{hint}
:when: platform == "linux"
Try the docs.
\`\`\`

\`\`\`{quiz}
:id: q1
question: Which?
choices: [a, b]
answer: a
\`\`\`
`;

describe('pageInventory', () => {
  const page = parsePage(SOURCE, { path: 'pages/03-inventory.md' });

  it('lists every directive with an id in document order', () => {
    expect(pageInventory(page).map(entry => entry.id)).toEqual([
      '03-inventory-1',
      'setup',
      '03-inventory-2',
      'build',
      'verify-build',
      'click-only',
      '03-inventory-3',
      '03-inventory-4',
      'q1'
    ]);
    expect(pageInventory(page).map(entry => entry.type)).toEqual([
      'execute',
      'execute',
      'file-write',
      'execute',
      'verify',
      'verify',
      'execute',
      'hint',
      'quiz'
    ]);
  });

  it('says how each directive is expected to start', () => {
    const triggers = Object.fromEntries(
      pageInventory(page).map(entry => [entry.id, entry.trigger])
    );

    expect(triggers).toEqual({
      '03-inventory-1': 'click',
      setup: 'auto',
      '03-inventory-2': 'cascade',
      build: 'click',
      'verify-build': 'cascade',
      'click-only': 'click',
      '03-inventory-3': 'click',
      '03-inventory-4': 'click',
      q1: 'click'
    });
  });

  it('marks directives a condition may hide', () => {
    const conditional = pageInventory(page)
      .filter(entry => entry.conditional)
      .map(entry => entry.id);

    expect(conditional).toEqual(['03-inventory-3', '03-inventory-4']);
    expect(
      pageInventory(page).find(entry => entry.id === 'setup')
    ).not.toHaveProperty('conditional');
  });

  it('applies the manifest defaults under the page options', () => {
    const inventory = pageInventory(page, { cascade: 'true' });
    const triggers = Object.fromEntries(
      inventory.map(entry => [entry.id, entry.trigger])
    );

    // Every directive now cascades into the next, except where the page
    // says otherwise: `build` names its own target, and `setup` stays auto.
    expect(triggers).toEqual({
      '03-inventory-1': 'click',
      setup: 'auto',
      '03-inventory-2': 'cascade',
      build: 'cascade',
      'verify-build': 'cascade',
      'click-only': 'cascade',
      '03-inventory-3': 'cascade',
      '03-inventory-4': 'cascade',
      q1: 'cascade'
    });
  });

  it('prefers a trigger over a click when a check listens for anything', () => {
    const listening = parsePage(
      '```{verify}\n:id: v\n:trigger: click; page-enter\nexists x\n```\n',
      { path: 'pages/a.md' }
    );

    expect(pageInventory(listening)).toEqual([
      { id: 'v', type: 'verify', trigger: 'trigger' }
    ]);
  });

  it('is empty for a page of prose', () => {
    expect(
      pageInventory(parsePage('Just words.\n', { path: 'pages/b.md' }))
    ).toEqual([]);
  });
});
