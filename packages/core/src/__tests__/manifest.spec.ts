import { WorkshopFormatError } from '../errors';
import { parseManifest, resolveManifest } from '../format/manifest';

const VALID = `
apiVersion: jupyterlab-workshop/v1alpha1
name: git-basics
title: Git from the command line
version: 1.2.0
tags: [git, cli]
capabilities:
  - terminal
  - write-files
requires:
  tools:
    - { name: git, version: ">=2.30", platforms: [linux, macos] }
    - { name: python, optional: true, frontends: [jupyterlab] }
  shell: bash
environment:
  requirements: requirements.txt
  kernel: workshop-git
instructions: { side: left, width: 0.3 }
layout: default
layouts:
  default:
    main:
      areas:
        - { name: code, tabs: [] }
        - { size: 0.35, tabs: ["terminal:workshop"] }
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
      parseManifest(`${VALID}\nenv:\n  PAGER: less\n  RETRIES: "3"\n`).env
    ).toEqual({ PAGER: 'less', RETRIES: '3' });
    expect(() => parseManifest(`${VALID}\nenv:\n  bad-name: x\n`)).toThrow(
      WorkshopFormatError
    );
  });

  it('takes strings only where YAML would read something else', () => {
    // An unquoted 1.10 is the number 1.1 to YAML, an unquoted yes is
    // true, and neither is what the author wrote.
    expect(() => parseManifest(VALID.replace('1.2.0', '1.10'))).toThrow(
      /Field "version" must be a string; quote/
    );
    expect(() => parseManifest(`${VALID}\nenv:\n  RETRIES: 3\n`)).toThrow(
      /Field "env.RETRIES" must be a string; quote a number/
    );
    expect(() => parseManifest(`${VALID}\nenv:\n  DEBUG: true\n`)).toThrow(
      /Field "env.DEBUG" must be a string; quote a true/
    );
    expect(() =>
      parseManifest(VALID.replace('delay: 1s', 'delay: 1s\n    scroll: false'))
    ).toThrow(/Field "defaults.actions.scroll" must be a string/);
  });

  it('refuses the old tool hint and takes tool platforms and frontends', () => {
    expect(() =>
      parseManifest(
        VALID.replace(
          'optional: true, frontends: [jupyterlab]',
          'optional: true, hint: { macos: "brew install python" }'
        )
      )
    ).toThrow(/has a "hint".*"python" in missing_tools/);
    expect(() =>
      parseManifest(
        VALID.replace('platforms: [linux, macos]', 'platforms: [lite]')
      )
    ).toThrow(/Unknown platform "lite"/);
    expect(() =>
      parseManifest(
        VALID.replace('frontends: [jupyterlab]', 'frontends: [vscode]')
      )
    ).toThrow(/Unknown frontend "vscode"/);
  });

  it('parses variants and resolves them for a platform and frontend', () => {
    const manifest = parseManifest(
      `${VALID}\nenv:\n  PAGER: cat\n  A: base\nvariants:\n  windows:\n    env: { PAGER: more, B: windows }\n  jupyterlite:\n    env: { A: lite }\n    defaults: { actions: { timeout: 5m } }\n`
    );

    expect(manifest.variants).toEqual({
      windows: { env: { PAGER: 'more', B: 'windows' }, defaults: {} },
      jupyterlite: {
        env: { A: 'lite' },
        defaults: { timeout: '5m' }
      }
    });

    // Nothing applies on linux under JupyterLab, so the manifest is as is.
    expect(resolveManifest(manifest, 'linux', 'jupyterlab')).toBe(manifest);

    const windows = resolveManifest(manifest, 'windows', 'jupyterlab');

    expect(windows.env).toEqual({ PAGER: 'more', A: 'base', B: 'windows' });
    expect(windows.defaults).toEqual({ delay: '1s' });

    // The frontend entry is merged after the platform entry.
    const lite = resolveManifest(manifest, 'windows', 'jupyterlite');

    expect(lite.env).toEqual({ PAGER: 'more', A: 'lite', B: 'windows' });
    expect(lite.defaults).toEqual({ delay: '1s', timeout: '5m' });
    expect(lite.variants).toBe(manifest.variants);
  });

  it('rejects variants that name the unknown or override other settings', () => {
    expect(() =>
      parseManifest(`${VALID}\nvariants:\n  lite: { env: { A: b } }\n`)
    ).toThrow(/Unknown variant "lite"/);
    expect(() =>
      parseManifest(
        `${VALID}\nvariants:\n  windows: { requires: { shell: powershell } }\n`
      )
    ).toThrow(
      /"variants.windows.requires" is not a setting a variant can override/
    );
    expect(() =>
      parseManifest(`${VALID}\nvariants:\n  windows: { env: { A: 1 } }\n`)
    ).toThrow(/Field "variants.windows.env.A" must be a string/);
    expect(() =>
      parseManifest(`${VALID}\nvariants:\n  windows: [env]\n`)
    ).toThrow(/"variants.windows" must be a mapping/);
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

  it('refuses the workspace field, since the directory is always work', () => {
    expect(() => parseManifest(`${VALID}\nworkspace: work\n`)).toThrow(
      /"workspace" is no longer supported.*always "work"/
    );
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
    expect(manifest.capabilities).toEqual(['terminal', 'write-files']);
    expect(manifest.requires.shell).toBe('bash');
    expect(manifest.requires.tools).toEqual([
      {
        name: 'git',
        version: '>=2.30',
        optional: false,
        platforms: ['linux', 'macos'],
        frontends: []
      },
      {
        name: 'python',
        version: undefined,
        optional: true,
        platforms: [],
        frontends: ['jupyterlab']
      }
    ]);
    expect(manifest.environment).toEqual({
      requirements: 'requirements.txt',
      kernel: 'workshop-git',
      terminals: true
    });
    expect(manifest.instructions).toEqual({ side: 'left', width: 0.3 });
    expect(manifest.sidebar).toBeUndefined();
    expect(manifest.layout).toBe('default');
    expect(manifest.layouts.default).toEqual({
      main: {
        areas: [
          { name: 'code', tabs: [] },
          { size: 0.35, tabs: ['terminal:workshop'] }
        ]
      }
    });
    expect(manifest.gating).toBe('soft');
    expect(manifest.tracks).toEqual([
      { id: 'pip', label: 'pip' },
      { id: 'conda', label: 'conda' }
    ]);
    expect(manifest.defaults).toEqual({ delay: '1s' });
    expect(manifest.variants).toEqual({});
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
    expect(manifest.frontends).toEqual([]);
    expect(manifest.resumable).toBe(false);
    expect(manifest.analytics).toBeUndefined();
  });

  it('parses platforms, frontends and the resumable flag', () => {
    const base =
      'apiVersion: jupyterlab-workshop/v1alpha1\nname: x\ntitle: X\npages: [a.md]\n';
    const manifest = parseManifest(
      `${base}platforms: [linux, windows]\nfrontends: [jupyterlab, jupyterlite]\nresumable: true\n`
    );

    expect(manifest.platforms).toEqual(['linux', 'windows']);
    expect(manifest.frontends).toEqual(['jupyterlab', 'jupyterlite']);
    expect(manifest.resumable).toBe(true);
    expect(() => parseManifest(`${base}platforms: [linux, lite]\n`)).toThrow(
      /Unknown platform "lite".*frontends/
    );
    expect(() => parseManifest(`${base}frontends: [vscode]\n`)).toThrow(
      /Unknown frontend "vscode"/
    );
    expect(() => parseManifest(`${base}resumable: yes\n`)).toThrow(
      /true or false/
    );
  });

  it('parses the analytics block and checks its labels', () => {
    const base =
      'apiVersion: jupyterlab-workshop/v1alpha1\nname: x\ntitle: X\npages: [a.md]\n';
    const manifest = parseManifest(
      `${base}analytics:\n  sink: https://a.example.org/events\n  token: t.o.k\n  labels:\n    course: intro\n    year: 2026\n`
    );

    expect(manifest.analytics).toEqual({
      sink: 'https://a.example.org/events',
      token: 't.o.k',
      labels: { course: 'intro', year: '2026' }
    });
    expect(
      parseManifest(`${base}analytics:\n  labels: {}\n`).analytics
    ).toEqual({
      labels: {}
    });
    expect(() => parseManifest(`${base}analytics:\n  sink: ftp://a\n`)).toThrow(
      /http or https/
    );
    expect(() => parseManifest(`${base}analytics:\n  token: ''\n`)).toThrow(
      /non-empty/
    );
    expect(() =>
      parseManifest(`${base}analytics:\n  labels:\n    'Bad Key': x\n`)
    ).toThrow(/label key/);
    expect(() =>
      parseManifest(
        `${base}analytics:\n  labels:\n${Array.from({ length: 17 }, (_, i) => `    k${i}: v\n`).join('')}`
      )
    ).toThrow(/at most 16/);
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
      parseManifest(VALID.replace('name: code', 'edge: top'))
    ).toThrow(/Layout "default": "main": area 1 has unknown field "edge"/);
    expect(() =>
      parseManifest(VALID.replace('size: 0.35', 'size: 1.5'))
    ).toThrow(/between 0 and 1/);
  });

  it('parses the sidebar fields of the manifest and a layout', () => {
    const manifest = parseManifest(
      VALID.replace(
        '  default:\n',
        '  browse:\n    sidebar: filebrowser\n    instructions: { width: 0.2 }\n  default:\n    sidebar: hidden\n'
      ).replace(
        'instructions: { side: left, width: 0.3 }',
        'sidebar: filebrowser'
      )
    );

    expect(manifest.instructions).toBeUndefined();
    expect(manifest.sidebar).toBe('filebrowser');
    expect(manifest.layouts.default.sidebar).toBe('hidden');
    expect(manifest.layouts.browse).toEqual({
      sidebar: 'filebrowser',
      instructions: { width: 0.2 },
      main: undefined
    });
  });

  it('parses nested splits with their direction and sizes', () => {
    const manifest = parseManifest(
      VALID.replace(
        '        - { size: 0.35, tabs: ["terminal:workshop"] }\n',
        '        - size: 0.35\n          split: columns\n          areas:\n            - { tabs: ["terminal:shell"] }\n            - { tabs: ["terminal:client"], size: 0.5 }\n'
      )
    );

    expect(manifest.layouts.default.main?.areas?.[1]).toEqual({
      size: 0.35,
      split: 'columns',
      areas: [
        { tabs: ['terminal:shell'] },
        { tabs: ['terminal:client'], size: 0.5 }
      ]
    });
  });

  it('rejects malformed layouts and placements', () => {
    expect(() =>
      parseManifest(VALID.replace('name: code', 'name: Code'))
    ).toThrow(/"name" must be lower case/);
    expect(() =>
      parseManifest(VALID.replace('tabs: []', 'tabs: launcher'))
    ).toThrow(/"tabs" must be a list/);
    expect(() =>
      parseManifest(
        VALID.replace('      areas:\n', '      split: grid\n      areas:\n')
      )
    ).toThrow(/"split" must be rows or columns/);
    expect(() =>
      parseManifest(
        VALID.replace('  default:\n', '  default:\n    left: collapsed\n')
      )
    ).toThrow(/unknown field "left"/);
    expect(() =>
      parseManifest(
        VALID.replace(
          '  default:\n',
          '  default:\n    instructions: { side: right }\n'
        )
      )
    ).toThrow(/may set only "width"/);
    expect(() =>
      parseManifest(VALID.replace('side: left', 'side: top'))
    ).toThrow(/"side" must be left or right/);
    expect(() =>
      parseManifest(VALID.replace('width: 0.3', 'width: 3'))
    ).toThrow(/between 0 and 1/);
    expect(() =>
      parseManifest(
        VALID.replace('instructions: { side: left, width: 0.3 }', 'sidebar: ""')
      )
    ).toThrow(/sidebar/);
  });
});
