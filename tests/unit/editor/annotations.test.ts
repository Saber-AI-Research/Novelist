import { describe, it, expect } from 'vitest';
import { Annotation, EditorState } from '@codemirror/state';
import { remoteChangeAnnotation } from '$lib/editor/annotations';

/**
 * [precision] annotations — the remoteChangeAnnotation token must be a
 * stable Annotation<boolean> usable in CM6 transactions. The key contract
 * is: identity is preserved across imports, and a transaction tagged with
 * it round-trips through `tr.annotation(remoteChangeAnnotation)`.
 */

describe('[precision] remoteChangeAnnotation', () => {
  it('is an Annotation instance', () => {
    // CM6 Annotation factory returns an internal type — checking for the
    // characteristic `.of()` method is the closest portable assertion.
    expect(typeof remoteChangeAnnotation.of).toBe('function');
  });

  it('is distinct from an independently-defined Annotation<boolean>', () => {
    const other = Annotation.define<boolean>();
    expect(remoteChangeAnnotation).not.toBe(other);
  });

  it('round-trips a boolean payload through a transaction', () => {
    const state = EditorState.create({ doc: 'abc' });
    const tr = state.update({
      annotations: remoteChangeAnnotation.of(true),
    });
    expect(tr.annotation(remoteChangeAnnotation)).toBe(true);
  });

  it('yields undefined for a transaction that did not set it', () => {
    const state = EditorState.create({ doc: 'abc' });
    const tr = state.update({});
    expect(tr.annotation(remoteChangeAnnotation)).toBeUndefined();
  });

  it('preserves identity across imports (same module instance)', async () => {
    const a = (await import('$lib/editor/annotations')).remoteChangeAnnotation;
    const b = (await import('$lib/editor/annotations')).remoteChangeAnnotation;
    expect(a).toBe(b);
  });
});
