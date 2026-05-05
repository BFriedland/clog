import { vi } from "vitest";

export interface CapturedOutput {
  stdout: string;
  stderr: string;
}

export interface CapturedOutputWithError extends CapturedOutput {
  error: unknown;
}

export async function captureOutput(fn: () => Promise<void>): Promise<CapturedOutput> {
  const result = await captureOutputWithError(fn);
  if (result.error) {
    throw result.error;
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function captureOutputWithError(
  fn: () => Promise<void>,
): Promise<CapturedOutputWithError> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let error: unknown = null;

  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown, ...rest: unknown[]): boolean => {
      stdoutChunks.push(formatStreamChunk(chunk));
      invokeWriteCallback(rest);
      return true;
    }) as typeof process.stdout.write);

  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown, ...rest: unknown[]): boolean => {
      stderrChunks.push(formatStreamChunk(chunk));
      invokeWriteCallback(rest);
      return true;
    }) as typeof process.stderr.write);

  try {
    await fn();
  } catch (caught) {
    error = caught;
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    error,
  };
}

function formatStreamChunk(chunk: unknown): string {
  return typeof chunk === "string"
    ? chunk
    : Buffer.from(chunk as Uint8Array).toString("utf8");
}

function invokeWriteCallback(args: unknown[]): void {
  const callback = args[args.length - 1];
  if (typeof callback === "function") {
    (callback as () => void)();
  }
}
