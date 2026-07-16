<script lang="ts">
  import { Switch } from "$lib/components/ui/switch";
  let { label, checked, onchange }: { label: string; checked: boolean; onchange(value: boolean): void } = $props();
</script>
<label class="kl-profile-toggle-row"><strong>{label}</strong><Switch.Root {checked} aria-label={label} onCheckedChange={onchange} class="kl-profile-switch-control"><Switch.Thumb /></Switch.Root></label>
