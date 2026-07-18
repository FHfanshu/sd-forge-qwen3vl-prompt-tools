import { describe, expect, it, vi } from "vitest";
import { LoomRuntimeController } from "../src/runtime-controller";
import { useChatStore } from "../src/stores/chat";
import { useRuntimeStore } from "../src/stores/runtime";
import { KTHttpError } from "../src/kt/retry";

function controllerWith(
  kt: Promise<unknown>,
  legacy: Promise<unknown>,
): LoomRuntimeController {
  const host = { listLegacySessions: vi.fn(() => legacy) } as never;
  const client = { request: vi.fn(() => kt) } as never;
  return new LoomRuntimeController(host, client);
}

describe("runtime session history", () => {
  it("reports startup state while syncing profiles and becomes ready after history loads", async () => {
    useRuntimeStore.getState().reset();
    const abort = new AbortController();
    const host = {
      profileStore: { load: vi.fn(() => ({ profiles: [] })) },
      syncProfiles: vi.fn(() => Promise.resolve({})),
      listLegacySessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    } as never;
    const client = {
      request: vi.fn(() => Promise.resolve({ sessions: [] })),
      stream: vi.fn(async function* (_path: string, options: { signal?: AbortSignal }) {
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);

    const mounting = controller.mount();
    expect(useRuntimeStore.getState().startup).toBe("starting");
    await mounting;

    expect(useRuntimeStore.getState().startup).toBe("ready");
    controller.destroy();
    abort.abort();
  });

  it("can retry a failed startup before the next history load", async () => {
    useRuntimeStore.getState().reset();
    let syncCalls = 0;
    const host = {
      profileStore: { load: vi.fn(() => ({ profiles: [] })) },
      syncProfiles: vi.fn(() => {
        syncCalls += 1;
        return syncCalls === 1 ? Promise.reject(new Error("sidecar starting")) : Promise.resolve({});
      }),
      listLegacySessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    } as never;
    const client = {
      request: vi.fn(() => Promise.resolve({ sessions: [] })),
      stream: vi.fn(async function* (_path: string, options: { signal?: AbortSignal }) {
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);

    await controller.mount();
    expect(useRuntimeStore.getState().startup).toBe("error");
    await controller.mount();

    expect(syncCalls).toBe(2);
    expect(useRuntimeStore.getState().startup).toBe("ready");
    controller.destroy();
  });

  it("routes edited composer sends through native edit-and-rerun and restores version metadata", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });
    useChatStore.getState().setMessages([
      { id: "user-1", role: "user", content: "Original", status: "complete", attachments: [], branchIndex: 0, branchCount: 1, branchTurnIndex: 1, createdAt: 1 },
      { id: "assistant-1", role: "assistant", content: "Old answer", status: "complete", attachments: [], branchIndex: 0, branchCount: 1, branchTurnIndex: 1, createdAt: 2 },
    ]);
    const host = { restoreForgeState: vi.fn() } as never;
    let selectedOriginal = false;
    const request = vi.fn((path: string, _options?: RequestInit) => {
      if (path === "/sessions/kt-1/edit-rerun") return Promise.resolve({
        branch_view: { "1": 2 },
        turns: [{ turn_index: 1, branches: [1, 2], selected_branch_id: 2, user_groups: [{ content: "Original", branches: [1] }, { content: "Edited", branches: [2] }], selected_user_group_index: 1 }],
      });
      if (path === "/sessions/kt-1/branch-view") {
        selectedOriginal = true;
        return Promise.resolve({ branch_view: { "1": 1 }, turns: [{ turn_index: 1, branches: [1, 2], selected_branch_id: 1, user_groups: [{ content: "Original", branches: [1] }, { content: "Edited", branches: [2] }], selected_user_group_index: 0 }] });
      }
      if (path === "/sessions/kt-1") return Promise.resolve({
        branches: { branch_view: { "1": selectedOriginal ? 1 : 2 }, turns: [{ turn_index: 1, branches: [1, 2], selected_branch_id: selectedOriginal ? 1 : 2, user_groups: [{ content: "Original", branches: [1] }, { content: "Edited", branches: [2] }], selected_user_group_index: selectedOriginal ? 0 : 1 }] },
        messages: selectedOriginal
          ? [{ role: "user", content: "Original" }, { role: "assistant", content: "Old answer" }]
          : [{ role: "user", content: "Edited" }, { role: "assistant", content: "New answer" }],
      });
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController(host, { request } as never);

    await controller.sendMessage({ text: "Edited", attachments: [], riskMode: "normal", reasoning: "low", editOf: "user-1" });

    expect(request).toHaveBeenNthCalledWith(1, "/sessions/kt-1/edit-rerun", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ content: "Edited", turn_index: 1, user_position: 0 });
    expect(useChatStore.getState().messages[0]).toMatchObject({ content: "Edited", branchIndex: 1, branchCount: 2, branchTurnIndex: 1 });
    expect(useChatStore.getState().messages[1]).toMatchObject({ content: "New answer", branchCount: 1 });
    expect(request.mock.calls.some(([path]) => path === "/turns")).toBe(false);

    await controller.changeBranch(useChatStore.getState().messages[0], 0);

    const branchRequest = request.mock.calls.find(([path]) => path === "/sessions/kt-1/branch-view");
    expect(JSON.parse(String(branchRequest?.[1]?.body))).toMatchObject({ branch_view: { "1": 1 } });
    expect(useChatStore.getState().messages[0]).toMatchObject({ content: "Original", branchIndex: 0, branchCount: 2 });
    expect(useChatStore.getState().messages[1]).toMatchObject({ content: "Old answer" });
  });

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

  it("normalizes fractional sidecar queue timestamps to integer milliseconds", () => {
    useChatStore.getState().reset();
    const controller = new LoomRuntimeController({} as never, {} as never);
    const internals = controller as unknown as { syncQueue(messages: unknown[]): void };

    internals.syncQueue([{ message_id: "queued-1", display_content: "Follow up", state: "pending", created_at: 1_700_000_000.125 }]);

    expect(useChatStore.getState().queue[0].createdAt).toBe(1_700_000_000_125);
  });

  it("keeps queue text when normalized messages pass through the reducer", () => {
    useChatStore.getState().reset();
    const controller = new LoomRuntimeController({} as never, {} as never);
    const internals = controller as unknown as { applyQueueMessage(message: unknown): void };

    internals.applyQueueMessage({ id: "queued-1", text: "Queued follow-up", attachments: [], state: "pending", createdAt: 1 });

    expect(useChatStore.getState().queue[0]).toMatchObject({ id: "queued-1", text: "Queued follow-up" });
  });

  it("serializes queued images once in create and edit request bodies", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });
    const dataUrl = "data:image/png;base64,AQIDBA==";
    const attachment = { id: "image-1", name: "reference.png", dataUrl, mimeType: "image/png", size: 4 };
    const request = vi.fn((path: string, options?: RequestInit) => {
      if (path === "/sessions/kt-1/messages") return Promise.resolve({ message: { message_id: "queued-1", display_content: "Queued", content: JSON.parse(String(options?.body)).content, state: "pending", created_at: 1 } });
      if (path === "/sessions/kt-1/messages/queued-1") return Promise.resolve({ message: { message_id: "queued-1", display_content: "Edited", content: JSON.parse(String(options?.body)).content, state: "pending", created_at: 1 } });
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController({} as never, { request } as never);
    (controller as unknown as { activeRun: { finished: boolean } }).activeRun = { finished: false };

    await controller.sendMessage({ text: "Queued", attachments: [attachment], riskMode: "normal", reasoning: "low" });
    await controller.editQueuedMessage("queued-1", { text: "Edited", attachments: [attachment], riskMode: "normal", reasoning: "low" });

    for (const [, options] of request.mock.calls) {
      const body = JSON.parse(String(options?.body));
      expect(body).not.toHaveProperty("attachments");
      expect(JSON.stringify(body).split(dataUrl)).toHaveLength(2);
      expect(body.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "image_url", image_url: { url: dataUrl, detail: "high" } }),
      ]));
    }
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

  it("renders archived tool results as compact tool cards instead of raw JSON", async () => {
    useChatStore.getState().reset();
    const host = {
      getLegacySession: vi.fn(() => Promise.resolve({
        events: [
          { event_type: "user_message", payload: { content: "Review this prompt" } },
          { event_type: "assistant_message", payload: { content: "", tool_calls: [{ tool: "read_prompt" }] } },
          { event_type: "tool_result", payload: { tool: "read_prompt", result: { ok: true }, content: '{"prompt":"secret raw payload"}' } },
          { event_type: "tool_result", payload: { tool: "ask_teacher", result: { ok: false, error: "https://private.invalid failed" } } },
        ],
      })),
    } as never;
    const controller = new LoomRuntimeController(host, {} as never);

    await controller.actions.selectHistory({ id: "legacy-1", source: "legacy", title: "Archive", preview: "", updatedAt: "now", messageCount: 4 });

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "user", content: "Review this prompt" });
    expect(messages[1]).toMatchObject({ role: "tool", content: "", tool: { name: "read_prompt", status: "complete" } });
    expect(messages[2]).toMatchObject({ role: "tool", content: "", status: "error", tool: { name: "ask_teacher", status: "error" } });
    expect(JSON.stringify(messages)).not.toContain("private.invalid");
    expect(JSON.stringify(messages)).not.toContain("secret raw payload");
  });

  it("keeps internal system prompts out of restored KT conversations", async () => {
    useChatStore.getState().reset();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    const host = {
      assistantConfig: vi.fn(() => ({ profile_id: "local" })),
      syncProfiles: vi.fn(() => Promise.resolve({})),
      profileStore: { load: vi.fn(() => ({ profiles: [] })), requestProjection: vi.fn(() => ({})) },
    } as never;
    const client = {
      request: vi.fn((path: string) => {
        if (path === "/profiles/import") return Promise.resolve({});
        if (path === "/sessions/open") return Promise.resolve({ session: { session_id: "kt-1" } });
        if (path === "/sessions/kt-1") return Promise.resolve({
          messages: [
            { id: "system", role: "system", content: "private runtime instructions" },
            { id: "user", role: "user", content: "Hello", created_at: 1_700_000_000.25 },
            { id: "assistant", role: "assistant", content: "Hi", created_at: 1_700_000_001.75 },
          ],
        });
        if (path === "/runtime") return Promise.resolve({});
        throw new Error(`unexpected path: ${path}`);
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);

    await controller.openSession("kt-1", true);

    expect(useChatStore.getState().messages.map((message) => message.content)).toEqual(["Hello", "Hi"]);
    expect(useChatStore.getState().messages.map((message) => message.createdAt)).toEqual([1_700_000_000_250, 1_700_000_001_750]);
    vi.unstubAllGlobals();
  });

  it("persists the Svelte risk mode to an active KT session", async () => {
    const request = vi.fn(() => Promise.resolve({ session: { session_id: "kt-1", agent_mode: "yolo" } }));
    const controller = new LoomRuntimeController({} as never, { request } as never);
    useRuntimeStore.getState().setSession({ session_id: "kt-1", agent_mode: "normal" });

    await controller.actions.setRiskMode("yolo");

    expect(request).toHaveBeenCalledWith("/sessions/kt-1/mode", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ agent_mode: "yolo" }),
    }));
    expect(useRuntimeStore.getState().session?.agent_mode).toBe("yolo");
  });

  it("closes any remote active session before creating a fresh one", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    const host = {
      assistantConfig: vi.fn(() => ({ profile_id: "local" })),
      syncProfiles: vi.fn(() => Promise.resolve({})),
    } as never;
    const request = vi.fn((path: string) => {
      if (path === "/sessions/close") return Promise.resolve({ ok: true });
      if (path === "/sessions/open") return Promise.resolve({ session: { session_id: "fresh" } });
      if (path === "/sessions/fresh") return Promise.resolve({ messages: [] });
      if (path === "/runtime") return Promise.resolve({ active_session: { session_id: "fresh" } });
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController(host, { request } as never);

    await controller.newSession();

    expect(request.mock.calls.slice(0, 3)).toEqual([
      ["/runtime"],
      ["/sessions/close", { method: "POST" }],
      ["/sessions/open", expect.objectContaining({ method: "POST" })],
    ]);
    expect(useRuntimeStore.getState().sessionId).toBe("fresh");
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("adopts the sidecar active session instead of opening a duplicate", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    const request = vi.fn((path: string) => {
      if (path === "/runtime") return Promise.resolve({ active_session: { session_id: "surviving", agent_mode: "normal" } });
      if (path === "/sessions/surviving") return Promise.resolve({ messages: [] });
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController({} as never, { request } as never);

    const sessionId = await (controller as unknown as { ensureSession(): Promise<string> }).ensureSession();

    expect(sessionId).toBe("surviving");
    expect(useRuntimeStore.getState().sessionId).toBe("surviving");
    expect(request.mock.calls.some(([path]) => path === "/sessions/open")).toBe(false);
  });

  it("resumes a matching active history session without closing or reopening it", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    const request = vi.fn((path: string) => {
      if (path === "/runtime") return Promise.resolve({ active_session: { session_id: "kt-1", agent_mode: "normal" } });
      if (path === "/sessions/kt-1") return Promise.resolve({ messages: [{ role: "user", content: "restored" }] });
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController({ syncProfiles: vi.fn(() => Promise.resolve()) } as never, { request } as never);

    await controller.openSession("kt-1", true);

    expect(request.mock.calls.some(([path]) => path === "/sessions/close")).toBe(false);
    expect(request.mock.calls.some(([path]) => path === "/sessions/open")).toBe(false);
    expect(useChatStore.getState().messages[0]).toMatchObject({ role: "user", content: "restored" });
  });

  it("closes a different server session before resuming history", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    const host = { syncProfiles: vi.fn(() => Promise.resolve()), assistantConfig: vi.fn(() => ({ profile_id: "mock" })) } as never;
    const request = vi.fn((path: string) => {
      if (path === "/runtime") return Promise.resolve({ active_session: { session_id: "old" } });
      if (path === "/sessions/close") return Promise.resolve({});
      if (path === "/sessions/open") return Promise.resolve({ session: { session_id: "kt-2" } });
      if (path === "/sessions/kt-2") return Promise.resolve({ messages: [] });
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController(host, { request } as never);

    await controller.openSession("kt-2", true);

    expect(request.mock.calls.slice(0, 3).map(([path]) => path)).toEqual(["/runtime", "/sessions/close", "/sessions/open"]);
    expect(useRuntimeStore.getState().sessionId).toBe("kt-2");
  });

  it("ignores a session response that arrives after destroy", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    let resolveOpen!: (value: unknown) => void;
    const open = new Promise((resolve) => { resolveOpen = resolve; });
    const host = { syncProfiles: vi.fn(() => Promise.resolve()), assistantConfig: vi.fn(() => ({ profile_id: "mock" })) } as never;
    const request = vi.fn((path: string) => {
      if (path === "/runtime") return Promise.resolve({ active_session: null });
      if (path === "/sessions/open") return open;
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController(host, { request } as never);

    const opening = controller.openSession("late", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("/sessions/open", expect.anything()));
    controller.destroy();
    resolveOpen({ session: { session_id: "late" } });

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(useRuntimeStore.getState().sessionId).toBeNull();
  });

  it("recovers a conflicting open by adopting the matching server session", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    let runtimeCalls = 0;
    const host = { syncProfiles: vi.fn(() => Promise.resolve()), assistantConfig: vi.fn(() => ({ profile_id: "mock" })) } as never;
    const request = vi.fn((path: string) => {
      if (path === "/runtime") {
        runtimeCalls += 1;
        return runtimeCalls === 1 ? Promise.reject(new Error("probe failed")) : Promise.resolve({ active_session: { session_id: "kt-1" } });
      }
      if (path === "/sessions/open") return Promise.reject(new KTHttpError(409, "active session"));
      if (path === "/sessions/kt-1") return Promise.resolve({ messages: [] });
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController(host, { request } as never);

    await controller.openSession("kt-1", true);

    expect(useRuntimeStore.getState().sessionId).toBe("kt-1");
    expect(request.mock.calls.some(([path]) => path === "/sessions/close")).toBe(false);
  });

  it("recovers a conflicting open by closing a different server session and retrying once", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    let runtimeCalls = 0;
    let openCalls = 0;
    const host = { syncProfiles: vi.fn(() => Promise.resolve()), assistantConfig: vi.fn(() => ({ profile_id: "mock" })) } as never;
    const request = vi.fn((path: string) => {
      if (path === "/runtime") {
        runtimeCalls += 1;
        if (runtimeCalls === 1) return Promise.reject(new Error("probe failed"));
        if (runtimeCalls === 2) return Promise.resolve({ active_session: { session_id: "other" } });
        return Promise.resolve({ active_session: { session_id: "kt-2" } });
      }
      if (path === "/sessions/open") {
        openCalls += 1;
        return openCalls === 1 ? Promise.reject(new KTHttpError(409, "active session")) : Promise.resolve({ session: { session_id: "kt-2" } });
      }
      if (path === "/sessions/close") return Promise.resolve({});
      if (path === "/sessions/kt-2") return Promise.resolve({ messages: [] });
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController(host, { request } as never);

    await controller.openSession("kt-2", true);

    expect(openCalls).toBe(2);
    expect(request.mock.calls.filter(([path]) => path === "/sessions/close")).toHaveLength(1);
    expect(useRuntimeStore.getState().sessionId).toBe("kt-2");
  });

  it("coalesces streaming deltas into one render per animation frame", async () => {
    useChatStore.getState().reset();
    const renders: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      renders.push(callback);
      return 1;
    }));
    const controller = new LoomRuntimeController({} as never, {} as never);
    const internals = controller as unknown as {
      createRun(requestId: string): unknown;
      handleTurnEvent(run: unknown, event: Record<string, unknown>): Promise<void>;
    };
    const run = internals.createRun("stream");

    await internals.handleTurnEvent(run, { type: "text_delta", payload: { text: "a" } });
    await internals.handleTurnEvent(run, { type: "text_delta", payload: { text: "b" } });

    expect(useChatStore.getState().messages.at(-1)?.content).toBe("a");
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    renders[0](16);
    expect(useChatStore.getState().messages.at(-1)?.content).toBe("ab");
    vi.unstubAllGlobals();
  });

  it("reports the active tool while it is running", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    let release!: (value: unknown) => void;
    const result = new Promise((resolve) => { release = resolve; });
    const host = { executeTool: vi.fn(() => result) } as never;
    const client = { request: vi.fn(() => Promise.resolve({})) } as never;
    const controller = new LoomRuntimeController(host, client);
    const internals = controller as unknown as {
      createRun(requestId: string): unknown;
      handleToolEvent(run: unknown, event: Record<string, unknown>): Promise<void>;
    };
    const run = internals.createRun("tool-run");
    (run as { accepted: boolean }).accepted = true;
    useChatStore.getState().beginRequest("tool-run");
    useRuntimeStore.getState().setWorking("thinking");

    const pending = internals.handleToolEvent(run, { type: "tool_request", payload: { request_id: "request-1", tool: "read_prompt", arguments: {} } });
    expect(useRuntimeStore.getState()).toMatchObject({ workingPhase: "tool", workingTool: "read_prompt" });
    release({ ok: true });
    await pending;

    expect(useRuntimeStore.getState()).toMatchObject({ workingPhase: "thinking", workingTool: null });
    useChatStore.getState().cancelRequest();
    useRuntimeStore.getState().reset();
  });

  it("does not let a stale terminal event finish a newly accepted turn", async () => {
    useChatStore.getState().reset();
    const host = {
      claimToolBridge: vi.fn(() => Promise.resolve({ owned: true, bridge_id: "bridge" })),
      assistantConfig: vi.fn(() => ({ timeout: 120 })),
      captureForgeState: vi.fn(() => ({})),
    } as never;
    const client = {
      request: vi.fn((path: string) => {
        if (path === "/runtime") return Promise.resolve({ turn_event_sequence: 0, tool_event_sequence: 0 });
        if (path === "/turns") return Promise.resolve({ turn_id: "new-turn" });
        throw new Error(`unexpected path: ${path}`);
      }),
      stream: vi.fn(async function* (path: string) {
        if (path === "/turns/events") {
          yield { sequence: 1, data: { type: "turn_ended", payload: { turn_id: "old-turn", status: "completed", text: "old" } } };
          yield { sequence: 2, data: { type: "text_delta", payload: { turn_id: "new-turn", text: "new" } } };
          yield { sequence: 3, data: { type: "turn_ended", payload: { turn_id: "new-turn", status: "completed", text: "new" } } };
        }
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });

    await controller.sendMessage({ text: "hello", attachments: [], riskMode: "normal", reasoning: "low" });

    await vi.waitFor(() => expect(useChatStore.getState().activeRequestId).toBeNull());
    expect(useChatStore.getState().messages.some((message) => message.role === "assistant" && message.content === "old")).toBe(false);
    expect(useChatStore.getState().messages.some((message) => message.role === "assistant" && message.content === "new" && message.status === "complete")).toBe(true);
  });

  it("keeps an active turn alive when its SSE connection drops", async () => {
    useChatStore.getState().reset();
    let turnStreamCalls = 0;
    const host = {
      claimToolBridge: vi.fn(() => Promise.resolve({ owned: true, bridge_id: "bridge" })),
      assistantConfig: vi.fn(() => ({ timeout: 120 })),
      captureForgeState: vi.fn(() => ({})),
    } as never;
    const client = {
      request: vi.fn((path: string) => {
        if (path === "/runtime") return Promise.resolve(turnStreamCalls > 1
          ? { active_turn_id: "", last_turn: { turn_id: "turn-1", status: "completed", text: "recovered" } }
          : { active_turn_id: "turn-1", active_turn: { turn_id: "turn-1", text: "partial" }, turn_event_sequence: 0, tool_event_sequence: 0 });
        if (path === "/turns") return Promise.resolve({ turn_id: "turn-1" });
        throw new Error(`unexpected path: ${path}`);
      }),
      stream: vi.fn(async function* (path: string) {
        if (path === "/tools/events") return;
        turnStreamCalls += 1;
        if (turnStreamCalls === 1) throw new TypeError("connection reset");
        yield { sequence: 2, data: { type: "turn_ended", payload: { turn_id: "turn-1", status: "completed", text: "recovered" } } };
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });

    await controller.sendMessage({ text: "hello", attachments: [], riskMode: "normal", reasoning: "low" });

    await vi.waitFor(() => expect(useChatStore.getState().activeRequestId).toBeNull());
    expect(turnStreamCalls).toBe(2);
    expect(useChatStore.getState().messages.some((message) => message.role === "assistant" && message.content === "recovered" && message.status === "complete")).toBe(true);
  });

  it("recovers an active turn after a clean SSE EOF without a terminal event", async () => {
    useChatStore.getState().reset();
    let turnStreamCalls = 0;
    const host = {
      claimToolBridge: vi.fn(() => Promise.resolve({ owned: true, bridge_id: "bridge" })),
      assistantConfig: vi.fn(() => ({ timeout: 120 })),
      captureForgeState: vi.fn(() => ({})),
    } as never;
    const client = {
      request: vi.fn((path: string) => {
        if (path === "/runtime") return Promise.resolve(turnStreamCalls > 1
          ? { active_turn_id: "", last_turn: { turn_id: "turn-eof", status: "completed", text: "recovered after EOF" } }
          : { active_turn_id: "turn-eof", active_turn: { turn_id: "turn-eof", text: "partial" }, turn_event_sequence: 0, tool_event_sequence: 0 });
        if (path === "/turns") return Promise.resolve({ turn_id: "turn-eof" });
        throw new Error(`unexpected path: ${path}`);
      }),
      stream: vi.fn(async function* (path: string) {
        if (path === "/tools/events") return;
        turnStreamCalls += 1;
        if (turnStreamCalls === 1) {
          yield { sequence: 1, data: { type: "text_delta", payload: { turn_id: "turn-eof", text: "partial" } } };
          return;
        }
        yield { sequence: 2, data: { type: "turn_ended", payload: { turn_id: "turn-eof", status: "completed", text: "recovered after EOF" } } };
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });

    await controller.sendMessage({ text: "hello", attachments: [], riskMode: "normal", reasoning: "low" });

    await vi.waitFor(() => expect(useChatStore.getState().activeRequestId).toBeNull());
    expect(turnStreamCalls).toBe(2);
    expect(useChatStore.getState().messages.some((message) => message.role === "assistant" && message.content === "recovered after EOF" && message.status === "complete")).toBe(true);
  });

  it("reconnects the tool stream and replies to a request after the first connection fails", async () => {
    useChatStore.getState().reset();
    let releaseTurn!: () => void;
    let releaseTools!: () => void;
    const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const toolReplied = new Promise<void>((resolve) => { releaseTools = resolve; });
    let toolStreamCalls = 0;
    const host = {
      claimToolBridge: vi.fn(() => Promise.resolve({ owned: true, bridge_id: "bridge" })),
      assistantConfig: vi.fn(() => ({ timeout: 120 })),
      captureForgeState: vi.fn(() => ({})),
      executeTool: vi.fn(async () => {
        releaseTurn();
        return { ok: true, value: "read" };
      }),
    };
    const clientMock = {
      request: vi.fn((path: string) => {
        if (path === "/runtime") return Promise.resolve({ turn_event_sequence: 0, tool_event_sequence: 0 });
        if (path === "/turns") return Promise.resolve({ turn_id: "turn-tools" });
        if (path === "/tools/replies/request-1") {
          releaseTools();
          return Promise.resolve({ ok: true });
        }
        throw new Error(`unexpected path: ${path}`);
      }),
      stream: vi.fn(async function* (path: string) {
        if (path === "/turns/events") {
          await turnReleased;
          yield { sequence: 2, data: { type: "turn_ended", payload: { turn_id: "turn-tools", status: "completed", text: "tool complete" } } };
          return;
        }
        toolStreamCalls += 1;
        if (toolStreamCalls === 1) throw new TypeError("connection reset");
        yield { sequence: 3, data: { type: "tool_request", payload: { request_id: "request-1", tool: "read_prompt", arguments: {} } } };
        await toolReplied;
      }),
    };
    const controller = new LoomRuntimeController(host as never, clientMock as never);
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });

    await controller.sendMessage({ text: "hello", attachments: [], riskMode: "normal", reasoning: "low" });

    await vi.waitFor(() => expect(useChatStore.getState().activeRequestId).toBeNull());
    expect(toolStreamCalls).toBeGreaterThanOrEqual(2);
    expect(host.executeTool).toHaveBeenCalledOnce();
    expect(clientMock.request).toHaveBeenCalledWith("/tools/replies/request-1", expect.objectContaining({ method: "POST" }));
  });

  it("rejects malformed bridge leases and cancels an accepted turn", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    const host = {
      claimToolBridge: vi.fn(() => Promise.resolve({})),
      releaseToolBridge: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const cancel = vi.fn(() => Promise.resolve({ ok: true }));
    const client = { request: vi.fn((path: string) => path.endsWith("/cancel") ? cancel() : Promise.resolve({})) };
    const controller = new LoomRuntimeController(host as never, client as never);
    const internals = controller as unknown as {
      createRun(requestId: string, runtime?: Record<string, unknown>): unknown;
      refreshBridgeLease(run: unknown): Promise<boolean>;
    };
    const run = internals.createRun("lease-loss");

    expect(await internals.refreshBridgeLease(run)).toBe(false);
    expect(useRuntimeStore.getState().error).toContain("invalid lease");
    expect(cancel).not.toHaveBeenCalled();
    expect(host.releaseToolBridge).toHaveBeenCalledOnce();
  });

  it("handles an initial bridge claim rejection without an unhandled rejection", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    const host = { claimToolBridge: vi.fn(() => Promise.reject(new Error("bridge offline"))), releaseToolBridge: vi.fn(() => Promise.resolve()) };
    const controller = new LoomRuntimeController(host as never, { request: vi.fn(() => Promise.resolve({})) } as never);
    const internals = controller as unknown as { createRun(requestId: string): unknown; startToolStream(run: unknown): Promise<void> };
    const run = internals.createRun("claim-failure");

    await expect(internals.startToolStream(run)).resolves.toBeUndefined();
    expect(useRuntimeStore.getState().error).toContain("could not be claimed");
    expect((run as { finished: boolean }).finished).toBe(true);
  });

  it("bounds retained Forge snapshots to the most recent messages", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });
    const host = { captureForgeState: vi.fn(() => ({ prompt: "snapshot" })), assistantConfig: vi.fn(() => ({ timeout: 1 })), claimToolBridge: vi.fn(() => Promise.resolve({ owned: false, bridge_id: "other" })), releaseToolBridge: vi.fn(() => Promise.resolve()) } as never;
    const client = {
      request: vi.fn((path: string) => path === "/runtime" ? Promise.resolve({}) : path === "/turns" ? Promise.reject(new Error("rejected")) : Promise.resolve({})),
      stream: vi.fn(async function* () { await Promise.resolve(); }),
    } as never;
    const controller = new LoomRuntimeController(host, client);

    for (let index = 0; index < 35; index += 1) {
      await expect(controller.sendMessage({ text: `message ${index}`, attachments: [], riskMode: "normal", reasoning: "low" })).rejects.toThrow();
      await vi.waitFor(() => expect(useChatStore.getState().activeRequestId).toBeNull());
    }

    expect((controller as unknown as { snapshots: Map<string, unknown> }).snapshots.size).toBe(32);
  });

  it("cancels an accepted turn when bridge ownership is lost during approval", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    let claims = 0;
    const host = {
      claimToolBridge: vi.fn(() => Promise.resolve(++claims === 1
        ? { owned: true, bridge_id: "bridge-a" }
        : { owned: false, bridge_id: "bridge-b" })),
      releaseToolBridge: vi.fn(() => Promise.resolve({ ok: true })),
      executeTool: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const client = {
      request: vi.fn((path: string) => path.endsWith("/cancel")
        ? Promise.resolve({ ok: true })
        : Promise.resolve({ ok: true })),
    };
    const controller = new LoomRuntimeController(host as never, client as never);
    const internals = controller as unknown as {
      createRun(requestId: string, runtime?: Record<string, unknown>): unknown;
      handleToolEvent(run: unknown, event: Record<string, unknown>): Promise<void>;
      refreshBridgeLease(run: unknown): Promise<boolean>;
    };
    const run = internals.createRun("approval-loss", { active_turn_id: "turn-approval" });
    const pending = internals.handleToolEvent(run, { type: "tool_request", payload: { request_id: "request-approval", tool: "edit_prompt", arguments: { prompt: "new" } } });

    await vi.waitFor(() => expect(useRuntimeStore.getState().pendingToolApproval?.requestId).toBe("request-approval"));
    expect(await internals.refreshBridgeLease(run)).toBe(false);
    await pending;

    expect(host.executeTool).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledWith("/turns/turn-approval/cancel", { method: "POST" });
    expect(useRuntimeStore.getState().pendingToolApproval).toBeNull();
  });

  it("does not block turn submission on a pending bridge claim", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    let resolveClaim!: (value: unknown) => void;
    const claimPending = new Promise((resolve) => { resolveClaim = resolve; });
    const host = {
      claimToolBridge: vi.fn(() => claimPending),
      releaseToolBridge: vi.fn(() => Promise.resolve({ ok: true })),
      assistantConfig: vi.fn(() => ({ timeout: 120 })),
      captureForgeState: vi.fn(() => ({})),
    };
    const client = {
      request: vi.fn((path: string) => {
        if (path === "/runtime") return Promise.resolve({ turn_event_sequence: 0, tool_event_sequence: 0 });
        if (path === "/turns") return Promise.resolve({ turn_id: "should-not-start" });
        return Promise.resolve({});
      }),
    };
    const controller = new LoomRuntimeController(host as never, client as never);
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });
    const sending = controller.sendMessage({ text: "hello", attachments: [], riskMode: "normal", reasoning: "low" });

    await vi.waitFor(() => expect(host.claimToolBridge).toHaveBeenCalledOnce());
    controller.destroy();
    resolveClaim({ owned: true, bridge_id: "late-bridge" });
    await expect(sending).resolves.toMatchObject({ kind: "turn", id: "should-not-start" });

    expect(client.request.mock.calls.some(([path]) => path === "/turns")).toBe(true);
    expect(host.releaseToolBridge).toHaveBeenCalled();
  });

  it("returns after turn acceptance while streaming continues", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    let finish!: () => void;
    const finishTurn = new Promise<void>((resolve) => { finish = resolve; });
    const host = {
      claimToolBridge: vi.fn(() => Promise.resolve({ owned: true, bridge_id: "bridge" })),
      assistantConfig: vi.fn(() => ({ timeout: 120 })),
      captureForgeState: vi.fn(() => ({})),
    } as never;
    const client = {
      request: vi.fn((path: string) => {
        if (path === "/runtime") return Promise.resolve({ turn_event_sequence: 0, tool_event_sequence: 0 });
        if (path === "/turns") return Promise.resolve({ turn_id: "turn-accepted" });
        throw new Error(`unexpected path: ${path}`);
      }),
      stream: vi.fn(async function* (path: string) {
        if (path === "/tools/events") return;
        await finishTurn;
        yield { sequence: 1, data: { type: "turn_ended", payload: { turn_id: "turn-accepted", status: "completed", text: "done" } } };
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });

    await expect(controller.sendMessage({ text: "hello", attachments: [], riskMode: "normal", reasoning: "low" })).resolves.toMatchObject({ kind: "turn", id: "turn-accepted" });
    expect(useChatStore.getState().activeRequestId).not.toBeNull();
    expect(useRuntimeStore.getState().workingPhase).toBe("thinking");
    finish();
    await vi.waitFor(() => expect(useChatStore.getState().activeRequestId).toBeNull());
  });

  it("creates a session before activating the first submitted turn", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    const host = {
      syncProfiles: vi.fn(() => Promise.resolve({})),
      assistantConfig: vi.fn(() => ({ profile_id: "mock", timeout: 120 })),
      captureForgeState: vi.fn(() => ({})),
      claimToolBridge: vi.fn(() => Promise.resolve({ owned: true, bridge_id: "bridge" })),
      releaseToolBridge: vi.fn(() => Promise.resolve({ released: true })),
    } as never;
    const request = vi.fn((path: string) => {
      if (path === "/runtime") return Promise.resolve({ active_session: null, turn_event_sequence: 0, tool_event_sequence: 0 });
      if (path === "/sessions/open") return Promise.resolve({ session: { session_id: "fresh" } });
      if (path === "/sessions/fresh") return Promise.resolve({ messages: [], queue: [] });
      if (path === "/turns") return Promise.resolve({ turn_id: "turn-1" });
      throw new Error(`unexpected path: ${path}`);
    });
    const client = {
      request,
      stream: vi.fn(async function* (path: string) {
        if (path === "/tools/events") return;
        yield { sequence: 1, data: { type: "turn_ended", payload: { turn_id: "turn-1", status: "completed", text: "done" } } };
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);

    await expect(controller.sendMessage({ text: "first", attachments: [], riskMode: "normal", reasoning: "low" })).resolves.toMatchObject({ kind: "turn", id: "turn-1" });

    expect(request.mock.calls.findIndex(([path]) => path === "/sessions/open")).toBeLessThan(request.mock.calls.findIndex(([path]) => path === "/turns"));
    expect(useChatStore.getState().messages.some((message) => message.role === "user" && message.content === "first")).toBe(true);
  });

  it("removes queued messages optimistically and restores them after an unrecoverable failure", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });
    useChatStore.getState().upsertQueue({ id: "queued-1", text: "Follow up", attachments: [], state: "pending", createdAt: 1 });
    let rejectCancel!: (error: Error) => void;
    const cancel = new Promise((_, reject) => { rejectCancel = reject; });
    const request = vi.fn((path: string) => {
      if (path.endsWith("/cancel")) return cancel;
      if (path === "/sessions/kt-1") return Promise.reject(new Error("sidecar unavailable"));
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController({} as never, { request } as never);

    const removing = controller.removeQueuedMessage("queued-1");
    expect(useChatStore.getState().queue).toEqual([]);
    rejectCancel(new Error("cancel failed"));
    await expect(removing).rejects.toThrow("cancel failed");
    expect(useChatStore.getState().queue).toHaveLength(1);
  });
});
