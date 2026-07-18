<script lang="ts">
  import { BrainCircuit, CircleStop, Send, Sparkles, Wrench } from "lucide-svelte";
  import type { WorkingPhase } from "../stores/runtime";
  import { useI18nStore } from "../stores/i18n";

  let { phase, tool = null, statusDetail = null, reasoning = "" }: { phase: Exclude<WorkingPhase, "idle">; tool?: string | null; statusDetail?: string | null; reasoning?: string } = $props();

  function t(key: string, fallback: string): string {
    const value = $useI18nStore.t(key);
    return value === key ? fallback : value;
  }

  const label = $derived(phase === "submitting"
    ? t("assistant.working.submitting", "Sending request…")
    : phase === "cancelling"
      ? t("assistant.working.cancelling", "Stopping response…")
      : phase === "retrying"
        ? t("assistant.working.retrying", "Retrying provider…")
      : phase === "tool"
        ? t("assistant.working.tool", "Running tool…")
        : phase === "generating"
          ? t("assistant.working.generating", "Generating response…")
          : t("assistant.working.thinking", "Thinking…"));
  const reasoningExcerpt = $derived.by(() => {
    const text = reasoning.replace(/\s+/g, " ").trim();
    return text.length > 180 ? `…${text.slice(-180)}` : text;
  });
  const detail = $derived(phase === "retrying" && statusDetail
    ? statusDetail
    : phase === "tool" && tool
    ? `${t("assistant.working.tool_name", "Tool")}: ${tool}`
    : reasoningExcerpt
      ? `${t("assistant.working.reasoning", "Reasoning")}: ${reasoningExcerpt}`
      : "");
</script>

<div class:kl-working-has-reasoning={Boolean(reasoningExcerpt)} class="kl-working-indicator kl-working-{phase}" role="status" aria-live="polite">
  <span class="kl-working-icon" aria-hidden="true">
    {#if phase === "submitting"}<Send size={15} />{:else if phase === "cancelling"}<CircleStop size={15} />{:else if phase === "tool"}<Wrench size={15} />{:else if phase === "generating"}<Sparkles size={15} />{:else}<BrainCircuit size={15} />{/if}
  </span>
  <span class="kl-working-copy"><strong>{label}</strong>{#if detail}<small title={detail}>{detail}</small>{/if}</span>
  <span class="kl-working-thread" aria-hidden="true"><i></i></span>
</div>
