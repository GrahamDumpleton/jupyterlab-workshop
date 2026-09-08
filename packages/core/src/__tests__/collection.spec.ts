import * as fs from 'fs';
import * as path from 'path';

import Ajv from 'ajv';

import {
  ICollectionEntry,
  collectionSourceKey,
  collectionTags,
  compareVersions,
  latestVersion,
  mergeCollectionEntry,
  normalizeLocation,
  parseCollectionIndex,
  parsePublisher,
  resolveLocation,
  searchCollection,
  supportsPlatform
} from '../collection';
import { COLLECTION_SCHEMA } from '../schema';

const INDEX = path.resolve(
  __dirname,
  '../../../../collections/examples/collection.json'
);

const SAMPLE = {
  version: 1,
  title: 'Sample',
  description: 'Two workshops.',
  publisher: { name: 'Example Org', url: 'https://example.org' },
  homepage: 'https://example.org/workshops',
  icon: 'icon.svg',
  tags: ['sample'],
  ordered: true,
  workshops: [
    {
      name: 'git-basics',
      title: 'Git from the command line',
      description: 'Learn git.',
      tags: ['git', 'cli'],
      platforms: ['linux', 'macos'],
      capabilities: ['terminal', 'write-files:workspace'],
      versions: [
        {
          version: '1.2.0',
          source: { git: 'https://github.com/x/y', ref: 'v1.2.0', subdir: 'w' },
          sha256: 'a'.repeat(64)
        }
      ]
    },
    {
      name: 'pandas-intro',
      title: 'Pandas',
      tags: ['python', 'data'],
      versions: [{ version: '0.1', source: { archive: 'https://h/p.tar.gz' } }]
    }
  ]
};

describe('parseCollectionIndex', () => {
  it('parses a valid index with its metadata', () => {
    const index = parseCollectionIndex(SAMPLE);

    expect(index.title).toBe('Sample');
    expect(index.description).toBe('Two workshops.');
    expect(index.publisher).toEqual({
      name: 'Example Org',
      url: 'https://example.org'
    });
    expect(index.homepage).toBe('https://example.org/workshops');
    expect(index.icon).toBe('icon.svg');
    expect(index.tags).toEqual(['sample']);
    expect(index.ordered).toBe(true);
    expect(index.workshops).toHaveLength(2);
    expect(index.workshops[0].capabilities).toEqual([
      'terminal',
      'write-files:workspace'
    ]);
    expect(index.workshops[1].platforms).toEqual([]);
    expect(latestVersion(index.workshops[0]).sha256).toBe('a'.repeat(64));
  });

  it('keeps the workshops in the listed order', () => {
    const index = parseCollectionIndex({
      version: 1,
      workshops: [...SAMPLE.workshops].reverse()
    });

    expect(index.workshops.map(entry => entry.name)).toEqual([
      'pandas-intro',
      'git-basics'
    ]);
  });

  it('leaves out absent metadata', () => {
    const index = parseCollectionIndex({ version: 1, workshops: [] });

    expect(index.title).toBeUndefined();
    expect(index.publisher).toBeUndefined();
    expect(index.icon).toBeUndefined();
    expect(index.tags).toEqual([]);
    expect(index.ordered).toBe(false);
  });

  it('accepts a publisher given as a bare name', () => {
    expect(parsePublisher('Example Org')).toEqual({ name: 'Example Org' });
    expect(parsePublisher({ name: 'X', url: 'https://x' })).toEqual({
      name: 'X',
      url: 'https://x'
    });
    expect(parsePublisher({ url: 'https://x' })).toBeUndefined();
    expect(parsePublisher('')).toBeUndefined();
  });

  it('rejects bad shapes', () => {
    expect(() => parseCollectionIndex(null)).toThrow('must be an object');
    expect(() => parseCollectionIndex({ version: 2, workshops: [] })).toThrow(
      'Unsupported collection version'
    );
    expect(() =>
      parseCollectionIndex({ version: 1, workshops: [{ name: 'Bad Name' }] })
    ).toThrow('invalid name');
    expect(() =>
      parseCollectionIndex({
        version: 1,
        workshops: [{ name: 'a', title: 'A', versions: [] }]
      })
    ).toThrow('at least one version');
    expect(() =>
      parseCollectionIndex({
        version: 1,
        workshops: [
          { name: 'a', title: 'A', versions: [{ version: '1', source: {} }] }
        ]
      })
    ).toThrow('neither "git" nor "archive"');
  });

  it('agrees with the JSON schema on the sample and the shipped index', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(COLLECTION_SCHEMA);

    expect(validate(SAMPLE)).toBe(true);

    const data: unknown = JSON.parse(fs.readFileSync(INDEX, 'utf8'));

    expect(validate(data)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(
      parseCollectionIndex(data).workshops.map(entry => entry.name)
    ).toEqual(['hello-jupyterlab', 'git-basics', 'workshop-authoring']);
  });
});

describe('searching and tags', () => {
  const entries = parseCollectionIndex(SAMPLE).workshops;

  it('matches words against name, title, description and tags', () => {
    expect(searchCollection(entries, 'GIT').map(e => e.name)).toEqual([
      'git-basics'
    ]);
    expect(searchCollection(entries, 'learn command').map(e => e.name)).toEqual(
      ['git-basics']
    );
    expect(searchCollection(entries, '', ['data']).map(e => e.name)).toEqual([
      'pandas-intro'
    ]);
    expect(searchCollection(entries, 'git', ['data'])).toEqual([]);
  });

  it('lists tags by frequency then name', () => {
    expect(collectionTags(entries)).toEqual(['cli', 'data', 'git', 'python']);
  });

  it('treats no platforms as every platform', () => {
    expect(supportsPlatform(entries[0], 'windows')).toBe(false);
    expect(supportsPlatform(entries[1], 'windows')).toBe(true);
  });
});

describe('source keys and merging', () => {
  it('forms the same keys as the server', () => {
    expect(
      collectionSourceKey({ git: 'https://g/x/y', ref: 'v1', subdir: 'w' })
    ).toBe('git:https://g/x/y@v1/w');
    expect(collectionSourceKey({ archive: 'https://h/p.tar.gz' })).toBe(
      'archive:https://h/p.tar.gz'
    );
  });

  it('orders versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('a', 'b')).toBeLessThan(0);
  });

  it('updates an entry in place with newest versions first', () => {
    const entries = parseCollectionIndex(SAMPLE).workshops;
    const update: ICollectionEntry = {
      ...entries[0],
      description: 'Updated',
      versions: [
        {
          version: '1.10.0',
          source: { archive: 'https://h/git-basics-1.10.0.tar.gz' }
        },
        entries[0].versions[0]
      ]
    };
    const merged = mergeCollectionEntry([entries[1], entries[0]], update);

    expect(merged.map(entry => entry.name)).toEqual([
      'pandas-intro',
      'git-basics'
    ]);
    expect(merged[1].description).toBe('Updated');
    expect(merged[1].versions.map(version => version.version)).toEqual([
      '1.10.0',
      '1.2.0'
    ]);
  });

  it('appends a new entry at the end', () => {
    const entries = parseCollectionIndex(SAMPLE).workshops;
    const added: ICollectionEntry = { ...entries[0], name: 'aaa-first' };

    expect(mergeCollectionEntry(entries, added).map(e => e.name)).toEqual([
      'git-basics',
      'pandas-intro',
      'aaa-first'
    ]);
  });
});

describe('locations', () => {
  it('resolves relative locations against a URL or a path', () => {
    expect(
      resolveLocation('https://h/site/catalog.json', 'python/collection.json')
    ).toBe('https://h/site/python/collection.json');
    expect(resolveLocation('https://h/site/catalog.json', '../icon.svg')).toBe(
      'https://h/icon.svg'
    );
    expect(resolveLocation('collections/catalog.json', 'x/icon.svg')).toBe(
      'collections/x/icon.svg'
    );
    expect(resolveLocation('collections/catalog.json', '../icon.svg')).toBe(
      'icon.svg'
    );
    expect(resolveLocation('catalog.json', 'icon.svg')).toBe('icon.svg');
  });

  it('leaves absolute URLs and data URIs alone', () => {
    expect(resolveLocation('https://h/c.json', 'https://x/i.svg')).toBe(
      'https://x/i.svg'
    );
    expect(resolveLocation('c.json', 'data:image/svg+xml,<svg/>')).toBe(
      'data:image/svg+xml,<svg/>'
    );
  });

  it('normalises locations for comparison', () => {
    expect(normalizeLocation('HTTPS://Example.org/A/collection.json/')).toBe(
      'https://example.org/A/collection.json'
    );
    expect(normalizeLocation(' collections/examples/collection.json ')).toBe(
      'collections/examples/collection.json'
    );
  });
});
