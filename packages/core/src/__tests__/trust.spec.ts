import { parseManifest } from '../format/manifest';
import { parsePage } from '../format/page';
import {
  capabilityUses,
  countAutomatic,
  declaredCapabilities,
  undeclaredCapabilities
} from '../trust/capabilities';
import { decideAction } from '../trust/policy';

const MANIFEST = `
apiVersion: jupyterlab-workshop/v1alpha1
name: demo
title: Demo
capabilities:
  - terminal
  - write-files: [workspace]
pages: [pages/01.md]
`;

const PAGE = `---
title: One
---

\`\`\`{execute}
:auto: page-enter
:cascade: true
echo hi
\`\`\`

\`\`\`{file-write}
:path: notes.txt
hello
\`\`\`

\`\`\`{kernel-execute}
print(1)
\`\`\`

\`\`\`{toast}
Done
\`\`\`
`;

function pages() {
  return [parsePage(PAGE, { path: 'pages/01.md', variables: {} })];
}

describe('capabilities', () => {
  it('groups declared capabilities with their scopes', () => {
    const declared = declaredCapabilities(parseManifest(MANIFEST));

    expect([...declared.entries()]).toEqual([
      ['terminal', []],
      ['write-files', ['workspace']]
    ]);
  });

  it('reports what pages use against what is declared', () => {
    const manifest = parseManifest(MANIFEST);

    expect(capabilityUses(manifest, pages())).toEqual([
      { capability: 'terminal', count: 1, declared: true },
      { capability: 'write-files', count: 1, declared: true },
      { capability: 'kernel-exec', count: 1, declared: false },
      { capability: 'auto-run', count: 1, declared: false }
    ]);
    expect(undeclaredCapabilities(manifest, pages())).toEqual([
      'kernel-exec',
      'auto-run'
    ]);
    expect(countAutomatic(pages())).toBe(1);
  });

  it('rejects unknown capability names and scopes in the manifest', () => {
    expect(() =>
      parseManifest(MANIFEST.replace('terminal', 'teleport'))
    ).toThrow(/Unknown capability "teleport"/);
    expect(() =>
      parseManifest(MANIFEST.replace('[workspace]', '[everywhere]'))
    ).toThrow(/Unknown write-files scope/);
  });
});

describe('decideAction', () => {
  const declared = [
    'terminal',
    'write-files:workspace',
    'kernel-exec',
    'auto-run'
  ];

  it('runs everything when trusted', () => {
    expect(
      decideAction({
        type: 'execute',
        level: 'trusted',
        automatic: true,
        declared
      })
    ).toEqual({ kind: 'run' });
  });

  it('rejects undeclared capabilities at every level', () => {
    for (const level of ['trusted', 'restricted', 'ask'] as const) {
      expect(
        decideAction({
          type: 'settings-set',
          level,
          automatic: false,
          declared
        })
      ).toMatchObject({ kind: 'reject' });
    }

    expect(
      decideAction({
        type: 'toast',
        level: 'trusted',
        automatic: true,
        declared: ['terminal']
      })
    ).toMatchObject({
      kind: 'reject',
      reason: expect.stringContaining('auto-run')
    });
  });

  it('skips capabilities an administrator disabled', () => {
    expect(
      decideAction({
        type: 'execute',
        level: 'trusted',
        automatic: false,
        declared,
        disabled: ['terminal']
      })
    ).toMatchObject({ kind: 'skip' });
  });

  it('degrades and confirms when restricted', () => {
    const restricted = (type: string, automatic = false) =>
      decideAction({ type, level: 'restricted', automatic, declared });

    expect(restricted('execute')).toMatchObject({
      kind: 'downgrade',
      type: 'terminal-type'
    });
    expect(restricted('file-write')).toMatchObject({ kind: 'confirm' });
    expect(restricted('kernel-execute')).toMatchObject({ kind: 'confirm' });
    expect(restricted('send-key')).toMatchObject({ kind: 'confirm' });
    expect(restricted('terminal-open')).toEqual({ kind: 'run' });
    expect(restricted('toast')).toEqual({ kind: 'run' });
    expect(restricted('toast', true)).toMatchObject({ kind: 'skip' });
    expect(restricted('execute', true)).toMatchObject({ kind: 'skip' });
  });

  it('asks per capability unless already allowed', () => {
    expect(
      decideAction({
        type: 'execute',
        level: 'ask',
        automatic: false,
        declared
      })
    ).toMatchObject({ kind: 'confirm' });
    expect(
      decideAction({
        type: 'execute',
        level: 'ask',
        automatic: true,
        declared,
        allowed: ['terminal']
      })
    ).toEqual({ kind: 'run' });
    expect(
      decideAction({ type: 'toast', level: 'ask', automatic: false, declared })
    ).toEqual({ kind: 'run' });
  });

  it('lets unknown action types through to the registry', () => {
    expect(
      decideAction({
        type: 'teleport',
        level: 'restricted',
        automatic: false,
        declared
      })
    ).toEqual({ kind: 'run' });
  });
});

describe('write targets', () => {
  const declared = ['write-files:workspace'];
  const decide = (
    options: Record<string, string>,
    layout: { workspace?: string; requirements?: string } = {}
  ) =>
    decideAction({
      type: 'file-write',
      options,
      level: 'trusted',
      automatic: false,
      declared,
      layout
    });

  it("refuses the workshop's own files at every scope", () => {
    expect(decide({ path: 'pages/01.md' })).toMatchObject({
      kind: 'reject',
      reason: expect.stringContaining('part of the workshop')
    });
    expect(decide({ path: 'workshop.yaml' })).toMatchObject({ kind: 'reject' });
    expect(
      decide({ path: 'requirements.txt' }, { requirements: 'requirements.txt' })
    ).toMatchObject({ kind: 'reject' });
    expect(
      decide({ path: '../files/x.py' }, { workspace: 'work' })
    ).toMatchObject({ kind: 'reject' });
    expect(decide({ path: 'notes.txt' })).toEqual({ kind: 'run' });
  });

  it('confines the workspace scope to a declared workspace', () => {
    expect(decide({ path: 'notes.txt' }, { workspace: 'work' })).toEqual({
      kind: 'run'
    });
    expect(
      decide({ path: '../notes.txt' }, { workspace: 'work' })
    ).toMatchObject({
      kind: 'reject',
      reason: expect.stringContaining('outside the workspace')
    });
    expect(
      decideAction({
        type: 'file-write',
        options: { path: '../notes.txt' },
        level: 'trusted',
        automatic: false,
        declared: ['write-files:any'],
        layout: { workspace: 'work' }
      })
    ).toEqual({ kind: 'run' });
  });
});
