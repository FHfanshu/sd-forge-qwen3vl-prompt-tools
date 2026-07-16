(function () {
    const tools = window.kohakuLoom;
    if (!tools) return;

    async function ktJson(path, options) {
        const response = await fetch(tools.KT_ASSISTANT_BASE + path, options);
        if (!response.ok) throw new Error(await response.text());
        return response.json();
    }

    async function forgeJson(path) {
        const response = await fetch(`/kohaku-loom${path}`);
        if (!response.ok) throw new Error(await response.text());
        return response.json();
    }

    function openAssistantSessionHistory() {
        const panel = tools.assistantPanel?.();
        if (!panel) return;
        tools.assistantState.sessionHistoryCleanup?.();
        const menu = document.createElement("div");
        const results = document.createElement("div");
        const backButton = panel.querySelector("#loom_assistant_history_back");
        menu.id = "loom_assistant_session_menu";
        menu.className = "loom-assistant-session-menu loom-assistant-session-page";
        results.className = "loom-assistant-session-results";
        results.textContent = "Loading...";
        menu.appendChild(results);
        panel.appendChild(menu);
        panel.classList.add("loom-assistant-history-open");
        panel.querySelector("#loom_assistant_session_title")?.setAttribute("aria-expanded", "true");
        panel.querySelector(".loom-assistant-chat-head")?.setAttribute("hidden", "");
        panel.querySelector(".loom-assistant-history-head")?.removeAttribute("hidden");
        let refreshTimer = null;
        let renderVersion = 0;
        const closeMenu = function () {
            if (refreshTimer) window.clearInterval(refreshTimer);
            refreshTimer = null;
            menu.remove();
            panel.classList.remove("loom-assistant-history-open");
            panel.querySelector("#loom_assistant_session_title")?.setAttribute("aria-expanded", "false");
            panel.querySelector(".loom-assistant-chat-head")?.removeAttribute("hidden");
            panel.querySelector(".loom-assistant-history-head")?.setAttribute("hidden", "");
            if (backButton) backButton.onclick = null;
            if (tools.assistantState.sessionHistoryCleanup === closeMenu) tools.assistantState.sessionHistoryCleanup = null;
            panel.querySelector("#loom_assistant_session_title")?.focus();
        };
        tools.assistantState.sessionHistoryCleanup = closeMenu;
        if (backButton) backButton.onclick = closeMenu;
        const renderSessions = async function () {
            const version = ++renderVersion;
            if (!menu.isConnected) { closeMenu(); return; }
            const [data, legacy] = await Promise.all([
                ktJson(tools.assistantSessionListPath()),
                forgeJson("/legacy-sessions?limit=30").catch(function () { return { sessions: [] }; })
            ]);
            if (!menu.isConnected || version !== renderVersion) return;
            results.replaceChildren();
            (data.sessions || []).forEach(function (session) { renderSessionRow(session); });
            (legacy.sessions || []).forEach(function (session) { renderLegacyRow(session); });
            if (!results.childElementCount) results.textContent = "No saved sessions";
        };
        function renderSessionRow(session) {
            const item = document.createElement("div");
            const open = document.createElement("button");
            const refresh = document.createElement("button");
            const title = document.createElement("strong");
            const description = document.createElement("span");
            const details = document.createElement("small");
            item.className = "loom-assistant-session-item";
            item.dataset.loomSessionStatus = String(session.status || "pending");
            open.type = refresh.type = "button";
            open.className = "loom-assistant-session-open";
            title.textContent = tools.sessionListLabel(session);
            description.textContent = String(session.description || "等待生成会话说明");
            const modified = session.modified_at ? new Date(session.modified_at * 1000).toLocaleString() : "";
            details.textContent = `${tools.sessionMetadataStatus(session)}${modified ? ` · ${modified}` : ""}`;
            open.append(title, description, details);
            if (session.session_id === tools.activeAssistantSessionId()) open.setAttribute("aria-current", "true");
            open.addEventListener("click", async function () {
                if (tools.assistantState.running) return;
                await tools.closeActiveAssistantSession();
                tools.setActiveAssistantSessionId(session.session_id);
                tools.setAssistantSessionTitle?.(session.title);
                panel.dataset.loomSessionRestored = "";
                panel.querySelector("#loom_assistant_messages")?.replaceChildren();
                closeMenu();
                await tools.restoreAssistantSession();
            });
            refresh.className = "loom-assistant-session-refresh";
            refresh.textContent = "↻";
            refresh.title = "重新生成标题和说明";
            refresh.setAttribute("aria-label", refresh.title);
            refresh.disabled = session.status === "generating";
            refresh.addEventListener("click", async function () {
                refresh.disabled = true;
                try {
                    await ktJson(`/sessions/${encodeURIComponent(session.session_id)}/metadata`, {
                        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh: true })
                    });
                    await renderSessions();
                } catch (error) {
                    tools.addAssistantMessage("error", String(error?.message || error));
                    refresh.disabled = false;
                }
            });
            item.append(open, refresh);
            results.appendChild(item);
        }
        function renderLegacyRow(session) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "loom-assistant-session-legacy";
            item.textContent = `旧 · ${session.title || session.session_id}`;
            item.addEventListener("click", async function () {
                if (tools.assistantState.running) return;
                await tools.closeActiveAssistantSession();
                tools.setActiveAssistantSessionId("");
                tools.setAssistantSessionTitle?.(session.title);
                const data = await forgeJson(`/legacy-sessions/${encodeURIComponent(session.session_id)}`);
                closeMenu();
                tools.renderLegacyAssistantSession(data);
            });
            results.appendChild(item);
        }
        renderSessions().then(function () {
            refreshTimer = window.setInterval(function () {
                if (!menu.isConnected) { closeMenu(); return; }
                renderSessions().catch(function () { });
            }, 1200);
        }).catch(function () { results.textContent = "Unable to load sessions"; });
    }

    tools.openAssistantSessionHistory = openAssistantSessionHistory;
})();
