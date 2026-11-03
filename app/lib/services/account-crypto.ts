export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type EncryptedEnvelope = { version: 1; iv: string; ciphertext: string };
const MAX_CLOUD_PLAINTEXT_BYTES = 380_000;
const MAX_LOCAL_PLAINTEXT_BYTES = 4 * 1024 * 1024;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decode(value: string, max: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid_envelope');
  const binary = atob(value);
  if (binary.length > max) throw new Error('invalid_envelope');
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function generateRecoveryKey(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32)));
}

export function validateRecoveryKey(value: string): void {
  try {
    if (decode(value, 32).length === 32) return;
  } catch { /* Invalid base64 is an invalid recovery key at this boundary. */ }
  throw new Error('invalid_recovery_key');
}

async function importKey(value: string): Promise<CryptoKey> {
  validateRecoveryKey(value);
  const bytes = decode(value, 32);
  try {
    return await crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    bytes.fill(0);
  }
}

/** Service, account and purpose are authenticated; local backups cannot become cloud documents. */
function associatedData(endpoint: string, userId: string, purpose: 'cloud' | 'local'): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['novelist-config', 1, endpoint, userId, purpose]));
}

export async function encryptConfiguration(value: unknown, key: string, endpoint: string, userId: string, purpose: 'cloud' | 'local'): Promise<EncryptedEnvelope> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > (purpose === 'cloud' ? MAX_CLOUD_PLAINTEXT_BYTES : MAX_LOCAL_PLAINTEXT_BYTES)) throw new Error('configuration_too_large');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: associatedData(endpoint, userId, purpose) as BufferSource }, await importKey(key), bytes);
    return { version: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
  } finally {
    bytes.fill(0);
  }
}

export async function decryptConfiguration(envelope: EncryptedEnvelope, key: string, endpoint: string, userId: string, purpose: 'cloud' | 'local'): Promise<unknown> {
  if (!envelope || envelope.version !== 1) throw new Error('unsupported_schema');
  const iv = decode(envelope.iv, 12);
  const ciphertext = decode(envelope.ciphertext, purpose === 'cloud' ? 524_288 : MAX_LOCAL_PLAINTEXT_BYTES + 16);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('invalid_envelope');
  let clear: Uint8Array;
  try {
    clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: associatedData(endpoint, userId, purpose) as BufferSource }, await importKey(key), ciphertext as BufferSource));
  } catch {
    throw new Error('decryption_failed');
  }
  try {
    if (clear.length > (purpose === 'cloud' ? MAX_CLOUD_PLAINTEXT_BYTES : MAX_LOCAL_PLAINTEXT_BYTES)) throw new Error('configuration_too_large');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear));
  } finally {
    clear.fill(0);
  }
}
