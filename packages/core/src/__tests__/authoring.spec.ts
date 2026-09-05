import {
  addManifestCapability,
  appendBlock,
  applyFix,
  directiveExtent,
  draftFromRecording,
  draftManifest,
  insertBlock,
  manifestCapabilities,
  newPagePath,
  parseRecording,
  removeDirective,
  removeManifestCapability,
  replaceDirective,
  serializeDirective,
  setFrontmatter,
  setManifestPages
} from '../authoring';
import { parseManifest } from '../format/manifest';
import { parsePage } from '../format/page';
import { lintWorkshop } from '../lint/rules';

const PAGE = `---
title: Demo
---

# Demo

Intro.

\`\`\`{execute}
:id: first
:bogus: yes
echo one
\`\`\`

Middle.

\`\`\`{verify}
:id: check
:substrate: contents
exists demo
\`\`\`
`;

const MANIFEST = `apiVersion: jupyterlab-workshop/v1alpha1
name: demo
title: Demo
# What the workshop may do
capabilities:
  - terminal
  - write-files: [workspace]
gating: soft
pages:
  - pages/01.md
  - pages/02.md
`;

describe('serializeDirective', () => {
  it('writes options first and lengthens the fence around backticks', () => {
    const text = serializeDirective({
      name: 'file-write',
      options: { path: 'a.md', title: 'Notes', id: 'notes', open: '' },
      body: '# Notes\n\n```\ncode\n```\n'
    });

    expect(text).toBe(
      '````{file-write}\n:id: notes\n:title: Notes\n:path: a.md\n:open:\n# Notes\n\n```\ncode\n```\n````'
    );
  });

  it('round trips through the parser', () => {
    const text = serializeDirective({
      name: 'execute',
      options: { session: 'git', wait: 'prompt' },
      body: 'git status'
    });
    const page = parsePage(`${text}\n`, { path: 'pages/01.md' });
    const node = page.nodes[0];

    expect(node.kind).toBe('directive');

    if (node.kind === 'directive') {
      expect(node.options).toEqual({ session: 'git', wait: 'prompt' });
      expect(node.body).toBe('git status');
      expect(node.endLine).toBe(5);
    }
  });
});

describe('directive editing', () => {
  it('finds the extent of a directive from its first line', () => {
    const page = parsePage(PAGE, { path: 'pages/01.md' });
    const first = page.nodes[1];

    expect(first.kind).toBe('directive');

    if (first.kind === 'directive') {
      expect(directiveExtent(PAGE, first.line)).toEqual({
        start: first.line,
        end: first.endLine
      });
    }

    expect(directiveExtent(PAGE, 1)).toBeNull();
  });

  it('replaces, removes, inserts and appends blocks', () => {
    const replaced = replaceDirective(PAGE, 9, '```{execute}\necho two\n```');

    expect(replaced).toContain('echo two');
    expect(replaced).not.toContain('echo one');
    expect(replaced).toContain('Middle.');

    const removed = removeDirective(PAGE, 9);

    expect(removed).not.toContain('echo one');
    expect(removed).toContain('Intro.\n\nMiddle.');

    const inserted = insertBlock('a\nb', 1, 'X');

    expect(inserted).toBe('a\n\nX\n\nb');
    expect(appendBlock('', 'X')).toBe('X\n');
    expect(appendBlock('a\n', 'X\n')).toBe('a\n\nX\n');
  });
});

describe('manifest editing', () => {
  it('rewrites the pages block and keeps the rest', () => {
    const edited = setManifestPages(MANIFEST, ['pages/02.md', 'pages/03.md']);

    expect(edited).toContain('# What the workshop may do');
    expect(edited.endsWith('pages:\n  - pages/02.md\n  - pages/03.md\n')).toBe(
      true
    );
    expect(parseManifest(edited).pages).toEqual(['pages/02.md', 'pages/03.md']);
  });

  it('adds and removes capabilities with scopes grouped', () => {
    expect(manifestCapabilities(MANIFEST)).toEqual([
      'terminal',
      'write-files:workspace'
    ]);

    const added = addManifestCapability(
      addManifestCapability(MANIFEST, 'write-files:home'),
      'kernel-exec'
    );

    expect(added).toContain(
      'capabilities:\n  - terminal\n  - write-files: [workspace, home]\n  - kernel-exec\ngating: soft'
    );
    expect(addManifestCapability(added, 'terminal')).toBe(added);

    const removed = removeManifestCapability(added, 'write-files');

    expect(parseManifest(removed).capabilities).toEqual([
      'terminal',
      'kernel-exec'
    ]);
    expect(
      removeManifestCapability(
        removeManifestCapability(removed, 'terminal'),
        'kernel-exec'
      )
    ).toContain('capabilities: []');
  });

  it('appends a missing key at the end', () => {
    const source =
      'apiVersion: jupyterlab-workshop/v1alpha1\nname: x\ntitle: X\n';

    expect(setManifestPages(source, ['pages/01.md'])).toBe(
      `${source}pages:\n  - pages/01.md\n`
    );
  });

  it('updates and clears front matter', () => {
    const updated = setFrontmatter(PAGE, {
      optional: true,
      requires: ['verify:check']
    });

    expect(
      updated.startsWith(
        '---\ntitle: Demo\noptional: true\nrequires: [verify:check]\n---\n\n# Demo'
      )
    ).toBe(true);

    const page = parsePage(updated, { path: 'pages/01.md' });

    expect(page.frontmatter.optional).toBe(true);
    expect(page.frontmatter.requires).toEqual(['verify:check']);

    expect(
      setFrontmatter(updated, {
        title: undefined,
        optional: false,
        requires: []
      })
    ).toBe('# Demo\n\nIntro.' + updated.slice(updated.indexOf('Intro.') + 6));
  });

  it('numbers new pages after the existing ones', () => {
    expect(newPagePath('Hello, World!', ['pages/01-a.md'])).toBe(
      'pages/02-hello-world.md'
    );
    expect(newPagePath('A', ['pages/01-a.md', 'pages/02-a.md'])).toBe(
      'pages/03-a.md'
    );
  });
});

describe('quick fixes', () => {
  it('declares a missing capability and drops an unknown option', () => {
    const manifest = parseManifest(MANIFEST.replace('  - terminal\n', ''));
    const page = parsePage(PAGE, { path: 'pages/01.md' });
    const messages = lintWorkshop({ manifest, pages: [page] });
    const files = {
      manifest: MANIFEST.replace('  - terminal\n', ''),
      pages: { 'pages/01.md': PAGE }
    };

    const missing = messages.find(
      item => item.rule === 'undeclared-capability'
    );
    const unknown = messages.find(item => item.rule === 'unknown-option');

    expect(missing?.fix).toEqual({
      kind: 'add-capability',
      capability: 'terminal'
    });
    expect(applyFix(missing!, files)?.source).toContain('  - terminal');

    const edit = applyFix(unknown!, files);

    expect(edit?.path).toBe('pages/01.md');
    expect(edit?.source).not.toContain(':bogus:');
    expect(edit?.source).toContain(':id: first\necho one');
  });
});

describe('draftFromRecording', () => {
  it('turns events into pages of actions split at markers', () => {
    const recording = parseRecording({
      version: 1,
      started: '2026-09-05T00:00:00Z',
      events: [
        {
          kind: 'terminal',
          ts: '',
          session: 'workshop',
          command: 'mkdir demo'
        },
        {
          kind: 'terminal',
          ts: '',
          session: 'git',
          command: 'git init',
          uncertain: true
        },
        {
          kind: 'file-saved',
          ts: '',
          path: 'demo/README.md',
          content: '# Demo\n',
          previous: null
        },
        { kind: 'file-opened', ts: '', path: 'demo/README.md' },
        { kind: 'page-break', ts: '', title: 'Edit the file' },
        {
          kind: 'file-saved',
          ts: '',
          path: 'demo/README.md',
          content: '# Demo\n\nHello\n',
          previous: '# Demo\n'
        },
        {
          kind: 'file-saved',
          ts: '',
          path: 'demo/README.md',
          content: '# Demo!\n\nHello\n',
          previous: '# Demo\n\nHello\n'
        },
        {
          kind: 'cell-executed',
          ts: '',
          path: 'demo/a.ipynb',
          source: '1 + 1'
        },
        { kind: 'file-opened', ts: '', path: 'demo/b.ipynb' }
      ]
    });
    const draft = draftFromRecording(recording, {
      existingPages: ['pages/01-welcome.md']
    });

    expect(draft.pages.map(page => page.path)).toEqual([
      'pages/02-getting-started.md',
      'pages/03-edit-the-file.md'
    ]);
    expect(draft.capabilities).toEqual([
      'terminal',
      'write-files:workspace',
      'kernel-exec'
    ]);

    const first = draft.pages[0].source;

    expect(first).toContain('```{execute}\nmkdir demo\n```');
    expect(first).toContain(':session: git\ngit init');
    expect(first).toContain('completion or history');
    expect(first).toContain(':path: demo/README.md\n:open: true\n# Demo\n```');
    expect(first).not.toContain('{file-open}');

    const second = draft.pages[1].source;

    // Adding lines to an existing file is written as a whole file, while a
    // one-line change becomes an editor-replace.
    expect(second).toContain(
      '{file-write}\n:path: demo/README.md\n:open: true\n# Demo\n\nHello\n```'
    );
    expect(second).toContain(
      '{editor-replace}\n:path: demo/README.md\n:match: # Demo\n# Demo!\n```'
    );
    expect(second).toContain(
      '{cell-insert}\n:path: demo/a.ipynb\n:run: true\n1 + 1\n```'
    );
    expect(second).toContain('{notebook-open}\n:path: demo/b.ipynb\n```');

    for (const page of draft.pages) {
      const parsed = parsePage(page.source, { path: page.path });

      expect(parsed.warnings).toEqual([]);
    }

    const manifest = draftManifest('demo', 'Demo', draft);

    expect(parseManifest(manifest).capabilities).toEqual([
      'terminal',
      'write-files:workspace',
      'kernel-exec'
    ]);
    expect(parseManifest(manifest).pages).toEqual(
      draft.pages.map(page => page.path)
    );
  });

  it('rejects malformed recordings', () => {
    expect(() => parseRecording({ version: 2 })).toThrow('version 1');
    expect(() => parseRecording({ version: 1, events: [1] })).toThrow('kind');
  });
});
