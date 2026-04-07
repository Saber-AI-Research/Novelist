<script lang="ts">
  // Placeholder - will be implemented in Task 10
  let wordCount = $state(0);
  let cursorLine = $state(1);
  let cursorCol = $state(1);

  export { wordCount, cursorLine, cursorCol };
</script>

<div class="flex-1 flex items-center justify-center" style="background: var(--novelist-editor-bg); color: var(--novelist-text-secondary);">
  <p>Open a file to start editing</p>
</div>
