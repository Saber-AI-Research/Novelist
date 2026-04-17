<script lang="ts">
  import { onMount } from 'svelte';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { commands } from '$lib/ipc/commands';
  import type { TemplateInfo } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';

  interface Props {
    onClose: () => void;
    onProjectCreated: (path: string) => void;
  }
  let { onClose, onProjectCreated }: Props = $props();

  let templates = $state<TemplateInfo[]>([]);
  let selectedTemplate = $state<TemplateInfo | null>(null);
  let projectName = $state('My Project');
  let parentDir = $state('');
  let creating = $state(false);
  let error = $state('');
  let nameInput = $state<HTMLInputElement | null>(null);

  // Categories derived from templates
  let categories = $derived.by(() => {
    const cats = new Map<string, TemplateInfo[]>();
    for (const tpl of templates) {
      const cat = tpl.category || 'other';
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat)!.push(tpl);
    }
    return cats;
  });

  let selectedCategory = $state<string | null>(null);

  let filteredTemplates = $derived.by(() => {
    if (!selectedCategory) return templates;
    return templates.filter(t => t.category === selectedCategory);
  });

  // Category display labels
  const categoryLabels: Record<string, string> = {
    general: 'General',
    fiction: 'Fiction',
    'non-fiction': 'Non-fiction',
    personal: 'Personal',
    custom: 'Custom',
  };

  // Template icons (simple SVG paths)
  function templateIcon(id: string): string {
    switch (id) {
      case 'blank': return 'M4 2h8l3 3v9H4V2z';
      case 'novel': return 'M3 1h4v14H3zM9 1h4v14H9z';
      case 'long-novel': return 'M1 1h3v14H1zM5 1h3v14H5zM9 1h3v14H9zM13 3v10';
      case 'short-story': return 'M4 1h8l2 2v11H4V1zM6 5h4M6 7h5M6 9h3';
      case 'screenplay': return 'M3 1h10v14H3zM5 4h6M5 6h4M5 8h6M5 10h3M5 12h5';
      case 'blog': return 'M2 3h12v2H2zM2 7h8v1H2zM2 10h10v1H2zM2 13h6v1H2z';
      case 'journal': return 'M3 1h10v14H3zM6 4h4M6 7h4M6 10h4';
      default: return 'M4 2h5l3 3v9H4V2z';
    }
  }

  onMount(async () => {
    // Set default parent directory to ~/Documents
    const home = await getHomeDir();
    parentDir = home ? `${home}/Documents` : '';

    const result = await commands.listTemplates();
    if (result.status === 'ok') {
      templates = result.data;
      if (templates.length > 0) {
        selectedTemplate = templates[0];
      }
    }

    requestAnimationFrame(() => {
      if (nameInput) {
        nameInput.focus();
        nameInput.select();
      }
    });
  });

  async function getHomeDir(): Promise<string | null> {
    // Derive from a known path pattern
    if (typeof window !== 'undefined') {
      // On macOS, home is typically /Users/<username>
      // We can use the Tauri path API or just default
      return `/Users/${await getUsername()}`;
    }
    return null;
  }

  async function getUsername(): Promise<string> {
    // Simple fallback — read from environment via a trick
    try {
      const result = await commands.listDirectory('/Users');
      if (result.status === 'ok') {
        // Find a likely home dir (not Shared, not hidden)
        const dirs = result.data.filter(f =>
          f.is_dir && !f.name.startsWith('.') && f.name !== 'Shared' && f.name !== 'Guest'
        );
        if (dirs.length === 1) return dirs[0].name;
        // Multiple users — try to find one that has Documents
        for (const d of dirs) {
          const docsResult = await commands.listDirectory(`/Users/${d.name}/Documents`);
          if (docsResult.status === 'ok') return d.name;
        }
        if (dirs.length > 0) return dirs[0].name;
      }
    } catch {}
    return 'user';
  }

  async function chooseDirectory() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected) {
      parentDir = selected as string;
    }
  }

  async function handleCreate() {
    if (!selectedTemplate || !projectName.trim() || !parentDir.trim()) return;
    creating = true;
    error = '';

    const result = await commands.createProjectFromTemplate(
      selectedTemplate.id,
      projectName.trim(),
      parentDir.trim(),
    );

    if (result.status === 'ok') {
      onProjectCreated(result.data);
      onClose();
    } else {
      error = result.error;
    }
    creating = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleCreate();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-backdrop" onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog" onclick={(e) => e.stopPropagation()}>

    <!-- Header -->
    <div class="dialog-header">
      <h2 class="dialog-title">{t('newProject.title')}</h2>
      <button class="dialog-close-btn" onclick={onClose} title="Close">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
    </div>

    <div class="dialog-body">
      <!-- Left: Category sidebar -->
      <div class="category-sidebar">
        <button
          class="category-item"
          class:category-active={selectedCategory === null}
          onclick={() => selectedCategory = null}
        >{t('newProject.allTemplates')}</button>
        {#each [...categories.keys()] as cat}
          <button
            class="category-item"
            class:category-active={selectedCategory === cat}
            onclick={() => selectedCategory = cat}
          >{categoryLabels[cat] || cat}</button>
        {/each}
      </div>

      <!-- Center: Template grid -->
      <div class="template-grid-wrapper">
        <div class="template-grid">
          {#each filteredTemplates as tpl}
            <button
              class="template-card"
              class:template-selected={selectedTemplate?.id === tpl.id}
              onclick={() => selectedTemplate = tpl}
              ondblclick={handleCreate}
            >
              <div class="template-icon">
                <svg width="32" height="32" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
                  <path d={templateIcon(tpl.id)} />
                </svg>
              </div>
              <div class="template-name">{tpl.name}</div>
              {#if !tpl.builtin}
                <div class="template-badge">{t('newProject.custom')}</div>
              {/if}
            </button>
          {/each}
        </div>

        {#if selectedTemplate}
          <div class="template-description">
            {selectedTemplate.description}
          </div>
        {/if}
      </div>
    </div>

    <!-- Bottom: Project config -->
    <div class="dialog-footer">
      <div class="footer-fields">
        <div class="field-row">
          <label class="field-label" for="np-name">{t('newProject.name')}</label>
          <input
            id="np-name"
            bind:this={nameInput}
            bind:value={projectName}
            class="field-input"
            placeholder={t('newProject.namePlaceholder')}
          />
        </div>
        <div class="field-row">
          <label class="field-label" for="np-location">{t('newProject.location')}</label>
          <div class="field-input-group">
            <input
              id="np-location"
              bind:value={parentDir}
              class="field-input field-input-path"
              placeholder={t('newProject.locationPlaceholder')}
            />
            <button class="field-browse-btn" onclick={chooseDirectory}>{t('newProject.browse')}</button>
          </div>
        </div>
      </div>

      {#if error}
        <div class="footer-error">{error}</div>
      {/if}

      <div class="footer-actions">
        <button class="btn-cancel" onclick={onClose}>{t('newProject.cancel')}</button>
        <button
          class="btn-create"
          onclick={handleCreate}
          disabled={creating || !projectName.trim() || !parentDir.trim() || !selectedTemplate}
        >
          {creating ? t('newProject.creating') : t('newProject.create')}
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.4);
  }

  .dialog {
    width: 680px;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    border-radius: 10px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
    color: var(--novelist-text);
    overflow: hidden;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px 10px;
    border-bottom: 1px solid var(--novelist-border);
  }

  .dialog-title {
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
  }

  .dialog-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    transition: background 0.1s;
  }
  .dialog-close-btn:hover {
    background: var(--novelist-bg-secondary);
  }

  .dialog-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* Category sidebar */
  .category-sidebar {
    width: 130px;
    flex-shrink: 0;
    padding: 8px;
    border-right: 1px solid var(--novelist-border);
    background: var(--novelist-bg-secondary);
    overflow-y: auto;
  }

  .category-item {
    display: block;
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-text);
    font-size: 0.78rem;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s;
  }
  .category-item:hover {
    background: var(--novelist-sidebar-hover);
  }
  .category-active {
    background: var(--novelist-sidebar-active) !important;
    color: var(--novelist-accent);
    font-weight: 600;
  }

  /* Template grid */
  .template-grid-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 12px 16px;
    overflow-y: auto;
    min-height: 200px;
  }

  .template-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 10px;
  }

  .template-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 14px 8px 10px;
    border: 2px solid transparent;
    border-radius: 8px;
    background: var(--novelist-bg-secondary);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    position: relative;
  }
  .template-card:hover {
    border-color: var(--novelist-border);
  }
  .template-selected {
    border-color: var(--novelist-accent) !important;
    background: color-mix(in srgb, var(--novelist-accent) 8%, var(--novelist-bg-secondary));
  }

  .template-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    border-radius: 8px;
    background: var(--novelist-bg);
    color: var(--novelist-accent);
  }

  .template-name {
    font-size: 0.78rem;
    font-weight: 500;
    text-align: center;
    color: var(--novelist-text);
  }

  .template-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    font-size: 0.6rem;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--novelist-accent);
    color: #fff;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .template-description {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--novelist-border);
    font-size: 0.8rem;
    color: var(--novelist-text-secondary);
    line-height: 1.5;
  }

  /* Footer */
  .dialog-footer {
    padding: 12px 18px 16px;
    border-top: 1px solid var(--novelist-border);
  }

  .footer-fields {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }

  .field-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .field-label {
    width: 70px;
    flex-shrink: 0;
    font-size: 0.82rem;
    color: var(--novelist-text-secondary);
    text-align: right;
  }

  .field-input {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
    font-size: 0.85rem;
    outline: none;
    transition: border-color 0.15s;
  }
  .field-input:focus {
    border-color: var(--novelist-accent);
  }

  .field-input-group {
    display: flex;
    flex: 1;
    gap: 6px;
  }
  .field-input-path {
    min-width: 0;
  }

  .field-browse-btn {
    flex-shrink: 0;
    padding: 6px 12px;
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
    font-size: 0.78rem;
    cursor: pointer;
    transition: border-color 0.1s;
  }
  .field-browse-btn:hover {
    border-color: var(--novelist-accent);
  }

  .footer-error {
    font-size: 0.78rem;
    color: #e5484d;
    margin-bottom: 8px;
  }

  .footer-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn-cancel {
    padding: 6px 16px;
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-text-secondary);
    font-size: 0.85rem;
    cursor: pointer;
    transition: border-color 0.1s;
  }
  .btn-cancel:hover {
    border-color: var(--novelist-text-secondary);
  }

  .btn-create {
    padding: 6px 20px;
    border: none;
    border-radius: 5px;
    background: var(--novelist-accent);
    color: #fff;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.1s;
  }
  .btn-create:hover {
    opacity: 0.85;
  }
  .btn-create:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
