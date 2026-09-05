/** Severity of a lint finding. */
export type LintLevel = 'error' | 'warning';

/** One finding from linting a workshop. */
export interface ILintMessage {
  level: LintLevel;

  /** Stable rule identifier, such as `undeclared-capability`. */
  rule: string;

  message: string;

  /** Page or manifest path the finding refers to, when known. */
  path?: string;

  /** One-based line within the path, when known. */
  line?: number;
}

/**
 * Format a finding as `path:line: level: message` for terminals and logs.
 */
export function formatLintMessage(message: ILintMessage): string {
  const where = message.path
    ? `${message.path}${message.line ? `:${message.line}` : ''}: `
    : '';

  return `${where}${message.level}: ${message.message}`;
}
