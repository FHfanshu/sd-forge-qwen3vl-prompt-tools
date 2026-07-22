<script lang="ts">
  import { onMount } from "svelte";
  import { Activity, Brain, Check, Copy, Grip, KeyRound, Languages, MoreHorizontal, Plus, RefreshCw, RotateCcw, Save, ServerCog, ShieldAlert, Trash2, X } from "lucide-svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { NativeSelect } from "$lib/components/ui/native-select";
  import { AlertDialog } from "$lib/components/ui/alert-dialog";
  import { DropdownMenu } from "$lib/components/ui/dropdown-menu";
  import { Tabs } from "$lib/components/ui/tabs";
  import type { ProfilePatch } from "../contracts";
  import { listProfiles, testProfileConnection, updateProfile as updateRemoteProfile } from "../profile-api";
  import { syncProfileFromModelsDev } from "../profile-model-catalog";
  import { supportsAgentChat, unsupportedProfileCapabilities } from "../providers/profile-capabilities";
  import type { ProviderCapability } from "../providers/capabilities";
  import { useI18nStore } from "../stores/i18n";
  import { useProfileStore } from "../stores/profiles";
  import { useUiStore } from "../stores/ui";
  import { clampWindowLayout, pointerWindow, readViewportRect, resolveViewportAfterKeyboard, viewportKind, type LayoutViewport } from "../window-interactions";
  import CommitInput from "./settings/CommitInput.svelte";
  import CommitTextarea from "./settings/CommitTextarea.svelte";
  import Field from "./settings/Field.svelte";
  import Route from "./settings/RouteField.svelte";
  import Heading from "./settings/SectionHeading.svelte";
  import Toggle from "./settings/ToggleField.svelte";

  let { open, onclose }: { open: boolean; onclose(): void } = $props();
  let tab = $state("model");
  let showKey = $state(false);
  let apiKeyDrafts = $state<Record<string, string>>({});
  let localPathDrafts = $state<Record<string, { modelPath?: string; mmprojPath?: string; draftModelPath?: string; llamaServerPath?: string }>>({});
  let status = $state("");
  let busy = $state<"save" | "test" | "sync" | "delete" | null>(null);
  let confirm = $state<"delete" | "restore" | null>(null);
  let pendingDeleteProfileId = $state<string | null>(null);
  let interacting = $state(false);
  let windowElement = $state<HTMLDivElement>();
  let connectionController: AbortController | null = null;
  let wasOpen = false;
  let stableViewport = readViewportRect();
  let viewportRecovering = $state(false);
  let kind = $state<LayoutViewport>(viewportKind(stableViewport));
  let viewport = $state(stableViewport);
  const minimum = $derived(kind === "desktop"
    ? { width: 340, height: 420 }
    : { width: 320, height: kind === "mobileLandscape" ? 240 : 360 });
  const selected = $derived($useProfileStore.profiles.find((profile) => profile.id === $useProfileStore.selectedProfileId) ?? $useProfileStore.profiles[0]);
  type ConnectionMode = "openai-compatible" | "gemini-native" | "llama-once";
  const connectionMode = $derived<ConnectionMode>(selected.runtime === "llama-once"
    ? "llama-once"
    : selected.protocol === "gemini-native" ? "gemini-native" : "openai-compatible");
  const apiKeyValue = $derived(apiKeyDrafts[selected.id] ?? "");
  const localPathDraft = $derived(localPathDrafts[selected.id] ?? {});
  const layout = $derived(clampWindowLayout($useUiStore.profileLayouts[kind], viewport, minimum));
  const enabledProfiles = $derived($useProfileStore.profiles.filter((profile) => profile.enabled));
  const localProfiles = $derived(enabledProfiles.filter((profile) => profile.runtime !== "remote-http"));
  const namingProfiles = $derived(enabledProfiles.filter((profile) => profile.runtime === "llama-once"));
  const profileTabs = $derived.by(() => [
    ["model", t("profiles.tab.model", "Model")],
    ...(selected.runtime !== "llama-once" ? [["connection", t("profiles.tab.connection", "Connection")]] : []),
    ["generation", t("profiles.tab.generation", "Generation")],
    ...(selected.runtime !== "remote-http" ? [["local", t("profiles.tab.local", "Local")]] : []),
    ["routes", t("profiles.tab.routes", "Routes")],
  ]);
  const reasoningScale = $derived.by(() => {
    if (!selected.capabilities.reasoning) return ["none"];
    const configured = selected.modelInfo.reasoningEfforts.map((value) => value.toLowerCase());
    const fallback = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    const values = selected.modelInfo.source === "models.dev"
      ? configured.length ? configured : ["high"]
      : fallback;
    if (selected.modelInfo.reasoningToggle && !values.includes("none")) values.unshift("none");
    return Array.from(new Set(values));
  });
  const reasoningIndex = $derived(Math.max(0, reasoningScale.indexOf(selected.parameters.reasoningEffort.toLowerCase())));
  const unsupportedCapabilities = $derived(unsupportedProfileCapabilities(selected));
  const agentChatSupported = $derived(supportsAgentChat(selected));

  function t(key: string, fallback: string): string {
    const value = $useI18nStore.t(key);
    return value === key ? fallback : value;
  }
  function isTextEntryFocused(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement
      || active instanceof HTMLSelectElement
      || (active instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit"].includes(active.type));
  }
  function refresh(): void {
    const focused = isTextEntryFocused();
    const next = resolveViewportAfterKeyboard(stableViewport, readViewportRect(), focused, viewportRecovering);
    stableViewport = next.stable;
    viewportRecovering = next.recovering;
    viewport = next.viewport;
    if (!focused) kind = viewportKind(viewport);
  }
  function updateLayout(next: typeof layout): void { $useUiStore.setProfileLayout(kind, next); if (kind !== "desktop") $useUiStore.markMobileResizeHintSeen(); }
  function update(patch: ProfilePatch): void {
    try { $useProfileStore.updateProfile(selected.id, patch); status = t("profiles.status.autosave", "Changes save automatically"); }
    catch { status = t("profiles.status.invalid", "Check this value and try again."); }
  }
  function updateConnectionMode(mode: ConnectionMode): void {
    if (mode === "llama-once") {
      update({ protocol: "openai-chat-completions", runtime: "llama-once", providerId: "llama-cpp" });
    } else if (mode === "gemini-native") {
      update({ protocol: "gemini-native", runtime: "remote-http", providerId: "gemini" });
    } else {
      update({ protocol: "openai-chat-completions", runtime: "remote-http", providerId: "openai-compatible" });
    }
  }
  function updateApiKey(value: string): void {
    apiKeyDrafts[selected.id] = value;
    status = t("profiles.save.key_pending", "API key ready. Click Save to store it securely.");
  }
  function updateLocalPath(key: "modelPath" | "mmprojPath" | "draftModelPath" | "llamaServerPath", value: string): void {
    localPathDrafts[selected.id] = { ...localPathDrafts[selected.id], [key]: value };
    status = t("profiles.save.paths_pending", "Local paths ready. Click Save to store them on the server.");
  }
  function numberValue(value: string, fallback: number): number { const result = Number(value); return Number.isFinite(result) ? result : fallback; }
  function invalidCommit(): void {
    status = t("profiles.status.invalid", "Check this value and try again.");
  }
  function commitEndpoints(value: string): void {
    update({ fallbackEndpoints: value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) });
  }
  function commitNumberValue(raw: string, current: number, build: (value: number) => ProfilePatch): void {
    const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value)) { invalidCommit(); return; }
    const rounded = Math.round(value);
    if (rounded !== current) update(build(rounded));
  }
  function reasoningLabel(value: string): string {
    const key = value === "none" ? "settings.reasoning_none" : `settings.reasoning_${value}`;
    return t(key, value === "none" ? "Off" : value[0].toUpperCase() + value.slice(1));
  }
  function capabilityLabel(value: ProviderCapability): string {
    const labels: Record<ProviderCapability, string> = {
      streaming: t("profiles.capability.streaming", "Streaming"),
      tools: t("profiles.capability.tools", "Tool calling"),
      vision: t("profiles.capability.vision", "Vision input"),
      reasoning: t("profiles.capability.reasoning", "Reasoning"),
      attachments: t("profiles.capability.attachments", "Attachments"),
      systemPrompt: t("profiles.capability.system_prompt", "System prompts"),
      usage: t("profiles.capability.usage", "Usage reporting"),
      abort: t("profiles.capability.abort", "Request cancellation"),
    };
    return labels[value];
  }
  function setReasoning(index: number): void {
    const effort = reasoningScale[Math.round(index)];
    if (effort) update({ parameters: { reasoningEffort: effort } });
  }
  function add(): void { $useProfileStore.addProfile({ displayName: t("profiles.new_name", "New model profile"), modelId: "model-id" }); tab = "model"; }
  function duplicate(id = selected.id): void { $useProfileStore.duplicateProfile(id); }
  function requestDelete(id: string): void { $useProfileStore.selectProfile(id); pendingDeleteProfileId = id; confirm = "delete"; }
  async function deleteRequestedProfile(): Promise<void> {
    const profileId = pendingDeleteProfileId;
    if (!profileId || busy) return;
    busy = "delete";
    try {
      if (!await $useProfileStore.deleteProfile(profileId)) throw new Error(t("profiles.delete.last_enabled", "At least one model profile must remain."));
      status = t("profiles.delete.success", "Model profile deleted");
      confirm = null;
      pendingDeleteProfileId = null;
    } catch (error) {
      const detail = connectionError(error);
      status = `${t("profiles.delete.error", "Delete failed. The model profile was kept.")}${detail ? ` ${detail}` : ""}`;
      confirm = null;
    } finally {
      busy = null;
    }
  }
  function activate(id: string): void { $useProfileStore.activateProfile(id); status = t("profiles.status.autosave", "Changes save automatically"); }
  function connectionError(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error || "");
    return detail.replace(/\s+/g, " ").trim().slice(0, 320);
  }
  function connectionTransport(result: unknown): string {
    if (!result || typeof result !== "object") return "";
    return String((result as { transport?: unknown }).transport || "").replace(/\s+/g, " ").trim().slice(0, 160);
  }
  async function saveProfiles(): Promise<void> {
    if (busy) return;
    const profileId = selected.id;
    const requiresApiKey = selected.runtime === "remote-http";
    const apiKeyDraft = apiKeyDrafts[profileId];
    const localPathDraft = localPathDrafts[profileId];
    busy = "save";
    status = t("profiles.save.saving", "Saving…");
    try {
      if (apiKeyDraft !== undefined) {
        await updateRemoteProfile(profileId, { api_key: apiKeyDraft });
      }
      if (localPathDraft) {
        await updateRemoteProfile(profileId, localPathDraft);
      }
      // Re-submit the complete visible profile so Save is an ordering barrier for
      // any earlier autosave request still in flight.
      const imported = await updateRemoteProfile(profileId, { ...selected });
      const hasStoredApiKey = imported.hasApiKey;
      if (requiresApiKey && typeof hasStoredApiKey !== "boolean") throw new Error(t("profiles.save.not_confirmed", "Prompt Agent did not confirm the saved profile."));
      if (requiresApiKey && !hasStoredApiKey) {
        throw new Error(t("profiles.save.key_missing", "The API key was not written to secure storage. Paste it again and save."));
      }
      delete apiKeyDrafts[profileId];
      delete localPathDrafts[profileId];
      $useProfileStore.setState(await listProfiles());
      status = t("profiles.save.success", "Saved securely");
    } catch (error) {
      const detail = connectionError(error);
      status = `${t("profiles.save.error", "Save failed. You can try again.")}${detail ? ` ${detail}` : ""}`;
    } finally {
      busy = null;
    }
  }
  async function testConnection(): Promise<void> {
    connectionController?.abort();
    const controller = new AbortController();
    connectionController = controller;
    const timeout = Math.min(selected.runtime === "llama-once" ? 60 : 30, Math.max(1, selected.parameters.timeout));
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, (timeout + 2) * 1000);
    busy = "test"; status = t("profiles.test.testing", "Testing connection…");
    try {
      const result = await testProfileConnection(selected.id, controller.signal);
      const transport = connectionTransport(result);
      status = `${t("profiles.test.success", "Connection successful.")}${transport ? ` ${t("profiles.test.route", "Route:")} ${transport}.` : ""}`;
    } catch (error) {
      if (timedOut) status = t("profiles.test.timeout", "Connection test timed out. The controls are ready to try again.");
      else if (!controller.signal.aborted) {
        const detail = connectionError(error);
        status = `${t("profiles.test.error", "Connection failed. Check the model profile.")}${detail ? ` ${detail}` : ""}`;
      }
    } finally {
      window.clearTimeout(timer);
      if (connectionController === controller) connectionController = null;
      busy = null;
    }
  }
  async function syncModel(): Promise<void> {
    busy = "sync"; status = t("profiles.models_dev.loading", "Querying models.dev…");
    try { const result = await syncProfileFromModelsDev(selected); update(result); status = t("profiles.models_dev.success", "Updated model parameters from models.dev."); }
    catch { status = t("profiles.models_dev.error", "No exact model match found on models.dev."); }
    finally { busy = null; }
  }
  function selectLanguage(value: "auto" | "en" | "zh-CN"): void { $useI18nStore.setLocale(value === "auto" ? null : value); }
  function resizeKey(event: KeyboardEvent): void {
    const delta = event.shiftKey ? 40 : 10;
    const width = event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0;
    const height = event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0;
    if (!width && !height) return;
    event.preventDefault();
    updateLayout(clampWindowLayout({ ...layout, width: layout.width + width, height: layout.height + height }, viewport, minimum));
  }
  onMount(() => {
    let focusRecoveryTimer: number | undefined;
    const recoverAfterFocus = () => {
      window.clearTimeout(focusRecoveryTimer);
      focusRecoveryTimer = window.setTimeout(refresh, 80);
    };
    window.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("scroll", refresh);
    document.addEventListener("focusin", refresh);
    document.addEventListener("focusout", recoverAfterFocus);
    return () => {
      window.clearTimeout(focusRecoveryTimer);
      connectionController?.abort();
      window.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("scroll", refresh);
      document.removeEventListener("focusin", refresh);
      document.removeEventListener("focusout", recoverAfterFocus);
    };
  });
  $effect(() => {
    if (!profileTabs.some(([value]) => value === tab)) tab = "model";
  });
  $effect(() => {
    if (open && !wasOpen) requestAnimationFrame(() => windowElement?.focus());
    wasOpen = open;
  });
</script>

{#if open && selected}
  <div bind:this={windowElement} class:pa-window-interacting={interacting} class:pa-keyboard-overflow={viewportRecovering} class="pa-profile-window" style:left="{layout.left}px" style:top="{layout.top}px" style:width="{layout.width}px" style:height="{layout.height}px" style:z-index={$useUiStore.frontWindow === "profiles" ? 1003 : 1001} role="dialog" tabindex="-1" aria-modal="false" aria-label={t("profiles.title", "Model profiles")} data-prompt-agent-profile-window="true" onpointerdown={() => $useUiStore.bringToFront("profiles")} onkeydown={(event) => { if (event.key === "Escape") onclose(); }}>
    <header class="pa-profile-window-header" use:pointerWindow={{ mode: "drag", layout: () => layout, update: updateLayout, minimum, interacting: (active) => interacting = active }}>
      <div class="pa-brand-lockup"><div><strong>{t("profiles.title", "Model profiles")}</strong></div></div>
      <div class="pa-profile-window-actions">
        <button type="button" class="pa-profile-save-button" onclick={() => void saveProfiles()} disabled={busy !== null}>
          {#if busy === "save"}<RefreshCw size={14} class="pa-spin" />{t("profiles.save.saving", "Saving…")}{:else}<Save size={14} />{t("profiles.save", "Save")}{/if}
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger aria-label={t("profiles.more", "More settings actions")} class="pa-header-icon"><MoreHorizontal size={16} /></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content class="pa-dropdown-content"><DropdownMenu.Item class="pa-dropdown-item" onclick={() => $useUiStore.resetWindowLayouts()}><RotateCcw size={13} />{t("profiles.interface.reset", "Reset window layouts")}</DropdownMenu.Item><DropdownMenu.Item class="pa-dropdown-item pa-profile-danger-text" onclick={() => confirm = "restore"}><RotateCcw size={13} />{t("profiles.restore", "Restore defaults")}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger aria-label={t("settings.locale", "Language")} class="pa-header-icon"><Languages size={16} /></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content class="pa-dropdown-content"><DropdownMenu.RadioGroup value={$useI18nStore.manualLocale ?? "auto"} onValueChange={(value) => selectLanguage(value as "auto" | "en" | "zh-CN")}><DropdownMenu.RadioItem value="auto" class="pa-dropdown-item">{t("settings.locale.auto", "Auto")} ({$useI18nStore.locale === "zh-CN" ? "简体中文" : "English"})</DropdownMenu.RadioItem><DropdownMenu.RadioItem value="zh-CN" class="pa-dropdown-item">简体中文</DropdownMenu.RadioItem><DropdownMenu.RadioItem value="en" class="pa-dropdown-item">English</DropdownMenu.RadioItem></DropdownMenu.RadioGroup></DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button type="button" class="pa-header-icon" onclick={onclose} aria-label={t("profiles.close", "Close")}><X size={17} /></button>
      </div>
    </header>

    <div class="pa-profile-window-body">
      <aside class="pa-profile-sidebar">
        <div class="pa-profile-sidebar-title"><div><span class="pa-eyebrow">{t("profiles.fleet", "Models")}</span><strong>{$useProfileStore.profiles.length}</strong></div><button type="button" class="pa-profile-add-icon" onclick={add} aria-label={t("profiles.add", "Add")}><Plus size={15} /></button></div>
        <div class="pa-profile-list" role="listbox" aria-label={t("profiles.list", "Model profiles")}>
          {#each $useProfileStore.profiles as profile (profile.id)}
            <div class:is-selected={profile.id === selected.id} class:is-disabled={!profile.enabled} class="pa-profile-list-item">
              <button type="button" role="option" aria-selected={profile.id === selected.id} class="pa-profile-list-select" onclick={() => $useProfileStore.selectProfile(profile.id)}>
                <span class:is-enabled={profile.enabled} class="pa-profile-status-dot"></span><span class="pa-profile-list-copy"><strong>{profile.displayName}</strong><small>{profile.modelId}</small></span>
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger class="pa-profile-row-menu" aria-label={`${profile.displayName} ${t("profiles.actions", "actions")}`}><MoreHorizontal size={14} /></DropdownMenu.Trigger>
                <DropdownMenu.Portal><DropdownMenu.Content class="pa-dropdown-content"><DropdownMenu.Item class="pa-dropdown-item" onclick={() => duplicate(profile.id)}><Copy size={13} />{t("profiles.duplicate", "Duplicate")}</DropdownMenu.Item><DropdownMenu.Item class="pa-dropdown-item pa-profile-danger-text" onclick={() => requestDelete(profile.id)}><Trash2 size={13} />{t("profiles.delete", "Delete")}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          {/each}
        </div>
      </aside>

      <main class="pa-profile-editor">
        <section class="pa-profile-summary">
          <div class="pa-profile-summary-main"><div><div class="pa-profile-title-row"><h2>{selected.displayName}</h2>{#if selected.id === $useProfileStore.activeProfileId}<span class="pa-profile-current-badge"><Check size={12} />{t("profiles.current", "Current")}</span>{/if}</div><p>{selected.modelId} · {selected.runtime}</p></div><button type="button" class:is-enabled={selected.enabled} class="pa-profile-enabled-toggle" aria-label={t("profiles.toggle_availability", "Toggle model availability")} aria-pressed={selected.enabled} title={selected.enabled ? t("profiles.enabled", "Enabled") : t("profiles.disabled", "Disabled")} onclick={() => update({ enabled: !selected.enabled })}><span>{selected.enabled ? t("profiles.enabled", "Enabled") : t("profiles.disabled", "Disabled")}</span><span class="pa-profile-enabled-switch" aria-hidden="true"><span></span></span></button></div>
          {#if selected.runtime !== "remote-http"}<div class="pa-profile-connection-row"><div class="pa-profile-local-callout"><ServerCog size={15} /><div><strong>{t("profiles.quick.local", "Local model - no API key needed")}</strong><small>{selected.runtime === "llama-once" ? selected.localModelConfigured ? t("profiles.model_path.configured", "Model path configured on server") : t("profiles.model_path.empty", "Model path not configured") : selected.endpoint}</small></div></div></div>{/if}
          {#if unsupportedCapabilities.length}<div class="pa-profile-capability-warning" role="status"><ShieldAlert size={15} /><div><strong>{agentChatSupported ? t("profiles.capability.limited", "Limited agent capabilities") : t("profiles.capability.agent_unavailable", "Agent chat is unavailable for this runtime")}</strong><small>{t("profiles.capability.unavailable", "Unavailable:")} {unsupportedCapabilities.map(capabilityLabel).join(", ")}</small></div></div>{/if}
          <div class="pa-profile-summary-footer"><div class="pa-profile-summary-actions"><Button size="sm" onclick={() => void testConnection()} disabled={busy !== null || !selected.enabled}><Activity size={13} />{busy === "test" ? t("profiles.test.testing", "Testing…") : t("profiles.test", "Test")}</Button>{#if selected.id !== $useProfileStore.activeProfileId}<Button variant="outline" size="sm" onclick={() => activate(selected.id)} disabled={!selected.enabled || !agentChatSupported}><Check size={13} />{t("profiles.use_model", "Use model")}</Button>{/if}<Button variant="outline" size="sm" onclick={() => void syncModel()} disabled={busy !== null}><RefreshCw size={13} />{busy === "sync" ? t("profiles.models_dev.loading", "Syncing…") : t("profiles.models_dev.sync", "Sync parameters")}</Button><button type="button" class="pa-profile-delete-button" aria-label={t("profiles.delete.selected", "Delete selected profile")} onclick={() => requestDelete(selected.id)} disabled={busy !== null || $useProfileStore.profiles.length <= 1}><Trash2 size={13} /><span>{t("profiles.delete", "Delete")}</span></button></div>{#if status}<div class="pa-profile-status" role="status">{status}</div>{/if}</div>
        </section>

        <Tabs.Root bind:value={tab} class="pa-profile-tabs"><Tabs.List class="pa-profile-tabs-list" aria-label={t("profiles.advanced_tabs", "Profile settings")}>{#each profileTabs as item}<Tabs.Trigger value={item[0]} class="pa-profile-tab">{t(`profiles.tab.${item[0]}`, item[1])}</Tabs.Trigger>{/each}</Tabs.List>
            <Tabs.Content value="model"><div class="pa-profile-tab-content"><Heading title={t("profiles.section.basic", "Basic information")} hint={t("profiles.section.basic.hint", "Set this model's identity, connection type, and availability.")} /><div class="pa-profile-grid"><Field label={t("profiles.display_name", "Display name")}><CommitInput value={selected.displayName} onCommit={(v) => update({ displayName: v })} onInvalid={invalidCommit} /></Field><Field label={t("profiles.model_id", "Model ID")}><CommitInput value={selected.modelId} onCommit={(v) => update({ modelId: v })} onInvalid={invalidCommit} /></Field><Field wide label={t("profiles.connection_type", "Connection type")}><NativeSelect value={connectionMode} onchange={(event) => updateConnectionMode(event.currentTarget.value as ConnectionMode)}><option value="openai-compatible">{t("profiles.protocol.openai", "OpenAI-compatible API")}</option><option value="gemini-native">{t("profiles.protocol.gemini", "Gemini native API")}</option><option value="llama-once">{t("profiles.runtime.once", "Local GGUF (one-shot)")}</option></NativeSelect></Field></div><div class="pa-profile-toggle-grid"><Toggle label={t("profiles.capability.tools", "Tool calling")} checked={selected.capabilities.tools} onchange={(value: boolean) => update({ capabilities: { tools: value } })} /><Toggle label={t("profiles.capability.vision", "Vision input")} checked={selected.capabilities.vision} onchange={(value: boolean) => update({ capabilities: { vision: value } })} /><Toggle label={t("profiles.capability.streaming", "Streaming")} checked={selected.capabilities.streaming} onchange={(value: boolean) => update({ capabilities: { streaming: value } })} /></div></div></Tabs.Content>
            <Tabs.Content value="connection"><div class="pa-profile-tab-content"><Heading title={t("profiles.section.connection", "Connection")} hint={t("profiles.section.connection.hint", "Configure endpoints and credentials.")} /><div class="pa-profile-grid">{#if selected.runtime === "remote-http"}<Field wide label={t("profiles.api_key", "API key")}><div class="pa-profile-key-row"><KeyRound size={14} /><input name="api-key" autocomplete="off" spellcheck="false" aria-label={t("profiles.api_key", "API key")} type={showKey ? "text" : "password"} value={apiKeyValue} placeholder={selected.hasApiKey && !apiKeyValue ? t("profiles.api_key.stored", "Stored securely") : t("profiles.api_key.placeholder", "Paste an API key…")} oninput={(event) => updateApiKey(event.currentTarget.value)} /><button type="button" onclick={() => showKey = !showKey}>{showKey ? t("profiles.api_key.hide", "Hide") : t("profiles.api_key.show", "Show")}</button></div></Field>{/if}<Field wide label={t("profiles.endpoint", "Endpoint")}><CommitInput value={selected.endpoint} disabled={selected.runtime === "llama-once"} allowEmpty onCommit={(v) => update({ endpoint: v })} /></Field><Field wide label={t("profiles.fallback_endpoints", "Fallback endpoints (one per line)")}><CommitTextarea value={selected.fallbackEndpoints.join("\n")} allowEmpty onCommit={commitEndpoints} /></Field></div></div></Tabs.Content>
            <Tabs.Content value="generation"><div class="pa-profile-tab-content"><Heading title={t("profiles.section.generation", "Generation parameters")} hint={t("profiles.section.generation.hint", "Set sampling, reasoning, and privacy behavior.")} /><div class="pa-profile-grid"><Field label={`${t("profiles.temperature", "Temperature")} · ${selected.parameters.temperature.toFixed(2)}`}><input class="pa-profile-slider" type="range" min="0" max="2" step="0.05" value={selected.parameters.temperature} oninput={(event) => update({ parameters: { temperature: numberValue(event.currentTarget.value, selected.parameters.temperature) } })} /></Field><Field label={`${t("profiles.top_p", "Top P")} · ${selected.parameters.topP.toFixed(2)}`}><input class="pa-profile-slider" type="range" min="0" max="1" step="0.05" value={selected.parameters.topP} oninput={(event) => update({ parameters: { topP: numberValue(event.currentTarget.value, selected.parameters.topP) } })} /></Field><Field label={t("profiles.max_tokens", "Max tokens")}><CommitInput type="number" value={String(selected.parameters.maxTokens)} onCommit={(v) => commitNumberValue(v, selected.parameters.maxTokens, (n) => ({ parameters: { maxTokens: n } }))} onInvalid={invalidCommit} /></Field><Field label={`${t("profiles.reasoning_effort", "Reasoning effort")} · ${reasoningLabel(selected.parameters.reasoningEffort)}`}><div class="pa-profile-reasoning-slider"><Brain size={15} /><input class="pa-profile-slider" type="range" min="0" max={Math.max(0, reasoningScale.length - 1)} step="1" value={reasoningIndex} disabled={!selected.capabilities.reasoning} aria-label={t("profiles.reasoning_effort", "Reasoning effort")} oninput={(event) => setReasoning(Number(event.currentTarget.value))} /></div></Field></div></div></Tabs.Content>
             <Tabs.Content value="local"><div class="pa-profile-tab-content"><Heading title={t("profiles.section.local", "Local runtime")} hint={t("profiles.section.local.hint", "Configure llama.cpp paths and hardware allocation. Saved paths stay server-side and are never returned to the browser.")} /><div class="pa-profile-grid"><Field wide label={t("profiles.model_path", "GGUF path")}><Input value={localPathDraft.modelPath ?? ""} placeholder={selected.localModelConfigured ? t("profiles.path.configured", "Configured on server") : ""} oninput={(event) => updateLocalPath("modelPath", event.currentTarget.value)} /></Field><Field wide label={t("profiles.mmproj_path", "mmproj path")}><Input value={localPathDraft.mmprojPath ?? ""} placeholder={selected.mmprojConfigured ? t("profiles.path.configured", "Configured on server") : ""} oninput={(event) => updateLocalPath("mmprojPath", event.currentTarget.value)} /></Field><Field wide label={t("profiles.draft_model_path", "MTP draft GGUF path")}><Input value={localPathDraft.draftModelPath ?? ""} placeholder={selected.draftModelConfigured ? t("profiles.path.configured", "Configured on server") : ""} oninput={(event) => updateLocalPath("draftModelPath", event.currentTarget.value)} /></Field><Field wide label={t("profiles.llama_server_path", "llama-server path")}><Input value={localPathDraft.llamaServerPath ?? ""} placeholder={selected.llamaServerConfigured ? t("profiles.path.configured", "Configured on server") : ""} oninput={(event) => updateLocalPath("llamaServerPath", event.currentTarget.value)} /></Field><Field label={t("profiles.n_ctx", "Context size")}><CommitInput type="number" value={String(selected.nCtx)} onCommit={(v) => commitNumberValue(v, selected.nCtx, (n) => ({ nCtx: n }))} onInvalid={invalidCommit} /></Field><Field label={t("profiles.n_gpu_layers", "GPU layers")}><CommitInput type="number" value={String(selected.nGpuLayers)} onCommit={(v) => commitNumberValue(v, selected.nGpuLayers, (n) => ({ nGpuLayers: n }))} onInvalid={invalidCommit} /></Field><Field label={t("profiles.idle_unload_minutes", "Idle unload time (minutes, 0 = never)")}><CommitInput type="number" min="0" max="1440" value={String(selected.idleUnloadMinutes)} disabled={selected.unloadAfterTurn} onCommit={(v) => commitNumberValue(v, selected.idleUnloadMinutes, (n) => ({ idleUnloadMinutes: n }))} onInvalid={invalidCommit} /></Field></div><div class="pa-profile-toggle-grid"><Toggle label={t("profiles.thinking", "Thinking")} checked={selected.thinking} onchange={(thinking: boolean) => update({ thinking })} /><Toggle label={t("profiles.unload_after_turn", "Unload local model after each reply")} checked={selected.unloadAfterTurn} onchange={(unloadAfterTurn: boolean) => update({ unloadAfterTurn })} /></div></div></Tabs.Content>
            <Tabs.Content value="routes"><div class="pa-profile-tab-content"><Heading title={t("profiles.routes.title", "Routing")} hint={t("profiles.routes.hint", "Choose which enabled profile handles each assistant role.")} /><div class="pa-profile-route-grid"><Route label={t("profiles.active_profile", "Active profile")} value={$useProfileStore.activeProfileId} profiles={enabledProfiles} onchange={(id: string) => $useProfileStore.activateProfile(id)} /><Route label={t("profiles.session_profile", "Session model")} value={$useProfileStore.sessionProfileId} profiles={localProfiles} onchange={(id: string) => $useProfileStore.setSessionProfile(id)} /><Route label={t("profiles.naming_profile", "Naming model")} value={$useProfileStore.namingProfileId} profiles={namingProfiles} onchange={(id: string) => $useProfileStore.setNamingProfile(id)} /></div></div></Tabs.Content>
        </Tabs.Root>
      </main>
    </div>
    {#if kind === "desktop"}<button type="button" class="pa-profile-resize-handle" data-prompt-agent-interaction-handle="true" use:pointerWindow={{ mode: "resize", layout: () => layout, update: updateLayout, minimum, interacting: (active) => interacting = active }} onkeydown={resizeKey} aria-label={t("profiles.resize", "Resize profile window")}><Grip size={15} /></button>{/if}

    <AlertDialog.Root open={confirm === "delete"} onOpenChange={(value) => { if (!value) { confirm = null; pendingDeleteProfileId = null; } }}><AlertDialog.Portal><AlertDialog.Overlay class="pa-dialog-layer" /><AlertDialog.Content class="pa-dialog-card"><header><AlertDialog.Title>{t("profiles.delete", "Delete")}</AlertDialog.Title></header><AlertDialog.Description class="pa-dialog-description">{t("profiles.delete.confirm", "Delete this model profile?")}</AlertDialog.Description><div class="pa-dialog-actions"><AlertDialog.Cancel class="pa-dialog-cancel">{t("common.cancel", "Cancel")}</AlertDialog.Cancel><AlertDialog.Action class="pa-dialog-confirm" disabled={busy === "delete"} onclick={() => void deleteRequestedProfile()}>{busy === "delete" ? t("profiles.delete.deleting", "Deleting…") : t("profiles.delete.confirm_action", "Delete profile")}</AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
    <AlertDialog.Root open={confirm === "restore"} onOpenChange={(value) => { if (!value) confirm = null; }}><AlertDialog.Portal><AlertDialog.Overlay class="pa-dialog-layer" /><AlertDialog.Content class="pa-dialog-card"><header><AlertDialog.Title>{t("profiles.restore", "Restore defaults")}</AlertDialog.Title></header><AlertDialog.Description class="pa-dialog-description">{t("profiles.restore.confirm", "Replace all profiles with the defaults?")}</AlertDialog.Description><div class="pa-dialog-actions"><AlertDialog.Cancel class="pa-dialog-cancel">{t("common.cancel", "Cancel")}</AlertDialog.Cancel><AlertDialog.Action class="pa-dialog-confirm" onclick={() => { $useProfileStore.restoreDefaults(); confirm = null; }}>{t("profiles.restore.confirm_action", "Restore defaults")}</AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
  </div>
{/if}
