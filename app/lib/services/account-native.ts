import { invoke } from '@tauri-apps/api/core';

export interface AccountSummary {
  endpoint: string;
  user_id: string;
  username: string;
  device_id: string;
  expires_at: string;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : (error as Error)?.message ?? 'account_request_failed');
  }
}

export function status(): Promise<AccountSummary | null> {
  return call('account_status');
}

export function authenticate(
  endpoint: string,
  username: string,
  password: string,
  deviceName: string,
  register: boolean,
): Promise<AccountSummary> {
  return call('account_authenticate', { endpoint, username, password, deviceName, register });
}

export function request<T = unknown>(method: string, path: string, body: unknown = null): Promise<T> {
  return call('account_request', { method, path, body });
}

export function forget(): Promise<void> {
  return call('account_forget');
}

export function recoveryKey(value: string | null = null): Promise<string | null> {
  return call('account_recovery_key', { value });
}

export function loadState(): Promise<string | null> {
  return call('account_load_state');
}

export function saveState(value: string): Promise<void> {
  return call('account_save_state', { value });
}
