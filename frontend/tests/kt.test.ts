import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { KTClient } from "../src/kt/client";
import { KTHttpError, classifyRetry, retryOperation } from "../src/kt/retry";
import { parseSSEFrame, parseSSEStream, SSEParser } from "../src/kt/sse";

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

  it("does not retry non-idempotent requests by default", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("connection reset"); }) as typeof fetch;
    const client = new KTClient({ fetchImpl, retry: { maxAttempts: 6, baseDelayMs: 0, sleep: async () => {} } });

    await expect(client.request("/sessions/open", { method: "POST" })).rejects.toThrow("KT HTTP request failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("decodes multibyte UTF-8 characters split across stream chunks", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('id: 1\nevent: text_delta\ndata: {"text":"'),
      encoder.encode("你").slice(0, 1),
      encoder.encode("你").slice(1),
      encoder.encode('好"}\n\n'),
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseSSEStream(body)) events.push(event);

    expect(events[0]).toMatchObject({ id: "1", data: { text: "你好" } });
  });

  it("resumes an interrupted SSE request from the latest event cursor", async () => {
    const encoder = new TextEncoder();
    const calls: RequestInit[] = [];
    let attempt = 0;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      attempt += 1;
      if (attempt === 1) {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(encoder.encode('id: 5\ndata: {"text":"partial"}\n\n'));
            else controller.error(new TypeError("connection reset"));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return Promise.resolve(new Response('id: 6\ndata: {"text":"done"}\n\n', { status: 200 }));
    }) as typeof fetch;
    const client = new KTClient({ fetchImpl });
    const events = [];
    for await (const event of client.stream("/turns/events", { lastEventId: "3", retry: { maxAttempts: 2, baseDelayMs: 0, sleep: async () => {} } })) {
      events.push(event);
    }

    expect(events.map((event) => event.id)).toEqual(["5", "6"]);
    expect(new Headers(calls[1].headers).get("Last-Event-ID")).toBe("5");
  });
});
