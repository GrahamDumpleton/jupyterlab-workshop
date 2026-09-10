/**
 * Rendering of the environment files that expose workshop variables to
 * terminals. Each variable becomes an upper-cased environment variable,
 * and the built-in variables are prefixed with `WORKSHOP_`.
 *
 * The files also install the workshop prompt: the working directory
 * relative to the work directory, preceded by a marker sequence that the
 * terminal does not show and the extension listens for to tell when a
 * command has finished.
 */

import { Variables, shellQuote } from './substitute';

/** Built-in variable names, which are exported with a `WORKSHOP_` prefix. */
export const BUILTIN_VARIABLES: readonly string[] = [
  'platform',
  'shell',
  'path_sep',
  'workshop_dir',
  'workspace',
  'home',
  'user',
  'host',
  'container'
];

/**
 * The operating system command number of the prompt marker. Terminals
 * silently drop an OSC sequence they do not recognise, so the marker
 * leaves no trace on screen.
 */
export const PROMPT_MARKER_OSC = 7770;

/**
 * One prompt marker: the OSC introducer, the number, the word `workshop`,
 * the exit status of the last command, the serial number of the prompt
 * where the shell can count them, and a BEL or ST terminator.
 */
// eslint-disable-next-line no-control-regex
const PROMPT_MARKER = /\x1b\]7770;workshop;(-?\d+)(?:;(\d+))?(?:\x07|\x1b\\)/;

/** How long a marker can be, so a split one can be kept for the next chunk. */
export const PROMPT_MARKER_MAX_LENGTH = 60;

/** A prompt marker found in terminal output. */
export interface IPromptMarker {
  /** The exit status of the command before the prompt. */
  status: number;

  /**
   * The serial number of the prompt, which the shell increases each time
   * it draws a primary prompt, or null for a continuation prompt and for
   * shells that cannot count.
   */
  serial: number | null;

  /** The offset just past the marker in the searched text. */
  end: number;
}

/**
 * Find the first prompt marker in a piece of terminal output, or null
 * when there is none.
 */
export function findPromptMarker(text: string): IPromptMarker | null {
  const match = PROMPT_MARKER.exec(text);

  if (!match) {
    return null;
  }

  return {
    status: Number.parseInt(match[1], 10),
    serial: match[2] === undefined ? null : Number.parseInt(match[2], 10),
    end: match.index + match[0].length
  };
}

/**
 * Pick the prompt markers out of a terminal's output as it arrives, in
 * chunks that may split a marker, and tell a prompt newly drawn from one
 * drawn again. A shell redraws its prompt, marker included, when the
 * terminal is resized or the screen is redrawn, so a marker whose serial
 * number has been seen is dropped; only a marker without a serial number
 * is passed through every time.
 */
export class PromptScanner {
  /**
   * Feed the next chunk of output and get the markers of the prompts it
   * completes, in order, redraws left out.
   */
  feed(text: string): IPromptMarker[] {
    const markers: IPromptMarker[] = [];

    this._pending += text;

    for (
      let marker = findPromptMarker(this._pending);
      marker;
      marker = findPromptMarker(this._pending)
    ) {
      this._pending = this._pending.slice(marker.end);

      if (marker.serial !== null) {
        if (marker.serial <= this._serial) {
          continue;
        }

        this._serial = marker.serial;
      }

      markers.push(marker);
    }

    // Keep a tail long enough to hold a marker split across chunks.
    this._pending = this._pending.slice(-PROMPT_MARKER_MAX_LENGTH);

    return markers;
  }

  private _pending = '';
  private _serial = -1;
}

/**
 * Map workshop variables to environment variable names and values.
 */
export function environmentVariables(
  variables: Variables
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(variables)) {
    const upper = name.toUpperCase();

    result[BUILTIN_VARIABLES.includes(name) ? `WORKSHOP_${upper}` : upper] =
      value;
  }

  return result;
}

/**
 * A workshop environment to put on a terminal's PATH: the virtual
 * environment's directory and the directory of its programs.
 */
export interface IVenvExports {
  root: string;
  bin: string;
}

/**
 * How the workshop prompt is set up in a terminal.
 */
export interface IPromptConfig {
  /**
   * The absolute path of the work directory. The prompt shows the working
   * directory relative to it, as `~` for the directory itself, and the
   * full path once outside it.
   */
  root: string;
}

/**
 * The environment exported to workshop terminals: the variables, then
 * the manifest's `env` mapping, which wins where the names clash.
 */
export function terminalEnvironment(
  variables: Variables,
  env: Readonly<Record<string, string>> = {}
): Record<string, string> {
  return { ...environmentVariables(variables), ...env };
}

/**
 * Render a POSIX shell file that exports the variables. The file is
 * sourced by bash, zsh and plain sh alike, so it stays within what all
 * three accept and branches only where the prompt syntax differs.
 */
export function renderEnvSh(
  variables: Variables,
  env: Readonly<Record<string, string>> = {},
  venv?: IVenvExports,
  prompt?: IPromptConfig
): string {
  const lines = ['# Generated by the workshop extension. Do not edit.'];

  for (const [name, value] of Object.entries(
    terminalEnvironment(variables, env)
  )) {
    lines.push(`export ${name}=${shellQuote(value)}`);
  }

  // The workshop environment goes first on PATH, as activating it would
  // put it, and VIRTUAL_ENV names it for tools and prompts that look.
  if (venv) {
    lines.push(`export VIRTUAL_ENV=${shellQuote(venv.root)}`);
    lines.push(`export PATH=${shellQuote(venv.bin)}:"$PATH"`);
  }

  if (prompt) {
    lines.push(...promptLinesSh(prompt));
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The lines of the POSIX file that install the prompt. The marker bytes
 * are produced by printf so that the file itself holds no control
 * characters. Prompt hooks from the user's rc files are replaced by the
 * workshop's own, which records the exit status and counts the prompts
 * drawn, since tools such as starship rewrite the prompt from them on
 * every command. The count is never reset, so loading the file again
 * keeps the numbers rising. The zsh array assignment goes through eval
 * because plain sh refuses to parse it even in a branch it does not
 * take. The work directory is
 * resolved to its physical path and compared with the physical working
 * directory, so a symbolic link on the way (macOS keeps /var under
 * /private) does not hide that the shell is inside it.
 * The screen is cleared the first time a terminal loads the file, taking
 * the typed source command and any login banner with it.
 */
function promptLinesSh(prompt: IPromptConfig): string[] {
  const osc = `\\033]${PROMPT_MARKER_OSC};workshop;`;

  return [
    '',
    '# The workshop prompt: the directory relative to the work directory,',
    '# preceded by the marker the extension listens for.',
    `export WORKSHOP_PROMPT_ROOT="$(cd ${shellQuote(prompt.root)} 2>/dev/null && pwd -P || printf '%s' ${shellQuote(prompt.root)})"`,
    '__workshop_prompt_dir() {',
    '  __workshop_pwd="$(pwd -P)"',
    '  case "$__workshop_pwd" in',
    '    "$WORKSHOP_PROMPT_ROOT") printf \'~\' ;;',
    '    "$WORKSHOP_PROMPT_ROOT"/*) printf \'~%s\' "${__workshop_pwd#"$WORKSHOP_PROMPT_ROOT"}" ;;',
    '    *) printf \'%s\' "$PWD" ;;',
    '  esac',
    '}',
    `__workshop_osc="$(printf '${osc}')"`,
    `__workshop_bel="$(printf '\\007')"`,
    'if [ -n "$ZSH_VERSION" ]; then',
    '  setopt PROMPT_SUBST',
    "  eval 'precmd_functions=()'",
    '  unset RPS1 RPROMPT',
    '  precmd() { __workshop_status=$?; __workshop_serial=$((__workshop_serial+1)); }',
    '  PS1="%{${__workshop_osc}"\'${__workshop_status};${__workshop_serial}\'"${__workshop_bel}%}"\'$(__workshop_prompt_dir) %(!.#.$) \'',
    '  PS2="%{${__workshop_osc}0${__workshop_bel}%}> "',
    'elif [ -n "$BASH_VERSION" ]; then',
    '  unset PROMPT_COMMAND',
    "  PROMPT_COMMAND='__workshop_status=$?; __workshop_serial=$((__workshop_serial+1))'",
    '  PS1="\\[${__workshop_osc}"\'${__workshop_status};${__workshop_serial}\'"${__workshop_bel}\\]"\'$(__workshop_prompt_dir) \\$ \'',
    '  PS2="\\[${__workshop_osc}0${__workshop_bel}\\]> "',
    'else',
    '  # Plain sh takes the prompt literally, so it cannot show the directory.',
    '  PS1="${__workshop_osc}0${__workshop_bel}\\$ "',
    '  PS2="${__workshop_osc}0${__workshop_bel}> "',
    'fi',
    'unset __workshop_osc __workshop_bel',
    'if [ -z "$WORKSHOP_TERMINAL" ]; then',
    '  export WORKSHOP_TERMINAL=1',
    "  printf '\\033[H\\033[2J\\033[3J'",
    'fi'
  ];
}

/**
 * Quote a value for fish, whose single quotes escape only the quote and
 * the backslash.
 */
function fishQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Render a fish file that sets the variables.
 */
export function renderEnvFish(
  variables: Variables,
  env: Readonly<Record<string, string>> = {},
  venv?: IVenvExports,
  prompt?: IPromptConfig
): string {
  const lines = ['# Generated by the workshop extension. Do not edit.'];

  for (const [name, value] of Object.entries(
    terminalEnvironment(variables, env)
  )) {
    lines.push(`set -gx ${name} ${fishQuote(value)}`);
  }

  // PATH is a list in fish, so the directory is put in front of it.
  if (venv) {
    lines.push(`set -gx VIRTUAL_ENV ${fishQuote(venv.root)}`);
    lines.push(`set -gx PATH ${fishQuote(venv.bin)} $PATH`);
  }

  if (prompt) {
    lines.push(
      '',
      '# The workshop prompt: the directory relative to the work directory,',
      '# preceded by the marker the extension listens for.',
      `set -gx WORKSHOP_PROMPT_ROOT (realpath -- ${fishQuote(prompt.root)} 2>/dev/null; or echo ${fishQuote(prompt.root)})`,
      'set -q __workshop_serial; or set -g __workshop_serial 0',
      'function fish_prompt',
      '    set -l code $status',
      '    set -g __workshop_serial (math $__workshop_serial + 1)',
      '    set -l here (pwd -P)',
      '    set -l dir $PWD',
      '    if test "$here" = "$WORKSHOP_PROMPT_ROOT"',
      "        set dir '~'",
      '    else if string match -q -- "$WORKSHOP_PROMPT_ROOT/*" "$here"',
      '        set dir \'~\'(string sub -s (math (string length -- "$WORKSHOP_PROMPT_ROOT") + 1) -- "$here")',
      '    end',
      `    printf '\\e]${PROMPT_MARKER_OSC};workshop;%s;%s\\a%s $ ' $code $__workshop_serial $dir`,
      'end',
      'functions -e fish_right_prompt',
      'if not set -q WORKSHOP_TERMINAL',
      '    set -gx WORKSHOP_TERMINAL 1',
      "    printf '\\e[H\\e[2J\\e[3J'",
      'end'
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Render a Windows command prompt batch file that sets the variables.
 */
export function renderEnvCmd(
  variables: Variables,
  env: Readonly<Record<string, string>> = {},
  venv?: IVenvExports,
  prompt?: IPromptConfig
): string {
  const lines = [
    '@echo off',
    'rem Generated by the workshop extension. Do not edit.'
  ];

  for (const [name, value] of Object.entries(
    terminalEnvironment(variables, env)
  )) {
    // Quoting the whole assignment keeps special characters literal; the
    // quotes themselves are not part of the value.
    lines.push(`set "${name}=${value.replace(/"/g, '')}"`);
  }

  if (venv) {
    lines.push(`set "VIRTUAL_ENV=${venv.root.replace(/"/g, '')}"`);
    lines.push(`set "PATH=${venv.bin.replace(/"/g, '')};%PATH%"`);
  }

  // The prompt string's $E is the escape character and $P the full
  // path; there is no way to show a relative one or the exit status.
  if (prompt) {
    lines.push(
      'rem The workshop prompt, preceded by the marker the extension listens for.',
      `set "WORKSHOP_PROMPT_ROOT=${prompt.root.replace(/"/g, '')}"`,
      `set "PROMPT=$E]${PROMPT_MARKER_OSC};workshop;0$E\\$P$G "`,
      'if not defined WORKSHOP_TERMINAL (set "WORKSHOP_TERMINAL=1" & cls)'
    );
  }

  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Render a PowerShell file that sets the variables.
 */
export function renderEnvPs1(
  variables: Variables,
  env: Readonly<Record<string, string>> = {},
  venv?: IVenvExports,
  prompt?: IPromptConfig
): string {
  const lines = ['# Generated by the workshop extension. Do not edit.'];

  for (const [name, value] of Object.entries(
    terminalEnvironment(variables, env)
  )) {
    lines.push(`$env:${name} = '${value.replace(/'/g, "''")}'`);
  }

  // PowerShell runs on every platform, so the separator is asked for.
  if (venv) {
    lines.push(`$env:VIRTUAL_ENV = '${venv.root.replace(/'/g, "''")}'`);
    lines.push(
      `$env:PATH = '${venv.bin.replace(/'/g, "''")}' + [IO.Path]::PathSeparator + $env:PATH`
    );
  }

  // The prompt function reads $? first, before anything else in it can
  // change it. The continuation prompt is PSReadLine's, so setting it is
  // allowed to fail where PSReadLine is not loaded.
  if (prompt) {
    const marker = `$([char]27)]${PROMPT_MARKER_OSC};workshop;`;

    lines.push(
      '',
      '# The workshop prompt: the directory relative to the work directory,',
      '# preceded by the marker the extension listens for.',
      `$env:WORKSHOP_PROMPT_ROOT = '${prompt.root.replace(/'/g, "''")}'`,
      'if ($null -eq $global:WorkshopPromptSerial) { $global:WorkshopPromptSerial = 0 }',
      'function global:prompt {',
      '    $code = if ($?) { 0 } else { 1 }',
      '    $global:WorkshopPromptSerial += 1',
      '    $root = $env:WORKSHOP_PROMPT_ROOT',
      '    $here = $PWD.ProviderPath',
      '    if ($here -eq $root) {',
      "        $dir = '~'",
      '    } elseif ($here.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {',
      "        $dir = '~' + $here.Substring($root.Length)",
      '    } else {',
      '        $dir = $here',
      '    }',
      `    "${marker}$code;$($global:WorkshopPromptSerial)$([char]7)$dir \`$ "`,
      '}',
      `try { Set-PSReadLineOption -ContinuationPrompt "${marker}0$([char]7)>> " } catch {}`,
      'if (-not $env:WORKSHOP_TERMINAL) {',
      "    $env:WORKSHOP_TERMINAL = '1'",
      '    Clear-Host',
      '}'
    );
  }

  return `${lines.join('\n')}\n`;
}
