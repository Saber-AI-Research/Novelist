/**
 * Registry of "Configure…" entries available for installed plugins —
 * Obsidian-inspired: each plugin can register a Settings tab, surfaced
 * from Settings → Plugins → ⚙ next to the plugin row.
 *
 * For built-in panels (ai-talk, ai-agent) this dynamic-imports the
 * panel's settings component on demand. Third-party plugins distributed
 * via iframe don't currently get a host-side settings panel; their
 * settings live inside the iframe.
 */

import type { Component } from 'svelte';

export type PluginSettingsEntry = {
  /** Plugin id (matches PluginInfo.id / UIExtension.pluginId). */
  pluginId: string;
  /** Human label, defaulting to the plugin's `name` if not set here. */
  label?: string;
  /** Async loader for the settings component. */
  load: () => Promise<{ default: Component }>;
  /**
   * Optional companion: if set, clicking "Open panel" on the settings
   * dialog will activate this panel id and (when the panel renders) it'll
   * open its in-panel settings drawer.
   */
  panelId?: string;
};

const ENTRIES: Record<string, PluginSettingsEntry> = {
  'ai-talk': {
    pluginId: 'ai-talk',
    label: 'AI Talk',
    panelId: 'ai-talk',
    load: () => import('$lib/components/ai-talk/AiTalkSettings.svelte'),
  },
  'ai-agent': {
    pluginId: 'ai-agent',
    label: 'AI Agent',
    panelId: 'ai-agent',
    load: () => import('$lib/components/ai-agent/AiAgentSettings.svelte'),
  },
};

export const pluginSettings = {
  has(pluginId: string): boolean {
    return pluginId in ENTRIES;
  },
  get(pluginId: string): PluginSettingsEntry | null {
    return ENTRIES[pluginId] ?? null;
  },
  list(): PluginSettingsEntry[] {
    return Object.values(ENTRIES);
  },
};

/**
 * Stash a flag in sessionStorage so the panel's mount logic knows to open
 * its settings drawer. Used by the "Open in panel" button on the settings
 * dialog when the user wants to also see the panel UI.
 */
export function requestOpenPanelSettings(panelId: string) {
  try {
    sessionStorage.setItem(`novelist:${panelId}:open-settings`, '1');
  } catch {
    /* ignore */
  }
}
