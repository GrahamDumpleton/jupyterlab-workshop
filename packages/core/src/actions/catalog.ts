/**
 * The vocabulary of actions a workshop page may use.
 *
 * This module only describes actions; their implementations live in the
 * JupyterLab extension. The catalogue is used for validation, lint and
 * rendering decisions such as whether a body is Markdown.
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

/** How the body of a directive is used. */
export type BodyKind = 'required' | 'optional' | 'none' | 'markdown' | 'yaml';

/** Grouping of actions for documentation and the trust dialog. */
export type ActionGroup =
  | 'terminal'
  | 'files'
  | 'notebook'
  | 'ui'
  | 'guidance'
  | 'flow'
  | 'checks'
  | 'external';

/** Description of a block action directive. */
export interface IActionTypeSpec {
  /** Directive name, for example `execute`. */
  name: string;

  group: ActionGroup;

  /** One-line description for documentation and tooling. */
  description: string;

  /** Capability the action needs at runtime. */
  capability: Capability;

  /** How the directive body is used. */
  body: BodyKind;

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
  'substitute',
  'on-error'
];

function spec(
  name: string,
  group: ActionGroup,
  description: string,
  capability: Capability,
  body: BodyKind,
  options: readonly string[] = []
): IActionTypeSpec {
  return { name, group, description, capability, body, options };
}

/** Block action directives, keyed by directive name. */
export const ACTION_TYPES: Readonly<Record<string, IActionTypeSpec>> =
  Object.fromEntries(
    [
      // Terminal.
      spec(
        'execute',
        'terminal',
        'Run a command in a named terminal.',
        'terminal',
        'required',
        ['session', 'cwd', 'wait', 'timeout']
      ),
      spec(
        'execute-capture',
        'terminal',
        'Run a command in the background and capture its output into a variable.',
        'kernel-exec',
        'required',
        ['capture', 'cwd', 'timeout']
      ),
      spec(
        'terminal-open',
        'terminal',
        'Open or reveal a named terminal.',
        'terminal',
        'none',
        ['session', 'cwd', 'area']
      ),
      spec(
        'terminal-clear',
        'terminal',
        'Clear a named terminal.',
        'terminal',
        'none',
        ['session']
      ),
      spec(
        'terminal-type',
        'terminal',
        'Type text into a terminal without pressing Enter.',
        'terminal',
        'required',
        ['session']
      ),
      spec(
        'send-key',
        'terminal',
        'Send key strokes to a terminal.',
        'terminal',
        'none',
        ['session', 'keys']
      ),
      spec(
        'interrupt',
        'terminal',
        'Interrupt the command running in a terminal.',
        'terminal',
        'none',
        ['session']
      ),

      // Files and editor.
      spec(
        'file-write',
        'files',
        'Write the body, or a file shipped with the workshop, to a file.',
        'write-files',
        'optional',
        ['path', 'open', 'mode', 'from']
      ),
      spec(
        'file-open',
        'files',
        'Open a file in the editor, optionally at a line.',
        'none',
        'none',
        ['path', 'line', 'split']
      ),
      spec(
        'editor-insert',
        'files',
        'Insert the body into a file at a line, or at the end.',
        'write-files',
        'required',
        ['path', 'line', 'save']
      ),
      spec(
        'editor-replace',
        'files',
        'Replace text matching a pattern in a file with the body.',
        'write-files',
        'optional',
        ['path', 'match', 'regex', 'all', 'save']
      ),
      spec('editor-select', 'files', 'Select text in a file.', 'none', 'none', [
        'path',
        'match',
        'line'
      ]),
      spec(
        'editor-highlight',
        'files',
        'Briefly highlight text in a file.',
        'none',
        'none',
        ['path', 'match', 'line', 'duration']
      ),
      spec(
        'file-browser-reveal',
        'files',
        'Show a path in the file browser.',
        'none',
        'none',
        ['path']
      ),
      spec(
        'download',
        'files',
        'Download a file to the learner’s machine.',
        'none',
        'none',
        ['path']
      ),
      spec(
        'upload-prompt',
        'files',
        'Ask the learner to upload files.',
        'none',
        'none',
        ['path']
      ),

      // Notebooks and kernels.
      spec(
        'notebook-open',
        'notebook',
        'Open a notebook, optionally at a cell.',
        'none',
        'none',
        ['path', 'cell', 'split']
      ),
      spec(
        'notebook-create',
        'notebook',
        'Create a notebook with the cells listed in the body.',
        'write-files',
        'yaml',
        ['path', 'kernel', 'open']
      ),
      spec(
        'cell-insert',
        'notebook',
        'Insert a cell into a notebook.',
        'write-files',
        'required',
        ['path', 'at', 'kind', 'tags', 'run']
      ),
      spec(
        'cell-run',
        'notebook',
        'Run a cell of a notebook.',
        'kernel-exec',
        'none',
        ['path', 'cell']
      ),
      spec(
        'cell-run-all',
        'notebook',
        'Run every cell of a notebook.',
        'kernel-exec',
        'none',
        ['path']
      ),
      spec(
        'cell-run-to',
        'notebook',
        'Run every cell up to and including one.',
        'kernel-exec',
        'none',
        ['path', 'cell']
      ),
      spec(
        'cell-select',
        'notebook',
        'Make a cell the active cell.',
        'none',
        'none',
        ['path', 'cell']
      ),
      spec(
        'cell-highlight',
        'notebook',
        'Briefly highlight a cell.',
        'none',
        'none',
        ['path', 'cell', 'duration']
      ),
      spec(
        'kernel-restart',
        'notebook',
        'Restart the kernel of a notebook.',
        'kernel-exec',
        'none',
        ['path']
      ),
      spec(
        'kernel-interrupt',
        'notebook',
        'Interrupt the kernel of a notebook.',
        'none',
        'none',
        ['path']
      ),
      spec(
        'kernel-select',
        'notebook',
        'Change the kernel of a notebook.',
        'none',
        'none',
        ['path', 'kernel']
      ),
      spec(
        'kernel-execute',
        'notebook',
        'Run code in a kernel, optionally capturing the output into a variable.',
        'kernel-exec',
        'required',
        ['path', 'kernel', 'silent', 'capture']
      ),
      spec(
        'console-open',
        'notebook',
        'Open a console attached to a notebook.',
        'none',
        'none',
        ['path']
      ),
      spec(
        'output-clear',
        'notebook',
        'Clear the outputs of a notebook.',
        'none',
        'none',
        ['path']
      ),

      // UI and layout.
      spec(
        'command',
        'ui',
        'Run a JupyterLab command, with JSON arguments in the body.',
        'none',
        'optional',
        ['command']
      ),
      spec(
        'layout',
        'ui',
        'Arrange the JupyterLab panels using a named layout.',
        'none',
        'none',
        ['name']
      ),
      spec(
        'panel-open',
        'ui',
        'Show a JupyterLab panel or widget by id.',
        'none',
        'none',
        ['id']
      ),
      spec(
        'panel-close',
        'ui',
        'Hide a JupyterLab sidebar panel.',
        'none',
        'none',
        ['id', 'side']
      ),
      spec('focus', 'ui', 'Give a widget focus.', 'none', 'none', ['id']),
      spec(
        'settings-set',
        'ui',
        'Change a JupyterLab setting, with the JSON value in the body.',
        'ui-settings',
        'required',
        ['plugin', 'key']
      ),
      spec(
        'launcher-open',
        'ui',
        'Open the launcher, or show the open one.',
        'none',
        'none'
      ),

      // Guidance.
      spec(
        'highlight',
        'guidance',
        'Draw attention to part of the interface.',
        'none',
        'optional',
        ['selector', 'duration']
      ),
      spec(
        'tour',
        'guidance',
        'Walk through interface elements listed in the body.',
        'none',
        'yaml'
      ),
      spec(
        'toast',
        'guidance',
        'Show a notification message.',
        'none',
        'required',
        ['type', 'duration']
      ),
      spec(
        'tooltip',
        'guidance',
        'Pin a note to an element until dismissed.',
        'none',
        'required',
        ['selector']
      ),
      spec(
        'dialog',
        'guidance',
        'Ask a question and store the answer in a variable.',
        'none',
        'required',
        ['title', 'buttons', 'capture']
      ),
      spec('hint', 'guidance', 'Collapsible help text.', 'none', 'markdown', [
        'title',
        'open'
      ]),

      // Flow and variables.
      spec(
        'choice',
        'flow',
        'Let the learner pick a value, optionally choosing a track.',
        'none',
        'optional',
        ['variable', 'options', 'track', 'label']
      ),
      spec(
        'env-set',
        'flow',
        'Set a variable, with the value in the body.',
        'none',
        'required',
        ['name', 'value']
      ),
      spec('next-page', 'flow', 'Go to the next page.', 'none', 'none'),

      // Checks, forms and checkpoints.
      spec(
        'verify',
        'checks',
        'Check learner progress with code, a script, or file and interface predicates.',
        'none',
        'optional',
        ['label', 'trigger', 'substrate', 'script', 'path', 'timeout']
      ),
      spec(
        'quiz',
        'checks',
        'Ask a multiple choice question with the options in the body.',
        'none',
        'yaml',
        ['type', 'shuffle', 'attempts']
      ),
      spec(
        'form',
        'checks',
        'Collect variable values from the learner with the fields in the body.',
        'none',
        'yaml',
        ['label']
      ),
      spec(
        'checkpoint',
        'checks',
        'Snapshot the workshop files and variables under a name.',
        'none',
        'none',
        ['name']
      ),
      spec(
        'restore',
        'checks',
        'Restore the workshop files and variables from a checkpoint.',
        'write-files',
        'none',
        ['name']
      ),

      // External.
      spec(
        'copy',
        'external',
        'Copy the body to the clipboard.',
        'none',
        'required'
      ),
      spec(
        'environment-create',
        'external',
        'Create the isolated environment declared in the manifest and register its kernel.',
        'install-packages',
        'none'
      )
    ].map(item => [item.name, item])
  );

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
  },
  var: {
    name: 'var',
    description: 'Show the value of a variable.',
    capability: 'none'
  }
};

/** Directives that structure content rather than run actions. */
export const STRUCTURE_DIRECTIVES: ReadonlySet<string> = new Set(['when']);

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

/**
 * Return the option names a directive accepts, common options included.
 */
export function allowedOptions(name: string): readonly string[] {
  const action = ACTION_TYPES[name];

  return action ? [...COMMON_OPTIONS, ...action.options] : COMMON_OPTIONS;
}
