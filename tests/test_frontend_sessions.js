const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.resolve(__dirname, "../javascript/kohaku_loom_sessions.js");

function loadModule() {
    delete require.cache[modulePath];
    global.window = { kohakuLoom: { assistantState: {}, assistantBridgeId: "bridge-test", assistantOperationId(kind) { return `bridge-test:${kind}:operation`; }, async startAssistantBridgeLease() { return { pending_requests: [] }; }, stopAssistantBridgeLease() { } } };
    global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    require(modulePath);
    return window.kohakuLoom;
}

test("session history search path encodes the query", () => {
    const tools = loadModule();
    assert.equal(tools.assistantSessionListPath(""), "/sessions");
    assert.equal(tools.assistantSessionListPath("red hair & sky"), "/sessions");
});

test("session history labels generated metadata and its lifecycle state", () => {
    const tools = loadModule();
    assert.equal(tools.sessionListLabel({ session_id: "abcdef123456", title: "Copper portrait" }), "Copper portrait · abcdef12");
    assert.equal(tools.sessionListLabel({ session_id: "abcdef123456", title: "New session" }), "abcdef123456");
    assert.equal(tools.sessionMetadataStatus({ status: "generating" }), "命名中");
    assert.equal(tools.sessionMetadataStatus({ status: "fallback" }), "规则降级");
});

test("KT SSE parser preserves cursor and event payload", () => {
    const tools = loadModule();
    const event = tools.parseKtSseFrame('id: 7\nevent: text_delta\ndata: {"payload":{"text":"hi"}}');
    assert.equal(event.sequence, 7);
    assert.equal(event.type, "text_delta");
    assert.equal(event.payload.text, "hi");
});

test("KT Forge resource calls map to browser resource tools", () => {
    const tools = loadModule();
    assert.deepEqual(tools.adaptKtForgeTool("forge_resource", {
        action: "apply",
        kind: "lora",
        resource_id: "detailer"
    }), {
        tool: "apply_resource",
        arguments: {
            action: "apply",
            kind: "lora",
            resource_id: "detailer",
            id: "detailer"
        }
    });
    assert.deepEqual(tools.adaptKtForgeTool("initialize_prompt", { positive: "subject" }), {
        tool: "initialize_prompt",
        arguments: { positive: "subject", positive_prompt: "subject", negative_prompt: undefined }
    });
});

test("Gemini content-wrapped edit arguments normalize to the Forge edit contract", () => {
    const tools = loadModule();
    assert.deepEqual(tools.adaptKtForgeTool("edit_prompt", {
        content: JSON.stringify({
            positive_prompt: "dynamic subject",
            positive_prompt_hash: "fnv1a:positive",
            context_hash: "fnv1a:context"
        }),
        _: true
    }), {
        tool: "edit_prompt",
        arguments: {
            _: true,
            positive_prompt: "dynamic subject",
            positive_prompt_hash: "fnv1a:positive",
            context_hash: "fnv1a:context",
            field: "positive",
            prompt: "dynamic subject",
            base_hash: "fnv1a:positive"
        }
    });
});

test("KT mutation classification keeps read-only tools separate", () => {
    const tools = loadModule();
    assert.equal(tools.ktMutationTool("edit_prompt", {}), true);
    assert.equal(tools.ktMutationTool("initialize_prompt", {}), true);
    assert.equal(tools.ktMutationTool("forge_resource", { action: "apply" }), true);
    assert.equal(tools.ktMutationTool("forge_resource", { action: "inspect" }), false);
    assert.equal(tools.ktMutationTool("read_prompt", {}), false);
});

test("rewind snapshots persist by session and user-message index", () => {
    const storage = new Map();
    global.window = { kohakuLoom: { assistantState: {}, assistantBridgeId: "bridge-test", assistantOperationId(kind) { return `bridge-test:${kind}:operation`; }, async startAssistantBridgeLease() { return { pending_requests: [] }; }, stopAssistantBridgeLease() { } } };
    global.localStorage = {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, value); },
        removeItem(key) { storage.delete(key); }
    };
    delete require.cache[modulePath];
    require(modulePath);
    const tools = window.kohakuLoom;
    const snapshot = { active_target: "txt2img", controls: [{ root: "#txt2img", index: 0, value: "prompt" }] };

    tools.storeRewindSnapshot("session-a", 2, snapshot);

    assert.deepEqual(tools.rewindSnapshot("session-a", 2), snapshot);
    assert.equal(tools.rewindSnapshot("session-a", 1), null);
    assert.deepEqual(tools.rewindSnapshots("session-a"), { "2": snapshot });
});

test("profile settings import invalidates the active KT provider snapshot", async () => {
    const storage = new Map([
        ["loom_kt_session_profile_snapshot", "old-provider"],
        ["q3vl_assistant_profiles_v2", "legacy"]
    ]);
    global.window = { kohakuLoom: { assistantState: {}, assistantBridgeId: "bridge-test", assistantOperationId(kind) { return `bridge-test:${kind}:operation`; }, async startAssistantBridgeLease() { return { pending_requests: [] }; }, stopAssistantBridgeLease() { } } };
    global.localStorage = {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, value); },
        removeItem(key) { storage.delete(key); }
    };
    global.fetch = async function () {
        return { ok: true, status: 200, async json() { return { imported: 1 }; } };
    };
    delete require.cache[modulePath];
    require(modulePath);
    const tools = window.kohakuLoom;
    let scrubbed = false;
    tools.LEGACY_PROFILE_STORAGE_KEY = "q3vl_assistant_profiles_v2";
    tools.profileStore = {
        load() { return { profiles: [] }; },
        scrubApiKeys() { scrubbed = true; }
    };

    await tools.importAssistantProfiles(true, true);

    assert.equal(scrubbed, true);
    assert.equal(storage.has("loom_kt_session_profile_snapshot"), false);
    assert.equal(storage.has("q3vl_assistant_profiles_v2"), false);
    assert.equal(storage.get("loom_kt_profiles_imported_v1"), "1");
});

test("KT run controls keep send available beside stop", () => {
    const tools = loadModule();
    const send = { hidden: false };
    const stop = { hidden: true, disabled: true };
    const runtimeControls = [{ disabled: false }, { disabled: false }];
    tools.assistantPanel = function () {
        return {
            querySelector(selector) { return selector === "#loom_assistant_stop" ? stop : null; },
            querySelectorAll() { return runtimeControls; }
        };
    };

    tools.setAssistantRunning(send, true);
    assert.equal(send.hidden, false);
    assert.equal(send.dataset.loomRunning, "1");
    assert.equal(stop.hidden, false);
    assert.equal(stop.disabled, false);
    assert.deepEqual(runtimeControls.map(function (control) { return control.disabled; }), [true, true]);

    tools.setAssistantRunning(send, false);
    assert.equal(send.hidden, false);
    assert.equal(send.dataset.loomRunning, "0");
    assert.equal(stop.hidden, true);
    assert.equal(stop.disabled, true);
    assert.deepEqual(runtimeControls.map(function (control) { return control.disabled; }), [false, false]);
});

test("KT reasoning and usage events restore the streaming assistant UI", () => {
    const tools = loadModule();
    const rendered = [];
    const statuses = [];
    tools.addAssistantMessage = function () { return {}; };
    tools.renderAssistantMarkdown = function () { };
    tools.updateAssistantStreamingMessage = function (_item, text, reasoning) {
        rendered.push({ text, reasoning });
    };
    tools.formatAssistantTokenStatus = function (usage) {
        return `↑ ${usage.prompt_tokens} ↓ ${usage.completion_tokens}`;
    };
    tools.updateAssistantMessage = function (_item, role, text) { statuses.push({ role, text }); };
    const run = {
        turnId: "turn-1",
        text: "",
        reasoning: "",
        usage: null,
        streamItem: null,
        statusItem: {},
        streamController: { abort() {} },
        resolve() {}
    };

    tools.handleKtTurnEvent(run, { type: "reasoning_delta", payload: { turn_id: "turn-1", text: "plan " } });
    tools.handleKtTurnEvent(run, { type: "reasoning_delta", payload: { turn_id: "turn-1", text: "steps" } });
    tools.handleKtTurnEvent(run, { type: "text_delta", payload: { turn_id: "turn-1", text: "answer" } });
    tools.handleKtTurnEvent(run, { type: "usage", payload: { turn_id: "turn-1", usage: { prompt_tokens: 12, completion_tokens: 4 } } });

    assert.deepEqual(rendered.at(-1), { text: "answer", reasoning: "plan steps" });
    assert.deepEqual(statuses, [{ role: "status", text: "↑ 12 ↓ 4" }]);
});

test("queue events update authoritative browser queue state", () => {
    const tools = loadModule();
    const run = { turnId: "turn-1", renderedMessages: new Set() };
    tools.handleKtTurnEvent(run, {
        type: "message_queued",
        payload: {
            message: { message_id: "m1", sequence: 1, kind: "primary", state: "pending", content: "next" }
        }
    });
    assert.equal(tools.assistantState.queue.length, 1);
    assert.equal(tools.assistantState.queue[0].message_id, "m1");
});

test("stale queue updates cannot resurrect newer terminal state", () => {
    const tools = loadModule();
    tools.renderAssistantQueue([{ message_id: "m1", state: "cancelled", updated_at: 20 }]);

    tools.handleKtTurnEvent({ turnId: "turn-1", renderedMessages: new Set() }, {
        type: "message_queued",
        payload: { message: { message_id: "m1", state: "pending", updated_at: 10 } }
    });

    assert.deepEqual(tools.assistantState.queue, []);
    assert.equal(tools.assistantState.queueVersions.m1, 20);
});

test("queue claim clears its active composer draft", () => {
    const tools = loadModule();
    const input = { value: "draft", dispatchEvent() { } };
    tools.assistantState.editingQueueId = "m1";
    tools.assistantState.attachments = [{ dataUrl: "data:image/png;base64,one" }];
    tools.assistantPanel = function () { return { querySelector(selector) { return selector === "#loom_assistant_input" ? input : null; } }; };
    tools.setAssistantAttachments = function (value) { tools.assistantState.attachments = value; };
    tools.addAssistantUserMessage = function () { return null; };
    tools.handleKtTurnEvent({ turnId: "turn-1", renderedMessages: new Set() }, {
        type: "message_updated",
        payload: { message: { message_id: "m1", sequence: 1, kind: "primary", state: "running", content: "draft" } }
    });
    assert.equal(tools.assistantState.editingQueueId, "");
    assert.equal(input.value, "");
    assert.deepEqual(tools.assistantState.attachments, []);
});

test("paused pending queue head exposes continue action", () => {
    const tools = loadModule();
    tools.assistantState.queuePaused = true;
    const buttons = [];
    const holder = {
        hidden: true,
        replaceChildren() { buttons.length = 0; },
        appendChild(row) {
            const actionRow = row.children?.find?.(function (item) { return item.className === "loom-assistant-queue-actions"; });
            (actionRow?.children || []).forEach(function (item) { buttons.push(item.textContent); });
        }
    };
    global.document = {
        createElement() {
            return {
                children: [],
                dataset: {},
                append() { this.children.push(...arguments); },
                appendChild(item) { this.children.push(item); },
                addEventListener() { },
                set type(_value) { },
                set className(value) { this._className = value; },
                get className() { return this._className || ""; }
            };
        }
    };
    tools.assistantPanel = function () { return { querySelector() { return holder; } }; };

    tools.renderAssistantQueue([
        { message_id: "m1", sequence: 1, kind: "primary", state: "pending", content: "next" },
        { message_id: "m2", sequence: 2, kind: "primary", state: "pending", content: "later" }
    ]);

    assert.deepEqual(buttons, ["编辑", "撤销", "继续", "编辑", "撤销"]);
});

test("paused queue edits preserve attachment metadata", async () => {
    const storage = new Map([["loom_kt_active_session", "session-1"]]);
    global.window = { kohakuLoom: { assistantState: {}, assistantBridgeId: "bridge-test", assistantOperationId(kind) { return `bridge-test:${kind}:operation`; }, async startAssistantBridgeLease() { return { pending_requests: [] }; }, stopAssistantBridgeLease() { } } };
    global.localStorage = {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, value); },
        removeItem(key) { storage.delete(key); }
    };
    delete require.cache[modulePath];
    require(modulePath);
    const tools = window.kohakuLoom;
    tools.assistantState.running = null;
    tools.assistantState.editingQueueId = "m1";
    tools.normalizedAssistantAttachments = function (value) { return value || []; };
    tools.assistantConfig = function () { return { capabilities: { vision: true } }; };
    tools.assistantSupportsNativeImages = function () { return true; };
    tools.addAssistantMessage = function () { };
    let body = null;
    global.fetch = async function (url, options) {
        assert.match(String(url), /\/sessions\/session-1\/messages\/m1$/);
        body = JSON.parse(options.body);
        return { ok: true, status: 200, async json() { return { message: Object.assign({ message_id: "m1", state: "pending" }, body) }; } };
    };
    const attachments = [{ dataUrl: "data:image/png;base64,one", name: "one.png" }];

    await tools.queueAssistantFollowup("edited", attachments, "Edited");

    assert.deepEqual(body.attachments, attachments);
    assert.equal(tools.assistantState.editingQueueId, "");
});

test("claimed queue edit conflict clears stale draft and queue", async () => {
    const storage = new Map([["loom_kt_active_session", "session-1"]]);
    global.window = { kohakuLoom: { assistantState: { editingQueueId: "m1", attachments: [{ dataUrl: "data:image/png;base64,one" }] }, assistantBridgeId: "bridge-test", assistantOperationId(kind) { return `bridge-test:${kind}:operation`; }, async startAssistantBridgeLease() { return { pending_requests: [] }; }, stopAssistantBridgeLease() { } } };
    global.localStorage = {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, value); },
        removeItem(key) { storage.delete(key); }
    };
    delete require.cache[modulePath];
    require(modulePath);
    const tools = window.kohakuLoom;
    tools.normalizedAssistantAttachments = function (value) { return value || []; };
    tools.assistantConfig = function () { return { capabilities: { vision: true } }; };
    tools.assistantSupportsNativeImages = function () { return true; };
    tools.addAssistantMessage = function () { };
    tools.setAssistantAttachments = function (value) { tools.assistantState.attachments = value; };
    const input = { value: "edited", dispatchEvent() { } };
    tools.assistantPanel = function () { return { querySelector() { return input; } }; };
    let calls = 0;
    global.fetch = async function (url) {
        calls += 1;
        if (calls === 1) return { ok: false, status: 409, async text() { return JSON.stringify({ detail: "message is already claimed" }); } };
        assert.match(String(url), /\/runtime$/);
        return { ok: true, status: 200, async json() { return { messages: [], queue_paused: false }; } };
    };

    await tools.queueAssistantFollowup("edited", tools.assistantState.attachments, "Edited");

    assert.equal(tools.assistantState.editingQueueId, "");
    assert.deepEqual(tools.assistantState.attachments, []);
    assert.deepEqual(tools.assistantState.queue, []);
    assert.equal(input.value, "");
});

test("session reset clears stale queue and edit state", async () => {
    const storage = new Map([["loom_kt_active_session", "old-session"]]);
    global.window = { kohakuLoom: { assistantState: { queue: [{ message_id: "old" }], editingQueueId: "old" }, assistantBridgeId: "bridge-test", assistantOperationId(kind) { return `bridge-test:${kind}:operation`; }, async startAssistantBridgeLease() { return { pending_requests: [] }; }, stopAssistantBridgeLease() { } } };
    global.localStorage = {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, value); },
        removeItem(key) { storage.delete(key); }
    };
    global.fetch = async function (url) {
        assert.match(String(url), /\/runtime$/);
        return { ok: true, status: 200, async json() { return { active_session: null }; } };
    };
    delete require.cache[modulePath];
    require(modulePath);
    const tools = window.kohakuLoom;

    await tools.resetAssistantSession();

    assert.deepEqual(tools.assistantState.queue, []);
    assert.equal(tools.assistantState.editingQueueId, "");
    assert.equal(tools.assistantState.queuePaused, false);
});

test("reattached turn completion refreshes authoritative queue", async () => {
    const tools = loadModule();
    window.setTimeout = setTimeout;
    tools.assistantState.queue = [{ message_id: "stale", state: "pending" }];
    tools.assistantPanel = function () { return null; };
    tools.addAssistantMessage = function () { return { remove() { } }; };
    tools.setAssistantRunning = function () { };
    let runtimeReads = 0;
    global.fetch = async function (url) {
        const value = String(url);
        if (value.includes("/turns/events") || value.includes("/tools/events")) {
            return { ok: true, status: 200, body: { getReader() { return { async read() { return { done: true }; } }; } } };
        }
        if (value.endsWith("/runtime")) {
            runtimeReads += 1;
            return {
                ok: true,
                status: 200,
                async json() {
                    if (runtimeReads === 1) return {
                        active_turn_id: "",
                        settling_turn_id: "turn-1",
                        messages: [{ message_id: "stale", state: "running", turn_id: "turn-1" }],
                        queue_paused: false,
                        token_usage: {}
                    };
                    return { active_turn_id: "", messages: [], queue_paused: false, token_usage: {} };
                }
            };
        }
        throw new Error(`unexpected URL: ${url}`);
    };
    const run = await tools.attachActiveRuntime({
        active_turn_id: "turn-1",
        active_turn: { turn_id: "turn-1", text: "", reasoning: "" },
        turn_event_sequence: 0,
        tool_event_sequence: 0,
        messages: [{ message_id: "stale", state: "pending" }]
    });

    run.resolve({ turn_id: "turn-1", status: "ok", text: "done" });
    await run.done;
    for (let attempt = 0; attempt < 20 && runtimeReads < 2; attempt += 1) {
        await new Promise(function (resolve) { setTimeout(resolve, 10); });
    }

    assert.ok(runtimeReads >= 2);
    assert.deepEqual(tools.assistantState.queue, []);
});

test("settlement and queue reattachment tolerate llama shutdown delay", () => {
    const source = require("node:fs").readFileSync(modulePath, "utf8");
    assert.match(source, /function reattachQueuedTurn[\s\S]*attempt < 300/);
    assert.match(source, /function settledRuntime[\s\S]*attempt < 300/);
});

test("KT tool reply retries without executing a mutation twice", async () => {
    const tools = loadModule();
    let executions = 0;
    let replies = 0;
    global.fetch = async function (url) {
        if (!String(url).includes("/tools/replies/request-1")) throw new Error(`unexpected URL: ${url}`);
        replies += 1;
        if (replies === 1) throw new TypeError("Failed to fetch");
        return { ok: true, status: 200, async json() { return { ok: true }; } };
    };
    tools.executeAssistantTool = async function () {
        executions += 1;
        return { ok: true, changed: true };
    };
    tools.addAssistantMessage = function () { };
    tools.assistantToolResultLabel = function () { return "applied"; };
    const run = {
        controller: { signal: { aborted: false } },
        cancelled: false,
        resourceMutationAllowed: false,
        toolRequests: new Set(),
        toolResults: new Map()
    };
    const event = {
        type: "tool_request",
        payload: { request_id: "request-1", bridge_id: tools.assistantBridgeId, tool: "edit_prompt", arguments: { patches: [] } }
    };

    await assert.rejects(() => tools.handleKtToolEvent(run, event), /Failed to fetch/);
    assert.equal(run.toolRequests.has("request-1"), false);
    assert.equal(run.toolResults.has("request-1"), true);
    await tools.handleKtToolEvent(run, event);

    assert.equal(executions, 1);
    assert.equal(replies, 2);
    assert.equal(run.toolRequests.has("request-1"), true);
    assert.equal(run.toolResults.has("request-1"), false);
});

test("concurrent tool event replay executes only once", async () => {
    const tools = loadModule();
    let executions = 0;
    let release;
    global.fetch = async function () { return { ok: true, status: 200, async json() { return { ok: true }; } }; };
    tools.executeAssistantTool = async function () {
        executions += 1;
        await new Promise(function (resolve) { release = resolve; });
        return { ok: true };
    };
    tools.addAssistantMessage = function () { };
    const run = { controller: { signal: { aborted: false } }, cancelled: false, toolRequests: new Set(), toolResults: new Map() };
    const event = { type: "tool_request", payload: { request_id: "request-1", bridge_id: tools.assistantBridgeId, tool: "edit_prompt", arguments: {} } };

    const first = tools.handleKtToolEvent(run, event);
    const replay = tools.handleKtToolEvent(run, event);
    await new Promise(function (resolve) { setImmediate(resolve); });
    release();
    await Promise.all([first, replay]);

    assert.equal(executions, 1);
});
