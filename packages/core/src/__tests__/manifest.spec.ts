import { WorkshopFormatError } from '../errors';
import { parseManifest } from '../format/manifest';

const VALID = `
apiVersion: jupyterlab-workshop/v1alpha1
name: git-basics
title: Git from the command line
version: 1.2.0
tags: [git, cli]
capabilities:
  - terminal
  - write-files: [workspace]
  - network: [github.com, pypi.org]
requires:
  tools:
    - { name: git, version: ">=2.30", hint: { macos: "brew install git" } }
    - { name: python, optional: true }
  shell: bash
environment:
  requirements: requirements.txt
  kernel: workshop-git
layout: default
layouts:
  default:
    left: instructions
    main:
      - { area: top, widgets: [editor] }
      - { area: bottom, widgets: ["terminal:workshop"], size: 0.35 }
gating: soft
tracks:
  - { id: pip, label: pip }
  - { id: conda }
defaults:
  actions:
    delay: 1s
pages:
  - pages/01-init.md
variables:
  - { name: repo_dir, type: path, default: demo }
  - { name: token, type: secret, required: true }
  - { name: pkg, type: select, options: [pip, conda] }
`;

describe('parseManifest', () => {
  it('parses the terminal environment', () => {
    expect(parseManifest(VALID).env).toEqual({});
    expect(
      parseManifest(`${VALID}\nenv:\n  PAGER: less\n  RETRIES: 3\n`).env
    ).toEqual({ PAGER: 'less', RETRIES: '3' });
    expect(() => parseManifest(`${VALID}\nenv:\n  bad-name: x\n`)).toThrow(
      WorkshopFormatError
    );
  });

  it('parses the finish message', () => {
    expect(parseManifest(VALID).finish).toBeUndefined();
    expect(
      parseManifest(`${VALID}\nfinish: |\n  Well done. Try the *next* one.\n`)
        .finish
    ).toBe('Well done. Try the *next* one.\n');
  });

  it('parses the environment terminals flag', () => {
    expect(parseManifest(VALID).environment?.terminals).toBe(true);
    expect(
      parseManifest(
        VALID.replace(
          '  kernel: workshop-git\n',
          '  kernel: workshop-git\n  terminals: false\n'
        )
      ).environment?.terminals
    ).toBe(false);
    expect(() =>
      parseManifest(
        VALID.replace('  kernel: workshop-git\n', '  terminals: no\n')
      )
    ).toThrow(WorkshopFormatError);
  });

  it('parses the links', () => {
    expect(parseManifest(VALID).homepage).toBeUndefined();
    expect(parseManifest(VALID).issues).toBeUndefined();

    const manifest = parseManifest(
      `${VALID}\nhomepage: https://example.org/w\nissues: https://example.org/w/issues\n`
    );

    expect(manifest.homepage).toBe('https://example.org/w');
    expect(manifest.issues).toBe('https://example.org/w/issues');
    expect(() => parseManifest(`${VALID}\nhomepage: [a]\n`)).toThrow(
      WorkshopFormatError
    );
  });

  it('parses a valid manifest', () => {
    const manifest = parseManifest(VALID);

    expect(manifest.name).toBe('git-basics');
    expect(manifest.title).toBe('Git from the command line');
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.tags).toEqual(['git', 'cli']);
    expect(manifest.authors).toEqual([]);
    expect(manifest.pages).toEqual(['pages/01-init.md']);
    expect(manifest.capabilities).toEqual([
      'terminal',
      'write-files:workspace',
      'network:github.com',
      'network:pypi.org'
    ]);
    expect(manifest.requires.shell).toBe('bash');
    expect(manifest.requires.tools).toEqual([
      {
        name: 'git',
        version: '>=2.30',
        optional: false,
        hint: { macos: 'brew install git' }
      },
      { name: 'python', version: undefined, optional: true, hint: {} }
    ]);
    expect(manifest.environment).toEqual({
      requirements: 'requirements.txt',
      kernel: 'workshop-git',
      terminals: true
    });
    expect(manifest.layout).toBe('default');
    expect(manifest.layouts.default).toEqual({
      left: { widget: 'instructions' },
      right: undefined,
      main: [
        { area: 'top', widgets: ['editor'], size: undefined },
        { area: 'bottom', widgets: ['terminal:workshop'], size: 0.35 }
      ]
    });
    expect(manifest.gating).toBe('soft');
    expect(manifest.tracks).toEqual([
      { id: 'pip', label: 'pip' },
      { id: 'conda', label: 'conda' }
    ]);
    expect(manifest.defaults).toEqual({ delay: '1s' });
    expect(manifest.variables).toEqual([
      {
        name: 'repo_dir',
        type: 'path',
        description: undefined,
        default: 'demo',
        required: false,
        readonly: false,
        secret: false,
        options: []
      },
      {
        name: 'token',
        type: 'secret',
        description: undefined,
        default: undefined,
        required: true,
        readonly: false,
        secret: true,
        options: []
      },
      {
        name: 'pkg',
        type: 'select',
        description: undefined,
        default: undefined,
        required: false,
        readonly: false,
        secret: false,
        options: ['pip', 'conda']
      }
    ]);
  });

  it('fills defaults for a minimal manifest', () => {
    const manifest = parseManifest(
      'apiVersion: jupyterlab-workshop/v1alpha1\nname: x\ntitle: X\npages: [a.md]\n'
    );

    expect(manifest.gating).toBe('off');
    expect(manifest.layouts).toEqual({});
    expect(manifest.requires).toEqual({ tools: [] });
    expect(manifest.environment).toBeUndefined();
  });

  it('rejects missing or invalid fields', () => {
    expect(() => parseManifest('name: x')).toThrow(WorkshopFormatError);
    expect(() => parseManifest(VALID.replace('v1alpha1', 'v9'))).toThrow(
      /Unsupported apiVersion/
    );
    expect(() =>
      parseManifest(VALID.replace('git-basics', 'Git Basics'))
    ).toThrow(/Invalid name/);
    expect(() =>
      parseManifest(VALID.replace('  - pages/01-init.md\n', ''))
    ).toThrow(/pages/);
    expect(() =>
      parseManifest(VALID.replace('gating: soft', 'gating: maybe'))
    ).toThrow(/gating/);
    expect(() =>
      parseManifest(VALID.replace('type: path', 'type: colour'))
    ).toThrow(/unknown type/);
    expect(() =>
      parseManifest(VALID.replace('area: top', 'area: middle'))
    ).toThrow(/Layout/);
    expect(() =>
      parseManifest(VALID.replace('size: 0.35', 'size: 1.5'))
    ).toThrow(/between 0 and 1/);
  });

  it('parses layout sides given as words or mappings', () => {
    const manifest = parseManifest(
      VALID.replace(
        '    left: instructions\n',
        '    left: collapsed\n    right: { widget: instructions, size: 0.2 }\n'
      )
    );

    expect(manifest.layouts.default.left).toEqual({ collapsed: true });
    expect(manifest.layouts.default.right).toEqual({
      widget: 'instructions',
      size: 0.2
    });
    expect(
      parseManifest(VALID.replace('left: instructions', 'left: filebrowser'))
        .layouts.default.left
    ).toEqual({ widget: 'filebrowser' });
  });

  it('rejects malformed layout sides', () => {
    expect(() =>
      parseManifest(VALID.replace('left: instructions', 'left: [a, b]'))
    ).toThrow(/"left" must be/);
    expect(() =>
      parseManifest(VALID.replace('left: instructions', 'left: { panel: x }'))
    ).toThrow(/unknown field "panel"/);
    expect(() =>
      parseManifest(
        VALID.replace('left: instructions', 'left: { collapsed: yes }')
      )
    ).toThrow(/"collapsed" must be/);
    expect(() =>
      parseManifest(VALID.replace('left: instructions', 'left: { size: 0 }'))
    ).toThrow(/between 0 and 1/);
  });
});
