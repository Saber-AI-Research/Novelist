<script lang="ts">
  // Placeholder - will be implemented in Task 12
  interface Props {
    wordCount?: number;
    cursorLine?: number;
    cursorCol?: number;
  }

  let { wordCount = 0, cursorLine = 1, cursorCol = 1 }: Props = $props();
</script>

<div class="h-6 flex items-center px-3 text-xs" style="background: var(--novelist-bg-secondary); border-top: 1px solid var(--novelist-border); color: var(--novelist-text-secondary);">
  <span>{wordCount} words</span>
  <span class="ml-auto">Ln {cursorLine}, Col {cursorCol}</span>
</div>
