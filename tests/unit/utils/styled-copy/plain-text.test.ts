import { describe, expect, it } from 'vitest';
import finalDomHtmlRaw from '../../../fixtures/styled-copy/final-dom.input.html?raw';
import finalPlainTextRaw from '../../../fixtures/styled-copy/final-dom.plain.txt?raw';
import {
  createFinalSanitizedDom,
  serializeFinalDomToPlainText,
} from '$lib/utils/styled-copy/plain-text';

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function finalFragment(): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = normalizeLineEndings(finalDomHtmlRaw);
  return template.content;
}

describe('[contract] serializeFinalDomToPlainText', () => {
  it('matches the block-aware CJK final-DOM golden exactly', () => {
    const finalDom = createFinalSanitizedDom(finalFragment());

    expect(serializeFinalDomToPlainText(finalDom)).toBe(
      normalizeLineEndings(finalPlainTextRaw),
    );
  });

  it('rejects an unbranded fragment at runtime', () => {
    expect(() => serializeFinalDomToPlainText(finalFragment() as never)).toThrow(
      'Expected a final sanitized DOM root',
    );
  });
});
