import {
  PUBLICATION_STYLE_PROPERTIES,
  PUBLICATION_STYLE_ROLES,
  WECHAT_STYLE_MAPS,
  ZHIHU_STYLE_MAP,
  type PublicationStyleDeclaration,
} from './themes';
import {
  createFinalSanitizedDom,
  type FinalSanitizedDom,
  type FinalSanitizedDomRoot,
} from './plain-text';
import type {
  StyledCopyAssetMode,
  StyledCopyResult,
  StyledCopySanitizerFailureReason,
} from './types';

export const ALLOWED_FINAL_TAGS = [
  'section',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'del',
  'mark',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'pre',
  'code',
  'br',
  'hr',
  'sup',
  'sub',
  'span',
] as const;

export type AllowedFinalTag = typeof ALLOWED_FINAL_TAGS[number];

export const ALLOWED_FINAL_ATTRIBUTES = [
  'style',
  'href',
  'title',
  'src',
  'alt',
  'start',
  'colspan',
  'rowspan',
] as const;

export type AllowedFinalAttribute = typeof ALLOWED_FINAL_ATTRIBUTES[number];

const ALLOWED_TAG_SET = new Set<string>(ALLOWED_FINAL_TAGS);
const VOID_TAGS = new Set<AllowedFinalTag>(['br', 'hr', 'img']);
const ATTRIBUTE_ORDER = new Map<string, number>(
  ALLOWED_FINAL_ATTRIBUTES.map((attribute, index) => [attribute, index]),
);
const FORBIDDEN_STYLE_FORM = /(?:url|var|expression)\s*\(|!important|\\|[\u0000-\u001f\u007f]/i;
const FORBIDDEN_URL_CHARACTER = /[\\\u0000-\u001f\u007f]/;
const SAFE_PREVIEW_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const ALL_STYLE_MAPS = [
  WECHAT_STYLE_MAPS.minimal,
  WECHAT_STYLE_MAPS.magazine,
  WECHAT_STYLE_MAPS.technical,
  ZHIHU_STYLE_MAP,
];

const ALLOWED_STYLE_DECLARATIONS = buildAllowedStyleDeclarations();

interface SanitizedNodeSuccess {
  kind: 'ok';
  value: Node | null;
}

interface SanitizedNodeFailure {
  kind: 'error';
  reason: StyledCopySanitizerFailureReason;
}

type SanitizedNodeResult = SanitizedNodeSuccess | SanitizedNodeFailure;

function buildAllowedStyleDeclarations(): ReadonlySet<string> {
  const declarations = new Set<string>();
  for (const styleMap of ALL_STYLE_MAPS) {
    for (const role of PUBLICATION_STYLE_ROLES) {
      declarations.add(serializePublicationStyleUnchecked(styleMap[role]));
    }
  }
  return declarations;
}

export function applyPublicationStyle(
  element: Element,
  declaration: PublicationStyleDeclaration,
): void {
  const serialized = serializePublicationStyle(declaration);
  if (serialized) element.setAttribute('style', serialized);
}

export function sanitizeGeneratedDom(
  sourceRoot: DocumentFragment | Element,
  mode: StyledCopyAssetMode,
): StyledCopyResult<FinalSanitizedDom> {
  if (!isSanitizableRoot(sourceRoot)) {
    return sanitizerFailure('invalid_root');
  }

  if (sourceRoot.nodeType === Node.ELEMENT_NODE) {
    const sanitized = sanitizeNode(sourceRoot, mode);
    if (sanitized.kind === 'error') return sanitizerFailure(sanitized.reason);
    if (!sanitized.value || sanitized.value.nodeType !== Node.ELEMENT_NODE) {
      return sanitizerFailure('invalid_root');
    }
    return {
      kind: 'ok',
      value: createFinalSanitizedDom(sanitized.value as Element),
      warnings: [],
    };
  }

  const fragment = document.createDocumentFragment();
  for (const sourceChild of Array.from(sourceRoot.childNodes)) {
    const sanitized = sanitizeNode(sourceChild, mode);
    if (sanitized.kind === 'error') return sanitizerFailure(sanitized.reason);
    if (sanitized.value) fragment.append(sanitized.value);
  }
  return {
    kind: 'ok',
    value: createFinalSanitizedDom(fragment),
    warnings: [],
  };
}

export function serializeSanitizedDomToHtml(finalDom: FinalSanitizedDom): string {
  if (finalDom.root.nodeType === Node.ELEMENT_NODE) {
    return serializeElement(finalDom.root as Element);
  }
  return Array.from(finalDom.root.childNodes).map(serializeNode).join('');
}

function isSanitizableRoot(value: unknown): value is DocumentFragment | Element {
  return value instanceof Node
    && (value.nodeType === Node.DOCUMENT_FRAGMENT_NODE || value.nodeType === Node.ELEMENT_NODE);
}

function sanitizeNode(source: Node, mode: StyledCopyAssetMode): SanitizedNodeResult {
  if (source.nodeType === Node.TEXT_NODE) {
    return { kind: 'ok', value: document.createTextNode((source as Text).data) };
  }
  if (source.nodeType === Node.COMMENT_NODE) return { kind: 'ok', value: null };
  if (source.nodeType !== Node.ELEMENT_NODE) return { kind: 'error', reason: 'disallowed_tag' };

  const sourceElement = source as Element;
  const tag = sourceElement.tagName.toLowerCase();
  if (!ALLOWED_TAG_SET.has(tag)) return { kind: 'error', reason: 'disallowed_tag' };

  const target = document.createElement(tag);
  const styleResult = sanitizeStyle(sourceElement, target);
  if (styleResult) return { kind: 'error', reason: styleResult };

  for (const attribute of Array.from(sourceElement.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name === 'style') continue;
    if (!isAttributeAllowedForTag(tag, name)) {
      return { kind: 'error', reason: 'disallowed_attribute' };
    }
    const value = sanitizeAttribute(tag, name, attribute.value, mode);
    if (value.kind === 'error') return value;
    target.setAttribute(name, value.value);
  }

  if (tag === 'a' && !target.hasAttribute('href')) {
    return { kind: 'error', reason: 'invalid_attribute' };
  }
  if (tag === 'img' && (!target.hasAttribute('src') || !target.hasAttribute('alt'))) {
    return { kind: 'error', reason: 'invalid_attribute' };
  }

  for (const sourceChild of Array.from(sourceElement.childNodes)) {
    const child = sanitizeNode(sourceChild, mode);
    if (child.kind === 'error') return child;
    if (child.value) target.append(child.value);
  }
  return { kind: 'ok', value: target };
}

function sanitizeStyle(
  source: Element,
  target: Element,
): StyledCopySanitizerFailureReason | null {
  if (!source.hasAttribute('style')) return null;
  const rawStyle = source.getAttribute('style') ?? '';
  if (!rawStyle || FORBIDDEN_STYLE_FORM.test(rawStyle)) return 'unsafe_style';
  if (!ALLOWED_STYLE_DECLARATIONS.has(rawStyle)) return 'unsafe_style';
  target.setAttribute('style', rawStyle);
  return null;
}

function sanitizeAttribute(
  tag: string,
  name: string,
  rawValue: string,
  mode: StyledCopyAssetMode,
): { kind: 'ok'; value: string } | SanitizedNodeFailure {
  if (name === 'href') {
    const href = safeHttpUrl(rawValue);
    return href
      ? { kind: 'ok', value: href }
      : { kind: 'error', reason: 'unsafe_anchor_url' };
  }
  if (name === 'src') {
    const source = mode === 'final'
      ? safeFinalImageUrl(rawValue)
      : safePreviewImageUrl(rawValue);
    return source
      ? { kind: 'ok', value: source }
      : { kind: 'error', reason: 'unsafe_image_url' };
  }
  if (name === 'start') {
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isSafeInteger(parsed) && String(parsed) === rawValue
      ? { kind: 'ok', value: rawValue }
      : { kind: 'error', reason: 'invalid_attribute' };
  }
  if (name === 'colspan' || name === 'rowspan') {
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === rawValue
      ? { kind: 'ok', value: rawValue }
      : { kind: 'error', reason: 'invalid_attribute' };
  }
  if (FORBIDDEN_URL_CHARACTER.test(rawValue)) {
    return { kind: 'error', reason: 'invalid_attribute' };
  }
  return { kind: 'ok', value: rawValue };
}

function isAttributeAllowedForTag(tag: string, attribute: string): boolean {
  if (attribute === 'href') return tag === 'a';
  if (attribute === 'src' || attribute === 'alt') return tag === 'img';
  if (attribute === 'title') return tag === 'a' || tag === 'img';
  if (attribute === 'start') return tag === 'ol';
  if (attribute === 'colspan' || attribute === 'rowspan') return tag === 'th' || tag === 'td';
  return false;
}

function serializePublicationStyle(declaration: PublicationStyleDeclaration): string {
  const serialized = serializePublicationStyleUnchecked(declaration);
  if (!serialized || !ALLOWED_STYLE_DECLARATIONS.has(serialized)) {
    throw new TypeError('Expected an internally authored publication style');
  }
  return serialized;
}

function serializePublicationStyleUnchecked(declaration: PublicationStyleDeclaration): string {
  const values: string[] = [];
  for (const property of PUBLICATION_STYLE_PROPERTIES) {
    const value = declaration[property];
    if (value === undefined) continue;
    values.push(`${property}:${value}`);
  }
  return values.join(';');
}

function safeHttpUrl(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value || FORBIDDEN_URL_CHARACTER.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function safeFinalImageUrl(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value || FORBIDDEN_URL_CHARACTER.test(value)) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function safePreviewImageUrl(rawValue: string): string | null {
  const value = rawValue.trim();
  if (safeFinalImageUrl(value)) return value;
  if (SAFE_PREVIEW_DATA_IMAGE.test(value)) return value;
  if (!value.startsWith('blob:http://') && !value.startsWith('blob:https://')) return null;
  try {
    return new URL(value).protocol === 'blob:' ? value : null;
  } catch {
    return null;
  }
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText((node as Text).data);
  if (node.nodeType === Node.ELEMENT_NODE) return serializeElement(node as Element);
  return '';
}

function serializeElement(element: Element): string {
  const tag = element.tagName.toLowerCase() as AllowedFinalTag;
  const attributes = Array.from(element.attributes)
    .sort((left, right) => (
      (ATTRIBUTE_ORDER.get(left.name) ?? Number.MAX_SAFE_INTEGER)
      - (ATTRIBUTE_ORDER.get(right.name) ?? Number.MAX_SAFE_INTEGER)
    ))
    .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
    .join('');
  if (VOID_TAGS.has(tag)) return `<${tag}${attributes}>`;
  return `<${tag}${attributes}>${Array.from(element.childNodes).map(serializeNode).join('')}</${tag}>`;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function sanitizerFailure(
  reason: StyledCopySanitizerFailureReason,
): StyledCopyResult<never> {
  return { kind: 'error', error: { code: 'sanitizer_failure', reason } };
}
