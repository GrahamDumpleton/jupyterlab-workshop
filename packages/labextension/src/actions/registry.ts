import {
  IActionImplementation,
  IActionRegistry,
  IActionRequest,
  IActionResult,
  errorMessage
} from '../tokens';

/**
 * Registry of action implementations keyed by action type.
 */
export class ActionRegistry implements IActionRegistry {
  register(implementation: IActionImplementation): void {
    this._implementations.set(implementation.type, implementation);
  }

  has(type: string): boolean {
    return this._implementations.has(type);
  }

  describe(request: IActionRequest): string {
    const implementation = this._implementations.get(request.type);

    return implementation
      ? implementation.describe(request)
      : `Unknown action "${request.type}"`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    const implementation = this._implementations.get(request.type);

    if (!implementation) {
      return {
        status: 'error',
        message: `Unknown action type "${request.type}"`
      };
    }

    try {
      return await implementation.run(request);
    } catch (error) {
      return { status: 'error', message: errorMessage(error) };
    }
  }

  private _implementations = new Map<string, IActionImplementation>();
}

/**
 * Return a required option or throw a readable error.
 */
export function requireOption(request: IActionRequest, name: string): string {
  const value = request.options[name];

  if (!value) {
    throw new Error(`The ${request.type} action needs a "${name}" option`);
  }

  return value;
}

/**
 * Return the request body or throw when it is empty.
 */
export function requireBody(request: IActionRequest, what = 'a body'): string {
  if (request.body.trim() === '') {
    throw new Error(`The ${request.type} action needs ${what}`);
  }

  return request.body;
}
