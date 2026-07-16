(function () {
    const tools = window.kohakuLoom;
    if (!tools) return;

    const BASE = "/kohaku-loom/kt";
    const SESSION_KEY = "loom_kt_active_session";
    const AGENT_MODE_KEY_PREFIX = "loom_kt_agent_mode_v1_";

    function normalizedAgentMode(value) {
        return String(value || "").toLowerCase() === "yolo" ? "yolo" : "normal";
    }

    function storedAssistantAgentMode(sessionId) {
        return normalizedAgentMode(sessionId ? localStorage.getItem(AGENT_MODE_KEY_PREFIX + sessionId) : "normal");
    }

    function storeAssistantAgentMode(sessionId, mode) {
        const normalized = normalizedAgentMode(mode);
        if (sessionId) localStorage.setItem(AGENT_MODE_KEY_PREFIX + sessionId, normalized);
        return normalized;
    }

    function syncAssistantAgentMode() {
        const mode = normalizedAgentMode(tools.assistantState.agentMode);
        const button = tools.assistantPanel?.()?.querySelector("#loom_assistant_agent_mode");
        const panel = tools.assistantPanel?.();
        if (button) {
            button.dataset.loomAgentMode = mode;
            button.setAttribute("aria-pressed", String(mode === "yolo"));
            button.textContent = mode === "yolo" ? "YOLO" : "Normal";
            button.title = mode === "yolo" ? "YOLO: 可自动修改 txt2img 核心参数；生成仍需手动点击" : "Normal: YOLO 工具已隔离";
        }
        if (panel) panel.dataset.loomAgentMode = mode;
        return mode;
    }

    async function setAssistantAgentMode(value) {
        const mode = normalizedAgentMode(value);
        const sessionId = localStorage.getItem(SESSION_KEY) || "";
        if (sessionId) {
            const response = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/mode`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ agent_mode: mode })
            });
            if (!response.ok) {
                let detail = await response.text();
                try { detail = JSON.parse(detail).detail || detail; } catch (_error) { }
                throw new Error(String(detail || `HTTP ${response.status}`));
            }
            const data = await response.json();
            tools.assistantState.agentMode = storeAssistantAgentMode(sessionId, data?.session?.agent_mode || mode);
        } else {
            tools.assistantState.agentMode = mode;
        }
        tools.assistantState.txt2imgStateRead = null;
        return syncAssistantAgentMode();
    }

    function attachmentContent(text, attachments) {
        const parts = [];
        if (text) parts.push({ type: "text", text: text });
        attachments.forEach(function (item) {
            parts.push({
                type: "image_url",
                image_url: { url: item.dataUrl, detail: "high" },
                meta: { source_type: "attachment", source_name: item.name || "reference image" }
            });
        });
        return parts;
    }

    function messageText(content) {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content.filter(function (part) { return part && part.type === "text"; }).map(function (part) { return part.text || ""; }).join("\n");
    }

    function messageAttachments(content) {
        if (!Array.isArray(content)) return [];
        return content.filter(function (part) { return part && part.type === "image_url" && part.image_url?.url; }).map(function (part) {
            return { dataUrl: part.image_url.url, name: part.meta?.source_name || "reference image" };
        });
    }

    function ktMutationTool(name, args) {
        if (["edit_prompt", "initialize_prompt", "apply_txt2img_patch"].includes(name)) return true;
        return name === "forge_resource" && String(args?.action || "") === "apply";
    }

    Object.assign(tools, {
        normalizedAgentMode,
        storedAssistantAgentMode,
        storeAssistantAgentMode,
        syncAssistantAgentMode,
        setAssistantAgentMode,
        attachmentContent,
        messageText,
        messageAttachments,
        ktMutationTool
    });
})();
