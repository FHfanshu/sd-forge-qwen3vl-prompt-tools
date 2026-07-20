<script lang="ts">
  import { Textarea } from "$lib/components/ui/textarea";
  import type { HTMLTextareaAttributes } from "svelte/elements";
  let { value, onCommit, onInvalid, allowEmpty = false, ...rest }: {
    value: string;
    onCommit(value: string): void;
    onInvalid?(): void;
    allowEmpty?: boolean;
  } & HTMLTextareaAttributes = $props();
  let draft = $state("");
  $effect(() => { draft = value; });
  function commit(): void {
    if (!allowEmpty && !draft.trim()) { draft = value; onInvalid?.(); return; }
    if (draft !== value) onCommit(draft);
  }
</script>
<Textarea bind:value={draft} onchange={commit} {...rest} />
