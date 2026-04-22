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
  <path d="M1 4l5-2 4 2 5-2v10l-5 2-4-2-5 2z" />
  <path d="M6 2v10M10 4v10" />
</svg>
