<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import type { HTMLInputAttributes } from "svelte/elements";
  let { value, onCommit, onInvalid, allowEmpty = false, ...rest }: {
    value: string;
    onCommit(value: string): void;
    onInvalid?(): void;
    allowEmpty?: boolean;
  } & HTMLInputAttributes = $props();
  let draft = $state("");
  $effect(() => { draft = value; });
  function commit(): void {
    if (!allowEmpty && !draft.trim()) { draft = value; onInvalid?.(); return; }
    if (draft !== value) onCommit(draft);
  }
</script>
<Input bind:value={draft} onchange={commit} {...rest} />
