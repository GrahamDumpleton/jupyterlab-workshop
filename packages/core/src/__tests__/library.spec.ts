import * as fs from 'fs';
import * as path from 'path';

import Ajv from 'ajv';

import {
  assignCollectionDirectory,
  chooseCollectionDirectory,
  collectionHash,
  emptyLibrary,
  isOwnLibraryPath,
  joinLibraryPath,
  libraryFilePath,
  mergeSources,
  normalizeWorkshopsDirectory,
  parseLibrary,
  projectEntry,
  projectWorkshops,
  recordedDirectory,
  serializeLibrary,
  slugifyCollectionId
} from '../library';
import { LIBRARY_SCHEMA } from '../schema';

interface IVectors {
  slugs: [string, string | null][];
  hashes: [string, string][];
}

const VECTORS: IVectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'library-vectors.json'), 'utf8')
);

describe('library schema', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(LIBRARY_SCHEMA);

  it('accepts a full registry and a bare one', () => {
    expect(validate({ version: 1 })).toBe(true);
    expect(
      validate({
        version: 1,
        collections: ['https://example.org/collection.json'],
        catalogs: [],
        directories: {
          'https://example.org/collection.json': 'example.org-course'
        },
        projects: [
          { name: 'wsgi-workshops' },
          {
            name: 'jupyterlab-workshop',
            target: '/src/x',
            workshops: 'examples'
          }
        ]
      })
    ).toBe(true);
  });

  it('rejects unknown keys, bad directories and bad project names', () => {
    expect(validate({ version: 2 })).toBe(false);
    expect(validate({ version: 1, colour: 'red' })).toBe(false);
    expect(validate({ version: 1, directories: { a: 'Upper/Case' } })).toBe(
      false
    );
    expect(validate({ version: 1, projects: [{ name: '../up' }] })).toBe(false);
  });
});

describe('parseLibrary', () => {
  it('keeps what is present and leaves out what is not', () => {
    expect(parseLibrary({ version: 1 })).toEqual({ version: 1 });
    expect(
      parseLibrary({
        version: 1,
        collections: [],
        projects: [{ name: 'p', workshops: 'examples' }]
      })
    ).toEqual({
      version: 1,
      collections: [],
      projects: [{ name: 'p', workshops: 'examples' }]
    });
  });

  it('refuses what the schema refuses', () => {
    expect(() => parseLibrary([])).toThrow('must be an object');
    expect(() => parseLibrary({ version: 2 })).toThrow('Unsupported');
    expect(() => parseLibrary({ version: 1, colour: 'red' })).toThrow(
      'unknown keys colour'
    );
    expect(() =>
      parseLibrary({ version: 1, projects: [{ name: 'p', path: 'x' }] })
    ).toThrow('unknown keys path');
    expect(() => parseLibrary({ version: 1, collections: [''] })).toThrow(
      'list of locations'
    );
    expect(() =>
      parseLibrary({ version: 1, directories: { a: '../x' } })
    ).toThrow('lower case name');
    expect(() =>
      parseLibrary({ version: 1, projects: [{ name: '.hidden' }] })
    ).toThrow('valid "name"');
    expect(() =>
      parseLibrary({ version: 1, projects: [{ name: 'p', target: '' }] })
    ).toThrow('invalid "target"');
  });
});

describe('serializeLibrary', () => {
  it('writes the keys in a fixed order with a final newline', () => {
    const text = serializeLibrary({
      projects: [{ name: 'p' }],
      collections: ['c'],
      version: 1
    });

    expect(text.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual([
      'version',
      'collections',
      'projects'
    ]);
    expect(parseLibrary(JSON.parse(serializeLibrary(emptyLibrary())))).toEqual(
      emptyLibrary()
    );
  });
});

describe('collection directories', () => {
  it.each(VECTORS.slugs)('slugs %s as the command line does', (id, slug) => {
    expect(slugifyCollectionId(id)).toBe(slug);
  });

  it.each(VECTORS.hashes)(
    'hashes %s as the command line does',
    (location, hash) => {
      expect(collectionHash(location)).toBe(hash);
    }
  );

  it('falls back to the hash and suffixes a clash', () => {
    const location = 'https://example.org/course/collection.json';

    expect(chooseCollectionDirectory(location, undefined, [])).toBe('858442f');
    expect(chooseCollectionDirectory(location, 'CON', [])).toBe('858442f');
    expect(chooseCollectionDirectory(location, 'example.org/c', [])).toBe(
      'example.org-c'
    );
    expect(
      chooseCollectionDirectory(location, 'example.org/c', ['example.org-c'])
    ).toBe('example.org-c-858442f');
  });

  it('records a directory once and finds it by any spelling of the location', () => {
    const first = assignCollectionDirectory(
      emptyLibrary(),
      'https://Example.org/c.json',
      'example.org/c'
    );

    expect(first.directory).toBe('example.org-c');
    expect(first.library.directories).toEqual({
      'https://Example.org/c.json': 'example.org-c'
    });

    // A later install keeps the directory even if the id changed.
    const again = assignCollectionDirectory(
      first.library,
      'https://example.org/c.json/',
      'another/id'
    );

    expect(again.directory).toBe('example.org-c');
    expect(again.library).toBe(first.library);
    expect(recordedDirectory(first.library, 'elsewhere.json')).toBeUndefined();

    // Another collection with the same id gets the suffix.
    const other = assignCollectionDirectory(
      first.library,
      'https://other.org/c.json',
      'example.org/c'
    );

    expect(other.directory).toMatch(/^example\.org-c-[0-9a-f]{7}$/);
  });
});

describe('paths', () => {
  it('treats every spelling of the root alike', () => {
    for (const root of ['', '.', './', ' ./ ', '/']) {
      expect(normalizeWorkshopsDirectory(root)).toBe('');
    }

    expect(normalizeWorkshopsDirectory('./workshops/')).toBe('workshops');
    expect(joinLibraryPath('', 'personal', 'x')).toBe('personal/x');
    expect(joinLibraryPath('.', 'installed/', '/c')).toBe('installed/c');
    expect(libraryFilePath('.')).toBe('library.json');
    expect(libraryFilePath('workshops')).toBe('workshops/library.json');
  });
});

describe('mergeSources', () => {
  it('labels the configured list, adds the session and drops repeats', () => {
    expect(
      mergeSources(['a.json', 'https://H/b.json'], 'defaults', [
        'https://h/b.json/',
        'c.json'
      ])
    ).toEqual([
      { url: 'a.json', origin: 'defaults' },
      { url: 'https://H/b.json', origin: 'defaults' },
      { url: 'c.json', origin: 'session' }
    ]);
    expect(mergeSources(['a.json', ''], 'user', [])).toEqual([
      { url: 'a.json', origin: 'user' }
    ]);
  });
});

describe('projects', () => {
  it('defaults the workshops directory and finds an entry by name', () => {
    const library = parseLibrary({
      version: 1,
      projects: [{ name: 'repo', workshops: 'examples' }]
    });

    expect(projectWorkshops(projectEntry(library, 'repo'))).toBe('examples');
    expect(projectEntry(library, 'other')).toEqual({ name: 'other' });
    expect(projectWorkshops({ name: 'other' })).toBe('workshops');
  });
});

describe('isOwnLibraryPath', () => {
  it('takes personal and project workshops and nothing else', () => {
    expect(isOwnLibraryPath('workshops', 'workshops/personal/mine')).toBe(true);
    expect(
      isOwnLibraryPath('workshops', 'workshops/projects/repo/workshops/x')
    ).toBe(true);
    expect(isOwnLibraryPath('.', 'personal/mine')).toBe(true);
    expect(isOwnLibraryPath('', 'projects/repo/workshops/x')).toBe(true);

    expect(isOwnLibraryPath('workshops', 'workshops/personal')).toBe(false);
    expect(isOwnLibraryPath('workshops', 'workshops/installed/c/alpha')).toBe(
      false
    );
    expect(isOwnLibraryPath('workshops', 'workshops/alpha')).toBe(false);
    expect(isOwnLibraryPath('workshops', 'elsewhere/personal/x')).toBe(false);
    expect(isOwnLibraryPath('workshops', 'workshops/personalised/x')).toBe(
      false
    );
    expect(
      isOwnLibraryPath('workshops', 'workshops/personal/../installed/x')
    ).toBe(false);
  });
});
