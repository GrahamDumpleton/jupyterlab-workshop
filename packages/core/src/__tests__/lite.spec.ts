import { parsePage } from '../format/page';
import {
  liteShellOutput,
  liteShellProblems,
  parseForgeUrl,
  rawBaseUrl,
  referencedFiles,
  usesSubprocess
} from '../lite';

describe('parseForgeUrl', () => {
  it('reads repository, tree and dotted URLs', () => {
    expect(parseForgeUrl('https://github.com/org/repo')).toEqual({
      host: 'github.com',
      owner: 'org',
      repo: 'repo',
      ref: '',
      subdir: ''
    });
    expect(
      parseForgeUrl('https://github.com/org/repo.git/tree/v1/workshops/git/')
    ).toEqual({
      host: 'github.com',
      owner: 'org',
      repo: 'repo',
      ref: 'v1',
      subdir: 'workshops/git'
    });
    expect(
      parseForgeUrl('https://codeberg.org/org/repo/src/branch/main/w', 'v2')
    ).toMatchObject({ ref: 'v2', subdir: 'w' });
    expect(
      parseForgeUrl('https://gitlab.com/org/repo/-/tree/main/w', '', 'other')
    ).toMatchObject({ ref: 'main', subdir: 'other' });
    expect(parseForgeUrl('https://example.com/archive.tar.gz')).toBeNull();
    expect(parseForgeUrl('not a url')).toBeNull();
  });
});

describe('rawBaseUrl', () => {
  it('goes through jsDelivr for GitHub and raw endpoints elsewhere', () => {
    const github = parseForgeUrl('https://github.com/org/repo/tree/v1/w');
    const plain = parseForgeUrl('https://github.com/org/repo');
    const gitlab = parseForgeUrl('https://gitlab.com/org/repo/-/tree/dev');
    const codeberg = parseForgeUrl('https://codeberg.org/org/repo');

    expect(rawBaseUrl(github!)).toBe(
      'https://cdn.jsdelivr.net/gh/org/repo@v1/w/'
    );
    expect(rawBaseUrl(plain!)).toBe('https://cdn.jsdelivr.net/gh/org/repo/');
    expect(rawBaseUrl(gitlab!)).toBe('https://gitlab.com/org/repo/-/raw/dev/');
    expect(rawBaseUrl(codeberg!)).toBe(
      'https://codeberg.org/org/repo/raw/branch/main/'
    );
  });
});

describe('referencedFiles', () => {
  it('lists shipped files the directives name', () => {
    const page = parsePage(
      [
        '```{file-write}',
        ':path: out.md',
        ':from: files/notes.md',
        '```',
        '```{verify}',
        ':script: verify/check.py',
        '```',
        '```{notebook-open}',
        ':path: notebooks/intro.ipynb',
        '```',
        '```{file-open}',
        ':path: ../outside.txt',
        '```',
        '```{file-write}',
        ':path: other.md',
        ':from: files/notes.md',
        '```'
      ].join('\n'),
      { path: 'pages/01.md', variables: {} }
    );

    expect(referencedFiles([page])).toEqual([
      'files/notes.md',
      'notebooks/intro.ipynb',
      'verify/check.py'
    ]);
  });
});

describe('liteShellProblems', () => {
  it('spots what cockle cannot run', () => {
    expect(liteShellProblems('ls -la scratch')).toEqual([]);
    expect(liteShellProblems('mkdir x && cd x')).toEqual([
      'chaining with && or ||'
    ]);
    expect(liteShellProblems('echo "$HOME" $(pwd) 2>&1')).toEqual([
      'command substitution',
      'variable expansion ($VAR)',
      'file descriptor redirection (2>&1)'
    ]);
  });

  it('spots Python that needs a process', () => {
    expect(usesSubprocess('import subprocess')).toBe(true);
    expect(usesSubprocess('print(os.getcwd())')).toBe(false);
  });
});

describe('liteShellOutput', () => {
  it('drops the download spinner and cursor codes', () => {
    // As captured from a headless shell whose first command had to
    // fetch coreutils: the spinner's hide cursor, dots and text, each
    // dot followed by a cursor left, then erase to end of line and show
    // cursor, before the command's own output.
    const spinner =
      "\x1b[?25l⠇ downloading wasm module 'coreutils'\x1b[36D" +
      '⠋\x1b[1D⠙\x1b[1D⠸\x1b[1D' +
      '\x1b[K\x1b[?25h';

    expect(liteShellOutput(`${spinner}42\n`)).toBe('42\n');
    expect(liteShellOutput('\x1b[0;31mError\x1b[1;0m\x1b[?25h')).toBe('Error');
    expect(liteShellOutput('plain')).toBe('plain');
  });
});
