/**
 * Heuristics that flag commands and code likely to do more than a workshop
 * should. They produce warnings for the trust dialog and the linter, not
 * blocks: an author can legitimately need any of them.
 */

/** A pattern with the warning it produces. */
interface IDangerPattern {
  rule: string;
  pattern: RegExp;
  message: string;
}

const PATTERNS: readonly IDangerPattern[] = [
  {
    rule: 'danger-pipe-to-shell',
    pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/,
    message: 'Pipes a download straight into a shell'
  },
  {
    rule: 'danger-sudo',
    pattern: /(?:^|[\s;&|(])sudo\s/m,
    message: 'Uses sudo'
  },
  {
    rule: 'danger-recursive-delete',
    pattern:
      /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)+(?:\/|~|\.\.|\$HOME|\$\{HOME\})/,
    message: 'Deletes recursively outside the workshop directory'
  },
  {
    rule: 'danger-eval',
    pattern: /(?:^|[\s;&|(`])eval\s/m,
    message: 'Uses eval'
  },
  {
    rule: 'danger-base64-exec',
    pattern:
      /base64\s+(?:-d|--decode)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:ba|z|da|k)?sh\s+<\s*\(\s*base64/,
    message: 'Executes base64-decoded content'
  },
  {
    rule: 'danger-home-path',
    pattern: /(?:^|[\s=:"'])(?:~|\$HOME|\$\{HOME\})(?:\/|$)/m,
    message: 'Refers to the home directory'
  }
];

const ABSOLUTE_PATH = /(?:^|[\s=:"'])\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+/m;

/** A danger warning about a piece of text. */
export interface IDangerWarning {
  rule: string;
  message: string;
}

/**
 * Warnings for a shell command or code snippet.
 */
export function dangerWarnings(text: string): IDangerWarning[] {
  const warnings: IDangerWarning[] = [];

  for (const { rule, pattern, message } of PATTERNS) {
    if (pattern.test(text)) {
      warnings.push({ rule, message });
    }
  }

  return warnings;
}

/**
 * Whether the text mentions an absolute path.
 */
export function mentionsAbsolutePath(text: string): boolean {
  return ABSOLUTE_PATH.test(text);
}
