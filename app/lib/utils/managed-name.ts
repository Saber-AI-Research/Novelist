export const MANAGED_NAME_SCHEMA_VERSION = 1 as const;

export type ManagedStatus = 'managed' | 'detached';

export interface ManagedNameStateV1 {
  version: 1;
  status: ManagedStatus;
  templateRaw: string;
  currentH1: string;
  documentKey: string;
}

export type ManagedNameState = ManagedNameStateV1;

const CANONICAL_TITLE_TOKEN = '{title}';

export function hasCanonicalTitleToken(templateRaw: string): boolean {
  if (typeof templateRaw !== 'string' || templateRaw.length === 0) return false;
  return templateRaw.includes(CANONICAL_TITLE_TOKEN);
}

export function isValidOpaqueDocumentKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKnownStatus(value: unknown): value is ManagedStatus {
  return value === 'managed' || value === 'detached';
}

function isValidTemplateRaw(value: unknown): value is string {
  return typeof value === 'string' && hasCanonicalTitleToken(value);
}

function isValidCurrentH1(value: unknown): value is string {
  return typeof value === 'string';
}

function isValidState(value: unknown): value is ManagedNameState {
  if (!isPlainRecord(value)) return false;
  if (value.version !== MANAGED_NAME_SCHEMA_VERSION) return false;
  if (!isKnownStatus(value.status)) return false;
  if (!isValidTemplateRaw(value.templateRaw)) return false;
  if (!isValidCurrentH1(value.currentH1)) return false;
  if (!isValidOpaqueDocumentKey(value.documentKey)) return false;
  return true;
}

export function enableManaged(
  templateRaw: string,
  documentKey: string,
  currentH1: string,
): ManagedNameState | null {
  if (!isValidTemplateRaw(templateRaw)) return null;
  if (!isValidOpaqueDocumentKey(documentKey)) return null;
  if (!isValidCurrentH1(currentH1)) return null;
  return {
    version: MANAGED_NAME_SCHEMA_VERSION,
    status: 'managed',
    templateRaw,
    currentH1,
    documentKey,
  };
}

export function detach(state: ManagedNameState): ManagedNameState {
  return { ...state, status: 'detached' };
}

export function reEnable(state: ManagedNameState): ManagedNameState {
  return { ...state, status: 'managed' };
}

export function migratePath(
  state: ManagedNameState,
  newDocumentKey: string,
): ManagedNameState | null {
  if (!isValidOpaqueDocumentKey(newDocumentKey)) return null;
  return { ...state, documentKey: newDocumentKey };
}

export function updateAnchor(
  state: ManagedNameState,
  newH1: string,
): ManagedNameState {
  return { ...state, currentH1: newH1 };
}

export function serialize(state: ManagedNameState): string | null {
  if (!isValidState(state)) return null;
  const payload: ManagedNameState = {
    version: MANAGED_NAME_SCHEMA_VERSION,
    status: state.status,
    templateRaw: state.templateRaw,
    currentH1: state.currentH1,
    documentKey: state.documentKey,
  };
  return JSON.stringify(payload);
}

export function parse(raw: string | undefined | null): ManagedNameState | null {
  if (raw === undefined || raw === null || raw === '') return null;

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isValidState(candidate)) return null;

  return {
    version: MANAGED_NAME_SCHEMA_VERSION,
    status: candidate.status,
    templateRaw: candidate.templateRaw,
    currentH1: candidate.currentH1,
    documentKey: candidate.documentKey,
  };
}
