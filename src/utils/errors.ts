export class ClogError extends Error {
  readonly exitCode: number;

  constructor(message: string, options: { exitCode?: number } = {}) {
    super(message);
    this.name = "ClogError";
    this.exitCode = options.exitCode ?? 1;
  }
}

export class UsageError extends ClogError {
  constructor(message: string) {
    super(message, { exitCode: 2 });
    this.name = "UsageError";
  }
}
