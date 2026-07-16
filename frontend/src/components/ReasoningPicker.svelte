<script lang="ts">
  import { onMount } from "svelte";
  import { Brain, Check, ChevronDown } from "lucide-svelte";
  import type { ReasoningEffort } from "../contracts";
  import { useI18nStore } from "../stores/i18n";
  import { useProfileStore } from "../stores/profiles";

  let open = $state(false);
  let anchor = $state<HTMLDivElement>();
  let sliderValue = $state(0);

  const activeProfile = $derived($useProfileStore.profiles.find((profile) => profile.id === $useProfileStore.activeProfileId && profile.enabled));
  const supported = $derived(Boolean(activeProfile && activeProfile.capabilities.reasoning !== false));
  const levels = $derived.by((): ReasoningEffort[] => {
    const modelLevels = activeProfile?.modelInfo.reasoningEfforts
      .map((value) => value.toLowerCase())
      .filter(isReasoningEffort)
      .filter((value) => value !== "none") ?? [];
    return modelLevels.length
      ? modelLevels
      : activeProfile?.modelInfo.source === "models.dev" ? ["high"] : ["low", "medium", "high", "max"];
  });
  const canDisable = $derived.by(() => {
    const info = activeProfile?.modelInfo;
    return !info || info.source !== "models.dev" || info.reasoningToggle || info.reasoningEfforts.includes("none");
  });
  const options = $derived(canDisable ? ["none", ...levels] as ReasoningEffort[] : levels);
  const value = $derived.by(() => {
    const current = String(activeProfile?.parameters.reasoningEffort ?? "low").toLowerCase();
    return options.includes(current as ReasoningEffort) ? current as ReasoningEffort : options[0] ?? "none";
  });
  const index = $derived(Math.max(0, options.indexOf(value)));

  function t(key: string, fallback: string): string {
    const translated = $useI18nStore.t(key);
    return translated === key ? fallback : translated;
  }

  function isReasoningEffort(value: string): value is ReasoningEffort {
    return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
  }

  function label(value: ReasoningEffort): string {
    return value === "none" ? t("settings.reasoning_none", "None") : t(`settings.reasoning_${value}`, value[0].toUpperCase() + value.slice(1));
  }

  function choose(next: ReasoningEffort, close = true): void {
    if (!activeProfile || !supported) return;
    $useProfileStore.updateProfile(activeProfile.id, { parameters: { reasoningEffort: next } });
    if (close) open = false;
  }

  function chooseIndex(rawValue: string): void {
    const option = options[Math.round(Number(rawValue))];
    if (option) choose(option, false);
  }

  function togglePicker(): void {
    sliderValue = index;
    open = !open;
  }

  function updateSlider(rawValue: string): void {
    const next = Number(rawValue);
    if (Number.isFinite(next)) sliderValue = Math.round(next);
  }

  function commitSlider(): void {
    chooseIndex(String(sliderValue));
  }

  onMount(() => {
    const close = (event: PointerEvent) => {
      if (anchor && !anchor.contains(event.target as Node)) open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        open = false;
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  });
</script>

<div class="kl-reasoning-picker" bind:this={anchor}>
  <button type="button" class="kl-reasoning-picker-trigger" disabled={!supported} aria-label="Change reasoning effort" aria-haspopup="dialog" aria-expanded={open} onclick={togglePicker}>
    <Brain size={15} aria-hidden="true" />
    <span>{label(value)}</span>
    <ChevronDown size={13} aria-hidden="true" />
  </button>

  {#if open}
    <div class="kl-reasoning-picker-popover" role="dialog" tabindex="-1" aria-label="Reasoning effort">
      <div class="kl-reasoning-picker-heading"><strong>Thinking</strong><span>{label(value)}</span></div>
      <div class="kl-reasoning-picker-options" role="listbox" aria-label="Reasoning effort options">
        {#each options as option (option)}
          <button type="button" role="option" aria-selected={option === value} class:is-selected={option === value} onclick={() => choose(option)}>
            <span>{label(option)}</span>{#if option === value}<Check size={16} aria-hidden="true" />{/if}
          </button>
        {/each}
      </div>
      <input class="kl-sr-only" type="range" min="0" max={Math.max(0, options.length - 1)} step="1" value={sliderValue} aria-label="Reasoning effort" oninput={(event) => updateSlider((event.target as HTMLInputElement).value)} onchange={commitSlider} />
    </div>
  {/if}
</div>
