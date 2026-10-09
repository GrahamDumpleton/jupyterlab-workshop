import { renderInlineMarkdown, renderPlainMarkdown } from '../markdown/parser';

describe('renderInlineMarkdown', () => {
  it('renders code spans and emphasis', () => {
    expect(renderInlineMarkdown('Run `git add` *now*')).toBe(
      'Run <code>git add</code> <em>now</em>'
    );
  });

  it('never wraps the result in a paragraph', () => {
    expect(renderInlineMarkdown('plain text')).toBe('plain text');
  });

  it('opens an explicit outside link in a new tab', () => {
    expect(
      renderInlineMarkdown('See [the docs](https://example.com/docs)')
    ).toBe(
      'See <a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">the docs</a>'
    );
  });

  it('leaves a relative link alone', () => {
    expect(renderInlineMarkdown('[here](pages/02.md)')).toBe(
      '<a href="pages/02.md">here</a>'
    );
  });

  it('does not auto-link a bare URL', () => {
    expect(renderInlineMarkdown('See https://example.com/docs')).toBe(
      'See https://example.com/docs'
    );
  });

  it('keeps a URL in backticks as a code span', () => {
    expect(renderInlineMarkdown('See `https://example.com/docs`')).toBe(
      'See <code>https://example.com/docs</code>'
    );
    expect(renderInlineMarkdown('`[x](https://example.com)`')).toBe(
      '<code>[x](https://example.com)</code>'
    );
  });

  it('escapes raw HTML inside and outside code spans', () => {
    expect(renderInlineMarkdown('<b>bold</b> and `<b>tags</b>`')).toBe(
      '&lt;b&gt;bold&lt;/b&gt; and <code>&lt;b&gt;tags&lt;/b&gt;</code>'
    );
  });

  it('leaves a role literal', () => {
    expect(renderInlineMarkdown('Use {copy}`git status` here')).toBe(
      'Use {copy}<code>git status</code> here'
    );
  });

  it('does not substitute variables', () => {
    expect(renderInlineMarkdown('In {{ repo_dir }}')).toBe('In {{ repo_dir }}');
  });

  it('is separate from the page parser', () => {
    // A directive body substituted by the page parser is not touched again.
    expect(renderInlineMarkdown('{var}`repo_dir`')).toBe(
      '{var}<code>repo_dir</code>'
    );
  });
});

describe('renderPlainMarkdown', () => {
  it('renders blocks without the workshop rules', () => {
    const html = renderPlainMarkdown(
      '# Done\n\nRun `{copy}` then:\n\n```{execute}\nls\n```\n\n<b>x</b> https://example.org'
    );

    expect(html).toContain('<h1>Done</h1>');
    expect(html).toContain('<code>{copy}</code>');
    expect(html).toContain('<pre><code class="language-{execute}">ls');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('target="_blank"');
  });

  it('links a URL only when it has its scheme, so a file name is not a host', () => {
    const html = renderPlainMarkdown(
      'See OUTLINE.md and pages/01.md, or https://example.org and [a file](pages/01.md).'
    );

    expect(html).not.toContain('href="http://OUTLINE.md"');
    expect(html).toContain('See OUTLINE.md and pages/01.md');
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('<a href="pages/01.md">a file</a>');
  });
});
