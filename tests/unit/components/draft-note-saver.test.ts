import { describe, expect, it } from 'vitest';
import { DraftNoteSaver, type DraftTarget } from '$lib/components/draft-note-saver';

function harness() {
  let content: string | null = '';
  let dirty = false;
  const writes: Array<{ target: DraftTarget; content: string }> = [];
  let release: (() => void) | null = null;
  let hold = false;
  const saver = new DraftNoteSaver({
    write(target, text) {
      writes.push({ target, content: text });
      if (!hold) return Promise.resolve();
      const gate = Promise.withResolvers<void>();
      release = gate.resolve;
      return gate.promise;
    },
    getContent: () => content,
    onDirtyChange: (next) => { dirty = next; },
  });
  return {
    saver,
    writes,
    type(text: string) { content = text; saver.markDirty(); },
    unmountEditor() { content = null; },
    holdWrites() { hold = true; },
    release() { hold = false; release?.(); },
    get dirty() { return dirty; },
  };
}

const A: DraftTarget = { projectDir: '/projects/A', filePath: '/projects/A/ch1.md' };

describe('DraftNoteSaver', () => {
  it('flush writes the draft to the project it was loaded from, before a project switch', async () => {
    const h = harness();
    h.saver.setTarget(A);
    h.type('A 的草稿');
    await h.saver.flush();
    expect(h.writes).toEqual([{ target: A, content: 'A 的草稿' }]);
    expect(h.dirty).toBe(false);
  });

  it('a save that runs after the editor unmounts still uses the text and target captured at call time', async () => {
    const h = harness();
    h.saver.setTarget(A);
    h.holdWrites();
    h.type('first');
    const first = h.saver.save();
    h.type('second');
    const second = h.saver.save();
    h.unmountEditor();
    h.saver.setTarget({ projectDir: '/projects/B', filePath: '/projects/B/x.md' });
    h.release();
    await Promise.all([first, second]);
    expect(h.writes).toEqual([
      { target: A, content: 'first' },
      { target: A, content: 'second' },
    ]);
  });

  it('stays dirty when the text changed during the write', async () => {
    const h = harness();
    h.saver.setTarget(A);
    h.holdWrites();
    h.type('v1');
    const pending = h.saver.save();
    h.type('v2');
    h.release();
    await pending;
    expect(h.dirty).toBe(true);
  });

  it('does nothing without a loaded draft', async () => {
    const h = harness();
    h.type('orphan');
    await h.saver.flush();
    expect(h.writes).toEqual([]);
  });
});
