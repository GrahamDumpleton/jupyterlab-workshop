import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { Launcher } from '@jupyterlab/launcher';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { JSONValue } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';

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
    const name = request.options.name || request.argument || 'default';
    const outcome = await this._layouts.apply(name);

    // What could be arranged has been; what could not is the error, so
    // the learner sees it and running the action again completes it.
    if (outcome.missing.length > 0) {
      return {
        status: 'error',
        message: `Layout "${name}" could not open ${outcome.missing.join(', ')}`
      };
    }

    if (!outcome.arranged) {
      return {
        status: 'error',
        message: `Layout "${name}" could not be arranged as declared`
      };
    }

    return { status: 'ok' };
  }

  private _layouts: LayoutManager;
}

/**
 * The `panel-open` and `focus` actions: activate a widget by id. A
 * sidebar widget opened this way is shown in the sidebar the
 * instructions are not in, so the two do not cover each other.
 */
export class ActivateAction implements IActionImplementation {
  constructor(
    shell: ILabShell,
    type: 'panel-open' | 'focus',
    layouts: LayoutManager | null = null
  ) {
    this._shell = shell;
    this._layouts = layouts;
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

    if (!this._layouts?.showSidebarWidget(id)) {
      this._shell.activateById(id);
    }

    return { status: 'ok' };
  }

  private _shell: ILabShell;
  private _layouts: LayoutManager | null;
}

/**
 * The `panel-close` action: collapse a sidebar, by default the one the
 * instructions are not in.
 */
export class PanelCloseAction implements IActionImplementation {
  readonly type = 'panel-close';

  constructor(shell: ILabShell, layouts: LayoutManager) {
    this._shell = shell;
    this._layouts = layouts;
  }

  describe(request: IActionRequest): string {
    const side = request.options.side;

    return side === 'left' || side === 'right'
      ? `Collapse the ${side} sidebar`
      : 'Collapse the sidebar beside the instructions';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const option = request.options.side;
    const side =
      option === 'left' || option === 'right'
        ? option
        : this._layouts.otherSide();

    if (side === 'right') {
      this._shell.collapseRight();
    } else {
      this._shell.collapseLeft();
    }

    return { status: 'ok' };
  }

  private _shell: ILabShell;
  private _layouts: LayoutManager;
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

  constructor(app: JupyterFrontEnd, layouts: LayoutManager) {
    this._app = app;
    this._layouts = layouts;
  }

  describe(): string {
    return 'Open the launcher';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const area = request.options.area;

    // JupyterLab's command always makes a new launcher pane, so bring an
    // existing one to the front instead when there is one.
    for (const widget of this._app.shell.widgets('main')) {
      const content =
        widget instanceof MainAreaWidget ? widget.content : widget;

      if (content instanceof Launcher) {
        await this._layouts.place(widget, 'document', area, {
          existed: true,
          placed: true
        });

        return { status: 'ok' };
      }
    }

    const created = (await this._app.commands.execute(
      'launcher:create'
    )) as unknown;

    if (created instanceof Widget) {
      await this._layouts.place(created, 'document', area, {
        existed: false,
        placed: false
      });
    }

    return { status: 'ok' };
  }

  private _app: JupyterFrontEnd;
  private _layouts: LayoutManager;
}
