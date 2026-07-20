import { describe, it, expect } from 'vitest';
import {
  MANAGED_NAME_SCHEMA_VERSION,
  hasCanonicalTitleToken,
  isValidOpaqueDocumentKey,
  enableManaged,
  detach,
  reEnable,
  migratePath,
  updateAnchor,
  serialize,
  parse,
  type ManagedNameState,
} from '$lib/utils/managed-name';

/**
 * Task 2 contract — persistent managed auto-name state.
 *
 * See `.sisyphus/plans/stability-editor-publish-workflows.md` "2. Define
 * persistent managed auto-name state" and
 * `docs/superpowers/specs/2026-05-12-h1-filename-ongoing-sync-design.md`.
 *
 * This module is pure — no Svelte, no IPC, no filesystem, no reactive state.
 * Task 8 will call `migratePath` from the rename lifecycle, Task 9 will read
 * `status` from `tryRenameAfterSave` and expose detach/re-enable in the
 * Sidebar. Nothing here writes to disk itself; it only shapes the payload
 * that lifecycle code will atomically persist via Task 1's sidecar module.
 */

const CJK_TEMPLATE = '第{N}章-{title}';
const CJK_KEY = 'chapters%2F%E7%AC%AC%E4%B8%80%E7%AB%A0.md';
const CJK_H1 = '开篇';

describe('[precision] MANAGED_NAME_SCHEMA_VERSION', () => {
  it('is a stable numeric constant starting at 1', () => {
    expect(MANAGED_NAME_SCHEMA_VERSION).toBe(1);
  });
});

describe('[precision] hasCanonicalTitleToken', () => {
  it('accepts the exact `{title}` token, case-sensitive', () => {
    expect(hasCanonicalTitleToken('{title}')).toBe(true);
    expect(hasCanonicalTitleToken('第{N}章-{title}')).toBe(true);
    expect(hasCanonicalTitleToken('draft-{title}')).toBe(true);
  });

  it('rejects title-token typos (case and spelling variants)', () => {
    expect(hasCanonicalTitleToken('{Title}')).toBe(false);
    expect(hasCanonicalTitleToken('{TITLE}')).toBe(false);
    expect(hasCanonicalTitleToken('{tile}')).toBe(false);
    expect(hasCanonicalTitleToken('{titel}')).toBe(false);
    expect(hasCanonicalTitleToken('{ title }')).toBe(false);
    expect(hasCanonicalTitleToken('{title }')).toBe(false);
    expect(hasCanonicalTitleToken('{ title}')).toBe(false);
    expect(hasCanonicalTitleToken('{Title}-{N}')).toBe(false);
  });

  it('rejects templates that have no title slot at all', () => {
    expect(hasCanonicalTitleToken('第{N}章')).toBe(false);
    expect(hasCanonicalTitleToken('Chapter {N}')).toBe(false);
    expect(hasCanonicalTitleToken('Untitled {N}')).toBe(false);
    expect(hasCanonicalTitleToken('')).toBe(false);
    expect(hasCanonicalTitleToken('no slot here at all')).toBe(false);
  });
});

describe('[precision] enableManaged', () => {
  it('returns null when the template does not contain canonical `{title}`', () => {
    expect(enableManaged('第{N}章', 'k.md', '')).toBeNull();
    expect(enableManaged('Chapter {N}', 'k.md', '')).toBeNull();
    expect(enableManaged('', 'k.md', '')).toBeNull();
  });

  it('returns null for typo/case variants of the title token', () => {
    expect(enableManaged('{Title}', 'k.md', '')).toBeNull();
    expect(enableManaged('{TITLE}', 'k.md', '')).toBeNull();
    expect(enableManaged('{tile}', 'k.md', '')).toBeNull();
    expect(enableManaged('{ title }', 'k.md', '')).toBeNull();
  });

  it('creates a managed v1 state when template contains canonical `{title}`', () => {
    const s = enableManaged('第{N}章-{title}', 'k.md', '');
    expect(s).toEqual({
      version: 1,
      status: 'managed',
      templateRaw: '第{N}章-{title}',
      currentH1: '',
      documentKey: 'k.md',
    });
  });

  it('preserves the raw template string verbatim (no normalization)', () => {
    const raw = '  第{N}章--{title}  ';
    const s = enableManaged(raw, 'k.md', '');
    expect(s?.templateRaw).toBe(raw);
  });

  it('preserves CJK H1 exactly', () => {
    const s = enableManaged(CJK_TEMPLATE, CJK_KEY, CJK_H1);
    expect(s?.currentH1).toBe(CJK_H1);
  });

  it('preserves the opaque documentKey verbatim (no re-encoding)', () => {
    // Task 1's document_key output is percent-encoded already. The state
    // module MUST treat it as opaque text and never re-encode / decode it.
    const s = enableManaged(CJK_TEMPLATE, CJK_KEY, '');
    expect(s?.documentKey).toBe(CJK_KEY);
  });

  it('accepts a title-only template', () => {
    const s = enableManaged('{title}', 'k.md', '');
    expect(s?.status).toBe('managed');
    expect(s?.templateRaw).toBe('{title}');
  });
});

describe('[precision] detach', () => {
  it('flips managed -> detached and preserves every other field', () => {
    const managed = enableManaged(CJK_TEMPLATE, CJK_KEY, CJK_H1)!;
    const detached = detach(managed);
    expect(detached).toEqual({
      version: 1,
      status: 'detached',
      templateRaw: CJK_TEMPLATE,
      currentH1: CJK_H1,
      documentKey: CJK_KEY,
    });
  });

  it('is idempotent when the state is already detached', () => {
    const managed = enableManaged(CJK_TEMPLATE, CJK_KEY, CJK_H1)!;
    const once = detach(managed);
    const twice = detach(once);
    expect(twice).toEqual(once);
  });

  it('returns a new object (does not mutate input)', () => {
    const managed = enableManaged(CJK_TEMPLATE, CJK_KEY, CJK_H1)!;
    const detached = detach(managed);
    expect(managed.status).toBe('managed');
    expect(detached).not.toBe(managed);
  });
});

describe('[precision] reEnable', () => {
  it('flips detached -> managed and preserves every other field', () => {
    const managed = enableManaged(CJK_TEMPLATE, CJK_KEY, CJK_H1)!;
    const detached = detach(managed);
    const revived = reEnable(detached);
    expect(revived).toEqual({
      version: 1,
      status: 'managed',
      templateRaw: CJK_TEMPLATE,
      currentH1: CJK_H1,
      documentKey: CJK_KEY,
    });
  });

  it('is idempotent when the state is already managed', () => {
    const managed = enableManaged(CJK_TEMPLATE, CJK_KEY, CJK_H1)!;
    const revived = reEnable(managed);
    expect(revived).toEqual(managed);
  });

  it('returns a new object (does not mutate input)', () => {
    const managed = enableManaged(CJK_TEMPLATE, CJK_KEY, CJK_H1)!;
    const detached = detach(managed);
    const revived = reEnable(detached);
    expect(detached.status).toBe('detached');
    expect(revived).not.toBe(detached);
  });
});

describe('[precision] migratePath', () => {
  it('replaces documentKey and preserves status/templateRaw/currentH1', () => {
    const before = enableManaged(CJK_TEMPLATE, 'old.md', '开篇')!;
    const after = migratePath(before, 'new.md');
    expect(after).toEqual({
      version: 1,
      status: 'managed',
      templateRaw: CJK_TEMPLATE,
      currentH1: '开篇',
      documentKey: 'new.md',
    });
  });

  it('preserves the detached status through migration (never re-enables)', () => {
    const managed = enableManaged(CJK_TEMPLATE, 'old.md', '开篇')!;
    const detached = detach(managed);
    const migrated = migratePath(detached, 'new.md')!;
    expect(migrated.status).toBe('detached');
    expect(migrated.documentKey).toBe('new.md');
  });

  it('accepts opaque percent-encoded keys and does not re-encode them', () => {
    const before = enableManaged(CJK_TEMPLATE, 'old.md', '')!;
    const after = migratePath(before, CJK_KEY)!;
    expect(after.documentKey).toBe(CJK_KEY);
  });

  it('returns a new object (does not mutate input)', () => {
    const before = enableManaged(CJK_TEMPLATE, 'old.md', '')!;
    const after = migratePath(before, 'new.md');
    expect(before.documentKey).toBe('old.md');
    expect(after).not.toBe(before);
  });

  it('a no-op path migration returns an equivalent state', () => {
    const before = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const after = migratePath(before, CJK_KEY);
    expect(after).toEqual(before);
  });
});

describe('[precision] updateAnchor', () => {
  it('replaces currentH1 and preserves other fields', () => {
    const before = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const after = updateAnchor(before, '序幕');
    expect(after).toEqual({
      version: 1,
      status: 'managed',
      templateRaw: CJK_TEMPLATE,
      currentH1: '序幕',
      documentKey: CJK_KEY,
    });
  });

  it('accepts an empty anchor', () => {
    const before = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const after = updateAnchor(before, '');
    expect(after.currentH1).toBe('');
  });

  it('preserves the detached status when updating the anchor', () => {
    const managed = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const detached = detach(managed);
    const after = updateAnchor(detached, '序幕');
    expect(after.status).toBe('detached');
    expect(after.currentH1).toBe('序幕');
  });

  it('preserves CJK anchors exactly (no normalization)', () => {
    const before = enableManaged(CJK_TEMPLATE, CJK_KEY, '')!;
    const after = updateAnchor(before, '开篇');
    expect(after.currentH1).toBe('开篇');
  });

  it('returns a new object (does not mutate input)', () => {
    const before = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const after = updateAnchor(before, '序幕');
    expect(before.currentH1).toBe('开篇');
    expect(after).not.toBe(before);
  });
});

describe('[precision] serialize / parse round-trip', () => {
  it('managed state round-trips exactly', () => {
    const before = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const restored = parse(serialize(before));
    expect(restored).toEqual(before);
  });

  it('detached state round-trips exactly', () => {
    const managed = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const detached = detach(managed);
    const restored = parse(serialize(detached));
    expect(restored).toEqual(detached);
  });

  it('preserves CJK template, anchor, and path key across a round-trip', () => {
    const before = enableManaged('第{N}章-{title}', CJK_KEY, '开篇')!;
    const restored = parse(serialize(before));
    expect(restored?.templateRaw).toBe('第{N}章-{title}');
    expect(restored?.currentH1).toBe('开篇');
    expect(restored?.documentKey).toBe(CJK_KEY);
  });

  it('serialize output is valid JSON with a stable version tag', () => {
    const before = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const raw = serialize(before);
    expect(raw).not.toBeNull();
    const asObject = JSON.parse(raw!);
    expect(asObject.version).toBe(1);
    expect(asObject.status).toBe('managed');
  });

  it('serialize preserves empty currentH1', () => {
    const before = enableManaged(CJK_TEMPLATE, CJK_KEY, '')!;
    const restored = parse(serialize(before));
    expect(restored?.currentH1).toBe('');
  });
});

describe('[precision] parse — safe fallback', () => {
  it('returns null for malformed JSON', () => {
    expect(parse('{not-json')).toBeNull();
    expect(parse('garbage')).toBeNull();
  });

  it('returns null for unknown / future / regressed schema versions', () => {
    const base = {
      status: 'managed',
      templateRaw: '{title}',
      currentH1: '',
      documentKey: 'k.md',
    };
    expect(parse(JSON.stringify({ ...base, version: 0 }))).toBeNull();
    expect(parse(JSON.stringify({ ...base, version: 2 }))).toBeNull();
    expect(parse(JSON.stringify({ ...base, version: 99 }))).toBeNull();
    expect(parse(JSON.stringify({ ...base, version: '1' }))).toBeNull();
    expect(parse(JSON.stringify({ ...base }))).toBeNull(); // missing version
  });

  it('returns null when required fields are missing', () => {
    const base = {
      version: 1,
      status: 'managed',
      templateRaw: '{title}',
      currentH1: '',
      documentKey: 'k.md',
    };
    for (const missing of ['status', 'templateRaw', 'currentH1', 'documentKey'] as const) {
      const { [missing]: _dropped, ...rest } = base;
      void _dropped;
      expect(parse(JSON.stringify(rest))).toBeNull();
    }
  });

  it('returns null for unknown status values', () => {
    const base = {
      version: 1,
      templateRaw: '{title}',
      currentH1: '',
      documentKey: 'k.md',
    };
    expect(parse(JSON.stringify({ ...base, status: 'active' }))).toBeNull();
    expect(parse(JSON.stringify({ ...base, status: 'pending' }))).toBeNull();
    expect(parse(JSON.stringify({ ...base, status: '' }))).toBeNull();
    expect(parse(JSON.stringify({ ...base, status: null }))).toBeNull();
  });

  it('returns null when field types are wrong', () => {
    const base = {
      version: 1,
      status: 'managed',
      templateRaw: '{title}',
      currentH1: '',
      documentKey: 'k.md',
    };
    expect(parse(JSON.stringify({ ...base, templateRaw: 42 }))).toBeNull();
    expect(parse(JSON.stringify({ ...base, currentH1: null }))).toBeNull();
    expect(parse(JSON.stringify({ ...base, documentKey: false }))).toBeNull();
  });

  it('returns null for non-object shapes (array, string, number, null)', () => {
    expect(parse(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parse(JSON.stringify('a string'))).toBeNull();
    expect(parse(JSON.stringify(42))).toBeNull();
    expect(parse(JSON.stringify(null))).toBeNull();
  });

  it('returns null for empty / null / undefined input', () => {
    expect(parse('')).toBeNull();
    expect(parse(undefined)).toBeNull();
    expect(parse(null)).toBeNull();
  });
});

describe('[contract] managed restart end-to-end (serialize -> parse -> migrate -> parse)', () => {
  it('preserves managed state through a full restart + path migration', () => {
    // Step 1: user creates a `{title}` file, edits H1 to `开篇`.
    const created = enableManaged('{title}', 'old-path.md', '开篇')!;
    expect(created.status).toBe('managed');

    // Step 2: state is persisted (serialize) at Cmd+S.
    const serialized = serialize(created);

    // Step 3: app restart -> parse the persisted state back.
    const rehydrated = parse(serialized);
    expect(rehydrated).toEqual(created);

    // Step 4: user manually renames the file. Task 8 calls migratePath with
    // the new opaque document key. Managed status MUST survive.
    const migrated = migratePath(rehydrated!, 'chapter-one.md')!;
    expect(migrated.status).toBe('managed');
    expect(migrated.documentKey).toBe('chapter-one.md');
    expect(migrated.currentH1).toBe('开篇');
    expect(migrated.templateRaw).toBe('{title}');

    // Step 5: persist again and reload — round-trip must still be exact.
    const serialized2 = serialize(migrated);
    const finalState = parse(serialized2);
    expect(finalState).toEqual(migrated);
  });

  it('preserves an explicit detach through a full restart cycle', () => {
    // User created a managed file, then chose "Stop Auto Naming" (Task 9 UI).
    const managed = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const detached = detach(managed);

    // Persist, restart, parse.
    const restored = parse(serialize(detached));
    expect(restored?.status).toBe('detached');

    // Even after a path migration, the detach is sticky.
    const migrated = migratePath(restored!, 'new-key.md')!;
    expect(migrated.status).toBe('detached');
  });
});

describe('[contract] unmanaged files produce no persisted state', () => {
  it('enableManaged on a non-`{title}` template returns null and yields no serialization', () => {
    // Ordinary files opened from disk without a `{title}` template — the
    // caller sees `null` from enableManaged and simply omits the state entry.
    const stateForOrdinary = enableManaged('Chapter {N}', 'notes.md', '');
    expect(stateForOrdinary).toBeNull();

    // Simulate the "read what caller persisted" step: nothing was written
    // for this document, so the persistence layer would call parse(undefined).
    // The safe-fallback contract makes that resolve to null, i.e. "not
    // managed" — indistinguishable from a fresh install of the app.
    const rehydrated = parse(undefined);
    expect(rehydrated).toBeNull();
  });

  it('a template with a typo like `{Title}` never activates management', () => {
    expect(enableManaged('{Title}', 'notes.md', '开篇')).toBeNull();
    expect(enableManaged('第{N}章-{Title}', 'notes.md', '')).toBeNull();
    // Confirm no partial state leaked out into the parse pipeline either.
    expect(parse(undefined)).toBeNull();
  });

  it('a user changing H1 on an ordinary file does not synthesize managed state', () => {
    // Simulates the tabs-store flow: `tryRenameAfterSave` observes an H1
    // change, but the file was never enrolled — it has no state entry, so
    // the pure module cannot manufacture one from just the H1.
    const noState = parse(undefined);
    expect(noState).toBeNull();
    // If a caller tried updateAnchor / migratePath / detach on nothing, the
    // type system would reject it. The intent here is: null in, null out.
    expect(parse('')).toBeNull();
  });
});

describe('[contract] enableManaged output shape is stable for downstream consumers', () => {
  it('the returned object is a plain data ManagedNameState (no extra keys)', () => {
    const s = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const keys = Object.keys(s).sort();
    expect(keys).toEqual([
      'currentH1',
      'documentKey',
      'status',
      'templateRaw',
      'version',
    ]);
  });

  it('assigning a ManagedNameState to the exported type compiles', () => {
    // Type-only test — a mismatch here fails `pnpm check`, not vitest.
    const s: ManagedNameState = enableManaged(CJK_TEMPLATE, CJK_KEY, '')!;
    expect(s.version).toBe(1);
  });
});

describe('[precision] isValidOpaqueDocumentKey', () => {
  it('accepts non-empty non-whitespace strings verbatim', () => {
    expect(isValidOpaqueDocumentKey('k.md')).toBe(true);
    expect(isValidOpaqueDocumentKey(CJK_KEY)).toBe(true);
    expect(isValidOpaqueDocumentKey('a')).toBe(true);
    expect(isValidOpaqueDocumentKey('第一章.md')).toBe(true);
  });

  it('rejects empty / whitespace-only strings', () => {
    expect(isValidOpaqueDocumentKey('')).toBe(false);
    expect(isValidOpaqueDocumentKey(' ')).toBe(false);
    expect(isValidOpaqueDocumentKey('\t')).toBe(false);
    expect(isValidOpaqueDocumentKey('\n\r  \t')).toBe(false);
  });

  it('rejects non-string values (defensive against runtime type breakage)', () => {
    expect(isValidOpaqueDocumentKey(undefined)).toBe(false);
    expect(isValidOpaqueDocumentKey(null)).toBe(false);
    expect(isValidOpaqueDocumentKey(0)).toBe(false);
    expect(isValidOpaqueDocumentKey(42)).toBe(false);
    expect(isValidOpaqueDocumentKey(false)).toBe(false);
    expect(isValidOpaqueDocumentKey({})).toBe(false);
    expect(isValidOpaqueDocumentKey([])).toBe(false);
  });
});

describe('[precision] enableManaged — opaque documentKey validation', () => {
  it('returns null when documentKey is an empty string', () => {
    expect(enableManaged(CJK_TEMPLATE, '', '')).toBeNull();
  });

  it('returns null when documentKey is whitespace-only', () => {
    expect(enableManaged(CJK_TEMPLATE, '   ', '')).toBeNull();
    expect(enableManaged(CJK_TEMPLATE, '\t\n', '')).toBeNull();
  });

  it('accepts CJK opaque keys and preserves them byte-for-byte', () => {
    const state = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    expect(state.documentKey).toBe(CJK_KEY);
  });

  it('does not decode / re-encode a percent-encoded Task-1 key', () => {
    const encoded = 'a%2Fb%252Fc.md';
    const state = enableManaged(CJK_TEMPLATE, encoded, '')!;
    expect(state.documentKey).toBe(encoded);
  });
});

describe('[precision] migratePath — opaque documentKey validation', () => {
  it('returns null when newDocumentKey is an empty string', () => {
    const state = enableManaged(CJK_TEMPLATE, 'old.md', '')!;
    expect(migratePath(state, '')).toBeNull();
  });

  it('returns null when newDocumentKey is whitespace-only', () => {
    const state = enableManaged(CJK_TEMPLATE, 'old.md', '')!;
    expect(migratePath(state, '   ')).toBeNull();
    expect(migratePath(state, '\t\n')).toBeNull();
  });

  it('a rejected migration does not mutate the input state', () => {
    const before = enableManaged(CJK_TEMPLATE, 'old.md', '开篇')!;
    const result = migratePath(before, '');
    expect(result).toBeNull();
    expect(before.documentKey).toBe('old.md');
    expect(before.currentH1).toBe('开篇');
    expect(before.status).toBe('managed');
  });

  it('preserves CJK newDocumentKey verbatim', () => {
    const before = enableManaged(CJK_TEMPLATE, 'old.md', '')!;
    const after = migratePath(before, CJK_KEY)!;
    expect(after.documentKey).toBe(CJK_KEY);
  });
});

describe('[precision] parse — rejects corrupted or forged state', () => {
  it('rejects a managed state whose templateRaw lacks canonical `{title}`', () => {
    const forged = {
      version: 1,
      status: 'managed',
      templateRaw: 'Chapter {N}',
      currentH1: '',
      documentKey: 'k.md',
    };
    expect(parse(JSON.stringify(forged))).toBeNull();
  });

  it('rejects a detached state whose templateRaw lacks canonical `{title}`', () => {
    // A detached state must still originate from a valid `{title}` template —
    // otherwise a caller could plant a detached record on any file to
    // suppress future auto-naming without ever enrolling it first.
    const forged = {
      version: 1,
      status: 'detached',
      templateRaw: 'Chapter {N}',
      currentH1: '',
      documentKey: 'k.md',
    };
    expect(parse(JSON.stringify(forged))).toBeNull();
  });

  it('rejects a state whose templateRaw has a `{Title}` typo instead of `{title}`', () => {
    const forged = {
      version: 1,
      status: 'managed',
      templateRaw: '{Title}',
      currentH1: '',
      documentKey: 'k.md',
    };
    expect(parse(JSON.stringify(forged))).toBeNull();
  });

  it('rejects a state with an empty templateRaw', () => {
    const forged = {
      version: 1,
      status: 'managed',
      templateRaw: '',
      currentH1: '',
      documentKey: 'k.md',
    };
    expect(parse(JSON.stringify(forged))).toBeNull();
  });

  it('rejects a state with an empty documentKey', () => {
    const forged = {
      version: 1,
      status: 'managed',
      templateRaw: '{title}',
      currentH1: '',
      documentKey: '',
    };
    expect(parse(JSON.stringify(forged))).toBeNull();
  });

  it('rejects a state with a whitespace-only documentKey', () => {
    const forged = {
      version: 1,
      status: 'managed',
      templateRaw: '{title}',
      currentH1: '',
      documentKey: '   ',
    };
    expect(parse(JSON.stringify(forged))).toBeNull();
  });

  it('still accepts a valid managed state after the validators tighten', () => {
    const valid = {
      version: 1,
      status: 'managed',
      templateRaw: '第{N}章-{title}',
      currentH1: '开篇',
      documentKey: CJK_KEY,
    };
    const restored = parse(JSON.stringify(valid));
    expect(restored).toEqual(valid);
  });

  it('still accepts a valid detached state after the validators tighten', () => {
    const valid = {
      version: 1,
      status: 'detached',
      templateRaw: '{title}',
      currentH1: '开篇',
      documentKey: 'chapter-one.md',
    };
    const restored = parse(JSON.stringify(valid));
    expect(restored).toEqual(valid);
  });
});

describe('[precision] serialize — rejects forged runtime input', () => {
  it('returns null when templateRaw lacks canonical `{title}` at runtime', () => {
    const forged = {
      version: 1,
      status: 'managed',
      templateRaw: 'Chapter {N}',
      currentH1: '',
      documentKey: 'k.md',
    } as ManagedNameState;
    expect(serialize(forged)).toBeNull();
  });

  it('returns null when documentKey is empty at runtime', () => {
    const forged = {
      version: 1,
      status: 'managed',
      templateRaw: '{title}',
      currentH1: '',
      documentKey: '',
    } as ManagedNameState;
    expect(serialize(forged)).toBeNull();
  });

  it('returns null when documentKey is whitespace-only at runtime', () => {
    const forged = {
      version: 1,
      status: 'managed',
      templateRaw: '{title}',
      currentH1: '',
      documentKey: '   ',
    } as ManagedNameState;
    expect(serialize(forged)).toBeNull();
  });

  it('returns null when version is not 1 at runtime', () => {
    const forged = {
      version: 2 as unknown as 1,
      status: 'managed',
      templateRaw: '{title}',
      currentH1: '',
      documentKey: 'k.md',
    } as ManagedNameState;
    expect(serialize(forged)).toBeNull();
  });

  it('returns null when status is an unknown string at runtime', () => {
    const forged = {
      version: 1,
      status: 'active' as unknown as ManagedNameState['status'],
      templateRaw: '{title}',
      currentH1: '',
      documentKey: 'k.md',
    } as ManagedNameState;
    expect(serialize(forged)).toBeNull();
  });

  it('returns a JSON string only for a state that survives isValidState', () => {
    const state = enableManaged(CJK_TEMPLATE, CJK_KEY, '开篇')!;
    const raw = serialize(state);
    expect(typeof raw).toBe('string');
    expect(raw).not.toBeNull();
    const restored = parse(raw);
    expect(restored).toEqual(state);
  });
});

describe('[contract] persistence pipeline is closed to forged input', () => {
  it('a forged state cannot be serialized then parsed back as apparently valid JSON', () => {
    // Attacker constructs a runtime object bypassing the module helpers.
    const forged = {
      version: 1,
      status: 'managed',
      templateRaw: 'Chapter {N}',
      currentH1: '',
      documentKey: 'k.md',
    } as ManagedNameState;
    const raw = serialize(forged);
    expect(raw).toBeNull();
    // Even if a caller ignored the null and passed it downstream, parse
    // would reject the forged payload too (see the parse suite above).
  });
});
