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
  <path d="M5 10c0-1-2-2-2-4.5A5 5 0 0 1 13 5.5c0 2.5-2 3.5-2 4.5z" />
  <path d="M5.5 12h5" />
  <path d="M6.5 14h3" />
</svg>
