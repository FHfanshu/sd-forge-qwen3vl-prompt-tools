export const DEFAULT_MAX_ATTEMPTS = 6;
export const DEFAULT_MAX_ELAPSED_MS = 20_000;

export type RetryClassification = "network" | "http" | "none" | "cancelled";

export class KTNetworkError extends Error {
  readonly kind = "network" as const;

  constructor(message = "Kohaku Terrarium network request failed", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "KTNetworkError";
  }
}

export class KTHttpError extends Error {
  readonly kind = "http" as const;
  readonly status: number;
  readonly body: string;

  constructor(status: number, body = "") {
    super(body || `Kohaku Terrarium request failed with HTTP ${status}`);
    this.name = "KTHttpError";
    this.status = status;
    this.body = body;
  }
}

export function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError"
  );
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500 && status <= 599;
}

export function isNetworkError(error: unknown): boolean {
  return (
    error instanceof KTNetworkError ||
    error instanceof TypeError ||
    error instanceof Error && ["NetworkError", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(error.name)
  );
}

export async function sleepWithCancellation(
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>,
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await sleep(delayMs);
    return;
  }
  if (signal.aborted) throw createAbortError();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => finish(() => reject(createAbortError()));
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(sleep(delayMs, signal)).then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

export async function withCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw createAbortError();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(createAbortError()));

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

export function classifyRetry(error: unknown): RetryClassification {
  if (isAbortError(error)) return "cancelled";
  if (error instanceof KTHttpError) return isRetryableHttpStatus(error.status) ? "http" : "none";
  if (isNetworkError(error)) return "network";
  return "none";
}

export interface RetryOptions {
  signal?: AbortSignal;
  maxAttempts?: number;
  maxElapsedMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

async function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(createAbortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function retryOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.min(
    DEFAULT_MAX_ATTEMPTS,
    Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
  );
  const maxElapsedMs = Math.min(
    DEFAULT_MAX_ELAPSED_MS,
    Math.max(0, options.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS),
  );
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 150);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 2_000);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let attempt = 0;

  while (true) {
    throwIfAborted(options.signal);
    attempt += 1;
    try {
      return await withCancellation(operation(attempt), options.signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      const classification = classifyRetry(error);
      const elapsed = now() - startedAt;
      if (
        classification === "none" ||
        classification === "cancelled" ||
        attempt >= maxAttempts ||
        elapsed >= maxElapsedMs
      ) {
        throw error;
      }
      const remaining = maxElapsedMs - elapsed;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs, remaining);
      await sleepWithCancellation(sleep, delay, options.signal);
    }
  }
}
