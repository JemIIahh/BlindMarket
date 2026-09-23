/** A failure the CLI explains itself: printed as `code: message`, exit 1. */
export class CliError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'CliError';
  }
}
