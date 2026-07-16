<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";

  type Variant = "default" | "outline" | "secondary" | "ghost" | "destructive";
  type Size = "default" | "sm" | "icon";
  let { variant = "default", size = "default", class: className, type = "button", children, ...rest }: HTMLButtonAttributes & { variant?: Variant; size?: Size; children?: Snippet } = $props();
  const variants: Record<Variant, string> = {
    default: "kl-bg-primary kl-text-primary-foreground hover:kl-bg-accent",
    outline: "kl-border kl-border-border kl-bg-background hover:kl-bg-accent",
    secondary: "kl-bg-secondary kl-text-secondary-foreground hover:kl-bg-accent",
    ghost: "hover:kl-bg-accent hover:kl-text-accent-foreground",
    destructive: "kl-bg-destructive kl-text-destructive-foreground hover:kl-bg-accent",
  };
  const sizes: Record<Size, string> = { default: "kl-h-9 kl-px-3", sm: "kl-h-8 kl-px-2.5 kl-text-xs", icon: "kl-size-8" };
</script>

<button data-slot="button" {type} class={cn("kl-inline-flex kl-items-center kl-justify-center kl-gap-1.5 kl-rounded-md kl-text-sm kl-font-medium kl-transition-colors focus-visible:kl-outline-none focus-visible:kl-ring-2 focus-visible:kl-ring-ring disabled:kl-pointer-events-none disabled:kl-opacity-50 [&_svg]:kl-size-4", variants[variant], sizes[size], className)} {...rest}>{@render children?.()}</button>
