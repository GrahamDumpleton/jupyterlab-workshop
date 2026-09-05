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
 * Parse a duration such as `1500ms`, `2s` or `3` (seconds) into milliseconds.
 */
export function parseDuration(
  value: string | undefined,
  fallbackMs: number
): number {
  if (value === undefined || value.trim() === '') {
    return fallbackMs;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s)?$/.exec(value.trim());

  if (!match) {
    return fallbackMs;
  }

  const amount = Number(match[1]);

  return match[2] === 'ms' ? amount : amount * 1000;
}
