import { parseBoundary, type KTEvent } from "../contracts";
import {
  KTHttpError,
  KTNetworkError,
  createAbortError,
  classifyRetry,
  isAbortError,
  isNetworkError,
  retryOperation,
  sleepWithCancellation,
  withCancellation,
  type RetryOptions,
} from "./retry";
import { parseSSEStream } from "./sse";
import type { z } from "zod";

export interface KTClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retry?: Omit<RetryOptions, "signal">;
}

export interface KTRequestOptions extends RequestInit {
  retry?: Omit<RetryOptions, "signal">;
}

export interface KTStreamOptions extends KTRequestOptions {
  lastEventId?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function errorFromResponse(response: Response): Promise<KTHttpError> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  return new KTHttpError(response.status, body);
}

function networkError(error: unknown): KTNetworkError | unknown {
  if (isAbortError(error)) return error;
  if (error instanceof KTNetworkError) return error;
  if (isNetworkError(error)) return new KTNetworkError("KT HTTP request failed", { cause: error });
  return error;
}

export class KTClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDefaults: Omit<RetryOptions, "signal">;

  constructor(options: KTClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "/kohaku-loom/kt";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDefaults = options.retry ?? {};
  }

  async request<T = unknown>(
    path: string,
    options: KTRequestOptions = {},
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const { retry: requestRetry, ...init } = options;
    const signal = init.signal ?? undefined;
    return retryOperation(async () => {
      let response: Response;
      try {
        const fetchImpl = this.fetchImpl;
        response = await withCancellation(fetchImpl(joinUrl(this.baseUrl, path), init), signal);
      } catch (error) {
        throw networkError(error);
      }
      if (!response.ok) throw await errorFromResponse(response);
      if (response.status === 204) return undefined as T;
      let value: unknown;
      try {
        value = await response.json();
      } catch (error) {
        throw new Error(`KT response JSON decoding failed: ${String(error)}`);
      }
      return schema ? parseBoundary(schema, value, "KT response") : value as T;
    }, {
      ...this.retryDefaults,
      ...requestRetry,
      signal,
    });
  }

  async *stream<T = unknown>(
    path: string,
    options: KTStreamOptions = {},
    schema?: z.ZodType<T>,
  ): AsyncGenerator<KTEvent & { data: T }> {
    const { retry: requestRetry, lastEventId, ...init } = options;
    const signal = init.signal ?? undefined;
    const retryOptions = { ...this.retryDefaults, ...requestRetry };
    let cursor = lastEventId;
    let attempt = 0;
    const startedAt = (retryOptions.now ?? Date.now)();
    const maxAttempts = Math.min(6, Math.max(1, retryOptions.maxAttempts ?? 6));
    const maxElapsedMs = Math.min(20_000, Math.max(0, retryOptions.maxElapsedMs ?? 20_000));

    while (true) {
      if (signal?.aborted) throw createAbortError();
      attempt += 1;
      try {
        const headers = new Headers(init.headers);
        headers.set("Accept", "text/event-stream");
        if (cursor) headers.set("Last-Event-ID", cursor);
        const fetchImpl = this.fetchImpl;
        const response = await withCancellation(
          fetchImpl(joinUrl(this.baseUrl, path), { ...init, headers }),
          signal,
        );
        if (!response.ok) throw await errorFromResponse(response);
        if (!response.body) throw new KTNetworkError("KT SSE response body is unavailable");
        for await (const event of parseSSEStream(response.body, signal)) {
          if (event.id) cursor = event.id;
          const data = schema ? parseBoundary(schema, event.data, "KT SSE payload") : event.data as T;
          yield { ...event, data };
        }
        return;
      } catch (error) {
        const normalized = networkError(error);
        if (isAbortError(normalized)) throw normalized;
        const elapsed = (retryOptions.now ?? Date.now)() - startedAt;
        const classification = classifyRetry(normalized);
        if (classification === "none" || classification === "cancelled" || attempt >= maxAttempts || elapsed >= maxElapsedMs) {
          throw normalized;
        }
        const remaining = maxElapsedMs - elapsed;
        const delay = Math.min(
          Math.max(0, retryOptions.baseDelayMs ?? 150) * 2 ** (attempt - 1),
          Math.max(retryOptions.baseDelayMs ?? 150, retryOptions.maxDelayMs ?? 2_000),
          remaining,
        );
        await sleepWithCancellation(retryOptions.sleep ?? (async (ms, retrySignal) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            retrySignal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(createAbortError());
            }, { once: true });
          });
        }), delay, signal);
      }
    }
  }
}
