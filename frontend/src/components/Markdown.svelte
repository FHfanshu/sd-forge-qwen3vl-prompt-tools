<script lang="ts">
  import DOMPurify from "dompurify";
  import { marked } from "marked";

  let { content }: { content: string } = $props();
  const html = $derived(DOMPurify.sanitize(marked.parse(content || " ", { gfm: true }) as string));
</script>

<div class="kl-markdown">{@html html}</div>
