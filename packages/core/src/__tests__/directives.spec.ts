import {
  parseDirectiveContent,
  parseDirectiveInfo
} from '../format/directives';

describe('parseDirectiveInfo', () => {
  it('recognises directive names in braces', () => {
    expect(parseDirectiveInfo('{execute}')).toEqual({
      name: 'execute',
      argument: ''
    });
    expect(parseDirectiveInfo(' {file-write} ')).toEqual({
      name: 'file-write',
      argument: ''
    });
    expect(parseDirectiveInfo('{when} track == "pip" ')).toEqual({
      name: 'when',
      argument: 'track == "pip"'
    });
  });

  it('rejects ordinary code fence info strings', () => {
    expect(parseDirectiveInfo('python')).toBeNull();
    expect(parseDirectiveInfo('{Execute}')).toBeNull();
  });
});

describe('parseDirectiveContent', () => {
  it('splits leading options from the body', () => {
    const content = ':session: git\n:cwd: demo\n:flag:\n\ngit status\n';

    expect(parseDirectiveContent(content)).toEqual({
      options: { session: 'git', cwd: 'demo', flag: '' },
      body: 'git status'
    });
  });

  it('treats a block without options as all body', () => {
    expect(parseDirectiveContent('echo one\necho two\n')).toEqual({
      options: {},
      body: 'echo one\necho two'
    });
  });

  it('stops parsing options at the first non-option line', () => {
    expect(
      parseDirectiveContent(':path: a.txt\nline: not an option\n:x: y\n')
    ).toEqual({
      options: { path: 'a.txt' },
      body: 'line: not an option\n:x: y'
    });
  });
});
