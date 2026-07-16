import { ktEventSchema, parseBoundary, type KTEvent } from "../contracts";
import { KTNetworkError, createAbortError } from "./retry";

function decodeData(rawData: string): unknown {
  try {
    return JSON.parse(rawData);
  } catch {
    return rawData;
  }
}

export class SSEParser {
  private buffer = "";
  private eventName = "";
  private eventId = "";
  private dataLines: string[] = [];

  feed(chunk: string): KTEvent[] {
    this.buffer += chunk;
    const events: KTEvent[] = [];
    let lineEnd = this.findLineEnd();
    while (lineEnd) {
      const { end, next } = lineEnd;
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(next);
      this.consumeLine(line, events);
      lineEnd = this.findLineEnd();
    }
    return events;
  }

  finish(): KTEvent[] {
    const events: KTEvent[] = [];
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer.replace(/\r$/, ""), events);
      this.buffer = "";
    }
    this.dispatch(events);
    return events;
  }

  private findLineEnd(): { end: number; next: number } | null {
    const newline = this.buffer.indexOf("\n");
    const carriage = this.buffer.indexOf("\r");
    if (newline < 0 && carriage < 0) return null;
    if (carriage >= 0 && (newline < 0 || carriage < newline)) {
      return { end: carriage, next: this.buffer[carriage + 1] === "\n" ? carriage + 2 : carriage + 1 };
    }
    return { end: newline, next: newline + 1 };
  }

  private consumeLine(line: string, events: KTEvent[]): void {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") this.eventName = value;
    else if (field === "id") this.eventId = value;
    else if (field === "data") this.dataLines.push(value);
  }

  private dispatch(events: KTEvent[]): void {
    if (this.dataLines.length === 0) {
      this.eventName = "";
      return;
    }
    const rawData = this.dataLines.join("\n");
    const candidate = {
      id: this.eventId || undefined,
      event: this.eventName || "message",
      data: decodeData(rawData),
      rawData,
      sequence: /^\d+$/.test(this.eventId) ? Number(this.eventId) : undefined,
    };
    events.push(parseBoundary(ktEventSchema, candidate, "KT SSE event"));
    this.eventName = "";
    this.dataLines = [];
  }
}

export function parseSSEFrame(frame: string): KTEvent | null {
  const parser = new SSEParser();
  const events = parser.feed(`${frame}\n\n`);
  return events[0] ?? null;
}

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<KTEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw createAbortError();
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal?.aborted) throw createAbortError();
        throw new KTNetworkError("KT SSE stream read failed", { cause: error });
      }
      if (signal?.aborted) throw createAbortError();
      if (result.done) break;
      for (const event of parser.feed(decoder.decode(result.value, { stream: true }))) yield event;
    }
    if (signal?.aborted) throw createAbortError();
    for (const event of parser.feed(decoder.decode())) yield event;
    for (const event of parser.finish()) yield event;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    if (signal?.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
