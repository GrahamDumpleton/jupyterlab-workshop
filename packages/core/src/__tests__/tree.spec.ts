import Ajv from 'ajv';

import { TREE_SCHEMA } from '../schema';
import {
  cleanBase64,
  isRestorablePath,
  parseWorkshopTree,
  TREE_FILE
} from '../tree';

function tree(...entries: Record<string, unknown>[]): Record<string, unknown> {
  return {
    version: 1,
    files: [{ path: 'workshop.yaml', name: 'workshop.yaml' }, ...entries]
  };
}

const ESCAPING: string[] = [
  '/etc/passwd',
  '../outside.md',
  'pages/../../outside.md',
  'pages/./01.md',
  'pages//01.md',
  'pages\\01.md',
  'C:/temp/x.md',
  '_workshop/source.json',
  '.git/config',
  'files/.git/hooks/post-checkout',
  TREE_FILE
];

describe('parseWorkshopTree', () => {
  it('reads entries of each kind', () => {
    expect(
      parseWorkshopTree(
        tree(
          { path: 'pages/01.md', name: 'pages--01.md' },
          { path: 'files/logo.png', name: 'logo.base64', encoding: 'base64' },
          { path: 'files/__init__.py', empty: true }
        )
      ).files
    ).toEqual([
      { path: 'workshop.yaml', name: 'workshop.yaml' },
      { path: 'pages/01.md', name: 'pages--01.md' },
      { path: 'files/logo.png', name: 'logo.base64', encoding: 'base64' },
      { path: 'files/__init__.py', empty: true }
    ]);
  });

  it.each(ESCAPING)('refuses the path %s', path => {
    expect(isRestorablePath(path)).toBe(false);
    expect(() => parseWorkshopTree(tree({ path, name: 'x.md' }))).toThrow(
      'not a file inside the workshop'
    );
  });

  it('accepts paths that only look like reserved ones', () => {
    expect(isRestorablePath('pages/01.md')).toBe(true);
    expect(isRestorablePath('files/.gitignore')).toBe(true);
    expect(isRestorablePath('_workshop.md')).toBe(true);
    expect(isRestorablePath('docs/_workshop/x.md')).toBe(true);
  });

  it.each([
    [[], 'must be an object'],
    [{ version: 2, files: [] }, 'Unsupported'],
    [{ version: 1 }, '"files" list'],
    [tree({ path: 'a.md', name: 'a.md', mode: 1 }), 'unknown field "mode"'],
    [tree({ path: 'a.md' }), 'gist file name'],
    [tree({ path: 'a.md', name: 'pages/a.md' }), 'gist file name'],
    [tree({ path: 'a.md', name: TREE_FILE }), 'gist file name'],
    [tree({ path: 'a.md', name: 'a', encoding: 'gzip' }), 'encoding'],
    [tree({ path: 'a.md', empty: false }), 'can only be true'],
    [tree({ path: 'a.md', empty: true, name: 'a' }), 'names no gist file'],
    [
      tree({ path: 'a.md', name: 'a' }, { path: 'A.md', name: 'b' }),
      'the same file'
    ],
    [
      tree({ path: 'a.md', name: 'a' }, { path: 'b.md', name: 'A' }),
      'reads A for both'
    ],
    [
      tree({ path: 'a', name: 'a' }, { path: 'A/b.md', name: 'b' }),
      'as a file and as the directory'
    ],
    [{ version: 1, files: [{ path: 'a.md', name: 'a' }] }, 'workshop.yaml']
  ])('refuses a malformed tree (%#)', (data, message) => {
    expect(() => parseWorkshopTree(data)).toThrow(message);
  });
});

describe('cleanBase64', () => {
  it('drops line breaks and refuses what is not base64', () => {
    expect(cleanBase64('iVBO\nRw0K\n')).toBe('iVBORw0K');

    for (const bad of ['abc', 'ab$=', 'a===']) {
      expect(() => cleanBase64(bad)).toThrow('not valid base64');
    }
  });
});

describe('tree schema', () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(
    TREE_SCHEMA
  );

  it('accepts what the parser accepts', () => {
    const data = tree(
      { path: 'pages/01.md', name: 'pages--01.md' },
      { path: 'files/logo.png', name: 'logo.base64', encoding: 'base64' },
      { path: 'files/__init__.py', empty: true },
      { path: 'files/.gitignore', name: 'files--.gitignore' }
    );

    expect(validate(data)).toBe(true);
  });

  it.each(ESCAPING)('refuses the path %s', path => {
    expect(validate(tree({ path, name: 'x.md' }))).toBe(false);
  });

  it('refuses a bad name, encoding or empty entry', () => {
    expect(validate(tree({ path: 'a.md', name: 'p/a.md' }))).toBe(false);
    expect(validate(tree({ path: 'a.md', name: TREE_FILE }))).toBe(false);
    expect(validate(tree({ path: 'a.md', name: 'a', encoding: 'gzip' }))).toBe(
      false
    );
    expect(validate(tree({ path: 'a.md', empty: true, name: 'a' }))).toBe(
      false
    );
  });
});
