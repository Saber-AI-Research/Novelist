<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { t } from '$lib/i18n';

  interface Props {
    projectDir: string;
    chapters: { fileName: string; filePath: string; wordCount: number }[];
  }

  let { projectDir, chapters }: Props = $props();

  interface DailyStats {
    date: string;
    words_written: number;
    time_minutes: number;
  }

  interface ChapterStat {
    file_name: string;
    file_path: string;
    word_count: number;
  }

  interface StatsOverview {
    daily: DailyStats[];
    total_words: number;
    chapters: ChapterStat[];
    streak_days: number;
    today_words: number;
    today_minutes: number;
  }

  let stats = $state<StatsOverview | null>(null);
  let loading = $state(true);
  let dailyGoal = $state(1000);

  async function loadStats() {
    try {
      const chaptersInput = chapters.map(c => ({
        file_name: c.fileName,
        file_path: c.filePath,
        word_count: c.wordCount,
      }));
      const result = await invoke<StatsOverview>('get_writing_stats', {
        projectDir,
        chapters: chaptersInput,
      });
      stats = result;
    } catch (e) {
      console.error('Failed to load stats:', e);
    } finally {
      loading = false;
    }
  }

  // Reload when project or chapters change
  $effect(() => {
    if (projectDir) {
      // Access chapters to create dependency
      const _len = chapters.length;
      loadStats();
    }
  });

  // Last 7 days for chart
  let last7 = $derived(stats ? stats.daily.slice(-7) : []);
  let maxWords = $derived(Math.max(1, ...last7.map(d => Math.abs(d.words_written))));

  // Sorted chapters
  let sortedChapters = $derived(
    stats ? [...stats.chapters].sort((a, b) => b.word_count - a.word_count) : []
  );

  function dayLabel(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    return t(`stats.day.${d.getDay()}`);
  }

  function formatMinutes(m: number): string {
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  }

  let goalPercent = $derived(
    stats ? Math.min(100, Math.round((Math.max(0, stats.today_words) / dailyGoal) * 100)) : 0
  );
</script>

<div class="flex flex-col h-full" style="background: var(--novelist-bg); color: var(--novelist-text);">
  <!-- Header -->
  <div class="shrink-0 flex items-center justify-between px-3 py-1.5"
    style="border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
    <span style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--novelist-text-secondary); font-weight: 600;">
      {t('stats.title')}
    </span>
  </div>

  {#if loading}
    <div class="flex-1 flex items-center justify-center">
      <span style="font-size: 12px; color: var(--novelist-text-secondary);">{t('stats.loading')}</span>
    </div>
  {:else if stats}
    <div class="flex-1 overflow-y-auto px-3 py-3" style="font-size: 13px;">

      <!-- Today's Progress -->
      <div class="mb-4">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--novelist-text-secondary); margin-bottom: 8px;">
          {t('stats.today')}
        </div>
        <div class="flex items-end gap-2 mb-2">
          <span style="font-size: 28px; font-weight: 700; line-height: 1; color: var(--novelist-accent);">
            {stats.today_words > 0 ? '+' : ''}{stats.today_words}
          </span>
          <span style="font-size: 12px; color: var(--novelist-text-secondary); margin-bottom: 2px;">{t('stats.words')}</span>
        </div>

        <!-- Progress bar -->
        <div style="height: 6px; border-radius: 3px; background: var(--novelist-border-subtle, var(--novelist-border)); overflow: hidden; margin-bottom: 4px;">
          <div style="height: 100%; width: {goalPercent}%; background: var(--novelist-accent); border-radius: 3px; transition: width 300ms;"></div>
        </div>
        <div class="flex justify-between" style="font-size: 10px; color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
          <span>{t('stats.goalProgress', { percent: goalPercent, goal: dailyGoal })}</span>
          <span>{formatMinutes(Number(stats.today_minutes))}</span>
        </div>
      </div>

      <!-- Streak -->
      {#if stats.streak_days > 0}
        <div class="mb-4 flex items-center gap-1.5" style="font-size: 12px;">
          <span style="display: inline-block; padding: 2px 8px; border-radius: 10px; background: color-mix(in srgb, var(--novelist-accent) 15%, transparent); color: var(--novelist-accent); font-weight: 600; font-size: 11px;">
            {t('stats.streak', { days: stats.streak_days })}
          </span>
        </div>
      {/if}

      <!-- 7-day Chart -->
      <div class="mb-4">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--novelist-text-secondary); margin-bottom: 8px;">
          {t('stats.last7Days')}
        </div>
        <div class="flex items-end gap-1" style="height: 80px;">
          {#each last7 as day}
            <div class="flex flex-col items-center flex-1" style="height: 100%;">
              <div class="flex-1 flex items-end w-full" style="padding: 0 2px;">
                <div
                  style="width: 100%; border-radius: 2px 2px 0 0; background: {day.words_written > 0 ? 'var(--novelist-accent)' : day.words_written < 0 ? 'color-mix(in srgb, red 60%, transparent)' : 'var(--novelist-border-subtle, var(--novelist-border))'}; min-height: 2px; height: {Math.max(2, (Math.abs(day.words_written) / maxWords) * 100)}%; opacity: {day.words_written === 0 ? 0.3 : 0.8}; transition: height 300ms;"
                  title="{day.date}: {day.words_written} words, {day.time_minutes}min"
                ></div>
              </div>
              <span style="font-size: 9px; color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); margin-top: 4px;">
                {dayLabel(day.date)}
              </span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Project Total -->
      <div class="mb-4">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--novelist-text-secondary); margin-bottom: 4px;">
          {t('stats.projectTotal')}
        </div>
        <span style="font-size: 18px; font-weight: 600;">
          {stats.total_words.toLocaleString()}
        </span>
        <span style="font-size: 12px; color: var(--novelist-text-secondary);"> {t('stats.words')}</span>
      </div>

      <!-- Chapter Breakdown -->
      {#if sortedChapters.length > 0}
        <div>
          <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--novelist-text-secondary); margin-bottom: 8px;">
            {t('stats.chapters')}
          </div>
          <div style="font-size: 12px;">
            {#each sortedChapters as ch}
              <div class="flex justify-between py-1" style="border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px;" title={ch.file_name}>
                  {ch.file_name}
                </span>
                <span style="color: var(--novelist-text-secondary); white-space: nowrap; margin-left: 8px;">
                  {ch.word_count.toLocaleString()}
                  {#if stats && stats.total_words > 0}
                    <span style="font-size: 10px; color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
                      ({Math.round((ch.word_count / stats.total_words) * 100)}%)
                    </span>
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
