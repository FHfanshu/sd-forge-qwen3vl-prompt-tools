const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

global.window = {
    location: { href: "http://127.0.0.1:7860" },
    kohakuLoom: {}
};

require(path.resolve(__dirname, "../javascript/kohaku_loom_assistant.js"));
require(path.resolve(__dirname, "../javascript/kohaku_loom_assistant_attachments.js"));
const tools = window.kohakuLoom;

test("repeated tools converge before a high-confidence loop stop", () => {
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 1), "execute");
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 4), "converge");
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 5), "execute");
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 6), "stop");
});

test("retries of mutating tools are not killed immediately", () => {
    assert.equal(tools.assistantRepeatedToolAction("edit_prompt", 2), "execute");
    assert.equal(tools.assistantRepeatedToolAction("apply_resource", 4), "converge");
});

test("profile vision capability controls native image attachments", () => {
    assert.equal(tools.assistantSupportsNativeImages({ model: "arbitrary", capabilities: { vision: true } }), true);
    assert.equal(tools.assistantSupportsNativeImages({ model: "gemini-named", capabilities: { vision: false } }), false);
});

test("Grok attachments are delegated to Gemini vision", () => {
    assert.equal(tools.assistantUsesGeminiVisionDelegate({ model: "grok-4.5" }), true);
    assert.equal(tools.assistantUsesGeminiVisionDelegate({ model: "gemini-3.1-pro-high" }), false);
});

test("prompt skill loading is not exposed as a model tool", () => {
    assert.deepEqual(tools.parseAssistantTools("Use load_prompt_skill when an Anima guide is needed."), []);
    assert.deepEqual(tools.parseAssistantTools('load_prompt_skill {"name":"anima_dit"}'), []);
});

test("native tool call ids survive browser normalization", () => {
    assert.deepEqual(
        tools.normalizeAssistantToolCall({ id: "call-7", function: { name: "read_prompt", arguments: '{"target":"active"}' } }),
        { id: "call-7", tool: "read_prompt", arguments: { target: "active" } }
    );
});

test("style-template reader is an available assistant tool", () => {
    assert.equal(tools.assistantToolNameFromText("read_style_template"), "read_style_template");
    assert.deepEqual(
        tools.parseAssistantTools('{"tool":"read_style_template","arguments":{"target":"txt2img"}}'),
        [{ tool: "read_style_template", arguments: { target: "txt2img" } }]
    );
});

test("assistant attachments normalize single and multiple images", () => {
    const first = { name: "one.png", dataUrl: "data:image/png;base64,AA==" };
    const second = { name: "two.png", dataUrl: "data:image/png;base64,AA==" };
    assert.deepEqual(tools.normalizedAssistantAttachments(first), [first]);
    assert.deepEqual(tools.normalizedAssistantAttachments([first, null, second]), [first, second]);
});

test("file input snapshots selected images before clearing", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/kohaku_loom_boot.js"), "utf8");
    assert.match(source, /const files = Array\.from\(fileInput\.files \|\| \[\]\);\s*fileInput\.value = "";\s*acceptAssistantImageFiles\(files\);/);
});

test("Svelte readiness removes legacy UI without recreating it", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/kohaku_loom_boot.js"), "utf8");
    const callbacks = {};
    const calls = { remove: 0, settings: 0, restore: 0 };
    const documentElement = {
        classList: { toggle() {} },
        dataset: {},
        addEventListener() {}
    };
    const context = {
        Element: class Element {},
        document: {
            documentElement,
            body: {},
            addEventListener() {},
            querySelector() { return null; },
            querySelectorAll() { return []; }
        },
        onAfterUiUpdate(callback) { callbacks.afterUpdate = callback; },
        onUiLoaded(callback) { callbacks.uiLoaded = callback; },
        window: {
            KohakuLoomSvelteUi: { UI_READY: true },
            addEventListener() {},
            kohakuLoom: {
                loomApp: () => null,
                loomMainApp: () => null,
                removeAssistantWindow: () => { calls.remove += 1; },
                setupModelProfileSettingsWindow: () => { calls.settings += 1; },
                restoreAssistantSession: () => { calls.restore += 1; }
            }
        }
    };
    context.window.document = context.document;
    vm.runInNewContext(source, context);

    callbacks.uiLoaded();
    callbacks.afterUpdate();

    assert.deepEqual(calls, { remove: 2, settings: 0, restore: 0 });
});

test("locale hints resolve without recursing through their own export", async () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/kohaku_loom_01_i18n.js"), "utf8");
    const context = {
        CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        fetch: async () => ({ ok: false, json: async () => ({}) }),
        localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
        navigator: { language: "en-US", languages: ["en-US"] },
        window: { addEventListener() {}, dispatchEvent() {}, kohakuLoom: {} }
    };
    vm.runInNewContext(source, context);
    await context.window.kohakuLoom.loadI18nBundle();

    assert.equal(context.window.kohakuLoom.getLocaleHints().locale, "en");
});

test("released Svelte boot mounts only through the Forge UI callback", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/kohaku_loom_99_boot.js"), "utf8");
    let callback;
    let mounts = 0;
    const context = {
        window: {
            KohakuLoomSvelteUi: { UI_READY: true, mountSvelteUi: () => { mounts += 1; } },
            onUiLoaded: (next) => { callback = next; }
        }
    };
    vm.runInNewContext(source, context);

    assert.equal(mounts, 0);
    callback();
    assert.equal(mounts, 1);
});

test("user messages have an always-visible edit and resend action", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/kohaku_loom_assistant_attachments.js"), "utf8");
    assert.match(source, /loom-assistant-message-actions/);
    assert.match(source, /loom-assistant-message-edit/);
    assert.match(source, /assistant\.rewind/);
    assert.match(source, /restoreForgeUiState/);
});

test("assistant responses expose a copy action", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/kohaku_loom_assistant.js"), "utf8");
    const core = fs.readFileSync(path.resolve(__dirname, "../javascript/kohaku_loom.js"), "utf8");
    assert.match(source, /loom-assistant-message-copy/);
    assert.match(source, /navigator\.clipboard\.writeText/);
    assert.match(core, /appendAssistantCopyAction/);
});
