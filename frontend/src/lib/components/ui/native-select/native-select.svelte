<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLSelectAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";
  let { class: className, value = $bindable(), children, ...rest }: HTMLSelectAttributes & { children?: Snippet } = $props();
</script>
<select data-slot="native-select" bind:value class={cn("kl-h-9 kl-w-full kl-rounded-md kl-border kl-border-input kl-bg-background kl-px-3 kl-text-sm focus-visible:kl-outline-none focus-visible:kl-ring-2 focus-visible:kl-ring-ring disabled:kl-opacity-50", className)} {...rest}>{@render children?.()}</select>
