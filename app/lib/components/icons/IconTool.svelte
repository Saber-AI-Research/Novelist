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
  <path d="M10.5 2.5a3 3 0 0 0-2 5l-5.5 5.5 1.5 1.5 5.5-5.5a3 3 0 0 0 3.5-4.5L11.5 6.5l-2-2z" />
</svg>
