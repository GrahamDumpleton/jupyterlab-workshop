import { IProseNode, parsePage } from '../format/page';
import { lintWorkshop } from '../lint/rules';
import { parseManifest } from '../format/manifest';
import { FILE_ATTRIBUTE, resolveWorkshopFile } from '../markdown/parser';

const MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: demo
title: Demo
pages: [pages/01.md]
`;

function prose(source: string, path = 'pages/01.md') {
  const page = parsePage(source, { path });
  const html = page.nodes
    .filter((node): node is IProseNode => node.kind === 'prose')
    .map(node => node.html)
    .join('');

  return { page, html };
}

describe('resolveWorkshopFile', () => {
  it('resolves against the page, or the workshop with a leading slash', () => {
    expect(resolveWorkshopFile('pages/01.md', '../images/a.png')).toBe(
      'images/a.png'
    );
    expect(resolveWorkshopFile('pages/01.md', 'shots/b.png')).toBe(
      'pages/shots/b.png'
    );
    expect(resolveWorkshopFile('pages/01.md', './c.png')).toBe('pages/c.png');
    expect(resolveWorkshopFile('pages/01.md', '/images/d.png')).toBe(
      'images/d.png'
    );
    expect(resolveWorkshopFile('01.md', 'images/e.png')).toBe('images/e.png');
    expect(resolveWorkshopFile('pages/01.md', 'my%20shot.png')).toBe(
      'pages/my shot.png'
    );
  });

  it('refuses a path that leaves the workshop', () => {
    expect(resolveWorkshopFile('pages/01.md', '../../secret.png')).toBeNull();
    expect(resolveWorkshopFile('01.md', '../x.png')).toBeNull();
    expect(resolveWorkshopFile('pages/01.md', '/')).toBeNull();
  });
});

describe('images on pages', () => {
  it('names the workshop file on the tag instead of a source', () => {
    const { page, html } = prose(
      '# Start\n\nSee ![the diagram](../images/flow.png "Flow") here.\n'
    );

    expect(html).toContain(
      `<img alt="the diagram" title="Flow" ${FILE_ATTRIBUTE}="images/flow.png">`
    );
    expect(html).not.toContain('src=');
    expect(page.files).toEqual([{ path: 'images/flow.png', line: 3 }]);
    expect(page.problems).toEqual([]);
  });

  it('leaves web and data images alone', () => {
    const { page, html } = prose(
      '![a](https://example.com/a.png) ![b](data:image/png;base64,AAAA)\n'
    );

    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(page.files).toEqual([]);
  });

  it('reports an image outside the workshop and shows its text', () => {
    const { page, html } = prose('Intro.\n\n![leaked](../../etc/x.png)\n');

    expect(html).toContain(`<img alt="leaked">`);
    expect(page.files).toEqual([]);
    expect(page.problems).toEqual([
      {
        rule: 'file-outside-workshop',
        line: 3,
        message:
          'The image "../../etc/x.png" at line 3 is outside the workshop directory, so it cannot be shown'
      }
    ]);
  });

  it('knows the line of an image inside a hint', () => {
    const { page } = prose(
      '# Start\n\n````{hint}\nLook:\n\n![shot](../images/shot.png)\n````\n'
    );

    expect(page.files).toEqual([{ path: 'images/shot.png', line: 6 }]);
  });

  it('is linted against the files the workshop has, when known', () => {
    const page = parsePage('![a](../images/a.png)\n\n![b](../images/b.png)\n', {
      path: 'pages/01.md'
    });
    const manifest = parseManifest(MANIFEST);

    expect(lintWorkshop({ manifest, pages: [page] })).toEqual([]);

    const messages = lintWorkshop({
      manifest,
      pages: [page],
      exists: path => path === 'images/a.png'
    });

    expect(messages).toEqual([
      {
        level: 'error',
        rule: 'missing-file',
        message: 'The image "images/b.png" is not in the workshop',
        path: 'pages/01.md',
        line: 3
      }
    ]);
  });
});
