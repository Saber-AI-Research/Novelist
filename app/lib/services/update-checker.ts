/**
 * Task 22 — update-check orchestrator.
 *
 * Shares one `UpdateCheckState` snapshot and one in-flight Promise between
 * startup and manual callers. Portable mode short-circuits before any
 * updater plugin import. Silent terminal outcomes (no-update, skipped,
 * unsupported) return without banners or dialogs. Available updates
 * project into `updaterState` once. Startup failure logs and stays quiet;
 * the reducer resets to idle so a later manual retry allocates a fresh
 * token and dispatches a fresh plugin call.
 */
import { getPortableInfo } from '$lib/services/portable';
import { updaterState } from '$lib/stores/updater-state.svelte';
import {
  applyEvent,
  completeFromResult,
  initialUpdateCheckState,
  isSilentPhase,
  startCheck,
  type UpdateCheckEvent,
  type UpdateCheckState,
  type UpdateRequestToken,
  type UpdaterResult,
} from '$lib/utils/update-check-state';

export const SKIPPED_VERSION_KEY = 'novelist-skipped-update-version';

export type UpdaterPluginResult = {
  version: string;
  body?: string | null;
  handle?: unknown;
};

export type UpdaterPluginCheck = () => Promise<null | UpdaterPluginResult>;

export type UpdateCheckOutcome =
  | { kind: 'available'; version: string; notes: string | null; handle: unknown }
  | { kind: 'no-update' }
  | { kind: 'skipped'; version: string }
  | { kind: 'unsupported' }
  | { kind: 'failed'; error: string };

export type UpdateCheckRunOptions = { startup: boolean };

type CheckerHooks = {
  loadPluginCheck: () => Promise<UpdaterPluginCheck>;
  getSkippedVersion: () => string | null;
  isPortable: () => Promise<boolean>;
};

type SharedRequest = {
  promise: Promise<UpdateCheckOutcome>;
  token: UpdateRequestToken;
};

const PLUGIN_TIMEOUT_MS = 10000;

let state: UpdateCheckState = initialUpdateCheckState();
let inflight: SharedRequest | null = null;
let hooks: CheckerHooks = defaultHooks();
let lastAvailableHandle: unknown = null;

function defaultHooks(): CheckerHooks {
  return {
    loadPluginCheck: async () => {
      const mod = await import('@tauri-apps/plugin-updater');
      return async () => {
        const update = await mod.check({ timeout: PLUGIN_TIMEOUT_MS });
        if (!update) return null;
        return { version: update.version, body: update.body ?? null, handle: update };
      };
    },
    getSkippedVersion: () => {
      try {
        return localStorage.getItem(SKIPPED_VERSION_KEY);
      } catch {
        return null;
      }
    },
    isPortable: async () => {
      const info = await getPortableInfo();
      return info.enabled;
    },
  };
}

const MAX_LOGGED_ERROR_LEN = 200;

function sanitizeErrorForLog(raw: string): string {
  let s = raw.replace(/[?&](token|access_token|api_key|apikey|key|secret|password|credential|auth)=[^&\s"'#]+/gi, (_, k: string) => `&${k}=<redacted>`);
  s = s.replace(/(["']?(?:token|access_token|api_key|apikey|secret|password|credential|authorization)["']?\s*[:=]\s*)["']?[^"'\s,}]+/gi, '$1<redacted>');
  s = s.replace(/(Bearer|Basic|Token|Ghost)\s+[A-Za-z0-9._\-+/=]{16,}/g, '$1 <redacted>');
  s = s.replace(/[\x00-\x1f\x7f]+/g, ' ');
  if (s.length > MAX_LOGGED_ERROR_LEN) {
    s = s.slice(0, MAX_LOGGED_ERROR_LEN) + '…';
  }
  return s;
}

function toBoundedError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return sanitizeErrorForLog(raw);
}

function dispatch(event: UpdateCheckEvent): UpdateCheckState {
  state = applyEvent(state, event);
  return state;
}

function projectAvailableToStore(version: string, notes: string | null) {
  updaterState.setAvailable(version, notes);
}

function logOutcome(outcome: UpdateCheckOutcome, opts: UpdateCheckRunOptions) {
  const base = { source: opts.startup ? 'startup' : 'manual' as const };
  switch (outcome.kind) {
    case 'available':
      console.info('[updater] available', { ...base, version: outcome.version });
      return;
    case 'no-update':
      console.info('[updater] no-update', base);
      return;
    case 'skipped':
      console.info('[updater] skipped', { ...base, version: outcome.version });
      return;
    case 'unsupported':
      console.info('[updater] unsupported', base);
      return;
    case 'failed':
      console.warn('[updater] check failed', { ...base, error: outcome.error });
      return;
  }
}

function phaseToOutcome(snapshot: UpdateCheckState): UpdateCheckOutcome | null {
  switch (snapshot.phase) {
    case 'no-update':
      return { kind: 'no-update' };
    case 'skipped':
      return { kind: 'skipped', version: snapshot.version ?? '' };
    case 'unsupported':
      return { kind: 'unsupported' };
    case 'failed':
      return { kind: 'failed', error: snapshot.error ?? '' };
    default:
      return null;
  }
}

async function runPluginCheck(token: UpdateRequestToken): Promise<UpdateCheckOutcome> {
  let pluginCheck: UpdaterPluginCheck;
  try {
    pluginCheck = await hooks.loadPluginCheck();
  } catch (e) {
    const error = toBoundedError(e);
    dispatch({ type: 'fail', token, error });
    lastAvailableHandle = null;
    return { kind: 'failed', error };
  }

  let raw: Awaited<ReturnType<UpdaterPluginCheck>>;
  try {
    raw = await pluginCheck();
  } catch (e) {
    const error = toBoundedError(e);
    dispatch({ type: 'fail', token, error });
    lastAvailableHandle = null;
    return { kind: 'failed', error };
  }

  const result: UpdaterResult = raw === null
    ? { available: false }
    : { available: true, version: raw.version, notes: raw.body ?? null };

  const skipped = hooks.getSkippedVersion();
  const event = completeFromResult(result, skipped, token);
  const snapshot = dispatch(event);

  if (snapshot.phase === 'available' && raw !== null) {
    lastAvailableHandle = raw.handle ?? null;
    projectAvailableToStore(snapshot.version ?? '', snapshot.notes);
    return {
      kind: 'available',
      version: snapshot.version ?? '',
      notes: snapshot.notes,
      handle: lastAvailableHandle,
    };
  }

  lastAvailableHandle = null;

  const outcome = phaseToOutcome(snapshot);
  if (!outcome) {
    return { kind: 'no-update' };
  }
  return outcome;
}

function resetTerminalToIdle() {
  if (state.phase !== 'idle' && state.phase !== 'checking') {
    state = applyEvent(state, { type: 'retry' });
  }
}

export async function runUpdateCheck(
  opts: UpdateCheckRunOptions,
): Promise<UpdateCheckOutcome> {
  const existing: SharedRequest | null = inflight;
  if (existing) {
    return existing.promise;
  }

  const { state: next, token } = startCheck(state);
  state = next;

  const promise = (async () => {
    try {
      const outcome = await runRequest(token, opts);
      logOutcome(outcome, opts);
      resetTerminalToIdle();
      return outcome;
    } finally {
      const current: SharedRequest | null = inflight;
      if (current && current.token.id === token.id) {
        inflight = null;
      }
    }
  })();

  inflight = { promise, token };
  return promise;
}

async function runRequest(
  token: UpdateRequestToken,
  _opts: UpdateCheckRunOptions,
): Promise<UpdateCheckOutcome> {
  let portable: boolean;
  try {
    portable = await hooks.isPortable();
  } catch (e) {
    const error = toBoundedError(e);
    dispatch({ type: 'fail', token, error });
    lastAvailableHandle = null;
    return { kind: 'failed', error };
  }

  if (portable) {
    dispatch({ type: 'completeNoUpdate', token });
    dispatch({ type: 'markUnsupported' });
    lastAvailableHandle = null;
    return { kind: 'unsupported' };
  }

  return runPluginCheck(token);
}

export function __setUpdateCheckerHooksForTests(overrides: Partial<CheckerHooks>): void {
  hooks = { ...hooks, ...overrides };
}

export function __resetUpdateCheckerForTests(): void {
  state = initialUpdateCheckState();
  inflight = null;
  hooks = defaultHooks();
  lastAvailableHandle = null;
}

export function __currentUpdateCheckStateForTests(): UpdateCheckState {
  return state;
}

export function __currentInflightTokenForTests(): UpdateRequestToken | null {
  return inflight ? inflight.token : null;
}

export function isUpdateCheckSilentPhase(): boolean {
  return isSilentPhase(state.phase);
}

export function takeLastAvailableHandle(): unknown {
  const h = lastAvailableHandle;
  lastAvailableHandle = null;
  return h;
}
