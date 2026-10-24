<script lang="ts">
  import { onMount } from "svelte";
  import { getPortableInfo, type PortableInfo } from "$lib/services/portable";
  import { t } from "$lib/i18n";

  let info = $state<PortableInfo | null>(null);

  onMount(async () => {
    info = await getPortableInfo();
  });
</script>

{#if info?.enabled}
  <div
    role="status"
    class="px-4 py-2 text-sm"
    style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border-bottom: 1px solid var(--novelist-border);"
    data-testid="portable-mode-banner"
  >
    {t('portable.bannerLabel')} <code class="font-mono" style="color: var(--novelist-text-secondary);">{info.dataRoot}</code>
  </div>
{/if}
