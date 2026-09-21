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

    // The manager stores what an action reports as captured and holds
    // the action until open terminals have the values, so the next
    // command never runs against the old ones.
    const captured: Record<string, string> = { [variable]: value };

    if (request.options.track === 'true') {
      captured.track = value;
    }

    return {
      status: 'ok',
      message: value,
      captured,
      captureSource: 'form'
    };
  }
}

/**
 * The `env-set` action: set a variable from the workshop.
 */
export class EnvSetAction implements IActionImplementation {
  readonly type = 'env-set';

  describe(request: IActionRequest): string {
    return `Set ${request.options.name ?? '?'}`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const name = requireOption(request, 'name');
    const value = request.options.value ?? request.body.replace(/\n$/, '');

    // Reported as captured, not stored here, so that the manager holds
    // the action until open terminals have loaded the value.
    return { status: 'ok', message: value, captured: { [name]: value } };
  }
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
