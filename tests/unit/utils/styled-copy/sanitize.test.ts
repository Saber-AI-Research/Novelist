import { describe, expect, it } from 'vitest';
import sanitizerAttacksRaw from '../../../fixtures/styled-copy/sanitizer-attacks.json?raw';
import {
  ALLOWED_FINAL_ATTRIBUTES,
  ALLOWED_FINAL_TAGS,
  applyPublicationStyle,
  sanitizeGeneratedDom,
  serializeSanitizedDomToHtml,
} from '$lib/utils/styled-copy/sanitize';
import { WECHAT_STYLE_MAPS } from '$lib/utils/styled-copy/themes';

interface StyleAttack {
  property: string;
  value: string;
}

const STYLE_ATTACKS = JSON.parse(sanitizerAttacksRaw) as StyleAttack[];

function fragmentWith(...children: Node[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(...children);
  return fragment;
}

function element(tag: string, text?: string): Element {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
}

function expectSanitizerFailure(
  root: DocumentFragment | Element,
  reason: string,
  mode: 'final' | 'preview' = 'final',
): void {
  expect(sanitizeGeneratedDom(root, mode)).toEqual({
    kind: 'error',
    error: { code: 'sanitizer_failure', reason },
  });
}

describe('[contract] styled-copy generated DOM sanitizer', () => {
  it('reconstructs an independent allowlisted DOM with canonical inline styles', () => {
    const source = element('section');
    applyPublicationStyle(source, WECHAT_STYLE_MAPS.minimal.article);
    const paragraph = element('p', '安全正文');
    applyPublicationStyle(paragraph, WECHAT_STYLE_MAPS.minimal.paragraph);
    const anchor = element('a', '资料');
    anchor.setAttribute('href', 'https://example.com/文章');
    anchor.setAttribute('title', '外部资料');
    applyPublicationStyle(anchor, WECHAT_STYLE_MAPS.minimal.link);
    paragraph.append(anchor);
    source.append(paragraph);

    const result = sanitizeGeneratedDom(source, 'final');

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.root).not.toBe(source);
    expect(result.value.root.firstChild).not.toBe(source.firstChild);
    expect(serializeSanitizedDomToHtml(result.value)).toBe(
      '<section style="background-color:#ffffff;color:#1f2328;font-size:16px;line-height:1.75;max-width:100%;overflow-wrap:break-word;word-break:break-word"><p style="margin:0 0 16px">安全正文<a style="color:#2f6f5e;text-decoration:underline" href="https://example.com/文章" title="外部资料">资料</a></p></section>',
    );
  });

  it.each(['script', 'style', 'svg', 'iframe', 'object', 'form', 'video'])(
    'rejects the disallowed <%s> element instead of preserving its subtree',
    (tag) => {
      const section = element('section');
      section.append(element(tag, 'DROP'));

      expectSanitizerFailure(section, 'disallowed_tag');
    },
  );

  it.each(['class', 'id', 'data-source', 'onclick', 'onerror', 'srcset', 'role'])(
    'rejects source metadata attribute %s',
    (attribute) => {
      const paragraph = element('p', '正文');
      paragraph.setAttribute(attribute, 'source-value');

      expectSanitizerFailure(paragraph, 'disallowed_attribute');
    },
  );

  it.each(STYLE_ATTACKS)(
    'rejects generated style bypass $property:$value',
    ({ property, value }) => {
      const paragraph = element('p', '正文');
      paragraph.setAttribute('style', `${property}:${value}`);

      expectSanitizerFailure(paragraph, 'unsafe_style');
    },
  );

  it.each([
    'javascript:alert(1)',
    'data:text/html,bad',
    'blob:https://example.com/id',
    'file:///tmp/private',
    '/relative',
    '//protocol.example/path',
    '#internal',
  ])('rejects non-HTTP(S) final anchor %s', (href) => {
    const anchor = element('a', '链接');
    anchor.setAttribute('href', href);

    expectSanitizerFailure(anchor, 'unsafe_anchor_url');
  });

  it.each([
    'http://cdn.example.com/image.png',
    'data:image/png;base64,AAAA',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'blob:https://example.com/id',
    'file:///tmp/image.png',
  ])('rejects non-HTTPS final image %s', (src) => {
    const image = element('img');
    image.setAttribute('src', src);
    image.setAttribute('alt', '图片');

    expectSanitizerFailure(image, 'unsafe_image_url');
  });

  it('allows branded preview data/blob images only in preview mode', () => {
    for (const src of [
      'data:image/png;base64,AAAA',
      'blob:https://example.com/00000000-0000-0000-0000-000000000000',
    ]) {
      const image = element('img');
      image.setAttribute('src', src);
      image.setAttribute('alt', '预览图');

      expect(sanitizeGeneratedDom(image, 'preview').kind).toBe('ok');
      expectSanitizerFailure(image, 'unsafe_image_url', 'final');
    }
  });

  it('serializes only the explicit final tag and attribute allowlists', () => {
    const section = element('section');
    const table = element('table');
    const body = element('tbody');
    const row = element('tr');
    const cell = element('td', '跨列');
    cell.setAttribute('colspan', '2');
    cell.setAttribute('rowspan', '3');
    row.append(cell);
    body.append(row);
    table.append(body);
    const image = element('img');
    image.setAttribute('src', 'https://cdn.example.com/image.png');
    image.setAttribute('alt', '安全图');
    section.append(table, image, element('br'), element('hr'));

    const result = sanitizeGeneratedDom(fragmentWith(section), 'final');

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const html = serializeSanitizedDomToHtml(result.value);
    const parsed = document.createElement('template');
    parsed.innerHTML = html;
    for (const outputElement of Array.from(parsed.content.querySelectorAll('*'))) {
      expect(ALLOWED_FINAL_TAGS).toContain(outputElement.tagName.toLowerCase());
      for (const attribute of Array.from(outputElement.attributes)) {
        expect(ALLOWED_FINAL_ATTRIBUTES).toContain(attribute.name);
      }
    }
    expect(html).toContain('colspan="2" rowspan="3"');
  });
});
