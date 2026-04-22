<script lang="ts">
  let { size = 14, class: cls = '' }: { size?: number; class?: string } = $props();
</script>
<svg
  width={size} height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={cls}
  aria-hidden="true"
>
  <rect x="4" y="3" width="8" height="11" rx="0.5" />
  <rect x="6" y="2" width="4" height="2.5" rx="0.5" />
  <path d="M6.5 8h3M6.5 11h3" />
</svg>
