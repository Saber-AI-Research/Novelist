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
  <circle cx="8" cy="8" r="6" />
  <path d="M2 8h12" />
  <ellipse cx="8" cy="8" rx="3" ry="6" />
</svg>
