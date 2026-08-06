import { describe, expect, it } from 'vitest';
import {
  MANAGED_NAME_SCHEMA_VERSION,
  detach,
  enableManaged,
  hasCanonicalTitleToken,
  isValidOpaqueDocumentKey,
  migratePath,
  parse,
  reEnable,
  serialize,
  updateAnchor,
  type ManagedNameState,
} from '$lib/utils/managed-name';

const CJK_TEMPLATE = '第{N}章-{title}';
const CJK_KEY = 'chapters%2F%E7%AC%AC%E4%B8%80%E7%AB%A0.md';

function managedState(overrides: Partial<ManagedNameState> = {}): ManagedNameState {
  return {
    version: MANAGED_NAME_SCHEMA_VERSION,
    status: 'managed',
    templateRaw: CJK_TEMPLATE,
    currentH1: '开篇',
    documentKey: CJK_KEY,
    ...overrides,
  };
}

describe('[precision] managed-name validation and transitions', () => {
  it('recognizes only the canonical case-sensitive title token', () => {
    expect([
      hasCanonicalTitleToken('{title}'),
      hasCanonicalTitleToken(CJK_TEMPLATE),
      hasCanonicalTitleToken('{Title}'),
      hasCanonicalTitleToken('{ title }'),
      hasCanonicalTitleToken('第{N}章'),
      hasCanonicalTitleToken(''),
    ]).toEqual([true, true, false, false, false, false]);
  });

  it('accepts opaque nonblank keys without decoding and rejects other shapes', () => {
    expect([
      isValidOpaqueDocumentKey(CJK_KEY),
      isValidOpaqueDocumentKey('第一章.md'),
      isValidOpaqueDocumentKey(''),
      isValidOpaqueDocumentKey(' \t\n'),
      isValidOpaqueDocumentKey(null),
      isValidOpaqueDocumentKey(42),
    ]).toEqual([true, true, false, false, false, false]);
  });

  it('enrolls a valid CJK document as an exact versioned plain state', () => {
    expect(MANAGED_NAME_SCHEMA_VERSION).toBe(1);
    expect(enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')).toEqual(managedState());
    expect(enableManaged('{title}', 'untitled.md', '')).toEqual({
      version: 1,
      status: 'managed',
      templateRaw: '{title}',
      currentH1: '',
      documentKey: 'untitled.md',
    });
  });

  it('rejects invalid enrollment inputs at each public boundary', () => {
    expect([
      enableManaged('第{N}章', CJK_KEY, ''),
      enableManaged(CJK_TEMPLATE, '  ', ''),
      enableManaged(CJK_TEMPLATE, CJK_KEY, null as unknown as string),
    ]).toEqual([null, null, null]);
  });

  it('detaches and re-enables without mutating the source state', () => {
    const original = managedState();
    const detached = detach(original);
    const restored = reEnable(detached);

    expect(detached).toEqual({ ...original, status: 'detached' });
    expect(restored).toEqual(original);
    expect(detached).not.toBe(original);
    expect(restored).not.toBe(detached);
    expect(original.status).toBe('managed');
  });

  it('migrates opaque paths while preserving a detached state', () => {
    const original = detach(managedState());
    const migrated = migratePath(original, 'new%2F第二章.md');

    expect(migrated).toEqual({
      ...original,
      documentKey: 'new%2F第二章.md',
    });
    expect(original.documentKey).toBe(CJK_KEY);
    expect(migratePath(original, ' \t')).toBeNull();
  });

  it('updates the H1 anchor verbatim while preserving the remaining state', () => {
    const original = detach(managedState());
    const updated = updateAnchor(original, '序幕');

    expect(updated).toEqual({ ...original, currentH1: '序幕' });
    expect(updated).not.toBe(original);
    expect(original.currentH1).toBe('开篇');
  });
});

describe('[precision] managed-name persistence boundary', () => {
  it('round-trips managed and detached CJK states exactly', () => {
    const managed = managedState();
    const detached = detach(managed);

    expect(parse(serialize(managed))).toEqual(managed);
    expect(parse(serialize(detached))).toEqual(detached);
  });

  it('serializes only the stable public payload fields', () => {
    const forgedExtra = { ...managedState(), ignored: 'do not persist' } as ManagedNameState;
    const raw = serialize(forgedExtra);

    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(managedState());
  });

  it('returns null for absent, malformed, and non-record persisted input', () => {
    expect([
      parse(undefined),
      parse(null),
      parse(''),
      parse('{not-json'),
      parse('null'),
      parse('[]'),
      parse('"text"'),
    ]).toEqual([null, null, null, null, null, null, null]);
  });

  it('rejects every invalid persisted-state partition', () => {
    const invalid: unknown[] = [
      { ...managedState(), version: 2 },
      { ...managedState(), status: 'active' },
      { ...managedState(), templateRaw: '第{N}章' },
      { ...managedState(), templateRaw: 42 },
      { ...managedState(), currentH1: null },
      { ...managedState(), documentKey: '' },
      { ...managedState(), documentKey: false },
      { version: 1, status: 'managed', templateRaw: '{title}', currentH1: '' },
    ];

    expect(invalid.map(value => parse(JSON.stringify(value)))).toEqual(
      invalid.map(() => null),
    );
  });

  it('rejects forged runtime states before serialization', () => {
    const invalid = [
      { ...managedState(), version: 2 },
      { ...managedState(), status: 'active' },
      { ...managedState(), templateRaw: 'Chapter {N}' },
      { ...managedState(), currentH1: null },
      { ...managedState(), documentKey: '  ' },
    ] as unknown as ManagedNameState[];

    expect(invalid.map(serialize)).toEqual(invalid.map(() => null));
  });
});
