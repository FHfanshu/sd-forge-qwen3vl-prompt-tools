<script lang="ts">
  import DOMPurify from "dompurify";
  import { marked } from "marked";

  let { content, streaming = false }: { content: string; streaming?: boolean } = $props();
  const html = $derived(DOMPurify.sanitize(marked.parse(content || " ", { gfm: true }) as string));
</script>

{#if streaming}
  <div class="kl-markdown kl-markdown-streaming">{content}</div>
{:else}
  <div class="kl-markdown">{@html html}</div>
{/if}
