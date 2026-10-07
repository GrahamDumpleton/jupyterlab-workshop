import * as fs from 'fs';
import * as path from 'path';

import Ajv from 'ajv';

import {
  assignCollectionDirectory,
  chooseCollectionDirectory,
  catalogCollections,
  collectionHash,
  collectionTitle,
  collectionWorkshops,
  downloadKey,
  emptyLibrary,
  isOwnLibraryPath,
  isPersonalLibraryPath,
  joinLibraryPath,
  libraryFilePath,
  mayReplaceDownload,
  mergeSources,
  normalizeWorkshopsDirectory,
  parseLibrary,
  projectEntry,
  projectPath,
  projectWorkshops,
  recordedDirectory,
  serializeLibrary,
  slugifyCollectionId,
  standaloneDirectory
} from '../library';
import { LIBRARY_SCHEMA } from '../schema';

interface IVectors {
  slugs: [string, string | null][];
  hashes: [string, string][];
  ownPaths: [string, string, boolean][];
  downloadKeys: [string, string, string, string][];
  standalone: [string, string, string, string, string][];
  collectionDirectories: [string, string | null, string][];
  projectPaths: [string, string, string | null][];
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

  it.each(VECTORS.collectionDirectories)(
    'names the directory of %s with id %s as the command line does',
    (location, id, directory) => {
      expect(chooseCollectionDirectory(location, id ?? undefined)).toBe(
        directory
      );
    }
  );

  it('records a directory once and finds it by any spelling of the location', () => {
    const first = assignCollectionDirectory(
      emptyLibrary(),
      'https://Example.org/c.json',
      'example.org/c'
    );

    expect(first.directory).toMatch(/^example\.org-c-[0-9a-f]{7}$/);
    expect(first.library.directories).toEqual({
      'https://Example.org/c.json': first.directory
    });

    // A later install keeps the directory even if the id changed.
    const again = assignCollectionDirectory(
      first.library,
      'https://example.org/c.json/',
      'another/id'
    );

    expect(again.directory).toBe(first.directory);
    expect(again.library).toBe(first.library);
    expect(recordedDirectory(first.library, 'elsewhere.json')).toBeUndefined();

    // Another collection with the same id gets a directory of its own.
    const other = assignCollectionDirectory(
      first.library,
      'https://other.org/c.json',
      'example.org/c'
    );

    expect(other.directory).toMatch(/^example\.org-c-[0-9a-f]{7}$/);
    expect(other.directory).not.toBe(first.directory);
  });
});

describe('downloads', () => {
  it.each(VECTORS.downloadKeys)(
    'keys a %s download of %s in %s as the command line does',
    (kind, url, subdir, key) => {
      expect(downloadKey({ kind, url, subdir })).toBe(key);
    }
  );

  it.each(VECTORS.standalone)(
    'names %s from a %s download of %s in %s as the command line does',
    (name, kind, url, subdir, directory) => {
      expect(standaloneDirectory(name, { kind, url, subdir })).toBe(directory);
    }
  );

  it('replaces only a download of the same workshop', () => {
    const source = { kind: 'git', url: 'https://github.com/o/r', subdir: 'w' };
    const record = {
      source: {
        kind: 'git',
        url: 'https://GitHub.com/o/r.git',
        ref: 'v1',
        subdir: 'w'
      }
    };

    // The same source at another revision is the same workshop.
    expect(mayReplaceDownload(record, source)).toBe(true);
    expect(mayReplaceDownload(record, { ...source, subdir: 'x' })).toBe(false);

    // A collection's update may come from another URL.
    const installed = {
      ...record,
      collection: 'https://example.org/collection.json'
    };

    expect(
      mayReplaceDownload(
        installed,
        { kind: 'archive', url: 'https://example.org/w-2.zip' },
        'https://EXAMPLE.org/collection.json/'
      )
    ).toBe(true);
    expect(
      mayReplaceDownload(installed, {
        kind: 'archive',
        url: 'https://example.org/w-2.zip'
      })
    ).toBe(false);

    // A local workshop, or no record at all, is never replaced.
    expect(
      mayReplaceDownload({ source: { kind: 'local', url: '.' } }, source)
    ).toBe(false);
    expect(mayReplaceDownload(null, source)).toBe(false);
    expect(mayReplaceDownload('nonsense', source)).toBe(false);
  });
});

describe('projects', () => {
  it.each(VECTORS.projectPaths)(
    'resolves %s against %s inside a project as the command line does',
    (base, target, resolved) => {
      expect(projectPath(base, target)).toBe(resolved);
    }
  );

  it('reads a project index for what is inside the project', () => {
    const catalog = {
      collections: [
        { url: 'collections/a/collection.json', title: 'Part A' },
        { url: 'https://example.org/collection.json', title: 'Elsewhere' },
        { url: 'collections/b/collection.json' },
        { title: 'No URL' }
      ]
    };

    expect(catalogCollections(catalog, 'catalog.json')).toEqual([
      { path: 'collections/a/collection.json', title: 'Part A' },
      {
        path: 'collections/b/collection.json',
        title: 'collections/b/collection.json'
      }
    ]);
    expect(catalogCollections('nonsense', 'catalog.json')).toEqual([]);

    const source = (subdir?: string): unknown => ({
      versions: [{ source: { git: 'https://github.com/o/r', subdir } }]
    });
    const collection = {
      title: 'Part A',
      workshops: [
        source('workshops/one'),
        source('/workshops/two/'),
        source('workshops/one'),
        source(),
        source('../outside'),
        { versions: [{ source: { archive: 'https://x/w.zip' } }] },
        { versions: [] }
      ]
    };

    expect(collectionWorkshops(collection)).toEqual([
      'workshops/one',
      'workshops/two',
      ''
    ]);
    expect(collectionTitle(collection, 'fallback')).toBe('Part A');
    expect(collectionTitle({}, 'fallback')).toBe('fallback');
  });
});

describe('paths', () => {
  it('treats every spelling of the root alike', () => {
    for (const root of ['', '.', './', ' ./ ', '/']) {
      expect(normalizeWorkshopsDirectory(root)).toBe('');
    }

    expect(normalizeWorkshopsDirectory('./workshops/')).toBe('workshops');
    expect(joinLibraryPath('', 'personal', 'x')).toBe('personal/x');
    expect(joinLibraryPath('.', 'collections/', '/c')).toBe('collections/c');
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

describe('isPersonalLibraryPath', () => {
  it('takes personal workshops alone', () => {
    expect(isPersonalLibraryPath('workshops', 'workshops/personal/mine')).toBe(
      true
    );
    expect(isPersonalLibraryPath('.', 'personal/mine')).toBe(true);

    expect(isPersonalLibraryPath('workshops', 'workshops/personal')).toBe(
      false
    );
    expect(isPersonalLibraryPath('workshops', 'personal/mine')).toBe(false);
    expect(
      isPersonalLibraryPath('workshops', 'workshops/projects/repo/workshops/x')
    ).toBe(false);
    expect(
      isPersonalLibraryPath('workshops', 'workshops/personal/../collections/x')
    ).toBe(false);
  });
});

describe('isOwnLibraryPath', () => {
  it.each(VECTORS.ownPaths)(
    'agrees with the server for %s and %s',
    (directory, target, own) => {
      expect(isOwnLibraryPath(directory, target)).toBe(own);
    }
  );

  it('takes personal and project workshops and nothing else', () => {
    expect(isOwnLibraryPath('workshops', 'workshops/personal/mine')).toBe(true);
    expect(
      isOwnLibraryPath('workshops', 'workshops/projects/repo/workshops/x')
    ).toBe(true);
    expect(isOwnLibraryPath('.', 'personal/mine')).toBe(true);
    expect(isOwnLibraryPath('', 'projects/repo/workshops/x')).toBe(true);

    expect(isOwnLibraryPath('workshops', 'workshops/personal')).toBe(false);
    expect(isOwnLibraryPath('workshops', 'workshops/collections/c/alpha')).toBe(
      false
    );
    expect(
      isOwnLibraryPath('workshops', 'workshops/standalone/alpha-1234567')
    ).toBe(false);
    expect(isOwnLibraryPath('workshops', 'workshops/alpha')).toBe(false);
    expect(isOwnLibraryPath('workshops', 'elsewhere/personal/x')).toBe(false);
    expect(isOwnLibraryPath('workshops', 'workshops/personalised/x')).toBe(
      false
    );
    expect(
      isOwnLibraryPath('workshops', 'workshops/personal/../collections/x')
    ).toBe(false);
  });
});
