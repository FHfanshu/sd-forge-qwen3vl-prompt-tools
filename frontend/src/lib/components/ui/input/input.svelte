<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";
  let { class: className, value = $bindable(), ...rest }: HTMLInputAttributes = $props();
</script>
  <input data-slot="input" bind:value class={cn("kl-flex kl-h-9 kl-w-full kl-rounded-md kl-border kl-border-input kl-bg-background kl-px-3 kl-text-sm focus-visible:kl-outline-none focus-visible:kl-ring-2 focus-visible:kl-ring-ring disabled:kl-opacity-50", className)} {...rest} />
