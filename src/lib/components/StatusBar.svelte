<script lang="ts">
  import { projectStore } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';

  interface Props {
    wordCount?: number;
    cursorLine?: number;
    cursorCol?: number;
  }

  let { wordCount = 0, cursorLine = 1, cursorCol = 1 }: Props = $props();

  let dailyGoal = $derived(projectStore.config?.writing?.daily_goal ?? 2000);
  let goalPercent = $derived(dailyGoal > 0 ? Math.min(100, Math.round((wordCount / dailyGoal) * 100)) : 0);

  let activeFileName = $derived(tabsStore.activeTab?.fileName ?? '');

  let fileSize = $derived.by(() => {
    const tab = tabsStore.activeTab;
    if (!tab) return '';
    const entry = projectStore.files.find(f => f.path === tab.filePath);
    if (!entry || entry.size == null) return '';
    if (entry.size < 1024) return `${entry.size} B`;
    if (entry.size < 1024 * 1024) return `${(entry.size / 1024).toFixed(1)} KB`;
    return `${(entry.size / (1024 * 1024)).toFixed(1)} MB`;
  });
</script>

<div
  class="h-5 flex items-center px-3 gap-2 select-none"
  style="background: var(--novelist-bg); border-top: 1px solid var(--novelist-border-subtle); color: var(--novelist-text-tertiary); font-size: 0.65rem; letter-spacing: 0.01em;"
>
  <span>{wordCount} words</span>
  {#if goalPercent > 0}
    <span class="opacity-50">·</span>
    <span>{goalPercent}% of {dailyGoal}</span>
  {/if}

  <span class="ml-auto flex items-center gap-2">
    {#if activeFileName}
      <span>{activeFileName}</span>
      {#if fileSize}
        <span class="opacity-50">·</span>
        <span>{fileSize}</span>
      {/if}
      <span class="opacity-50">·</span>
    {/if}
    <span>Ln {cursorLine}, Col {cursorCol}</span>
  </span>
</div>
