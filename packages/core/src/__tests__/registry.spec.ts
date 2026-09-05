import * as fs from 'fs';
import * as path from 'path';

import Ajv from 'ajv';

import {
  IRegistryEntry,
  compareVersions,
  latestVersion,
  mergeRegistryEntry,
  parseRegistryIndex,
  registrySourceKey,
  registryTags,
  searchRegistry,
  supportsPlatform
} from '../registry';
import { REGISTRY_SCHEMA } from '../schema';

const INDEX = path.resolve(__dirname, '../../../../registry/index.json');

const SAMPLE = {
  version: 1,
  title: 'Sample',
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

describe('parseRegistryIndex', () => {
  it('parses a valid index', () => {
    const index = parseRegistryIndex(SAMPLE);

    expect(index.title).toBe('Sample');
    expect(index.workshops).toHaveLength(2);
    expect(index.workshops[0].capabilities).toEqual([
      'terminal',
      'write-files:workspace'
    ]);
    expect(index.workshops[1].platforms).toEqual([]);
    expect(latestVersion(index.workshops[0]).sha256).toBe('a'.repeat(64));
  });

  it('rejects bad shapes', () => {
    expect(() => parseRegistryIndex(null)).toThrow('must be an object');
    expect(() => parseRegistryIndex({ version: 2, workshops: [] })).toThrow(
      'Unsupported registry version'
    );
    expect(() =>
      parseRegistryIndex({ version: 1, workshops: [{ name: 'Bad Name' }] })
    ).toThrow('invalid name');
    expect(() =>
      parseRegistryIndex({
        version: 1,
        workshops: [{ name: 'a', title: 'A', versions: [] }]
      })
    ).toThrow('at least one version');
    expect(() =>
      parseRegistryIndex({
        version: 1,
        workshops: [
          { name: 'a', title: 'A', versions: [{ version: '1', source: {} }] }
        ]
      })
    ).toThrow('neither "git" nor "archive"');
  });

  it('agrees with the JSON schema on the shipped index', () => {
    const data: unknown = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(REGISTRY_SCHEMA);

    expect(validate(data)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(parseRegistryIndex(data).workshops.map(entry => entry.name)).toEqual(
      ['git-basics', 'hello-jupyterlab']
    );
  });
});

describe('searching and tags', () => {
  const entries = parseRegistryIndex(SAMPLE).workshops;

  it('matches words against name, title, description and tags', () => {
    expect(searchRegistry(entries, 'GIT').map(e => e.name)).toEqual([
      'git-basics'
    ]);
    expect(searchRegistry(entries, 'learn command').map(e => e.name)).toEqual([
      'git-basics'
    ]);
    expect(searchRegistry(entries, '', ['data']).map(e => e.name)).toEqual([
      'pandas-intro'
    ]);
    expect(searchRegistry(entries, 'git', ['data'])).toEqual([]);
  });

  it('lists tags by frequency then name', () => {
    expect(registryTags(entries)).toEqual(['cli', 'data', 'git', 'python']);
  });

  it('treats no platforms as every platform', () => {
    expect(supportsPlatform(entries[0], 'windows')).toBe(false);
    expect(supportsPlatform(entries[1], 'windows')).toBe(true);
  });
});

describe('source keys and merging', () => {
  it('forms the same keys as the server', () => {
    expect(
      registrySourceKey({ git: 'https://g/x/y', ref: 'v1', subdir: 'w' })
    ).toBe('git:https://g/x/y@v1/w');
    expect(registrySourceKey({ archive: 'https://h/p.tar.gz' })).toBe(
      'archive:https://h/p.tar.gz'
    );
  });

  it('orders versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('a', 'b')).toBeLessThan(0);
  });

  it('merges entries by name with newest versions first', () => {
    const entries = parseRegistryIndex(SAMPLE).workshops;
    const update: IRegistryEntry = {
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
    const merged = mergeRegistryEntry(entries, update);

    expect(merged.map(entry => entry.name)).toEqual([
      'git-basics',
      'pandas-intro'
    ]);
    expect(merged[0].description).toBe('Updated');
    expect(merged[0].versions.map(version => version.version)).toEqual([
      '1.10.0',
      '1.2.0'
    ]);
  });
});
