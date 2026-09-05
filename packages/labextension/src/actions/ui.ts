import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { JSONValue } from '@lumino/coreutils';

import { LayoutManager } from '../layout';
import {
  IActionImplementation,
  IActionRequest,
  IActionResult
} from '../tokens';
import { requireBody, requireOption } from './registry';

/**
 * The `command` action: run any JupyterLab command with JSON arguments.
 */
export class CommandAction implements IActionImplementation {
  readonly type = 'command';

  constructor(app: JupyterFrontEnd) {
    this._app = app;
  }

  describe(request: IActionRequest): string {
    return `Run command ${request.options.command || request.argument || '(none)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const id = request.options.command || request.argument;

    if (!id) {
      return {
        status: 'error',
        message: 'The command action needs a command id'
      };
    }

    if (!this._app.commands.hasCommand(id)) {
      return { status: 'error', message: `Unknown command "${id}"` };
    }

    const args = request.body.trim()
      ? (JSON.parse(request.body) as Record<string, JSONValue>)
      : {};

    await this._app.commands.execute(id, args);

    return { status: 'ok' };
  }

  private _app: JupyterFrontEnd;
}

/**
 * The `layout` action: apply a named layout.
 */
export class LayoutAction implements IActionImplementation {
  readonly type = 'layout';

  constructor(layouts: LayoutManager) {
    this._layouts = layouts;
  }

  describe(request: IActionRequest): string {
    return `Apply layout "${request.options.name || request.argument || 'default'}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    await this._layouts.apply(
      request.options.name || request.argument || 'default'
    );

    return { status: 'ok' };
  }

  private _layouts: LayoutManager;
}

/**
 * The `panel-open` and `focus` actions: activate a widget by id.
 */
export class ActivateAction implements IActionImplementation {
  constructor(shell: ILabShell, type: 'panel-open' | 'focus') {
    this._shell = shell;
    this.type = type;
  }

  readonly type: string;

  describe(request: IActionRequest): string {
    return `${this.type === 'focus' ? 'Focus' : 'Show'} ${request.options.id || request.argument || '(no id)'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const id = request.options.id || request.argument;

    if (!id) {
      return {
        status: 'error',
        message: `The ${this.type} action needs an "id" option`
      };
    }

    if (!document.getElementById(id)) {
      return { status: 'error', message: `No widget has the id "${id}"` };
    }

    this._shell.activateById(id);

    return { status: 'ok' };
  }

  private _shell: ILabShell;
}

/**
 * The `panel-close` action: collapse a sidebar.
 */
export class PanelCloseAction implements IActionImplementation {
  readonly type = 'panel-close';

  constructor(shell: ILabShell) {
    this._shell = shell;
  }

  describe(request: IActionRequest): string {
    return `Collapse the ${request.options.side ?? 'left'} sidebar`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    if (request.options.side === 'right') {
      this._shell.collapseRight();
    } else {
      this._shell.collapseLeft();
    }

    return { status: 'ok' };
  }

  private _shell: ILabShell;
}

/**
 * The `settings-set` action: change a JupyterLab setting.
 */
export class SettingsSetAction implements IActionImplementation {
  readonly type = 'settings-set';

  constructor(settings: ISettingRegistry | null) {
    this._settings = settings;
  }

  describe(request: IActionRequest): string {
    return `Set ${request.options.plugin ?? '?'} ${request.options.key ?? '?'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    if (!this._settings) {
      return {
        status: 'error',
        message: 'The setting registry is not available'
      };
    }

    const plugin = requireOption(request, 'plugin');
    const key = requireOption(request, 'key');
    const value = JSON.parse(requireBody(request, 'a JSON value')) as JSONValue;

    // Remember the learner's own value so uninstalling can put it back.
    const settings = await this._settings.load(plugin);
    const previous = settings.user[key];

    await this._settings.set(plugin, key, value);

    return { status: 'ok', setting: { plugin, key, previous } };
  }

  private _settings: ISettingRegistry | null;
}

/**
 * The `launcher-open` action.
 */
export class LauncherOpenAction implements IActionImplementation {
  readonly type = 'launcher-open';

  constructor(app: JupyterFrontEnd) {
    this._app = app;
  }

  describe(): string {
    return 'Open the launcher';
  }

  async run(): Promise<IActionResult> {
    await this._app.commands.execute('launcher:create');

    return { status: 'ok' };
  }

  private _app: JupyterFrontEnd;
}
