import {
  parseLaunchLink,
  parseSourceLink,
  parseWelcomeLink,
  stripLaunchParams
} from '../launch/link';

describe('parseSourceLink', () => {
  it('reads every collection and catalog in the order given', () => {
    expect(
      parseSourceLink(
        '?collection=collections/a/collection.json&catalog=catalog.json&collection=https://example.org/b/collection.json'
      )
    ).toEqual({
      collections: [
        'collections/a/collection.json',
        'https://example.org/b/collection.json'
      ],
      catalogs: ['catalog.json']
    });
  });

  it('trims, drops empties and repeats', () => {
    expect(
      parseSourceLink(
        '?collection=%20a.json%20&collection=&collection=a.json&collection=b.json'
      )
    ).toEqual({ collections: ['a.json', 'b.json'], catalogs: [] });
  });

  it('names nothing for a link without sources', () => {
    expect(parseSourceLink('')).toEqual({ collections: [], catalogs: [] });
    expect(parseSourceLink('?workshop=x')).toEqual({
      collections: [],
      catalogs: []
    });
  });
});

describe('parseLaunchLink', () => {
  it('returns null without a workshop', () => {
    expect(parseLaunchLink('?collection=a.json')).toBeNull();
    expect(parseLaunchLink('?workshop=%20')).toBeNull();
  });

  it('looks a bare name up in the collections in order', () => {
    expect(
      parseLaunchLink(
        '?workshop=lesson-three&collection=a.json&collection=b.json'
      )
    ).toMatchObject({
      path: undefined,
      collections: ['a.json', 'b.json'],
      url: 'lesson-three'
    });
  });

  it('keeps a directory a directory when no collection is named', () => {
    expect(parseLaunchLink('?workshop=workshops/git-basics')).toMatchObject({
      path: 'workshops/git-basics',
      collections: undefined,
      url: 'workshops/git-basics'
    });
  });

  it('reads a URL with its ref, subdir, hash and variables', () => {
    expect(
      parseLaunchLink(
        '?workshop=https://example.org/repo&ref=v1&subdir=ws&sha256=abc&var.name=Ada&var.=x&collection=a.json'
      )
    ).toEqual({
      path: undefined,
      collections: undefined,
      url: 'https://example.org/repo',
      ref: 'v1',
      subdir: 'ws',
      sha256: 'abc',
      variables: { name: 'Ada' },
      restart: undefined
    });
  });

  it('reads a bare restart as ask and restart=force as force', () => {
    expect(parseLaunchLink('?workshop=ws&restart')?.restart).toBe('ask');
    expect(parseLaunchLink('?restart&workshop=ws')?.restart).toBe('ask');
    expect(parseLaunchLink('?workshop=ws&restart=force')?.restart).toBe(
      'force'
    );
    expect(parseLaunchLink('?workshop=ws')?.restart).toBeUndefined();
  });
});

describe('parseWelcomeLink', () => {
  it('reads the welcome path or nothing', () => {
    expect(parseWelcomeLink('?welcome=hello.md')).toBe('hello.md');
    expect(parseWelcomeLink('?welcome=')).toBeUndefined();
    expect(parseWelcomeLink('')).toBeUndefined();
  });
});

describe('stripLaunchParams', () => {
  it('takes out the launch parameters and keeps every other value', () => {
    expect(
      stripLaunchParams(
        '?workshop=ws&collection=a.json&collection=b.json&var.x=1&tab=2&tab=3&catalog=c.json'
      )
    ).toBe('?tab=2&tab=3');
  });

  it('is empty when nothing else is there', () => {
    expect(stripLaunchParams('?workshop=ws&restart')).toBe('');
    expect(stripLaunchParams('')).toBe('');
  });
});
