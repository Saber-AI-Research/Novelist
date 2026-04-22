import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promptGoToLine } from '$lib/utils/go-to-line';

/**
 * [precision] go-to-line — tiny browser prompt wrapper that jumps to a
 * 1-based line. Covers the three "skip" paths (cancel, empty, non-positive)
 * and the happy-path jump.
 */

const originalPrompt = globalThis.prompt;
let promptFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  promptFn = vi.fn();
  globalThis.prompt = promptFn as unknown as typeof globalThis.prompt;
});

afterEach(() => {
  globalThis.prompt = originalPrompt;
});

describe('[precision] promptGoToLine', () => {
  it('jumps to the parsed line when input is a positive integer', () => {
    promptFn.mockReturnValue('42');
    const jump = vi.fn();
    promptGoToLine('Go to line:', jump);
    expect(jump).toHaveBeenCalledWith(42);
  });

  it('skips when the user cancels (null)', () => {
    promptFn.mockReturnValue(null);
    const jump = vi.fn();
    promptGoToLine('Go to line:', jump);
    expect(jump).not.toHaveBeenCalled();
  });

  it('skips when the input is empty', () => {
    promptFn.mockReturnValue('');
    const jump = vi.fn();
    promptGoToLine('Go to line:', jump);
    expect(jump).not.toHaveBeenCalled();
  });

  it('skips when the input is not a number', () => {
    promptFn.mockReturnValue('abc');
    const jump = vi.fn();
    promptGoToLine('Go to line:', jump);
    expect(jump).not.toHaveBeenCalled();
  });

  it('skips when the input is zero or negative', () => {
    promptFn.mockReturnValue('0');
    const jump = vi.fn();
    promptGoToLine('Go to line:', jump);
    expect(jump).not.toHaveBeenCalled();

    promptFn.mockReturnValue('-3');
    promptGoToLine('Go to line:', jump);
    expect(jump).not.toHaveBeenCalled();
  });

  it('truncates leading numeric parts of mixed input (parseInt semantics)', () => {
    promptFn.mockReturnValue('12abc');
    const jump = vi.fn();
    promptGoToLine('Go to line:', jump);
    expect(jump).toHaveBeenCalledWith(12);
  });

  it('passes the prompt label through to window.prompt', () => {
    promptFn.mockReturnValue('1');
    promptGoToLine('Enter a line number:', vi.fn());
    expect(promptFn).toHaveBeenCalledWith('Enter a line number:');
  });
});
