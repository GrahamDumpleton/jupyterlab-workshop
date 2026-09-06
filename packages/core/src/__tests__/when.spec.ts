import {
  IDirectiveNode,
  IWhenNode,
  collectDirectives,
  parsePage,
  declaredVariables
} from '../format/page';

const SOURCE = `---
title: Tracks
when: platform != "windows"
optional: true
requires: [verify:done]
estimated: 5m
---

Pick one.

\`\`\`\`{when} track == "pip"
Install with pip:

\`\`\`{execute}
pip install demo
\`\`\`
\`\`\`\`

\`\`\`\`{when}
:condition: track == "conda"
\`\`\`{execute}
conda install demo
\`\`\`
\`\`\`\`

\`\`\`{hint}
:title: Stuck?
Use {var}\`track\` and **read** the docs.
\`\`\`
`;

describe('when directives', () => {
  const page = parsePage(SOURCE, {
    path: 'pages/tracks.md',
    variables: { track: 'pip' }
  });

  it('parses the extended front matter', () => {
    expect(page.frontmatter).toEqual({
      title: 'Tracks',
      id: undefined,
      optional: true,
      when: 'platform != "windows"',
      requires: ['verify:done'],
      estimated: '5m'
    });
  });

  it('produces when nodes with nested content', () => {
    expect(page.nodes.map(node => node.kind)).toEqual([
      'prose',
      'when',
      'when',
      'directive'
    ]);

    const first = page.nodes[1] as IWhenNode;

    expect(first.condition).toBe('track == "pip"');
    expect(first.nodes.map(node => node.kind)).toEqual(['prose', 'directive']);
    expect((first.nodes[1] as IDirectiveNode).body).toBe('pip install demo');

    const second = page.nodes[2] as IWhenNode;

    expect(second.condition).toBe('track == "conda"');
  });

  it('numbers nested directives continuously and skips when blocks', () => {
    expect(collectDirectives(page.nodes).map(node => node.id)).toEqual([
      'tracks-1',
      'tracks-2',
      'tracks-3'
    ]);
  });

  it('renders markdown bodies and var roles', () => {
    const hint = page.nodes[3] as IDirectiveNode;

    expect(hint.options.title).toBe('Stuck?');
    expect(hint.html).toContain('<strong>read</strong>');
    expect(hint.html).toContain(
      '<code class="jp-Workshop-role jp-Workshop-role-var">pip</code>'
    );
  });

  it('warns when a when directive has no condition', () => {
    const result = parsePage('```{when}\ntext\n```\n', { path: 'p.md' });

    expect(result.warnings).toEqual([expect.stringContaining('no condition')]);
  });
});

describe('declared variables', () => {
  const source = `Python {var}\`python_version\` and {{ python_version }} here.

\`\`\`{kernel-execute}
:capture: python_version
print(1)
\`\`\`

\`\`\`{choice}
:track: true
\`\`\`

\`\`\`{env-set}
:name: greeting
hi
\`\`\`
`;

  it('lists the variables a page can set', () => {
    const page = parsePage(source, { path: 'p.md' });

    expect(declaredVariables(page.nodes)).toEqual([
      'python_version',
      'track',
      'greeting'
    ]);
  });

  it('renders declared but unset variables without warnings', () => {
    const page = parsePage(source, {
      path: 'p.md',
      declared: ['python_version']
    });
    const prose = page.nodes[0] as { html: string };

    expect(page.warnings).toEqual([]);
    expect(prose.html).toContain(
      '<code class="jp-Workshop-role jp-Workshop-role-var jp-mod-unset" title="Not set yet">python_version</code>'
    );
    expect(prose.html).toContain('and  here.');
  });

  it('still warns about variables nothing declares', () => {
    const page = parsePage(source, { path: 'p.md' });

    expect(page.warnings).toEqual([
      'Unknown variable "python_version"',
      'Unknown variable "python_version"'
    ]);
  });
});
