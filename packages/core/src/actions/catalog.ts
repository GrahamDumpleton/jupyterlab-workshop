/**
 * The vocabulary of actions a workshop page may use.
 *
 * This module only describes actions; their implementations live in the
 * JupyterLab extension. The catalogue is used for validation and lint.
 */

/** A capability an action needs, declared in the manifest and shown in the trust dialog. */
export type Capability =
  | 'none'
  | 'terminal'
  | 'write-files'
  | 'network'
  | 'install-packages'
  | 'kernel-exec'
  | 'auto-run'
  | 'ui-settings';

/** Description of a block action directive. */
export interface IActionTypeSpec {
  /** Directive name, for example `execute`. */
  name: string;

  /** One-line description for documentation and tooling. */
  description: string;

  /** Capability the action needs at runtime. */
  capability: Capability;

  /** Whether the directive body is required, optional, or unused. */
  body: 'required' | 'optional' | 'none';

  /** Option names the directive accepts in addition to the common ones. */
  options: readonly string[];
}

/** Description of an inline role such as `{copy}`. */
export interface IRoleTypeSpec {
  name: string;
  description: string;
  capability: Capability;
}

/** Options accepted by every action directive. */
export const COMMON_OPTIONS: readonly string[] = [
  'id',
  'title',
  'auto',
  'cascade',
  'delay',
  'scroll',
  'when',
  'substitute'
];

/** Block action directives, keyed by directive name. */
export const ACTION_TYPES: Readonly<Record<string, IActionTypeSpec>> = {
  execute: {
    name: 'execute',
    description: 'Run a command in a named terminal.',
    capability: 'terminal',
    body: 'required',
    options: ['session', 'cwd', 'wait', 'timeout']
  },
  'file-write': {
    name: 'file-write',
    description: 'Write the body to a file, creating directories as needed.',
    capability: 'write-files',
    body: 'required',
    options: ['path', 'open', 'mode']
  },
  'file-open': {
    name: 'file-open',
    description: 'Open a file in the editor, optionally at a line.',
    capability: 'none',
    body: 'none',
    options: ['path', 'line']
  },
  'editor-insert': {
    name: 'editor-insert',
    description: 'Insert the body into an open file at a line, or at the end.',
    capability: 'write-files',
    body: 'required',
    options: ['path', 'line', 'save']
  },
  highlight: {
    name: 'highlight',
    description: 'Draw attention to a part of the JupyterLab interface.',
    capability: 'none',
    body: 'optional',
    options: ['selector', 'duration']
  },
  toast: {
    name: 'toast',
    description: 'Show a notification message.',
    capability: 'none',
    body: 'required',
    options: ['type', 'duration']
  },
  copy: {
    name: 'copy',
    description: 'Copy the body to the clipboard.',
    capability: 'none',
    body: 'required',
    options: []
  }
};

/** Inline roles, keyed by role name. */
export const ROLE_TYPES: Readonly<Record<string, IRoleTypeSpec>> = {
  copy: {
    name: 'copy',
    description: 'Copy the text to the clipboard.',
    capability: 'none'
  },
  open: {
    name: 'open',
    description: 'Open the named file in the editor.',
    capability: 'none'
  },
  highlight: {
    name: 'highlight',
    description: 'Highlight the element matching the selector.',
    capability: 'none'
  }
};

/**
 * Test whether a directive name is a known action.
 */
export function isActionType(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACTION_TYPES, name);
}

/**
 * Test whether a role name is a known inline action.
 */
export function isRoleType(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROLE_TYPES, name);
}
