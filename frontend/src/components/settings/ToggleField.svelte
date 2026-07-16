<script lang="ts">
  import { Switch } from "$lib/components/ui/switch";
  let { label, checked, onchange }: { label: string; checked: boolean; onchange(value: boolean): void } = $props();
</script>
<div class="kl-profile-toggle-row"><strong>{label}</strong><Switch.Root {checked} onCheckedChange={onchange} class="kl-profile-switch-control"><Switch.Thumb /></Switch.Root></div>
