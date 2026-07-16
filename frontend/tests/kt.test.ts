import { describe, expect, it } from "vitest";
import { KTClient } from "../src/kt/client";
import { KTHttpError, classifyRetry, retryOperation } from "../src/kt/retry";
import { parseSSEFrame, SSEParser } from "../src/kt/sse";

describe("KT SSE parser", () => {
  it("handles split UTF-8-safe frames, comments, multiline data, and cursor IDs", () => {
    const parser = new SSEParser();
    expect(parser.feed(": keep-alive\n\nid: 7\nevent: text_delta\ndata: {\"text\":\n")).toEqual([]);
    const events = parser.feed("data: \"hi\"}\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "7", event: "text_delta", sequence: 7 });
    expect(events[0].data).toEqual({ text: "hi" });
  });

  it("parses a complete KT frame and keeps non-JSON payloads as text", () => {
    expect(parseSSEFrame("id: 8\nevent: status\ndata: ready")).toMatchObject({
      id: "8",
      event: "status",
      data: "ready",
      sequence: 8,
    });
  });
});

describe("KT retry classification", () => {
  it.each([408, 429, 500, 503, 599])("retries HTTP %s", (status) => {
    expect(classifyRetry(new KTHttpError(status))).toBe("http");
  });

  it.each([400, 401, 404, 409, 422])("does not retry HTTP %s", (status) => {
    expect(classifyRetry(new KTHttpError(status))).toBe("none");
  });

  it("stops at six attempts even when a caller asks for more", async () => {
    let attempts = 0;
    await expect(retryOperation(
      async () => {
        attempts += 1;
        throw new KTHttpError(503);
      },
      { maxAttempts: 99, maxElapsedMs: 20_000, sleep: async () => {} },
    )).rejects.toBeInstanceOf(KTHttpError);
    expect(attempts).toBe(6);
  });

  it("cancels during backoff without starting another request", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pendingSleep = new Promise<void>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    pendingSleep.catch(() => undefined);
    const pending = retryOperation(
      async () => {
        attempts += 1;
        throw new KTHttpError(503);
      },
      { signal: controller.signal, sleep: () => pendingSleep },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });
});

describe("KT client fetch invocation", () => {
  it("calls fetch without binding the KTClient instance as its receiver", async () => {
    let receiver: unknown;
    const fetchImpl = function (this: unknown) {
      receiver = this;
      return Promise.resolve(new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    } as typeof fetch;
    const client = new KTClient({ fetchImpl, retry: { maxAttempts: 1 } });

    await expect(client.request("/runtime")).resolves.toEqual({ ok: true });
    expect(receiver).toBeUndefined();
  });
});
