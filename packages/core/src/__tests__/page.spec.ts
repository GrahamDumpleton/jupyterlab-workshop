import { IDirectiveNode, IProseNode, parsePage } from '../format/page';

const SOURCE = `---
title: Your first commit
optional: true
---

# Ignored heading

Create the repo in {{ repo_dir }} then open {open}\`{{ repo_dir }}/README.md\`.
Literal braces: \\{{ repo_dir }} and \`\\{{ code }}\`.

\`\`\`{execute}
:session: git
:cwd: {{ repo_dir }}
git status
\`\`\`

Some text between.

\`\`\`{file-write}
:id: readme
:path: {{ repo_dir }}/README.md
:substitute: false
# {{ not_a_variable }}
\`\`\`

- item with nested directive:

  \`\`\`{execute}
  echo nested
  \`\`\`
`;

describe('parsePage', () => {
  const page = parsePage(SOURCE, {
    path: 'pages/02-first-commit.md',
    variables: { repo_dir: 'demo' }
  });

  it('uses front matter for title and id defaults to the file stem', () => {
    expect(page.title).toBe('Your first commit');
    expect(page.id).toBe('02-first-commit');
    expect(page.frontmatter.optional).toBe(true);
    expect(page.frontmatter.requires).toEqual([]);
  });

  it('splits prose and directives in document order', () => {
    expect(page.nodes.map(node => node.kind)).toEqual([
      'prose',
      'directive',
      'prose',
      'directive',
      'prose'
    ]);
  });

  it('substitutes variables in prose and renders roles as buttons', () => {
    const prose = page.nodes[0] as IProseNode;

    expect(prose.html).toContain('Create the repo in demo then open');
    expect(prose.html).toContain(
      '<button type="button" class="jp-Workshop-role jp-Workshop-role-open" data-role="open" data-value="demo/README.md"><code>demo/README.md</code></button>'
    );
  });

  it('keeps escaped references literal in prose and code', () => {
    const prose = page.nodes[0] as IProseNode;

    expect(prose.html).toContain(
      'Literal braces: {{ repo_dir }} and <code>{{ code }}</code>'
    );
  });

  it('parses directive options and bodies with substitution', () => {
    const execute = page.nodes[1] as IDirectiveNode;

    expect(execute.name).toBe('execute');
    expect(execute.id).toBe('02-first-commit-1');
    expect(execute.options).toEqual({ session: 'git', cwd: 'demo' });
    expect(execute.body).toBe('git status');
    expect(execute.line).toBe(11);
  });

  it('honours explicit ids and substitute: false', () => {
    const write = page.nodes[3] as IDirectiveNode;

    expect(write.id).toBe('readme');
    expect(write.options.path).toBe('{{ repo_dir }}/README.md');
    expect(write.body).toBe('# {{ not_a_variable }}');
  });

  it('warns about nested directives and leaves them as code', () => {
    const tail = page.nodes[4] as IProseNode;

    expect(tail.html).toContain('<code class="language-{execute}">echo nested');
    expect(page.warnings).toEqual([
      expect.stringContaining('directive "execute" is nested')
    ]);
  });

  it('falls back to the first heading and then the file stem for the title', () => {
    expect(parsePage('# Hello\n\ntext', { path: 'pages/a.md' }).title).toBe(
      'Hello'
    );
    expect(parsePage('text', { path: 'pages/01-intro.md' }).title).toBe(
      '01-intro'
    );
  });

  it('does not allow raw HTML', () => {
    const page = parsePage('<script>alert(1)</script>', { path: 'p.md' });
    const prose = page.nodes[0] as IProseNode;

    expect(prose.html).toContain('&lt;script&gt;');
  });
});
