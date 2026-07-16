(function () {
    const tools = window.kohakuLoom;
    if (!tools) return;

    const BASE = "/kohaku-loom/kt";
    const SESSION_KEY = "loom_kt_active_session";
    const RUNTIME_KEY = "loom_assistant_runtime";
    const PROFILE_IMPORT_KEY = "loom_kt_profiles_imported_v1";
    const SESSION_PROFILE_KEY = "loom_kt_session_profile_snapshot";
    const REWIND_KEY_PREFIX = "loom_kt_rewind_v1_";
    const BRIDGE_ID = tools.assistantBridgeId;
    let restorePromise = null;
    let sessionGeneration = 0;
    tools.assistantState.durableSessions = true;
    tools.assistantState.agentMode = "normal";
    tools.normalizedAgentMode = tools.normalizedAgentMode || function (value) { return String(value || "").toLowerCase() === "yolo" ? "yolo" : "normal"; };
    tools.storedAssistantAgentMode = tools.storedAssistantAgentMode || function () { return "normal"; };
    tools.storeAssistantAgentMode = tools.storeAssistantAgentMode || function (_sessionId, mode) { return tools.normalizedAgentMode(mode); };
    tools.syncAssistantAgentMode = tools.syncAssistantAgentMode || function () { return tools.normalizedAgentMode(tools.assistantState.agentMode); };
    tools.messageText = tools.messageText || function (content) { return typeof content === "string" ? content : Array.isArray(content) ? content.filter(function (part) { return part?.type === "text"; }).map(function (part) { return part.text || ""; }).join("\n") : ""; };
    tools.messageAttachments = tools.messageAttachments || function (content) { return Array.isArray(content) ? content.filter(function (part) { return part?.type === "image_url" && part.image_url?.url; }).map(function (part) { return { dataUrl: part.image_url.url, name: part.meta?.source_name || "reference image" }; }) : []; };
    tools.attachmentContent = tools.attachmentContent || function (text, attachments) { return (text ? [{ type: "text", text: text }] : []).concat(attachments.map(function (item) { return { type: "image_url", image_url: { url: item.dataUrl, detail: "high" }, meta: { source_type: "attachment", source_name: item.name || "reference image" } }; })); };
    tools.ktMutationTool = tools.ktMutationTool || function (name, args) { return ["edit_prompt", "initialize_prompt", "apply_txt2img_patch"].includes(name) || (name === "forge_resource" && String(args?.action || "") === "apply"); };

    function assistantRuntime() {
        return localStorage.getItem(RUNTIME_KEY) || "kohaku-terrarium";
    }

    function setAssistantRuntime(runtime) {
        const value = String(runtime || "");
        if (value !== "kohaku-terrarium") throw new Error(`Unsupported assistant runtime: ${value}`);
        localStorage.setItem(RUNTIME_KEY, value);
        return value;
    }
    function activeSessionId() {
        return localStorage.getItem(SESSION_KEY) || "";
    }
    function setActiveSessionId(sessionId) {
        const nextId = sessionId || "";
        const previousId = activeSessionId();
        if (nextId) localStorage.setItem(SESSION_KEY, nextId);
        else localStorage.removeItem(SESSION_KEY);
        tools.assistantState.sessionId = nextId;
        if (previousId !== nextId) {
            tools.assistantState.agentMode = tools.storedAssistantAgentMode(nextId);
            tools.assistantState.txt2imgStateRead = null;
            tools.syncAssistantAgentMode();
            tools.assistantState.editingQueueId = ""; const input = tools.assistantPanel?.()?.querySelector("#loom_assistant_input"); if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); } tools.setAssistantAttachments?.([]);
            tools.assistantState.queuePaused = false;
            tools.assistantState.queueVersions = {};
            renderAssistantQueue([]);
        }
        sessionGeneration += 1;
    }
    function rewindStorageKey(sessionId) {
        return REWIND_KEY_PREFIX + String(sessionId || "");
    }
    function rewindSnapshots(sessionId) {
        try {
            const saved = JSON.parse(localStorage.getItem(rewindStorageKey(sessionId)) || "{}");
            return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
        } catch (_error) {
            return {};
        }
    }
    function storeRewindSnapshot(sessionId, userIndex, snapshot) {
        if (!sessionId || !snapshot || !Array.isArray(snapshot.controls)) return;
        const snapshots = rewindSnapshots(sessionId);
        snapshots[String(userIndex)] = snapshot;
        localStorage.setItem(rewindStorageKey(sessionId), JSON.stringify(snapshots));
    }
    function rewindSnapshot(sessionId, userIndex) {
        return rewindSnapshots(sessionId)[String(userIndex)] || null;
    }
    async function ktRequest(path, options) {
        const response = await fetch(BASE + path, options);
        if (!response.ok) {
            let detail = await response.text();
            try { detail = JSON.parse(detail).detail || detail; } catch (_error) { }
            throw new Error(String(detail || `HTTP ${response.status}`));
        }
        return response.status === 204 ? null : response;
    }

    async function ktJson(path, options) {
        const response = await ktRequest(path, options);
        return response ? response.json() : null;
    }
    async function forgeJson(path, options) {
        const response = await fetch(`/kohaku-loom${path}`, options);
        if (!response.ok) throw new Error(await response.text());
        return await response.json();
    }
    async function importAssistantProfiles(force, invalidateSession) {
        if (!tools.profileStore) throw new Error("Model Profile store is unavailable");
        if (!force && localStorage.getItem(PROFILE_IMPORT_KEY) === "1") return;
        const imported = await ktJson("/profiles/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(tools.profileStore.load())
        });
        if (tools.LEGACY_PROFILE_STORAGE_KEY) localStorage.removeItem(tools.LEGACY_PROFILE_STORAGE_KEY);
        (tools.LEGACY_ASSISTANT_PROFILE_KEYS || []).filter(function (key) { return String(key).startsWith("q3vl_assistant_"); }).forEach(function (key) {
            localStorage.removeItem(key);
        });
        tools.profileStore.scrubApiKeys();
        if (invalidateSession) localStorage.removeItem(SESSION_PROFILE_KEY);
        localStorage.setItem(PROFILE_IMPORT_KEY, "1");
        return imported;
    }
    async function profileChat(profileId, messages, signal) {
        await importAssistantProfiles(true, false);
        return await ktJson(`/profiles/${encodeURIComponent(profileId)}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: signal,
            body: JSON.stringify({ messages: messages })
        });
    }
    function assistantSessionListPath() {
        return "/sessions";
    }
    function sessionListLabel(session) {
        const title = String(session?.title || "").trim();
        const sessionId = String(session?.session_id || "");
        return title && title !== "New session" ? `${title} · ${sessionId.slice(0, 8)}` : sessionId;
    }
    function sessionMetadataStatus(session) {
        const labels = {
            pending: "待补全",
            generating: "命名中",
            completed: "已完成",
            fallback: "规则降级",
            failed: "生成失败"
        };
        return labels[String(session?.status || "pending")] || "待补全";
    }
    async function closeActiveSession() {
        const runtime = await ktJson("/runtime");
        if (runtime?.active_session) {
            if (runtime.active_turn_id) throw new Error("Cannot switch sessions while a turn is active");
            await ktJson("/sessions/close", { method: "POST" });
        }
    }
    async function openSession(profileId, sessionId, resume) {
        await importAssistantProfiles(true, false);
        const requestedMode = sessionId && resume ? tools.storedAssistantAgentMode(sessionId) : tools.normalizedAgentMode(tools.assistantState.agentMode);
        const data = await ktJson("/sessions/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                profile_id: profileId,
                session_id: sessionId || "",
                resume: Boolean(resume),
                forge_bridge: true,
                agent_mode: requestedMode
            })
        });
        tools.storeAssistantAgentMode(data.session.session_id, data.session.agent_mode || requestedMode);
        setActiveSessionId(data.session.session_id);
        localStorage.setItem(SESSION_PROFILE_KEY, profileSnapshot(profileId));
        return data.session;
    }
    function profileSnapshot(profileId) {
        return JSON.stringify(tools.profileStore.requestProjection(profileId));
    }
    async function ensureAssistantSession(config) {
        setAssistantRuntime(assistantRuntime());
        await importAssistantProfiles(false, false);
        const runtime = await ktJson("/runtime");
        const storedId = activeSessionId();
        if (runtime.active_session) {
            const profileChanged = localStorage.getItem(SESSION_PROFILE_KEY) !== profileSnapshot(config.profile_id);
            if (runtime.active_session.profile_id !== config.profile_id || profileChanged) {
                const sessionId = runtime.active_session.session_id;
                await closeActiveSession();
                return (await openSession(config.profile_id, sessionId, true)).session_id;
            }
            setActiveSessionId(runtime.active_session.session_id);
            return runtime.active_session.session_id;
        }
        if (storedId) {
            try {
                return (await openSession(config.profile_id, storedId, true)).session_id;
            } catch (_error) {
                setActiveSessionId("");
            }
        }
        return (await openSession(config.profile_id, "", false)).session_id;
    }
    function setSendRunning(button, running) {
        if (!button) return;
        button.hidden = false;
        if (!button.dataset) button.dataset = {};
        button.dataset.loomRunning = running ? "1" : "0";
        button.title = running ? "发送跟进或引导" : "发送";
        button.setAttribute?.("aria-label", button.title);
        const stop = tools.assistantPanel?.()?.querySelector("#loom_assistant_stop");
        if (stop) {
            stop.hidden = !running;
            stop.disabled = !running;
        }
        tools.assistantPanel?.()?.querySelectorAll(".loom-assistant-runtime-control").forEach(function (control) {
            control.disabled = Boolean(running);
        });
    }
    function updateSessionUsage(usage) {
        tools.assistantState.sessionUsage = tools.normalizeAssistantUsage?.(usage) || usage || {};
        const item = tools.assistantPanel?.()?.querySelector("#loom_assistant_token_totals");
        if (item) item.textContent = tools.formatAssistantSessionUsage?.(tools.assistantState.sessionUsage) || "";
    }
    function queueStatusLabel(item) {
        if (item.state === "guide_waiting") return "等待模型接收";
        if (item.state === "failed") return "发送失败";
        if (item.state === "running") return "正在处理";
        return "已排队";
    }
    function renderAssistantQueue(messages) {
        const versions = tools.assistantState.queueVersions || (tools.assistantState.queueVersions = {});
        (messages || []).forEach(function (item) { versions[item.message_id] = Math.max(Number(versions[item.message_id] || 0), Number(item.updated_at || 0)); });
        const visible = (messages || []).filter(function (item) {
            return ["pending", "guide_waiting", "failed", "running"].includes(item.state);
        }).sort(function (a, b) { return Number(a.sequence) - Number(b.sequence); });
        const primaryHead = visible.find(function (item) { return item.kind === "primary" && ["pending", "failed"].includes(item.state); });
        tools.assistantState.queue = visible;
        const holder = tools.assistantPanel?.()?.querySelector("#loom_assistant_queue");
        if (!holder) return;
        holder.replaceChildren();
        visible.forEach(function (item) {
            const row = document.createElement("li");
            row.className = "loom-assistant-queue-item";
            row.dataset.loomQueueStatus = item.state;
            row.dataset.loomMessageId = item.message_id;
            const head = document.createElement("div");
            head.className = "loom-assistant-queue-head";
            const kind = document.createElement("strong");
            kind.textContent = item.kind === "guide" ? "引导" : "队列";
            const status = document.createElement("span");
            status.textContent = queueStatusLabel(item);
            head.append(kind, status);
            const body = document.createElement("div");
            body.className = "loom-assistant-queue-body";
            body.textContent = item.display_content || tools.messageText(item.content) || "附件消息";
            row.append(head, body);
            if (["pending", "guide_waiting", "failed"].includes(item.state)) {
                const actions = document.createElement("div");
                actions.className = "loom-assistant-queue-actions";
                const edit = document.createElement("button");
                edit.type = "button";
                edit.textContent = "编辑";
                edit.addEventListener("click", function () {
                    const input = tools.assistantPanel?.()?.querySelector("#loom_assistant_input");
                    if (!input) return;
                    tools.assistantState.editingQueueId = item.message_id;
                    input.value = item.display_content || tools.messageText(item.content);
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                    tools.setAssistantAttachments?.(item.attachments || []);
                    input.focus();
                });
                const cancel = document.createElement("button");
                cancel.type = "button";
                cancel.textContent = "撤销";
                cancel.addEventListener("click", function () { cancelQueuedMessage(item.message_id); });
                if (item.state !== "failed") actions.append(edit, cancel);
                if (primaryHead?.message_id === item.message_id && (item.state === "failed" || (item.state === "pending" && tools.assistantState.queuePaused))) {
                    const retry = document.createElement("button");
                    retry.type = "button";
                    retry.textContent = item.state === "failed" ? "重试" : "继续";
                    retry.addEventListener("click", function () { retryQueuedMessage(item.message_id); });
                    actions.appendChild(retry);
                }
                row.appendChild(actions);
            }
            holder.appendChild(row);
        });
        holder.hidden = !visible.length;
    }
    function mergeQueueMessage(message) {
        const versions = tools.assistantState.queueVersions || (tools.assistantState.queueVersions = {});
        const updatedAt = Number(message.updated_at || 0);
        if (Number(versions[message.message_id] || 0) > updatedAt) return;
        versions[message.message_id] = updatedAt;
        const current = Array.isArray(tools.assistantState.queue) ? tools.assistantState.queue.slice() : [];
        const index = current.findIndex(function (item) { return item.message_id === message.message_id; });
        if (index >= 0 && Number(current[index].updated_at || 0) > Number(message.updated_at || 0)) return;
        if (index >= 0) current[index] = message;
        else current.push(message);
        renderAssistantQueue(current);
    }
    function clearClaimedQueueEditor(message) {
        if (tools.assistantState.editingQueueId !== message?.message_id || ["pending", "guide_waiting", "failed"].includes(message.state)) return;
        tools.assistantState.editingQueueId = "";
        const input = tools.assistantPanel?.()?.querySelector("#loom_assistant_input"); if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
        tools.setAssistantAttachments?.([]);
    }
    function renderClaimedQueueMessage(message, run) {
        if (!message || !["running", "claimed"].includes(message.state)) return null;
        const log = tools.assistantPanel?.()?.querySelector("#loom_assistant_messages");
        if (log?.querySelector(`[data-loom-message-id="${message.message_id}"]`)) return null;
        const item = tools.addAssistantUserMessage(
            message.display_content || tools.messageText(message.content),
            message.attachments?.length ? message.attachments : tools.messageAttachments(message.content),
            message.display_content || tools.messageText(message.content)
        );
        if (item) {
            item.dataset.loomMessageId = message.message_id;
            if (message.kind === "guide") {
                item.dataset.loomGuide = "claimed";
                item.dataset.loomRole = "引导";
            }
        }
        run?.renderedMessages?.add(message.message_id);
        return item;
    }
    async function cancelQueuedMessage(messageId) {
        const sessionId = activeSessionId();
        if (!sessionId) return;
        const data = await ktJson(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/cancel`, { method: "POST" });
        mergeQueueMessage(data.message);
        clearClaimedQueueEditor(data.message);
    }
    async function retryQueuedMessage(messageId) {
        const sessionId = activeSessionId();
        if (!sessionId) return;
        const data = await ktJson(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/retry`, { method: "POST" });
        mergeQueueMessage(data.message);
        await reattachQueuedTurn("");
    }
    async function editQueuedMessage(sessionId, messageId, content, displayContent, attachments) {
        try {
            const data = await ktJson(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: content, display_content: displayContent, attachments: attachments })
            });
            tools.assistantState.editingQueueId = "";
            mergeQueueMessage(data.message);
            return data.message;
        } catch (error) {
            tools.assistantState.editingQueueId = "";
            tools.setAssistantAttachments?.([]);
            const input = tools.assistantPanel?.()?.querySelector("#loom_assistant_input");
            if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
            const runtime = await ktJson("/runtime").catch(function () { return null; });
            if (runtime) {
                tools.assistantState.queuePaused = Boolean(runtime.queue_paused);
                renderAssistantQueue(runtime.messages || []);
            }
            throw error;
        }
    }
    function assertRunning(run) {
        if (!run || run.cancelled || run.controller.signal.aborted) throw new Error("assistant run aborted");
    }
    function sseFrames(buffer) {
        const frames = [];
        let rest = buffer;
        let boundary;
        while ((boundary = rest.search(/\r?\n\r?\n/)) >= 0) {
            const marker = rest.match(/\r?\n\r?\n/);
            frames.push(rest.slice(0, boundary));
            rest = rest.slice(boundary + marker[0].length);
        }
        return { frames: frames, rest: rest };
    }
    function parseSseFrame(frame) {
        if (!frame || frame.startsWith(":")) return null;
        let id = 0;
        let type = "message";
        const data = [];
        frame.split(/\r?\n/).forEach(function (line) {
            if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || 0;
            else if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        });
        if (!data.length) return null;
        const event = JSON.parse(data.join("\n"));
        if (!event.sequence && id) event.sequence = id;
        if (!event.type) event.type = type;
        return event;
    }
    async function consumeSse(path, run, cursorName, onEvent) {
        let delay = 100;
        let attempts = 0;
        while (!run.finished && !run.controller.signal.aborted) {
            try {
                const cursor = Number(run[cursorName]) || 0;
                const response = await ktRequest(`${path}?after=${cursor}`, {
                    headers: { "Last-Event-ID": String(cursor) },
                    signal: run.streamController.signal
                });
                if (!response.body) throw new Error("SSE response body is unavailable");
                attempts = 0;
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                while (!run.finished) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    buffer += decoder.decode(chunk.value, { stream: true });
                    const parsed = sseFrames(buffer);
                    buffer = parsed.rest;
                    for (const frame of parsed.frames) {
                        const event = parseSseFrame(frame);
                        if (!event) continue;
                        await onEvent(event);
                        run[cursorName] = Math.max(Number(run[cursorName]) || 0, Number(event.sequence) || 0);
                    }
                }
                delay = 100;
            } catch (error) {
                if (run.finished || run.streamController.signal.aborted) return;
                attempts += 1;
                if (run.statusItem) tools.updateAssistantMessage(run.statusItem, "status", `连接恢复中 · 第 ${attempts} 次`);
                await new Promise(function (resolve) { window.setTimeout(resolve, delay); });
                delay = Math.min(delay * 2, 2000);
            }
        }
    }
    function unpackForgeArguments(args) {
        const source = args && typeof args === "object" ? Object.assign({}, args) : {};
        if (typeof source.content !== "string") return source;
        try {
            const parsed = JSON.parse(source.content);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return source;
            delete source.content;
            return Object.assign(source, parsed);
        } catch (_error) {
            return source;
        }
    }
    function adaptForgeTool(tool, rawArgs) {
        const args = unpackForgeArguments(rawArgs);
        if (tool === "initialize_prompt") {
            return {
                tool: tool,
                arguments: Object.assign({}, args, {
                    positive_prompt: args.positive_prompt === undefined ? args.positive : args.positive_prompt,
                    negative_prompt: args.negative_prompt === undefined ? args.negative : args.negative_prompt
                })
            };
        }
        if (tool === "edit_prompt") {
            const field = args.field === "negative" ? "negative" : "positive";
            const promptKey = field === "negative" ? "negative_prompt" : "positive_prompt";
            const hashKey = field === "negative" ? "negative_prompt_hash" : "positive_prompt_hash";
            return {
                tool: tool,
                arguments: Object.assign({}, args, {
                    field: field,
                    prompt: args.prompt === undefined ? args[promptKey] : args.prompt,
                    base_hash: args.base_hash || args[hashKey] || args.prompt_hash
                })
            };
        }
        if (tool !== "forge_resource") return { tool: tool, arguments: args };
        const action = String(args.action || "");
        if (action === "search") return { tool: "search_resources", arguments: args };
        if (action === "inspect") return { tool: "inspect_resource", arguments: Object.assign({}, args, { id: args.resource_id }) };
        if (action === "apply") return { tool: "apply_resource", arguments: Object.assign({}, args, { id: args.resource_id }) };
        return { tool: tool, arguments: args };
    }
    async function replyToTool(requestId, result) {
        try {
            await ktJson(`/tools/replies/${encodeURIComponent(requestId)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign({ bridge_id: BRIDGE_ID }, result))
            });
        } catch (error) {
            if (!/unknown tool request|already completed/i.test(String(error.message || error))) throw error;
        }
    }

    async function handleToolEvent(run, event) {
        if (event.type !== "tool_request") return;
        const payload = event.payload || {};
        if (payload.bridge_id !== BRIDGE_ID) return;
        if (!payload.request_id || run.toolRequests.has(payload.request_id)) return;
        run.toolRequests.add(payload.request_id);
        const call = adaptForgeTool(payload.tool, payload.arguments || {});
        const authorizedMode = tools.normalizedAgentMode(payload.agent_mode);
        let result = run.toolResults.get(payload.request_id);
        if (!result) {
            try {
                assertRunning(run);
                if (tools.isYoloTool?.(call.tool) && authorizedMode !== "yolo") {
                    result = { ok: false, error: "YOLO mode is required" };
                } else {
                    if (authorizedMode === "yolo") call.arguments._yolo_authorized = true;
                    result = await tools.executeAssistantTool(call, run.controller.signal);
                }
            } catch (error) {
                result = { ok: false, error: String(error?.message || error) };
            }
            run.toolResults.set(payload.request_id, result);
            const label = tools.assistantToolResultLabel?.(call.tool, result) || `工具 ${call.tool}: ${result.ok ? "完成" : "失败"}`;
            tools.addAssistantMessage("tool", label);
        }
        try {
            await replyToTool(payload.request_id, result);
            run.toolResults.delete(payload.request_id);
        } catch (error) {
            run.toolRequests.delete(payload.request_id);
            throw error;
        }
    }

    function handleTurnEvent(run, event) {
        const payload = event.payload || {};
        if (event.type === "message_queued" || event.type === "message_updated") {
            if (payload.message) {
                clearClaimedQueueEditor(payload.message);
                mergeQueueMessage(payload.message);
                if (["running", "claimed"].includes(payload.message.state) && !run.renderedMessages.has(payload.message.message_id)) {
                    renderClaimedQueueMessage(payload.message, run);
                }
            }
            return;
        }
        if (event.type === "queue_paused") {
            tools.assistantState.queuePaused = true;
            renderAssistantQueue(tools.assistantState.queue || []);
            if (run.statusItem) tools.updateAssistantMessage(run.statusItem, "status", "队列已暂停");
            return;
        }
        if (event.type === "queue_resumed") {
            tools.assistantState.queuePaused = false;
            renderAssistantQueue(tools.assistantState.queue || []);
            return;
        }
        if (run.turnId && payload.turn_id && payload.turn_id !== run.turnId) return;
        if (event.type === "text_delta") {
            run.text += String(payload.text || "");
            if (!run.streamItem) run.streamItem = tools.addAssistantMessage("assistant", "");
            tools.updateAssistantStreamingMessage(run.streamItem, run.text, run.reasoning, tools.renderAssistantMarkdown, run.recoveryLabel);
            return;
        }
        if (event.type === "reasoning_delta" || event.type === "reasoning_snapshot") {
            const reasoning = String(payload.text || "");
            run.reasoning = event.type === "reasoning_snapshot" ? reasoning : run.reasoning + reasoning;
            if (!run.streamItem) run.streamItem = tools.addAssistantMessage("assistant", "");
            tools.updateAssistantStreamingMessage(run.streamItem, run.text, run.reasoning, tools.renderAssistantMarkdown, run.recoveryLabel);
            return;
        }
        if (event.type === "provider_retry") {
            const attempt = Number(payload.attempt) || 1;
            const delay = Math.round(Number(payload.delay) || 0);
            run.recoveryLabel = `正在恢复 · ${payload.provider || "provider"} · 重试 ${attempt}/5 · ${delay}s`;
            if (run.streamItem) tools.updateAssistantStreamingMessage(run.streamItem, run.text, run.reasoning, tools.renderAssistantMarkdown, run.recoveryLabel);
            if (run.statusItem) tools.updateAssistantMessage(run.statusItem, "status", run.recoveryLabel);
            return;
        }
        if (event.type === "usage") {
            run.usage = payload.usage || payload;
            if (payload.session_usage) updateSessionUsage(payload.session_usage);
            if (run.statusItem) tools.updateAssistantMessage(run.statusItem, "status", tools.formatAssistantTokenStatus(run.usage));
            return;
        }
        if (event.type !== "turn_ended") return;
        run.result = payload;
        if (payload.session_usage) updateSessionUsage(payload.session_usage);
        if (!run.streamItem && payload.text) run.streamItem = tools.addAssistantMessage("assistant", payload.text);
        else if (run.streamItem && payload.text && payload.text !== run.text) {
            run.text = payload.text;
            tools.updateAssistantStreamingMessage(run.streamItem, run.text, run.reasoning, tools.renderAssistantMarkdown);
        }
        run.finished = true;
        run.streamController.abort();
        run.resolve(payload);
    }

    function createAssistantRun(runtime) {
        const snapshot = runtime?.active_turn || {};
        const run = {
            controller: new AbortController(),
            streamController: new AbortController(),
            cancelled: false,
            finished: false,
            turnCursor: Number(runtime?.turn_event_sequence) || 0,
            toolCursor: Number(runtime?.tool_event_sequence) || 0,
            toolRequests: new Set(),
            toolResults: new Map(),
            renderedMessages: new Set(),
            turnId: runtime?.active_turn_id || snapshot.turn_id || "",
            text: String(snapshot.text || ""),
            reasoning: String(snapshot.reasoning || ""),
            usage: snapshot.usage || null,
            recoveryLabel: snapshot.retry ? `正在恢复 · ${snapshot.retry.provider || "provider"} · 重试 ${snapshot.retry.attempt || 1}/5` : "",
            streamItem: null
        };
        run.done = new Promise(function (resolve, reject) { run.resolve = resolve; run.reject = reject; });
        return run;
    }

    async function reattachQueuedTurn(previousTurnId) {
        for (let attempt = 0; attempt < 300; attempt += 1) {
            if (tools.assistantState.running) return;
            const runtime = await ktJson("/runtime").catch(function () { return null; });
            if (runtime?.queue_paused) return;
            if (runtime?.active_turn_id && runtime.active_turn_id !== previousTurnId) {
                await attachActiveRuntime(runtime);
                return;
            }
            if (!runtime?.messages?.some(function (item) { return ["pending", "running"].includes(item.state); })) return;
            await new Promise(function (resolve) { window.setTimeout(resolve, 50); });
        }
    }

    async function attachRunStreams(run) {
        const claim = await tools.startAssistantBridgeLease(run);
        const turnEvents = consumeSse("/turns/events", run, "turnCursor", function (event) { return handleTurnEvent(run, event); });
        const toolEvents = consumeSse("/tools/events", run, "toolCursor", function (event) { return handleToolEvent(run, event); });
        return { streams: [turnEvents, toolEvents], claim: claim };
    }

    async function settledRuntime(turnId) {
        let latest = null;
        for (let attempt = 0; attempt < 300; attempt += 1) {
            latest = await ktJson("/runtime").catch(function () { return null; });
            if (!latest) return null;
            const settling = latest.active_turn_id === turnId || latest.settling_turn_id === turnId || (latest.messages || []).some(function (item) {
                return item.state === "running" && item.turn_id === turnId;
            });
            if (!settling) return latest;
            await new Promise(function (resolve) { window.setTimeout(resolve, 50); });
        }
        return latest;
    }

    async function attachActiveRuntime(runtime) {
        const state = tools.assistantState;
        const current = runtime || await ktJson("/runtime");
        if (current.active_session?.agent_mode) {
            tools.assistantState.agentMode = tools.storeAssistantAgentMode(current.active_session.session_id, current.active_session.agent_mode);
            tools.syncAssistantAgentMode();
        }
        tools.assistantState.queuePaused = Boolean(current.queue_paused);
        renderAssistantQueue(current.messages || []);
        updateSessionUsage(current.token_usage || {});
        if (!current.active_turn_id || state.running) return state.running;
        const run = createAssistantRun(current);
        state.running = run;
        setSendRunning(tools.assistantPanel?.()?.querySelector("#loom_assistant_send"), true);
        run.statusItem = tools.addAssistantMessage("status", run.recoveryLabel || "正在恢复运行...");
        if (run.text || run.reasoning) {
            run.streamItem = tools.addAssistantMessage("assistant", "");
            tools.updateAssistantStreamingMessage(run.streamItem, run.text, run.reasoning, tools.renderAssistantMarkdown, run.recoveryLabel || "运行时输出恢复");
        }
        (current.messages || []).forEach(function (message) { renderClaimedQueueMessage(message, run); });
        const attached = await attachRunStreams(run);
        const pending = attached.claim?.pending_requests || current.pending_tool_requests || [];
        for (const request of pending) {
            await handleToolEvent(run, { type: "tool_request", payload: request });
        }
        const streams = attached.streams;
        run.done.finally(async function () {
            run.finished = true;
            run.streamController.abort();
            run.controller.abort();
            tools.stopAssistantBridgeLease(run);
            await Promise.allSettled(streams);
            const latest = await settledRuntime(run.turnId);
            if (latest) {
                tools.assistantState.queuePaused = Boolean(latest.queue_paused);
                renderAssistantQueue(latest.messages || []);
                updateSessionUsage(latest.token_usage || {});
            }
            run.statusItem?.remove();
            if (state.running === run) state.running = null;
            setSendRunning(tools.assistantPanel?.()?.querySelector("#loom_assistant_send"), false);
            if (!latest?.queue_paused) reattachQueuedTurn(run.turnId).catch(function () { });
        });
        return run;
    }

    function attachmentAnalysisProfile(config) {
        const state = tools.profileStore.load();
        if (tools.assistantUsesGeminiVisionDelegate?.(config)) {
            const teacher = state.profiles.find(function (profile) { return profile.id === state.teacher_profile_id; });
            if (teacher?.enabled && teacher.capabilities?.vision) return teacher;
        }
        const local = state.profiles.find(function (profile) { return profile.id === state.session_profile_id; });
        if (local?.enabled && local.capabilities?.vision) return local;
        return state.profiles.find(function (profile) { return profile.enabled && profile.capabilities?.vision; }) || null;
    }

    async function summarizeAttachments(text, attachments, config, run) {
        if (!attachments.length || tools.assistantSupportsNativeImages?.(config)) {
            return attachments.length ? tools.attachmentContent(text, attachments) : text;
        }
        const profile = attachmentAnalysisProfile(config);
        if (!profile) throw new Error("No enabled vision Profile is available for attachment analysis");
        const summaries = [];
        for (const [index, attachment] of attachments.entries()) {
            assertRunning(run);
            const prompt = `Analyze reference image ${index + 1} for a downstream prompt assistant. Return a concise factual briefing covering subject count, composition, spatial relationships, clothing, objects, setting, lighting, camera, and reusable style. Do not use markdown or call tools.${text ? `\nUser task context: ${text.slice(0, 800)}` : ""}`;
            const result = await profileChat(profile.id, tools.attachmentContent(prompt, [attachment]), run.controller.signal);
            const summary = String(result.text || "").trim();
            if (!summary) throw new Error(`Vision Profile ${profile.display_name || profile.id} returned an empty briefing`);
            summaries.push(`Reference image ${index + 1} (${attachment.name || "image"}):\n${summary}`);
            tools.addAssistantMessage("tool", `视觉摘要 (${profile.display_name || result.model || profile.id}):\n${tools.truncateAssistantText(summary, 1200)}`);
        }
        return `${text}\n\n${summaries.join("\n\n")}`.trim();
    }

    function legacyTranscript(data) {
        const rows = [];
        if (data.session?.summary) rows.push(`Earlier summary: ${data.session.summary}`);
        (data.events || []).forEach(function (event) {
            const payload = event.payload || {};
            const message = payload.message || payload;
            const content = String(message.content || "").trim();
            if (!content) return;
            if (event.event_type === "user_message" || event.event_type === "user_followup_queued") rows.push(`User: ${content}`);
            else if (event.event_type === "assistant_message" && !message.tool_calls?.length) rows.push(`Assistant: ${content}`);
        });
        const transcript = rows.join("\n\n");
        return transcript.length > 48000 ? transcript.slice(-48000) : transcript;
    }

    function renderLegacySession(data) {
        const panel = tools.assistantPanel?.();
        const log = panel?.querySelector("#loom_assistant_messages");
        if (!log) return;
        log.replaceChildren();
        tools.addAssistantMessage("tool", "旧会话只读预览。发送下一条消息时会创建新的 KT 会话并携带此上下文。");
        (data.events || []).forEach(function (event) {
            const payload = event.payload || {};
            const message = payload.message || payload;
            if (event.event_type === "user_message" || event.event_type === "user_followup_queued") {
                tools.addAssistantUserMessage(message.content || "", message.image ? [{ dataUrl: message.image, name: message.filename || "reference image" }] : [], message.content || "");
            } else if (event.event_type === "assistant_message" && !message.tool_calls?.length) {
                tools.addAssistantMessage("assistant", message.content || "");
            }
        });
        tools.assistantState.legacyContext = legacyTranscript(data);
        if (panel) panel.dataset.loomSessionRestored = "legacy";
    }

    async function runAssistantSessionLoop(userText, attachment, displayText) {
        const state = tools.assistantState;
        if (state.running || (state.queue || []).length) return queueAssistantFollowup(userText, attachment, displayText);
        const attachments = tools.normalizedAssistantAttachments?.(attachment) || (attachment ? [attachment] : []);
        const text = String(userText || (attachments.length ? "请根据附件例图分析构图和风格，帮助我整理提示词。" : "")).trim();
        if (!text && !attachments.length) return;
        if (state.editingQueueId) {
            const sessionId = activeSessionId();
            if (!sessionId) return;
            try {
                const content = attachments.length ? tools.attachmentContent(text, attachments) : text;
                await editQueuedMessage(sessionId, state.editingQueueId, content, displayText === undefined ? text : displayText, attachments);
            } catch (error) {
                tools.addAssistantMessage("error", String(error?.message || error));
            }
            return;
        }
        const config = tools.assistantConfig();
        const run = createAssistantRun();
        const sendButton = tools.assistantPanel?.()?.querySelector("#loom_assistant_send");
        let status = null;
        state.running = run;
        setSendRunning(sendButton, true);
        try {
            await ensureAssistantSession(config);
            const sessionId = activeSessionId();
            const conversation = await ktJson(`/sessions/${encodeURIComponent(sessionId)}`);
            const userIndex = (conversation.messages || []).filter(function (message) { return message.role === "user"; }).length;
            const forgeSnapshot = tools.captureForgeUiState?.();
            storeRewindSnapshot(sessionId, userIndex, forgeSnapshot);
            tools.addAssistantUserMessage(displayText === undefined ? text : displayText, attachments, text, forgeSnapshot);
            let content = await summarizeAttachments(text, attachments, config, run);
            if (state.legacyContext) {
                const imported = `Read-only conversation imported from the legacy Loom runtime:\n\n${state.legacyContext}\n\nCurrent user request:\n`;
                if (Array.isArray(content)) content = [{ type: "text", text: imported }, ...content];
                else content = imported + content;
                state.legacyContext = "";
            }
            const runtime = await ktJson("/runtime");
            run.turnCursor = Number(runtime.turn_event_sequence) || 0;
            run.toolCursor = Number(runtime.tool_event_sequence) || 0;
            status = tools.addAssistantMessage("status", "思考中...");
            run.statusItem = status;
            const streams = (await attachRunStreams(run)).streams;
            const turnOperationId = tools.assistantOperationId("turn");
            let accepted;
            try {
                accepted = await ktJson("/turns", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ content: content, timeout: config.timeout || config.parameters?.timeout || 120, operation_id: turnOperationId })
                });
            } catch (error) {
                const recovered = await ktJson("/runtime").catch(function () { return null; });
                const snapshot = recovered?.active_turn || recovered?.last_turn;
                if (snapshot?.operation_id !== turnOperationId) throw error;
                accepted = { turn_id: snapshot.turn_id, status: "accepted", operation_id: turnOperationId };
            }
            run.turnId = accepted.turn_id;
            const result = await run.done;
            status?.remove();
            status = null;
            if (!["ok", "completed"].includes(String(result.status || "").toLowerCase()) && !run.cancelled) {
                throw new Error(result.error || `KohakuTerrarium turn ended with status ${result.status}`);
            }
            await Promise.allSettled(streams);
        } catch (error) {
            status?.remove();
            const message = String(error?.message || error);
            if (run.cancelled || run.controller.signal.aborted || message === "assistant run aborted") tools.addAssistantMessage("status", "已终止。");
            else tools.addAssistantMessage("error", message);
        } finally {
            run.finished = true;
            run.streamController.abort();
            run.controller.abort();
            tools.stopAssistantBridgeLease(run);
            if (state.running === run) state.running = null;
            setSendRunning(sendButton, false);
            const latest = await settledRuntime(run.turnId);
            if (latest) {
                state.queuePaused = Boolean(latest.queue_paused);
                renderAssistantQueue(latest.messages || []);
                updateSessionUsage(latest.token_usage || {});
            }
            if (!latest?.queue_paused) reattachQueuedTurn(run.turnId).catch(function () { });
        }
    }

    function queueAssistantFollowup(userText, attachment, displayText) {
        const attachments = tools.normalizedAssistantAttachments?.(attachment) || (attachment ? [attachment] : []);
        const text = String(userText || "").trim();
        if (!text && !attachments.length) return Promise.resolve();
        return (async function () {
            const sessionId = activeSessionId();
            if (!sessionId) throw new Error("当前会话不可用");
            let content = text;
            if (attachments.length) {
                const prepRun = tools.assistantState.running || {
                    controller: new AbortController(),
                    cancelled: false
                };
                content = await summarizeAttachments(text, attachments, tools.assistantConfig(), prepRun);
            }
            const editingId = tools.assistantState.editingQueueId;
            if (editingId) {
                return await editQueuedMessage(sessionId, editingId, content, displayText === undefined ? text : displayText, attachments);
            }
            const messageOperationId = tools.assistantOperationId("message");
            let data;
            try {
                data = await ktJson(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ content: content, display_content: displayText === undefined ? text : displayText, attachments: attachments, operation_id: messageOperationId })
                });
            } catch (error) {
                const recovered = await ktJson("/runtime").catch(function () { return null; });
                const message = (recovered?.messages || []).concat(recovered?.recent_operations || []).find(function (item) { return item.operation_id === messageOperationId; });
                if (!message) throw error;
                data = { message: message };
            }
            mergeQueueMessage(data.message);
            await reattachQueuedTurn("");
            return data.message;
        })().catch(function (error) {
            tools.addAssistantMessage("error", String(error?.message || error));
        });
    }

    function cancelAssistantSessionRun() {
        const run = tools.assistantState.running;
        if (!run || run.cancelled) return;
        run.cancelled = true;
        run.recoveryLabel = "已停止，部分输出已保留";
        if (run.streamItem) tools.updateAssistantStreamingMessage(run.streamItem, run.text, run.reasoning, tools.renderAssistantMarkdown, run.recoveryLabel);
        if (run.statusItem) tools.updateAssistantMessage(run.statusItem, "status", "正在停止...");
        run.controller.abort();
        if (run.turnId) fetch(`${BASE}/turns/${encodeURIComponent(run.turnId)}/cancel`, { method: "POST" }).catch(function () { });
    }

    function renderConversationMessage(message, userIndex, sessionId) {
        const role = String(message.role || "");
        if (role === "system" || role === "tool") return;
        const text = tools.messageText(message.content);
        if (role === "user") tools.addAssistantUserMessage(text, tools.messageAttachments(message.content), text, rewindSnapshot(sessionId, userIndex));
        else if (role === "assistant" && text) tools.addAssistantMessage("assistant", text);
    }

    async function restoreAssistantSession() {
        const panel = tools.assistantPanel?.();
        const sessionId = activeSessionId();
        if (!panel || !sessionId || panel.dataset.loomSessionRestored === sessionId) return;
        if (restorePromise) return restorePromise;
        const generation = sessionGeneration;
        restorePromise = (async function () {
            try {
                const config = tools.assistantConfig();
                const runtime = await ktJson("/runtime");
                if (!runtime.active_session) await openSession(config.profile_id, sessionId, true);
                else if (runtime.active_session.session_id !== sessionId) {
                    await closeActiveSession();
                    await openSession(config.profile_id, sessionId, true);
                }
                const data = await ktJson(`/sessions/${encodeURIComponent(sessionId)}`);
                if (generation !== sessionGeneration || activeSessionId() !== sessionId) return;
                const log = panel.querySelector("#loom_assistant_messages");
                if (!log) return;
                log.replaceChildren();
                let userIndex = 0;
                (data.messages || []).forEach(function (message) {
                    const isUser = message.role === "user";
                    renderConversationMessage(message, userIndex, sessionId);
                    if (isUser) userIndex += 1;
                });
                tools.assistantState.queuePaused = Boolean(runtime.queue_paused);
                renderAssistantQueue(data.queue || runtime.messages || []);
                updateSessionUsage(data.token_usage || runtime.token_usage || {});
                (data.queue || runtime.messages || []).filter(function (message) {
                    return ["running", "claimed"].includes(message.state);
                }).forEach(function (message) {
                    const userItems = Array.from(log.querySelectorAll(".loom-assistant-user:not([data-loom-message-id])"));
                    const match = userItems.find(function (item) {
                        return String(item.querySelector(".loom-assistant-user-body")?.textContent || "") === String(message.display_content || tools.messageText(message.content));
                    });
                    if (match) {
                        match.dataset.loomMessageId = message.message_id;
                        if (message.kind === "guide") { match.dataset.loomGuide = "claimed"; match.dataset.loomRole = "引导"; }
                    }
                });
                panel.dataset.loomSessionRestored = sessionId;
                await attachActiveRuntime();
                await reattachQueuedTurn("");
            } catch (_error) {
                if (generation === sessionGeneration) setActiveSessionId("");
            } finally {
                restorePromise = null;
            }
        })();
        return restorePromise;
    }

    async function resetAssistantSession() {
        setActiveSessionId("");
        tools.assistantState.legacyContext = "";
        localStorage.removeItem(SESSION_PROFILE_KEY);
        await closeActiveSession().catch(function () { });
    }

    async function createAssistantSession() {
        if (tools.assistantState.running) return;
        tools.assistantState.agentMode = "normal";
        tools.syncAssistantAgentMode();
        const config = tools.assistantConfig();
        await closeActiveSession();
        const session = await openSession(config.profile_id, "", false);
        const panel = tools.assistantPanel?.();
        panel?.querySelector("#loom_assistant_messages")?.replaceChildren();
        if (panel) panel.dataset.loomSessionRestored = session.session_id;
    }

    Object.assign(tools, {
        KT_ASSISTANT_BASE: BASE,
        ktAssistantJson: ktJson,
        assistantRuntime,
        setAssistantRuntime,
        importAssistantProfiles,
        profileChat,
        ensureAssistantSession,
        runAssistantSessionLoop,
        queueAssistantFollowup,
        cancelAssistantSessionRun,
        restoreAssistantSession,
        renderAssistantQueue,
        attachActiveRuntime,
        cancelQueuedMessage,
        retryQueuedMessage,
        resetAssistantSession,
        createAssistantSession,
        activeAssistantSessionId: activeSessionId,
        setActiveAssistantSessionId: setActiveSessionId,
        closeActiveAssistantSession: closeActiveSession,
        renderLegacyAssistantSession: renderLegacySession,
        assistantSessionListPath,
        sessionListLabel,
        sessionMetadataStatus,
        rewindSnapshots,
        rewindSnapshot,
        storeRewindSnapshot,
        parseKtSseFrame: parseSseFrame,
        adaptKtForgeTool: adaptForgeTool,
        setAssistantRunning: setSendRunning,
        handleKtTurnEvent: handleTurnEvent,
        handleKtToolEvent: handleToolEvent
    });
})();
