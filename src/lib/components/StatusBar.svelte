<script lang="ts">
  import { projectStore } from '$lib/stores/project.svelte';

  interface Props {
    wordCount?: number;
    cursorLine?: number;
    cursorCol?: number;
  }

  let { wordCount = 0, cursorLine = 1, cursorCol = 1 }: Props = $props();

  let dailyGoal = $derived(projectStore.config?.writing?.daily_goal ?? 2000);
  let goalPercent = $derived(dailyGoal > 0 ? Math.min(100, Math.round((wordCount / dailyGoal) * 100)) : 0);
</script>

<div
  class="h-6 flex items-center px-3 text-xs select-none"
  style="background: var(--novelist-bg-secondary); border-top: 1px solid var(--novelist-border); color: var(--novelist-text-secondary);"
>
  <span>{wordCount} words</span>
  <span class="mx-2">|</span>
  <span>Goal: {goalPercent}%</span>
  <span class="ml-auto">Ln {cursorLine}, Col {cursorCol}</span>
</div>
