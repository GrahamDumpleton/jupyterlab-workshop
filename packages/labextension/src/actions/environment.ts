import {
  IActionImplementation,
  IActionRequest,
  IActionResult,
  IWorkshopManager
} from '../tokens';

/**
 * The `environment-create` action: build the isolated environment the
 * manifest declares and register its kernel. Pages may carry it as an
 * explicit step; the panel's environment banner runs the same action.
 */
export class EnvironmentCreateAction implements IActionImplementation {
  readonly type = 'environment-create';

  constructor(manager: IWorkshopManager) {
    this._manager = manager;
  }

  describe(request: IActionRequest): string {
    const environment = this._manager.workshop?.manifest.environment;

    return environment?.requirements
      ? `Create the workshop environment from ${environment.requirements}`
      : 'Create the workshop environment';
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const before = this._manager.environment?.createdAt;
    const status = await this._manager.createEnvironment(
      request.options.force === 'true'
    );

    // An environment built earlier from the same requirements is kept, so
    // the step reads as done rather than as a second install.
    return {
      status: 'ok',
      message:
        before && before === status.createdAt
          ? `Environment already exists with kernel "${status.kernel}"`
          : `Environment ready with kernel "${status.kernel}"`
    };
  }

  private _manager: IWorkshopManager;
}
