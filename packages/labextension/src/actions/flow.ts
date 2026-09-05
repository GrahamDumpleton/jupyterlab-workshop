import {
  IActionImplementation,
  IActionRequest,
  IActionResult,
  IWorkshopManager
} from '../tokens';
import { requireOption } from './registry';

/**
 * The `choice` action: record the learner's pick, optionally as the track.
 *
 * The panel renders the options as buttons and passes the chosen value as
 * the request argument.
 */
export class ChoiceAction implements IActionImplementation {
  readonly type = 'choice';

  constructor(manager: IWorkshopManager) {
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return `Choose ${request.options.variable ?? (request.options.track === 'true' ? 'track' : 'a value')}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const value = request.argument;

    if (!value) {
      return { status: 'skipped', message: 'Pick one of the options' };
    }

    const variable =
      request.options.variable ??
      (request.options.track === 'true' ? 'track' : '');

    if (!variable) {
      return {
        status: 'error',
        message: 'The choice action needs a "variable" option'
      };
    }

    const store = this._manager.variables;

    store.set(variable, value, 'form');

    if (request.options.track === 'true' && variable !== 'track') {
      store.set('track', value, 'form');
    }

    return { status: 'ok', message: value };
  }

  private _manager: IWorkshopManager;
}

/**
 * The `env-set` action: set a variable from the workshop.
 */
export class EnvSetAction implements IActionImplementation {
  readonly type = 'env-set';

  constructor(manager: IWorkshopManager) {
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    return `Set ${request.options.name ?? '?'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const name = requireOption(request, 'name');
    const value = request.options.value ?? request.body.replace(/\n$/, '');

    this._manager.variables.set(name, value, 'capture');

    return { status: 'ok', message: value };
  }

  private _manager: IWorkshopManager;
}

/**
 * The `mark-done` action.
 */
export class MarkDoneAction implements IActionImplementation {
  readonly type = 'mark-done';

  constructor(manager: IWorkshopManager) {
    this._manager = manager;
  }

  describe(): string {
    return 'Mark this page done';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    this._manager.markDone(request.page);

    return { status: 'ok' };
  }

  private _manager: IWorkshopManager;
}

/**
 * The `next-page` action.
 */
export class NextPageAction implements IActionImplementation {
  readonly type = 'next-page';

  constructor(manager: IWorkshopManager) {
    this._manager = manager;
  }

  describe(): string {
    return 'Go to the next page';
  }

  async run(): Promise<IActionResult> {
    this._manager.next();

    return { status: 'ok' };
  }

  private _manager: IWorkshopManager;
}
