import { parsePage } from '../format/page';
import {
  allVariants,
  hasVariants,
  selectVariant,
  splitVariants
} from '../format/variants';

const BODY = [
  'python3 -m venv .venv && source .venv/bin/activate',
  ':windows:',
  'py -m venv .venv; .\\.venv\\Scripts\\Activate.ps1',
  ':jupyterlite:',
  ''
].join('\n');

describe('splitVariants', () => {
  it('splits the default from the platform and frontend variants', () => {
    const split = splitVariants(BODY);

    expect(split.defaultText).toBe(
      'python3 -m venv .venv && source .venv/bin/activate'
    );
    expect(split.variants).toEqual({
      windows: 'py -m venv .venv; .\\.venv\\Scripts\\Activate.ps1',
      jupyterlite: ''
    });
    expect(allVariants(split)).toHaveProperty('default');
  });

  it('has no default when the body starts with a marker', () => {
    const split = splitVariants(
      ':linux:\napt install git\n:macos:\nbrew install git'
    );

    expect(split.defaultText).toBeNull();
    expect(Object.keys(split.variants)).toEqual(['linux', 'macos']);
    expect(allVariants(split)).not.toHaveProperty('default');
  });

  it('ignores marker-like lines naming unknown platforms', () => {
    expect(hasVariants('echo :root:')).toBe(false);
    expect(hasVariants(':solaris:\nls')).toBe(false);
    expect(hasVariants(':lite:\nls')).toBe(false);
    expect(hasVariants('ls\n:windows:\ndir')).toBe(true);
    expect(hasVariants('ls\n:jupyterlab:\ndir')).toBe(true);
  });
});

describe('selectVariant', () => {
  const split = splitVariants(BODY);

  it('picks the platform variant when there is one', () => {
    expect(selectVariant(split, 'windows')).toEqual({
      body: 'py -m venv .venv; .\\.venv\\Scripts\\Activate.ps1',
      variant: 'windows'
    });
    expect(selectVariant(split, 'emscripten', 'jupyterlite')).toEqual({
      body: '',
      variant: 'jupyterlite'
    });
  });

  it('prefers the frontend variant to the platform variant', () => {
    const both = splitVariants('ls\n:windows:\ndir\n:jupyterlite:\nls -1');

    expect(selectVariant(both, 'windows', 'jupyterlite').variant).toBe(
      'jupyterlite'
    );
    expect(selectVariant(both, 'windows', 'jupyterlab').variant).toBe(
      'windows'
    );
    expect(selectVariant(both, 'linux', 'jupyterlab').variant).toBe('default');
  });

  it('falls back to the default otherwise', () => {
    expect(selectVariant(split, 'macos').variant).toBe('default');
    expect(selectVariant(split, undefined).body).toContain('python3');
    expect(selectVariant(splitVariants(':windows:\ndir'), 'linux')).toEqual({
      body: '',
      variant: 'default'
    });
  });
});

describe('parsePage with a platform', () => {
  const source = [
    '```{execute}',
    'ls {{ dir }}',
    ':windows:',
    'dir {{ dir }}',
    '```',
    '',
    '```{quiz}',
    'question: Which?',
    'options:',
    '  - { text: ":windows:", correct: true }',
    '```'
  ].join('\n');

  it('renders the matching variant and keeps the rest', () => {
    const page = parsePage(source, {
      path: 'p.md',
      variables: { dir: 'x' },
      platform: 'windows'
    });
    const node = page.nodes[0];

    expect(node.kind).toBe('directive');

    if (node.kind === 'directive') {
      expect(node.body).toBe('dir x');
      expect(node.variant).toBe('windows');
      expect(node.variants).toEqual({ default: 'ls x', windows: 'dir x' });
    }
  });

  it('renders the frontend variant when asked for one', () => {
    const page = parsePage(
      '```{execute}\nls\n:windows:\ndir\n:jupyterlite:\nls -1\n```',
      {
        path: 'p.md',
        variables: {},
        platform: 'windows',
        frontend: 'jupyterlite'
      }
    );
    const node = page.nodes[0];

    if (node.kind === 'directive') {
      expect(node.body).toBe('ls -1');
      expect(node.variant).toBe('jupyterlite');
    } else {
      throw new Error('expected a directive');
    }
  });

  it('uses the default without a platform and leaves YAML bodies alone', () => {
    const page = parsePage(source, { path: 'p.md', variables: { dir: 'x' } });
    const [execute, quiz] = page.nodes;

    if (execute.kind === 'directive' && quiz.kind === 'directive') {
      expect(execute.body).toBe('ls x');
      expect(execute.variant).toBe('default');
      expect(quiz.variants).toBeUndefined();
      expect(quiz.body).toContain(':windows:');
    } else {
      throw new Error('expected two directives');
    }
  });
});
