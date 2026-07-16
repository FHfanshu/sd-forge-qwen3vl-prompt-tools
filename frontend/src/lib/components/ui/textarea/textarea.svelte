<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";
  let { class: className, value = $bindable(), ...rest }: HTMLTextareaAttributes = $props();
</script>
  <textarea data-slot="textarea" bind:value class={cn("kl-flex kl-min-h-20 kl-w-full kl-rounded-md kl-border kl-border-input kl-bg-background kl-px-3 kl-py-2 kl-text-sm focus-visible:kl-outline-none focus-visible:kl-ring-2 focus-visible:kl-ring-ring disabled:kl-opacity-50", className)} {...rest}></textarea>
