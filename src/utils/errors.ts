export class ClogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClogError";
  }
}
