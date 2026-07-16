<script lang="ts">
  import { onMount } from "svelte";
  import {
    AlertTriangle, Bot, Check, ChevronLeft, ChevronRight,
    CircleStop, Clipboard, Clock3, Copy, FileArchive, FileCog, Grip, History,
    ImagePlus, Pencil, Plus, RefreshCw, Search, Send, Settings2,
    Sparkles, Trash2, UserRound, Wrench, X,
    XCircle,
  } from "lucide-svelte";
  import type {
    ChatAttachment, ChatMessage, HistoryRow, LoomActionHandlers,
    ReasoningEffort, RiskMode, SendMessageInput,
  } from "../contracts";
  import { mockHistory, noopActions } from "../mock-data";
  import { createRuntimeController, type LoomRuntimeController } from "../runtime-controller";
  import { useChatStore } from "../stores/chat";
  import { useProfileStore } from "../stores/profiles";
  import { useRuntimeStore } from "../stores/runtime";
  import { useUiStore } from "../stores/ui";
  import { clampWindowLayout, pointerPosition, pointerWindow, readViewportRect, viewportKind, type FloatingPosition, type LayoutViewport } from "../window-interactions";
  import Markdown from "./Markdown.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import ProfileSettings from "./ProfileSettings.svelte";
  import ReasoningPicker from "./ReasoningPicker.svelte";

  interface Props {
    messages?: ChatMessage[];
    history?: HistoryRow[];
    actions?: Partial<LoomActionHandlers>;
    initialAttachments?: ChatAttachment[];
    initialOpen?: boolean;
  }

  let {
    messages: providedMessages,
    history: providedHistory,
    actions: actionOverrides = {},
    initialAttachments = [],
    initialOpen = false,
  }: Props = $props();

  let draft = $state("");
  let attachments = $state<ChatAttachment[]>([]);
  let reasoning = $state<ReasoningEffort>("low");
  let historySearch = $state("");
  let lightbox = $state<{ attachments: ChatAttachment[]; index: number } | null>(null);
  let copiedId = $state<string | null>(null);
  let dropActive = $state(false);
  let interacting = $state(false);
  let launcherInteracting = $state(false);
  let launcherDragged = $state(false);
  let mobileHintDismissed = $state(false);
  let kind = $state<LayoutViewport>(viewportKind());
  let viewport = $state(readViewportRect());
  let fileInput = $state<HTMLInputElement>();
  let composerInput = $state<HTMLTextAreaElement>();
  let replacementInput = $state<HTMLInputElement>();
  let replacementId = $state<string | null>(null);
  let attachmentMenuId = $state<string | null>(null);
  let controller: LoomRuntimeController | null = null;

  const visibleMessages = $derived(providedMessages ?? $useChatStore.messages);
  const visibleHistory = $derived(providedHistory ?? (controller ? $useRuntimeStore.history : mockHistory));
  const filteredHistory = $derived(visibleHistory.filter((row) => {
    const query = historySearch.trim().toLowerCase();
    return !query || `${row.title} ${row.preview}`.toLowerCase().includes(query);
  }));
  const currentLayout = $derived(clampWindowLayout($useUiStore.layouts[kind], viewport));
  const activeProfile = $derived($useProfileStore.profiles.find((profile) => profile.id === $useProfileStore.activeProfileId && profile.enabled));
  const lastAssistantId = $derived([...visibleMessages].reverse().find((message) => message.role === "assistant")?.id);

  function syncReasoningFromProfile(): void {
    const profileValue = String(activeProfile?.parameters.reasoningEffort ?? "low").toLowerCase();
    reasoning = ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profileValue)
      ? profileValue as ReasoningEffort
      : "none";
  }

  function id(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function updateLayout(next: typeof currentLayout): void {
    $useUiStore.setLayout(kind, next);
    if (kind !== "desktop") $useUiStore.markMobileResizeHintSeen();
  }

  function updateLauncherPosition(next: FloatingPosition): void {
    $useUiStore.setLauncherPosition(next);
  }

  function openLauncher(): void {
    if (launcherDragged) {
      launcherDragged = false;
      return;
    }
    $useUiStore.setShellOpen(true);
    $useUiStore.bringToFront("chat");
  }

  function refreshViewport(): void {
    kind = viewportKind();
    viewport = readViewportRect();
  }

  function action<K extends keyof LoomActionHandlers>(name: K): LoomActionHandlers[K] {
    return (actionOverrides[name] ?? controller?.actions[name] ?? noopActions[name]) as LoomActionHandlers[K];
  }

  async function send(input: SendMessageInput): Promise<void> {
    if (!controller && $useChatStore.activeRequestId) {
      $useChatStore.enqueue({ id: id("queue"), text: input.text, attachments: input.attachments, createdAt: Date.now() });
      return;
    }
    if (actionOverrides.sendMessage || controller) {
      await action("sendMessage")(input);
      return;
    }
    $useChatStore.appendMessage({ id: id("user"), role: "user", content: input.text, attachments: input.attachments, status: "complete" });
  }

  async function submit(): Promise<void> {
    if (!draft.trim() && !attachments.length) return;
    await send({ text: draft.trim(), attachments: [...attachments], riskMode: $useUiStore.riskMode, reasoning });
    draft = "";
    attachments = [];
    requestAnimationFrame(() => resizeComposer());
  }

  function resizeComposer(element = composerInput): void {
    if (!element) return;
    element.style.height = "0px";
    const styles = getComputedStyle(element);
    const minimum = Number.parseFloat(styles.minHeight) || 42;
    const maximum = Number.parseFloat(styles.maxHeight) || 132;
    const contentHeight = element.scrollHeight;
    element.style.height = `${Math.min(maximum, Math.max(minimum, contentHeight))}px`;
    element.style.overflowY = contentHeight > maximum ? "auto" : "hidden";
  }

  function stop(): void {
    if (actionOverrides.stopRequest) actionOverrides.stopRequest();
    else if (controller) controller.actions.stopRequest();
    else $useChatStore.cancelRequest();
  }

  function openSettings(): void {
    actionOverrides.openSettings?.();
    if (kind !== "desktop") $useUiStore.setShellOpen(false);
    $useUiStore.setProfileSettingsOpen(true);
    $useUiStore.bringToFront("profiles");
  }

  function toggleHistory(): void {
    const next = !$useUiStore.historyOpen;
    $useUiStore.setHistoryOpen(next);
    if (next && controller) void controller.loadHistory().catch(() => undefined);
  }

  async function newSession(): Promise<void> {
    if (actionOverrides.newSession) await actionOverrides.newSession();
    else if (controller) await controller.actions.newSession();
    else $useChatStore.reset();
    attachments = [];
    draft = "";
  }

  async function fileAttachment(file: File): Promise<ChatAttachment> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ id: id("attachment"), name: file.name, dataUrl: String(reader.result), mimeType: file.type, size: file.size });
      reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files: File[]): Promise<void> {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    await action("attachFiles")(images);
    attachments = [...attachments, ...await Promise.all(images.map(fileAttachment))].slice(0, 8);
  }

  async function replaceAttachment(file: File): Promise<void> {
    if (!replacementId) return;
    const next = await fileAttachment(file);
    await action("replaceAttachment")(replacementId, file);
    attachments = attachments.map((item) => item.id === replacementId ? next : item);
    replacementId = null;
  }

  async function removeAttachment(attachmentId: string): Promise<void> {
    await action("removeAttachment")(attachmentId);
    attachments = attachments.filter((item) => item.id !== attachmentId);
  }

  async function copyMessage(message: ChatMessage): Promise<void> {
    await action("copyMessage")(message);
    copiedId = message.id;
    window.setTimeout(() => { if (copiedId === message.id) copiedId = null; }, 1200);
  }

  function resizeKey(event: KeyboardEvent): void {
    const delta = event.shiftKey ? 40 : 10;
    const width = event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0;
    const height = event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0;
    if (!width && !height) return;
    event.preventDefault();
    updateLayout(clampWindowLayout({ ...currentLayout, width: currentLayout.width + width, height: currentLayout.height + height }, viewport));
  }

  onMount(() => {
    attachments = [...initialAttachments];
    syncReasoningFromProfile();
    if (initialOpen) $useUiStore.setShellOpen(true);
    controller = Object.keys(actionOverrides).length ? null : createRuntimeController();
    void controller?.mount();
    window.addEventListener("resize", refreshViewport);
    window.visualViewport?.addEventListener("resize", refreshViewport);
    window.visualViewport?.addEventListener("scroll", refreshViewport);
    return () => {
      window.removeEventListener("resize", refreshViewport);
      window.visualViewport?.removeEventListener("resize", refreshViewport);
      window.visualViewport?.removeEventListener("scroll", refreshViewport);
      controller?.destroy();
    };
  });

  $effect(() => {
    activeProfile?.parameters.reasoningEffort;
    activeProfile?.capabilities.reasoning;
    syncReasoningFromProfile();
  });
</script>

<div class="kl-surface kl-viewport-{kind}" data-kohaku-loom-surface="true">
  {#if !$useUiStore.shellOpen}
    <button
      class:kl-launcher-interacting={launcherInteracting}
      class="kl-launcher"
      type="button"
      aria-label="Open Kohaku Loom"
      aria-expanded="false"
      title="Drag to move"
      style:left={$useUiStore.launcherPosition ? `${$useUiStore.launcherPosition.left}px` : undefined}
      style:top={$useUiStore.launcherPosition ? `${$useUiStore.launcherPosition.top}px` : undefined}
      style:right={$useUiStore.launcherPosition ? "auto" : undefined}
      style:bottom={$useUiStore.launcherPosition ? "auto" : undefined}
      use:pointerPosition={{ position: () => $useUiStore.launcherPosition, update: updateLauncherPosition, interacting: (active) => launcherInteracting = active, moved: (moved) => launcherDragged = moved }}
      onclick={openLauncher}
    >
      <Sparkles size={15} />
      <span>Assistant</span>
    </button>
  {/if}

  {#if $useUiStore.shellOpen}
    <div
      class:kl-window-interacting={interacting}
      class="kl-window"
      style:left="{currentLayout.left}px"
      style:top="{currentLayout.top}px"
      style:width="{currentLayout.width}px"
      style:height="{currentLayout.height}px"
      style:z-index={$useUiStore.frontWindow === "chat" ? 1002 : 1000}
      role="dialog"
      aria-modal="false"
      aria-label="Kohaku Loom chat"
      tabindex="-1"
      data-pending="false"
      onpointerdown={() => $useUiStore.bringToFront("chat")}
      onkeydown={(event) => { if (event.key === "Escape") $useUiStore.setShellOpen(false); }}
    >
      <header class="kl-window-header" use:pointerWindow={{ mode: "drag", layout: () => currentLayout, update: updateLayout, interacting: (active) => interacting = active }}>
        <div class="kl-chat-title"><strong>Assistant</strong></div>
        <div class="kl-header-controls">
          <div class="kl-history-anchor">
            <button type="button" class="kl-header-icon" aria-label="Open chat history" aria-expanded={$useUiStore.historyOpen} onclick={toggleHistory}><History size={16} /></button>
            {#if $useUiStore.historyOpen}
              <div class="kl-history-popover" role="dialog" aria-label="Chat history">
                <div class="kl-history-heading"><div><span class="kl-eyebrow">Archive</span><strong>Chat history</strong></div><span class="kl-history-count">{filteredHistory.length}</span></div>
                <label class="kl-history-search"><Search size={14} /><input bind:value={historySearch} placeholder="Search sessions" aria-label="Search chat history" /></label>
                <div class="kl-history-list" role="listbox" aria-label="Chat history sessions">
                  {#each filteredHistory as row (row.id)}
                    <button type="button" class="kl-history-row" aria-label={row.title} role="option" aria-selected="false" onclick={() => { void action("selectHistory")(row); $useUiStore.setHistoryOpen(false); }}>
                      <span class="kl-history-source kl-history-source-{row.source.toLowerCase()}">{#if row.source === "KT"}<Clock3 size={12} />{:else}<FileArchive size={12} />{/if}{row.source}</span>
                      <span class="kl-history-row-main"><strong>{row.title}</strong><small>{row.preview || "No preview"}</small></span>
                      <span class="kl-history-row-meta"><time>{row.updatedAt}</time><small>{row.messageCount} messages</small></span>
                    </button>
                  {:else}<p class="kl-history-empty">No sessions match that search.</p>{/each}
                </div>
              </div>
            {/if}
          </div>
          <button type="button" class="kl-header-icon" onclick={() => void newSession()} aria-label="Start a new chat"><Plus size={16} /></button>
          <button type="button" class="kl-header-icon" onclick={openSettings} aria-label="Open settings"><Settings2 size={16} /></button>
          <button type="button" class="kl-header-icon kl-header-close" onclick={() => $useUiStore.setShellOpen(false)} aria-label="Close Kohaku Loom"><X size={16} /></button>
        </div>
      </header>

      <div class="kl-window-body">
        <div class="kl-message-scroll" role="log" aria-live="polite" aria-busy={Boolean($useChatStore.activeRequestId)}>
          {#if visibleMessages.length > 0}
            {#each visibleMessages as message (message.id)}
              <article class="kl-message-card kl-message-{message.role} kl-message-{message.status}" data-message-id={message.id}>
                <div class="kl-message-heading"><span class="kl-message-role">
                  {#if message.role === "user"}<UserRound size={15} />{:else if message.role === "tool"}<Wrench size={15} />{:else if message.role === "error"}<XCircle size={15} />{:else if message.role === "assistant"}<Bot size={15} />{:else}<FileCog size={15} />{/if}
                  {message.role === "tool" ? message.tool?.name ?? "Tool" : message.role}
                </span><span class="kl-message-meta">
                  {#if message.status === "streaming"}<span class="kl-status-marker kl-status-streaming">Partial</span>{:else if message.status === "cancelled"}<span class="kl-status-marker kl-status-cancelled"><XCircle size={12} /> Cancelled</span>{:else if message.status === "error"}<span class="kl-status-marker kl-status-error">Error</span>{/if}
                  {#if message.usage}<span class="kl-usage"><Clipboard size={11} /> {[message.usage.inputTokens !== undefined ? `${message.usage.inputTokens} in` : "", message.usage.outputTokens !== undefined ? `${message.usage.outputTokens} out` : "", message.usage.latencyMs !== undefined ? `${(message.usage.latencyMs / 1000).toFixed(1)}s` : ""].filter(Boolean).join(" · ")}</span>{/if}
                </span></div>
                {#if message.role === "tool"}<div class="kl-tool-card"><strong>{message.tool?.name ?? "Tool call"}</strong>{#if message.tool?.detail}<span>{message.tool.detail}</span>{/if}<span class="kl-tool-status kl-tool-status-{message.tool?.status ?? 'complete'}">{message.tool?.status ?? "complete"}</span></div>{:else}<Markdown content={message.content} />{/if}
                {#if message.reasoning}<details class="kl-reasoning"><summary>Reasoning trace</summary><Markdown content={message.reasoning} /></details>{/if}
                {#if message.attachments.length}<div class="kl-message-attachments" aria-label="{message.attachments.length} reference images">{#each message.attachments as attachment, index (attachment.id)}<button type="button" class="kl-message-attachment" onclick={() => lightbox = { attachments: message.attachments, index }} aria-label="Preview {attachment.name}"><img src={attachment.dataUrl} alt={attachment.name} /></button>{/each}</div>{/if}
                <div class="kl-message-footer"><div class="kl-message-actions"><button type="button" class="kl-message-action" onclick={() => void copyMessage(message)}>{#if copiedId === message.id}<Check size={13} /> Copied{:else}<Copy size={13} /> Copy{/if}</button>{#if message.role === "user"}<button type="button" class="kl-message-action" onclick={() => void action("editResend")(message)}><Pencil size={13} /> Edit & resend</button>{/if}{#if message.id === lastAssistantId}<button type="button" class="kl-message-action" onclick={() => void action("regenerate")(message)}><RefreshCw size={13} /> Regenerate</button>{/if}</div>
                  {#if message.role === "assistant" && message.branchCount > 1}<div class="kl-branch-pager" aria-label="Assistant response branches"><button type="button" class="kl-mini-button" disabled={message.branchIndex === 0} onclick={() => void action("changeBranch")(message, message.branchIndex - 1)} aria-label="Previous branch"><ChevronLeft size={14} /></button><span>{message.branchIndex + 1} / {message.branchCount}</span><button type="button" class="kl-mini-button" disabled={message.branchIndex >= message.branchCount - 1} onclick={() => void action("changeBranch")(message, message.branchIndex + 1)} aria-label="Next branch"><ChevronRight size={14} /></button></div>{/if}
                </div>
              </article>
            {/each}
          {/if}
        </div>

        {#if $useChatStore.queue.length}<div class="kl-queue-strip" aria-label="Queued messages"><span class="kl-queue-label"><span class="kl-queue-dot"></span> Queue {$useChatStore.queue.length}</span><div class="kl-queue-items">{#each $useChatStore.queue as item (item.id)}<div class="kl-queue-item"><span>{item.text || `${item.attachments.length} images`}</span><button type="button" onclick={() => { if (actionOverrides.removeQueuedMessage) actionOverrides.removeQueuedMessage(item.id); else if (controller) void controller.actions.removeQueuedMessage(item.id); else $useChatStore.removeQueuedMessage(item.id); }} aria-label="Remove queued message {item.id}"><XCircle size={13} /></button></div>{/each}</div></div>{/if}

        <form class:kl-composer-drop-active={dropActive} class="kl-composer" onsubmit={(event) => { event.preventDefault(); void submit(); }} ondragover={(event) => { event.preventDefault(); dropActive = true; }} ondragleave={() => dropActive = false} ondrop={(event) => { event.preventDefault(); dropActive = false; void addFiles(Array.from(event.dataTransfer?.files ?? [])); }}>
          {#if attachments.length}<div class="kl-filmstrip" aria-label="Attached reference images">{#each attachments as attachment, index (attachment.id)}<div class="kl-filmstrip-item"><button type="button" class="kl-filmstrip-preview" onclick={() => lightbox = { attachments, index }} oncontextmenu={(event) => { event.preventDefault(); attachmentMenuId = attachment.id; }} aria-label="Preview {attachment.name}"><img src={attachment.dataUrl} alt={attachment.name} /><span class="kl-filmstrip-name">{attachment.name}</span></button><button type="button" class="kl-filmstrip-remove" onclick={() => void removeAttachment(attachment.id)} aria-label="Remove {attachment.name}"><X size={12} /></button><button type="button" class="kl-filmstrip-more" onclick={() => attachmentMenuId = attachmentMenuId === attachment.id ? null : attachment.id} aria-label="Edit {attachment.name}">•••</button>{#if attachmentMenuId === attachment.id}<div class="kl-attachment-menu" role="menu"><button type="button" role="menuitem" onclick={() => { replacementId = attachment.id; replacementInput?.click(); attachmentMenuId = null; }}><Pencil size={13} /> Replace</button><button type="button" role="menuitem" onclick={() => { void removeAttachment(attachment.id); attachmentMenuId = null; }}><Trash2 size={13} /> Remove</button></div>{/if}</div>{/each}<button type="button" class="kl-filmstrip-add" onclick={() => fileInput?.click()} aria-label="Attach another image"><Plus size={17} /></button></div>{/if}
          <textarea bind:this={composerInput} bind:value={draft} rows="1" placeholder="Ask about or change the current prompt..." aria-label="Message Kohaku Loom" oninput={(event) => resizeComposer(event.currentTarget)} onkeydown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } }}></textarea>
          <div class="kl-composer-bottom"><div class="kl-composer-tools"><button type="button" class="kl-composer-icon" onclick={() => fileInput?.click()} aria-label="Attach reference images"><ImagePlus size={16} /></button><button type="button" class="kl-composer-icon" onclick={() => { draft = ""; attachments = []; action("clearChat")(); $useChatStore.reset(); requestAnimationFrame(() => resizeComposer()); }} aria-label="Clear chat"><Trash2 size={16} /></button></div>
            <div class="kl-composer-tools"><div class="kl-composer-picker-row" aria-label="Model controls"><ModelPicker /><ReasoningPicker /></div><button type="button" class="kl-risk-pill kl-risk-{$useUiStore.riskMode}" onclick={() => { const mode: RiskMode = $useUiStore.riskMode === "yolo" ? "normal" : "yolo"; $useUiStore.setRiskMode(mode); void action("setRiskMode")(mode); }} aria-label="Toggle risk mode" aria-pressed={$useUiStore.riskMode === "yolo"}><span></span>{$useUiStore.riskMode === "yolo" ? "YOLO" : "Normal"}</button>{#if $useChatStore.activeRequestId}<button type="button" class="kl-send-button kl-stop-button" onclick={stop} aria-label="Stop response"><CircleStop size={17} /></button>{/if}<button type="submit" class="kl-send-button" disabled={!draft.trim() && !attachments.length} aria-label={$useChatStore.activeRequestId ? "Queue message" : "Send message"}><Send size={17} /></button></div>
           </div>
           {#if $useUiStore.riskMode === "yolo"}<p class="kl-risk-note"><AlertTriangle size={13} /> YOLO allows direct prompt edits and tool actions.</p>{/if}
          <input bind:this={fileInput} type="file" accept="image/*" multiple hidden onchange={(event) => { void addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
          <input bind:this={replacementInput} type="file" accept="image/*" hidden onchange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void replaceAttachment(file); event.currentTarget.value = ""; }} />
        </form>
      </div>
      <button type="button" class="kl-resize-handle" data-loom-interaction-handle="true" use:pointerWindow={{ mode: "resize", layout: () => currentLayout, update: updateLayout, interacting: (active) => interacting = active }} onkeydown={resizeKey} aria-label="Resize chat window"><Grip size={15} /></button>
      {#if kind !== "desktop" && !$useUiStore.hasSeenMobileResizeHint && !mobileHintDismissed}<div class="kl-mobile-resize-hint" role="status"><Grip size={14} /> Drag the corner to resize<button type="button" onclick={() => { mobileHintDismissed = true; $useUiStore.markMobileResizeHintSeen(); }}>Dismiss</button></div>{/if}
    </div>
  {/if}

  <ProfileSettings open={$useUiStore.profileSettingsOpen} onclose={() => $useUiStore.setProfileSettingsOpen(false)} />

  {#if lightbox && lightbox.attachments[lightbox.index]}
    <div class="kl-lightbox" role="dialog" tabindex="-1" aria-modal="true" aria-label="Image preview" onclick={() => lightbox = null} onkeydown={(event) => { if (event.key === "Escape") lightbox = null; }}>
      <div class="kl-lightbox-panel" onclick={(event) => event.stopPropagation()} role="presentation"><button type="button" class="kl-lightbox-close" onclick={() => lightbox = null} aria-label="Close preview"><X size={18} /></button><img src={lightbox.attachments[lightbox.index].dataUrl} alt={lightbox.attachments[lightbox.index].name} />{#if lightbox.attachments.length > 1}<button type="button" class="kl-lightbox-nav kl-lightbox-prev" disabled={lightbox.index === 0} onclick={() => lightbox && (lightbox = { ...lightbox, index: Math.max(0, lightbox.index - 1) })} aria-label="Previous image"><ChevronLeft size={22} /></button><button type="button" class="kl-lightbox-nav kl-lightbox-next" disabled={lightbox.index === lightbox.attachments.length - 1} onclick={() => lightbox && (lightbox = { ...lightbox, index: Math.min(lightbox.attachments.length - 1, lightbox.index + 1) })} aria-label="Next image"><ChevronRight size={22} /></button><span class="kl-lightbox-count">{lightbox.index + 1} / {lightbox.attachments.length}</span>{/if}</div>
    </div>
  {/if}
</div>
