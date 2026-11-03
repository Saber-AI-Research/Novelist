import { invoke } from '@tauri-apps/api/core';

export type WebdavConfiguration = {
  endpoint: string;
  remote_directory: string;
  username: string;
  password: string | null;
  connected_at: string;
  restored: boolean;
  secure_credential: boolean;
};

export const getConfigurationSecret = (key: string): Promise<string | null> =>
  invoke('account_config_get_secret', { key });
export const setConfigurationSecret = (key: string, value: string | null): Promise<void> =>
  invoke('account_config_set_secret', { key, value });
export const loadRestoreJournal = (): Promise<string | null> =>
  invoke('account_config_journal', { value: null, clear: false });
export const saveRestoreJournal = (value: string): Promise<null> =>
  invoke('account_config_journal', { value, clear: false });
export const clearRestoreJournal = (): Promise<null> =>
  invoke('account_config_journal', { value: null, clear: true });
export const captureWebdav = (includeSecrets: boolean): Promise<WebdavConfiguration | null> =>
  invoke('account_config_webdav', { includeSecrets });
export const restoreWebdav = (configuration: WebdavConfiguration | null, preservePassword = false): Promise<void> =>
  invoke('account_config_restore_webdav', { configuration, preservePassword });
export const removeRestoredWebdav = (): Promise<void> =>
  invoke('account_config_remove_restored_webdav');
