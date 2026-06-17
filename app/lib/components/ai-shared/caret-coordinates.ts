/**
 * Pixel coordinates of a <textarea> caret, used to anchor the composer's
 * `/` and `@` popup menus to the typing position.
 *
 * Browsers expose no caret-rect API for <textarea>, so we mirror the
 * textarea into a hidden div, copy its text up to the caret, and measure a
 * marker span. Adapted from the well-worn "textarea-caret-position"
 * technique (component/textarea-caret-position).
 *
 * The returned coordinates are relative to the textarea's border box and
 * already account for the textarea's own scroll offset, so a popup placed at
 * `{ left, top }` inside a wrapper that tightly wraps the textarea lands on
 * the caret.
 */

// CSS properties whose values must match the textarea for the mirror to wrap
// text identically. camelCase keys index CSSStyleDeclaration directly.
const MIRRORED_PROPERTIES = [
  'direction',
  'boxSizing',
  'width',
  'height',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'whiteSpace',
  'wordWrap',
] as const;

export type CaretCoordinates = { top: number; left: number; height: number };

function px(value: string): number {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? 0 : n;
}

export function getCaretCoordinates(
  element: HTMLTextAreaElement,
  position: number,
): CaretCoordinates {
  const doc = element.ownerDocument;
  const win = doc.defaultView ?? window;
  const computed = win.getComputedStyle(element);

  const div = doc.createElement('div');
  const style = div.style;
  style.position = 'absolute';
  style.top = '0';
  style.left = '0';
  style.visibility = 'hidden';
  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';

  for (const prop of MIRRORED_PROPERTIES) {
    style[prop] = computed[prop];
  }
  // The mirror grows with content; a hard height would clip the marker span.
  style.height = 'auto';
  style.overflow = 'hidden';

  div.textContent = element.value.slice(0, position);

  const span = doc.createElement('span');
  // A non-empty span guarantees a measurable box even at end-of-line.
  span.textContent = element.value.slice(position) || '.';
  div.appendChild(span);

  doc.body.appendChild(div);
  const coords: CaretCoordinates = {
    top: span.offsetTop + px(computed.borderTopWidth) - element.scrollTop,
    left: span.offsetLeft + px(computed.borderLeftWidth) - element.scrollLeft,
    height: px(computed.lineHeight) || px(computed.fontSize),
  };
  doc.body.removeChild(div);

  return coords;
}
