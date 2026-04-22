<script lang="ts">
  /**
   * Prompt preset library manager for AI Talk Settings. Lists built-in +
   * user presets, allows add/edit/delete, and soft-hide for built-ins.
   */
  import { promptPresets, BUILTIN_PRESETS, type PromptPreset } from './presets.svelte';
  import { IconPackage, IconDocument } from '../icons';

  type EditorState = {
    id: string | null;   // null when creating
    name: string;
    icon: string;
    systemPrompt: string;
    temperature: string; // kept as string for empty-means-inherit UX
    model: string;
  };

  const BLANK: EditorState = {
    id: null,
    name: '',
    icon: '',
    systemPrompt: '',
    temperature: '',
    model: '',
  };

  let editor = $state<EditorState | null>(null);
  let validationError = $state<string | null>(null);

  function openNew() {
    editor = { ...BLANK };
    validationError = null;
  }

  function openEdit(p: PromptPreset) {
    editor = {
      id: p.id,
      name: p.name,
      icon: typeof p.icon === 'string' ? p.icon : '',
      systemPrompt: p.systemPrompt,
      temperature: p.temperature != null ? String(p.temperature) : '',
      model: p.model ?? '',
    };
    validationError = null;
  }

  function cancelEdit() {
    editor = null;
    validationError = null;
  }

  function save() {
    if (!editor) return;
    const name = editor.name.trim();
    if (!name) {
      validationError = 'Name is required.';
      return;
    }
    if (!editor.systemPrompt.trim()) {
      validationError = 'System prompt is required.';
      return;
    }
    const tempParsed = editor.temperature.trim() === '' ? undefined : Number(editor.temperature);
    if (tempParsed != null && (!Number.isFinite(tempParsed) || tempParsed < 0 || tempParsed > 2)) {
      validationError = 'Temperature must be between 0 and 2.';
      return;
    }
    const data = {
      name,
      icon: editor.icon.trim() || undefined,
      systemPrompt: editor.systemPrompt,
      temperature: tempParsed,
      model: editor.model.trim() || undefined,
    };
    if (editor.id) {
      promptPresets.update(editor.id, data);
    } else {
      promptPresets.create(data);
    }
    editor = null;
  }

  function remove(p: PromptPreset) {
    const msg = p.builtin
      ? `Hide built-in preset "${p.name}"? You can restore it later from the hidden section below.`
      : `Delete preset "${p.name}"? This can't be undone.`;
    if (!confirm(msg)) return;
    promptPresets.delete(p.id);
  }

  let hiddenBuiltins = $derived(
    BUILTIN_PRESETS.filter((p) => promptPresets.hiddenBuiltins.includes(p.id)),
  );
</script>

<div class="presets-mgr" data-testid="prompt-preset-manager">
  <div class="header">
    <h4>Prompt presets</h4>
    <button
      type="button"
      class="novelist-btn novelist-btn-ghost novelist-btn-sm"
      data-testid="prompt-preset-add"
      onclick={openNew}
    >+ New preset</button>
  </div>

  {#if promptPresets.all.length === 0}
    <p class="empty">No presets. Click "+ New preset" to create one.</p>
  {:else}
    <ul class="list">
      {#each promptPresets.all as p (p.id)}
        <li class="item" data-testid="prompt-preset-row-{p.id}">
          <span class="icon">
            {#if !p.icon}
              {#if p.builtin}
                <IconPackage size={14} />
              {:else}
                <IconDocument size={14} />
              {/if}
            {:else if typeof p.icon === 'string'}
              {p.icon}
            {:else}
              {@const Icon = p.icon}
              <Icon size={14} />
            {/if}
          </span>
          <div class="meta">
            <div class="name">
              <span>{p.name}</span>
              {#if p.builtin}<span class="tag">built-in</span>{/if}
              {#if p.temperature != null}<span class="tag">temp {p.temperature}</span>{/if}
              {#if p.model}<span class="tag">{p.model}</span>{/if}
            </div>
            <div class="preview">{p.systemPrompt.slice(0, 140)}{p.systemPrompt.length > 140 ? '…' : ''}</div>
          </div>
          <div class="actions">
            {#if !p.builtin}
              <button type="button" class="novelist-btn novelist-btn-ghost novelist-btn-sm" onclick={() => openEdit(p)}>Edit</button>
            {:else}
              <button type="button" class="novelist-btn novelist-btn-ghost novelist-btn-sm" title="Built-ins aren't editable. Click to view." onclick={() => openEdit(p)}>View</button>
            {/if}
            <button
              type="button"
              class="novelist-btn novelist-btn-ghost novelist-btn-sm"
              data-testid="prompt-preset-delete-{p.id}"
              onclick={() => remove(p)}
            >{p.builtin ? 'Hide' : 'Delete'}</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if hiddenBuiltins.length > 0}
    <div class="hidden-section">
      <h5>Hidden built-ins</h5>
      <ul class="list hidden-list">
        {#each hiddenBuiltins as p (p.id)}
          <li class="item faded">
            <span class="icon">
              {#if !p.icon}
                <IconPackage size={14} />
              {:else if typeof p.icon === 'string'}
                {p.icon}
              {:else}
                {@const Icon = p.icon}
                <Icon size={14} />
              {/if}
            </span>
            <div class="meta">
              <div class="name">{p.name}</div>
            </div>
            <button
              type="button"
              class="novelist-btn novelist-btn-ghost novelist-btn-sm"
              onclick={() => promptPresets.restoreBuiltin(p.id)}
            >Restore</button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if editor}
    {@const locked = editor.id !== null && promptPresets.get(editor.id)?.builtin === true}
    <div class="editor" data-testid="prompt-preset-editor">
      <div class="editor-head">
        <strong>{editor.id ? (locked ? 'View preset' : 'Edit preset') : 'New preset'}</strong>
      </div>

      <div class="grid">
        <label>
          <span>Name</span>
          <input
            type="text"
            data-testid="prompt-preset-name"
            value={editor.name}
            readonly={locked}
            oninput={(e) => editor && (editor.name = e.currentTarget.value)}
          />
        </label>
        <label>
          <span>Icon (emoji, optional)</span>
          <input
            type="text"
            value={editor.icon}
            readonly={locked}
            maxlength="4"
            oninput={(e) => editor && (editor.icon = e.currentTarget.value)}
          />
        </label>
        <label class="full">
          <span>System prompt</span>
          <textarea
            rows="5"
            data-testid="prompt-preset-system"
            value={editor.systemPrompt}
            readonly={locked}
            oninput={(e) => editor && (editor.systemPrompt = e.currentTarget.value)}
          ></textarea>
        </label>
        <label>
          <span>Temperature (0–2, blank = inherit)</span>
          <input
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={editor.temperature}
            readonly={locked}
            oninput={(e) => editor && (editor.temperature = e.currentTarget.value)}
          />
        </label>
        <label>
          <span>Model (blank = inherit)</span>
          <input
            type="text"
            value={editor.model}
            readonly={locked}
            oninput={(e) => editor && (editor.model = e.currentTarget.value)}
          />
        </label>
      </div>

      {#if validationError}
        <p class="err" role="alert">{validationError}</p>
      {/if}

      <div class="editor-actions">
        <button
          type="button"
          class="novelist-btn novelist-btn-ghost"
          onclick={cancelEdit}
        >{locked ? 'Close' : 'Cancel'}</button>
        {#if !locked}
          <button
            type="button"
            class="novelist-btn novelist-btn-primary"
            data-testid="prompt-preset-save"
            onclick={save}
          >Save preset</button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .presets-mgr { display: flex; flex-direction: column; gap: 8px; }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  h4 { margin: 0; font-size: 12px; font-weight: 600; }
  h5 { margin: 8px 0 4px; font-size: 11px; font-weight: 500; color: var(--novelist-text-secondary); }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  .item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    background: var(--novelist-bg);
  }
  .item.faded { opacity: 0.7; }
  .icon { font-size: 14px; line-height: 1.3; flex-shrink: 0; }
  .meta { flex: 1; min-width: 0; }
  .name {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--novelist-text);
    font-weight: 500;
  }
  .tag {
    font-size: 10px;
    padding: 0 5px;
    border-radius: 8px;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text-secondary);
    font-weight: normal;
  }
  .preview {
    font-size: 11px;
    color: var(--novelist-text-secondary);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .actions { display: flex; gap: 4px; flex-shrink: 0; }
  .empty {
    margin: 0;
    padding: 10px;
    font-size: 11px;
    color: var(--novelist-text-secondary);
    background: var(--novelist-bg-secondary);
    border-radius: 4px;
    text-align: center;
  }
  .hidden-section { margin-top: 8px; }
  .hidden-list .item { border-style: dashed; }
  .editor {
    margin-top: 8px;
    padding: 10px;
    border: 1px solid var(--novelist-accent);
    border-radius: 4px;
    background: color-mix(in srgb, var(--novelist-accent) 5%, var(--novelist-bg));
  }
  .editor-head { font-size: 12px; margin-bottom: 8px; }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .grid label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--novelist-text-secondary);
  }
  .grid label.full { grid-column: 1 / -1; }
  .grid input,
  .grid textarea {
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text);
    padding: 4px 6px;
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
  }
  .grid input:read-only,
  .grid textarea:read-only {
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text-secondary);
  }
  .grid textarea { resize: vertical; }
  .err {
    margin: 6px 0 0;
    font-size: 11px;
    color: #dc2626;
  }
  .editor-actions {
    margin-top: 8px;
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
</style>
