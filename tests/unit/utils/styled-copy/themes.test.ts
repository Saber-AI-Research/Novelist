import { describe, expect, it } from 'vitest';
import {
  PUBLICATION_STYLE_PROPERTIES,
  PUBLICATION_STYLE_ROLES,
  WECHAT_STYLE_MAPS,
  ZHIHU_STYLE_MAP,
  type PublicationStyleMap,
} from '$lib/utils/styled-copy/themes';

const ALL_STYLE_MAPS: PublicationStyleMap[] = [
  WECHAT_STYLE_MAPS.minimal,
  WECHAT_STYLE_MAPS.magazine,
  WECHAT_STYLE_MAPS.technical,
  ZHIHU_STYLE_MAP,
];

describe('[precision] styled-copy publication style maps', () => {
  it('defines every semantic role for all three WeChat themes and fixed Zhihu', () => {
    for (const styleMap of ALL_STYLE_MAPS) {
      expect(Object.keys(styleMap)).toEqual(PUBLICATION_STYLE_ROLES);
    }
  });

  it('uses the required original white-base palettes', () => {
    expect(WECHAT_STYLE_MAPS.minimal.article).toMatchObject({
      'background-color': '#ffffff',
      color: '#1f2328',
    });
    expect(JSON.stringify(WECHAT_STYLE_MAPS.minimal)).toContain('#2f6f5e');

    expect(WECHAT_STYLE_MAPS.magazine.article).toMatchObject({
      'background-color': '#ffffff',
      color: '#222222',
    });
    expect(JSON.stringify(WECHAT_STYLE_MAPS.magazine)).toContain('#9f3434');
    expect(JSON.stringify(WECHAT_STYLE_MAPS.magazine)).toContain('#9a7b3f');

    expect(WECHAT_STYLE_MAPS.technical.article).toMatchObject({
      'background-color': '#ffffff',
      color: '#20252b',
    });
    expect(JSON.stringify(WECHAT_STYLE_MAPS.technical)).toContain('#2563eb');
    expect(JSON.stringify(WECHAT_STYLE_MAPS.technical)).toContain('#0f766e');

    expect(ZHIHU_STYLE_MAP.article).toMatchObject({
      'background-color': '#ffffff',
      color: '#202124',
    });
    expect(JSON.stringify(ZHIHU_STYLE_MAP)).toContain('#245ea8');
  });

  it('contains only typed properties and rejects forbidden CSS forms by construction', () => {
    const allowedProperties = new Set<string>(PUBLICATION_STYLE_PROPERTIES);

    for (const styleMap of ALL_STYLE_MAPS) {
      for (const role of PUBLICATION_STYLE_ROLES) {
        for (const [property, value] of Object.entries(styleMap[role])) {
          expect(allowedProperties.has(property)).toBe(true);
          expect(value).not.toMatch(/gradient|url\s*\(|var\s*\(|expression\s*\(|!important|\\|[\u0000-\u001f\u007f]/i);
          expect(property).not.toMatch(/^(?:position|z-index|top|right|bottom|left|letter-spacing|background-image)$/);
          expect(value).not.toMatch(/^-\d/);
        }
      }
    }
  });

  it('keeps publication styles independent from classes, fonts, and external CSS', () => {
    const serialized = JSON.stringify(ALL_STYLE_MAPS);

    for (const forbidden of ['class', '@font-face', 'font-family', 'stylesheet', '--']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
