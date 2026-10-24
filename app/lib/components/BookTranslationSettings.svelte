<script lang="ts">
  import { t } from '$lib/i18n';
  import { bookTranslationSettings } from '$lib/stores/book-translation-settings.svelte';
</script>

<div class="book-translation-settings">
  <h3>{t('settings.bookTranslation.title')}</h3>
  <label for="book-translation-google-api-key">{t('settings.bookTranslation.googleApiKey')}</label>
  <input
    id="book-translation-google-api-key"
    type="password"
    value={bookTranslationSettings.value.googleApiKey}
    placeholder={t('settings.bookTranslation.googleApiKeyPlaceholder')}
    autocomplete="off"
    oninput={(event) => bookTranslationSettings.update({ googleApiKey: event.currentTarget.value })}
  />
  <p class="hint">{t('settings.bookTranslation.googleApiKeyHint')}</p>
</div>

<style>
  .book-translation-settings {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  h3 {
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--novelist-text-secondary);
  }

  label {
    font-size: 12px;
    color: var(--novelist-text-secondary);
  }

  input {
    width: 100%;
    box-sizing: border-box;
    padding: 5px 7px;
    border: 1px solid var(--novelist-border);
    border-radius: 3px;
    background: var(--novelist-bg);
    color: var(--novelist-text);
    font: inherit;
    font-size: 12px;
  }

  .hint {
    margin: 2px 0 0;
    font-size: 11px;
    line-height: 1.45;
    color: var(--novelist-text-secondary);
  }
</style>
