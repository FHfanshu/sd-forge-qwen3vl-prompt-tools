import { describe, expect, it, vi } from "vitest";
import { LoomRuntimeController } from "../src/runtime-controller";
import { useRuntimeStore } from "../src/stores/runtime";

function controllerWith(
  kt: Promise<unknown>,
  legacy: Promise<unknown>,
): LoomRuntimeController {
  const host = { listLegacySessions: vi.fn(() => legacy) } as never;
  const client = { request: vi.fn(() => kt) } as never;
  return new LoomRuntimeController(host, client);
}

describe("runtime session history", () => {
  it("keeps legacy sessions visible when the KT sidecar is unavailable", async () => {
    const controller = controllerWith(
      Promise.reject(new Error("sidecar unavailable")),
      Promise.resolve({ sessions: [{ session_id: "legacy-1", title: "Legacy chat" }] }),
    );

    const rows = await controller.loadHistory();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "legacy-1", source: "legacy", title: "Legacy chat" });
    expect(useRuntimeStore.getState().history).toEqual(rows);
  });

  it("keeps KT sessions visible when the legacy reader is unavailable", async () => {
    const controller = controllerWith(
      Promise.resolve({ sessions: [{ session_id: "kt-1", title: "KT chat" }] }),
      Promise.reject(new Error("legacy reader unavailable")),
    );

    const rows = await controller.loadHistory();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "kt-1", source: "KT", title: "KT chat" });
  });

  it("uses a readable placeholder while a KT title is still pending", async () => {
    const controller = controllerWith(
      Promise.resolve({ sessions: [{ session_id: "kt-1", status: "pending" }] }),
      Promise.resolve({ sessions: [] }),
    );

    const rows = await controller.loadHistory();

    expect(rows[0]).toMatchObject({ id: "kt-1", title: "Untitled session" });
  });

  it("refreshes the archive when async metadata generation publishes an event", async () => {
    const abort = new AbortController();
    const request = vi.fn(() => Promise.resolve({ sessions: [{ session_id: "kt-1", title: "Updated title" }] }));
    const stream = vi.fn(async function* (_path: string, options: { signal?: AbortSignal }) {
      yield { sequence: 1, event: "message", data: { type: "session_metadata_updated" } };
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    });
    const host = { listLegacySessions: vi.fn(() => Promise.resolve({ sessions: [] })) } as never;
    const client = { request, stream } as never;
    const controller = new LoomRuntimeController(host, client);

    const task = (controller as unknown as { consumeHistoryEvents(signal: AbortSignal): Promise<void> }).consumeHistoryEvents(abort.signal);
    await vi.waitFor(() => expect(useRuntimeStore.getState().history[0]).toMatchObject({ title: "Updated title" }));

    abort.abort();
    await task;
    expect(stream).toHaveBeenCalledWith("/turns/events", expect.objectContaining({ lastEventId: "0" }));
    expect(request).toHaveBeenCalledTimes(1);
  });
});
