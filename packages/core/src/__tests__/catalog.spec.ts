import * as fs from 'fs';
import * as path from 'path';

import Ajv from 'ajv';

import { parseCatalog, resolveCatalog } from '../catalog';
import { CATALOG_SCHEMA } from '../schema';

const CATALOG = path.resolve(__dirname, '../../../../collections/catalog.json');

const SAMPLE = {
  version: 1,
  title: 'Workshops for learning JupyterLab',
  description: 'Collections that show what the extension can do.',
  publisher: 'Example Org',
  icon: 'logo.svg',
  collections: [
    {
      url: 'python/collection.json',
      title: 'Python basics',
      description: 'The language from the start.',
      publisher: { name: 'Example Org', url: 'https://example.org' },
      icon: 'python/icon.svg',
      tags: ['python', 'beginner']
    },
    { url: 'https://other.example/kubernetes/collection.json' }
  ]
};

describe('parseCatalog', () => {
  it('parses a catalog and its entries', () => {
    const catalog = parseCatalog(SAMPLE);

    expect(catalog.title).toBe('Workshops for learning JupyterLab');
    expect(catalog.publisher).toEqual({ name: 'Example Org' });
    expect(catalog.icon).toBe('logo.svg');
    expect(catalog.collections).toHaveLength(2);
    expect(catalog.collections[0].title).toBe('Python basics');
    expect(catalog.collections[0].tags).toEqual(['python', 'beginner']);
    expect(catalog.collections[1].title).toBeUndefined();
    expect(catalog.collections[1].tags).toEqual([]);
  });

  it('rejects bad shapes', () => {
    expect(() => parseCatalog([])).toThrow('must be an object');
    expect(() => parseCatalog({ version: 2, collections: [] })).toThrow(
      'Unsupported catalog version'
    );
    expect(() => parseCatalog({ version: 1 })).toThrow('"collections" list');
    expect(() =>
      parseCatalog({ version: 1, collections: [{ title: 'No URL' }] })
    ).toThrow('needs a "url"');
  });

  it('resolves relative collection URLs and icons', () => {
    const resolved = resolveCatalog(
      parseCatalog(SAMPLE),
      'https://example.org/workshops/catalog.json'
    );

    expect(resolved.icon).toBe('https://example.org/workshops/logo.svg');
    expect(resolved.collections.map(entry => entry.url)).toEqual([
      'https://example.org/workshops/python/collection.json',
      'https://other.example/kubernetes/collection.json'
    ]);
    expect(resolved.collections[0].icon).toBe(
      'https://example.org/workshops/python/icon.svg'
    );

    const local = resolveCatalog(
      parseCatalog(SAMPLE),
      'collections/catalog.json'
    );

    expect(local.collections[0].url).toBe('collections/python/collection.json');
  });

  it('agrees with the JSON schema on the sample and the shipped catalog', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(CATALOG_SCHEMA);

    expect(validate(SAMPLE)).toBe(true);

    const data: unknown = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

    expect(validate(data)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(parseCatalog(data).collections.map(entry => entry.url)).toEqual([
      'examples/collection.json'
    ]);
  });
});
