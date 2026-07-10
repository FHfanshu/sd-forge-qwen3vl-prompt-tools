const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

global.window = {
    location: { href: "http://127.0.0.1:7860" },
    q3vlPromptTools: {}
};

require(path.resolve(__dirname, "../javascript/qwen3vl_prompt_tools_assistant.js"));
const tools = window.q3vlPromptTools;

test("repeated read-only tools get one convergence attempt", () => {
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 1), "execute");
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 2), "converge");
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 3), "stop");
});

test("repeated mutating tools still stop immediately", () => {
    assert.equal(tools.assistantRepeatedToolAction("edit_prompt", 2), "stop");
    assert.equal(tools.assistantRepeatedToolAction("apply_resource", 2), "stop");
});

test("new prompt writing requests require a UI edit", () => {
    assert.equal(tools.assistantUserRequestedPromptEdit("帮我编写一份海边女孩的提示词"), true);
    assert.equal(tools.assistantUserRequestedPromptEdit("Generate a portrait prompt for me"), true);
    assert.equal(tools.assistantUserRequestedPromptEdit("提示词应该怎么写？"), false);
});

test("remote Grok models receive native image attachments", () => {
    assert.equal(tools.assistantSupportsNativeImages({ backend: "openai", model: "grok-4.5", endpoint: "https://moyuu.cc" }), true);
    assert.equal(tools.assistantSupportsNativeImages({ backend: "openai", model: "text-only", endpoint: "https://example.com" }), false);
});
