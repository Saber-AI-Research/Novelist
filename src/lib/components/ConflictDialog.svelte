<script lang="ts">
  interface Props {
    filePath: string;
    onKeepMine: () => void;
    onLoadTheirs: () => void;
    onClose: () => void;
  }

  let { filePath, onKeepMine, onLoadTheirs, onClose }: Props = $props();

  const fileName = $derived(filePath.split('/').pop() || filePath);
</script>

<!-- Overlay -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center"
  style="background: rgba(0, 0, 0, 0.5);"
  role="dialog"
  aria-modal="true"
  aria-labelledby="conflict-dialog-title"
>
  <div
    class="rounded-lg shadow-xl p-6 max-w-md w-full mx-4"
    style="background: var(--novelist-bg); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
  >
    <h2 id="conflict-dialog-title" class="text-base font-semibold mb-3">
      External Change Detected
    </h2>

    <p class="text-sm mb-5" style="color: var(--novelist-text-secondary);">
      File <strong style="color: var(--novelist-text);">{fileName}</strong> was changed externally.
      You have unsaved changes. What would you like to do?
    </p>

    <div class="flex gap-3 justify-end">
      <button
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
        onclick={() => { onKeepMine(); onClose(); }}
      >
        Keep Mine
      </button>
      <button
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="background: var(--novelist-accent); color: #fff;"
        onclick={() => { onLoadTheirs(); onClose(); }}
      >
        Load Theirs
      </button>
    </div>
  </div>
</div>
