/**
 * Error raised when a workshop manifest or page does not follow the
 * workshop format.
 */
export class WorkshopFormatError extends Error {
  /** Path of the file the error was found in, when known. */
  readonly path: string | undefined;

  /** One-based line number the error was found at, when known. */
  readonly line: number | undefined;

  constructor(message: string, path?: string, line?: number) {
    const location = path ? `${path}${line ? `:${line}` : ''}: ` : '';

    super(`${location}${message}`);

    this.name = 'WorkshopFormatError';
    this.path = path;
    this.line = line;
  }
}
