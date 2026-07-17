import type {
  CodeBlockNode,
  CodeTokenNode,
  EndnoteNode,
  EndnotesNode,
  HeadingNode,
  ListItemNode,
  MathNode,
  PandocCodeTokenKind,
  SemanticDocument,
  SemanticNode,
  StyledCopyResult,
  TableCellNode,
  TableRowNode,
  TextNode,
} from './types';
import { createWarningCollector, type WarningCollector } from './warnings';

interface FootnoteEntry {
  element: Element;
  container: Element;
  id: string;
  number: number;
}

interface FootnoteIndex {
  entries: FootnoteEntry[];
  numberById: Map<string, number>;
  duplicates: Array<{ container: Element; id: string }>;
}

interface NormalizeContext {
  warnings: WarningCollector;
  footnotes: FootnoteIndex;
  imageCount: number;
  mermaidCount: number;
}

const CODE_TOKEN_CLASSES: Readonly<Record<string, PandocCodeTokenKind>> = {
  kw: 'keyword',
  dt: 'data-type',
  dv: 'decimal',
  bn: 'base-n',
  fl: 'float',
  cn: 'constant',
  ch: 'char',
  sc: 'special-char',
  st: 'string',
  vs: 'verbatim-string',
  ss: 'special-string',
  im: 'import',
  co: 'comment',
  do: 'documentation',
  an: 'annotation',
  cv: 'comment-variable',
  ot: 'other',
  fu: 'function',
  va: 'variable',
  cf: 'control-flow',
  op: 'operator',
  bu: 'built-in',
  ex: 'extension',
  pp: 'preprocessor',
  at: 'attribute',
  re: 'region-marker',
  in: 'information',
  wa: 'warning',
  al: 'alert',
  er: 'error',
};

const INLINE_WHITESPACE_PARENTS = new Set([
  'A',
  'B',
  'DEL',
  'EM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'I',
  'LI',
  'MARK',
  'P',
  'S',
  'SPAN',
  'STRIKE',
  'STRONG',
  'SUB',
  'SUP',
  'TD',
  'TH',
]);

const DROP_WITH_CONTENT_TAGS = new Set([
  'AUDIO',
  'BASE',
  'BUTTON',
  'CANVAS',
  'EMBED',
  'FIELDSET',
  'FORM',
  'FRAME',
  'FRAMESET',
  'HEAD',
  'IFRAME',
  'INPUT',
  'LINK',
  'MATH',
  'META',
  'NOSCRIPT',
  'OBJECT',
  'OPTION',
  'SCRIPT',
  'SELECT',
  'SOURCE',
  'STYLE',
  'SVG',
  'TEMPLATE',
  'TEXTAREA',
  'TRACK',
  'VIDEO',
]);

export function normalizePandocHtml(html: string): StyledCopyResult<SemanticDocument> {
  const sourceDocument = new DOMParser().parseFromString(html, 'text/html');
  const sourceBody = sourceDocument.body;
  if (!sourceBody) {
    return {
      kind: 'error',
      error: { code: 'malformed_document', reason: 'missing_body' },
    };
  }

  const warnings = createWarningCollector();
  const context: NormalizeContext = {
    warnings,
    footnotes: indexFootnotes(sourceBody),
    imageCount: 0,
    mermaidCount: 0,
  };
  const value: SemanticDocument = {
    type: 'document',
    children: transformChildren(sourceBody, context),
  };

  return { kind: 'ok', value, warnings: warnings.values() };
}

function transformChildren(parent: Node, context: NormalizeContext): SemanticNode[] {
  const children: SemanticNode[] = [];
  for (const sourceChild of Array.from(parent.childNodes)) {
    children.push(...transformNode(sourceChild, context));
  }
  return children;
}

function transformNode(sourceNode: Node, context: NormalizeContext): SemanticNode[] {
  if (sourceNode.nodeType === Node.TEXT_NODE) {
    const text = transformText(sourceNode as Text);
    return text ? [text] : [];
  }
  if (sourceNode.nodeType !== Node.ELEMENT_NODE) return [];

  const element = sourceNode as Element;
  if (DROP_WITH_CONTENT_TAGS.has(element.tagName)) return [];
  if (isFootnotesContainer(element)) {
    return [transformEndnotes(element, context)];
  }
  if (isFootnoteBacklink(element)) return [];
  if (isFootnoteReference(element)) {
    const target = rawAttribute(element, 'href');
    const number = target.startsWith('#')
      ? context.footnotes.numberById.get(target.slice(1))
      : undefined;
    if (number !== undefined) return [{ type: 'footnote-reference', number }];
    context.warnings.add({
      code: 'malformed_footnote',
      ...(target ? { payload: target } : {}),
    });
    return transformChildren(element, context);
  }
  if (isMathElement(element)) return [transformMath(element)];
  if (isMermaidBlock(element)) return [transformMermaid(element, context)];

  const tag = element.tagName;
  if (/^H[1-6]$/.test(tag)) {
    return [{
      type: 'heading',
      level: Number(tag.slice(1)) as HeadingNode['level'],
      children: transformChildren(element, context),
    }];
  }

  switch (tag) {
    case 'P':
      return [{ type: 'paragraph', children: transformChildren(element, context) }];
    case 'EM':
    case 'I':
      return [{ type: 'emphasis', children: transformChildren(element, context) }];
    case 'STRONG':
    case 'B':
      return [{ type: 'strong', children: transformChildren(element, context) }];
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return [{ type: 'delete', children: transformChildren(element, context) }];
    case 'MARK':
      return [{ type: 'mark', children: transformChildren(element, context) }];
    case 'SUP':
      return [{ type: 'superscript', children: transformChildren(element, context) }];
    case 'SUB':
      return [{ type: 'subscript', children: transformChildren(element, context) }];
    case 'A':
      return transformLink(element, context);
    case 'IMG':
      return [transformImage(element, context)];
    case 'BLOCKQUOTE':
      return [{ type: 'blockquote', children: transformChildren(element, context) }];
    case 'UL':
    case 'OL':
      return [transformList(element, context)];
    case 'LI':
      return [{ type: 'list-item', children: transformChildren(element, context) }];
    case 'TABLE':
      return [transformTable(element, context)];
    case 'PRE':
      return [transformCodeBlock(element)];
    case 'CODE':
      return [{ type: 'inline-code', value: normalizeLineEndings(element.textContent ?? '') }];
    case 'BR':
      return [{ type: 'break', kind: 'hard' }];
    case 'HR':
      return [{ type: 'rule' }];
    default:
      return transformChildren(element, context);
  }
}

function transformText(sourceText: Text): TextNode | null {
  const value = normalizeLineEndings(sourceText.data).replace(/\s+/g, ' ');
  if (value.trim().length > 0) return { type: 'text', value };
  const parentTag = sourceText.parentElement?.tagName;
  return parentTag && INLINE_WHITESPACE_PARENTS.has(parentTag)
    ? { type: 'text', value: ' ' }
    : null;
}

function transformList(element: Element, context: NormalizeContext) {
  const ordered = element.tagName === 'OL';
  const rawStart = ordered ? rawAttribute(element, 'start') : '';
  const parsedStart = Number.parseInt(rawStart, 10);
  const children = transformChildren(element, context).filter(
    (child): child is ListItemNode => child.type === 'list-item',
  );
  return {
    type: 'list' as const,
    ordered,
    start: ordered && Number.isSafeInteger(parsedStart) ? parsedStart : null,
    children,
  };
}

function transformTable(element: Element, context: NormalizeContext) {
  const children: TableRowNode[] = [];
  for (const child of Array.from(element.children)) {
    if (child.tagName === 'TR') {
      children.push(transformTableRow(child, 'body', context));
      continue;
    }
    const section = tableSection(child.tagName);
    if (!section) continue;
    for (const row of Array.from(child.children)) {
      if (row.tagName === 'TR') children.push(transformTableRow(row, section, context));
    }
  }
  return { type: 'table' as const, children };
}

function transformTableRow(
  element: Element,
  section: TableRowNode['section'],
  context: NormalizeContext,
): TableRowNode {
  const children = Array.from(element.children)
    .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
    .map((cell) => transformTableCell(cell, context));
  return { type: 'table-row', section, children };
}

function transformTableCell(element: Element, context: NormalizeContext): TableCellNode {
  return {
    type: 'table-cell',
    header: element.tagName === 'TH',
    colSpan: positiveSpan(element, 'colspan'),
    rowSpan: positiveSpan(element, 'rowspan'),
    children: transformChildren(element, context),
  };
}

function transformImage(element: Element, context: NormalizeContext) {
  context.imageCount += 1;
  return {
    type: 'image' as const,
    asset: {
      kind: 'image' as const,
      id: `image-${context.imageCount}`,
      source: rawAttribute(element, 'src'),
      alt: rawAttribute(element, 'alt'),
      title: optionalRawAttribute(element, 'title'),
    },
  };
}

function transformLink(element: Element, context: NormalizeContext): SemanticNode[] {
  const rawHref = rawAttribute(element, 'href');
  const href = rawHref.trim();
  if (!href) {
    context.warnings.add({ code: 'malformed_link' });
    return transformChildren(element, context);
  }

  try {
    const parsed = new URL(href);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return [{
        type: 'link',
        href,
        title: optionalRawAttribute(element, 'title'),
        children: transformChildren(element, context),
      }];
    }
    context.warnings.add({ code: 'unsafe_link_removed', payload: href });
  } catch {
    context.warnings.add({ code: 'relative_link_removed', payload: href });
  }
  return transformChildren(element, context);
}

function transformCodeBlock(element: Element): CodeBlockNode {
  const code = Array.from(element.children).find((child) => child.tagName === 'CODE') ?? element;
  const language = extractCodeLanguage(code) ?? extractCodeLanguage(element);
  return {
    type: 'code-block',
    language,
    children: transformCodeChildren(code),
  };
}

function transformCodeChildren(parent: Node): Array<TextNode | CodeTokenNode> {
  const children: Array<TextNode | CodeTokenNode> = [];
  for (const sourceChild of Array.from(parent.childNodes)) {
    if (sourceChild.nodeType === Node.TEXT_NODE) {
      const value = normalizeLineEndings((sourceChild as Text).data);
      if (value.length > 0) appendCodeChild(children, { type: 'text', value });
      continue;
    }
    if (sourceChild.nodeType !== Node.ELEMENT_NODE) continue;
    const element = sourceChild as Element;
    const kind = codeTokenKind(element);
    if (kind) {
      children.push({
        type: 'code-token',
        kind,
        value: normalizeLineEndings(element.textContent ?? ''),
      });
    } else {
      for (const child of transformCodeChildren(element)) appendCodeChild(children, child);
    }
  }
  return children;
}

function appendCodeChild(
  children: Array<TextNode | CodeTokenNode>,
  child: TextNode | CodeTokenNode,
): void {
  const previous = children.at(-1);
  if (previous?.type === 'text' && child.type === 'text') {
    previous.value += child.value;
    return;
  }
  children.push(child);
}

function transformMath(element: Element): MathNode {
  const display = hasClass(element, 'display');
  let expression = normalizeLineEndings(element.textContent ?? '').trim();
  const wrappers = display ? ['\\[', '\\]'] : ['\\(', '\\)'];
  if (expression.startsWith(wrappers[0]) && expression.endsWith(wrappers[1])) {
    expression = expression.slice(wrappers[0].length, -wrappers[1].length).trim();
  }
  return { type: 'math', display, expression };
}

function transformMermaid(element: Element, context: NormalizeContext) {
  context.mermaidCount += 1;
  const code = element.tagName === 'CODE'
    ? element
    : Array.from(element.children).find((child) => child.tagName === 'CODE') ?? element;
  return {
    type: 'mermaid' as const,
    asset: {
      kind: 'mermaid' as const,
      id: `mermaid-${context.mermaidCount}`,
      source: normalizeLineEndings(code.textContent ?? ''),
    },
  };
}

function transformEndnotes(container: Element, context: NormalizeContext): EndnotesNode {
  for (const duplicate of context.footnotes.duplicates) {
    if (duplicate.container === container) {
      context.warnings.add({ code: 'duplicate_footnote', payload: duplicate.id });
    }
  }
  const children: EndnoteNode[] = context.footnotes.entries
    .filter((entry) => entry.container === container)
    .map((entry) => ({
      type: 'endnote',
      number: entry.number,
      children: transformChildren(entry.element, context),
    }));
  return { type: 'endnotes', children };
}

function indexFootnotes(root: Element): FootnoteIndex {
  const entries: FootnoteEntry[] = [];
  const numberById = new Map<string, number>();
  const duplicates: Array<{ container: Element; id: string }> = [];
  const containers = descendants(root).filter(isFootnotesContainer);

  for (const container of containers) {
    for (const element of descendants(container)) {
      if (element.tagName !== 'LI' || !isEndnoteElement(element)) continue;
      const id = rawAttribute(element, 'id');
      if (!id) continue;
      if (numberById.has(id)) {
        duplicates.push({ container, id });
        continue;
      }
      const number = entries.length + 1;
      numberById.set(id, number);
      entries.push({ element, container, id, number });
    }
  }

  return { entries, numberById, duplicates };
}

function descendants(root: Element): Element[] {
  const elements: Element[] = [];
  const stack = Array.from(root.children).reverse();
  while (stack.length > 0) {
    const element = stack.pop()!;
    elements.push(element);
    stack.push(...Array.from(element.children).reverse());
  }
  return elements;
}

function isFootnotesContainer(element: Element): boolean {
  return hasClass(element, 'footnotes') || rawAttribute(element, 'role') === 'doc-endnotes';
}

function isEndnoteElement(element: Element): boolean {
  return rawAttribute(element, 'role') === 'doc-endnote' || rawAttribute(element, 'id').startsWith('fn');
}

function isFootnoteReference(element: Element): boolean {
  return element.tagName === 'A'
    && (hasClass(element, 'footnote-ref') || rawAttribute(element, 'role') === 'doc-noteref');
}

function isFootnoteBacklink(element: Element): boolean {
  return element.tagName === 'A'
    && (hasClass(element, 'footnote-back') || rawAttribute(element, 'role') === 'doc-backlink');
}

function isMathElement(element: Element): boolean {
  return hasClass(element, 'math') && (hasClass(element, 'inline') || hasClass(element, 'display'));
}

function isMermaidBlock(element: Element): boolean {
  if (element.tagName !== 'PRE' && element.tagName !== 'CODE') return false;
  if (hasClass(element, 'mermaid') || hasClass(element, 'language-mermaid')) return true;
  if (element.tagName !== 'PRE') return false;
  return Array.from(element.children).some(
    (child) => child.tagName === 'CODE'
      && (hasClass(child, 'mermaid') || hasClass(child, 'language-mermaid')),
  );
}

function codeTokenKind(element: Element): PandocCodeTokenKind | null {
  for (const className of classTokens(element)) {
    const kind = CODE_TOKEN_CLASSES[className];
    if (kind) return kind;
  }
  return null;
}

function extractCodeLanguage(element: Element): string | null {
  for (const className of classTokens(element)) {
    if (!className.startsWith('language-')) continue;
    const language = className.slice('language-'.length);
    if (/^[A-Za-z0-9_+-]{1,64}$/.test(language) && language !== 'mermaid') return language;
  }
  return null;
}

function classTokens(element: Element): string[] {
  return rawAttribute(element, 'class').split(/\s+/).filter(Boolean);
}

function hasClass(element: Element, className: string): boolean {
  return classTokens(element).includes(className);
}

function rawAttribute(element: Element, name: string): string {
  return element.getAttribute(name) ?? '';
}

function optionalRawAttribute(element: Element, name: string): string | null {
  const value = element.getAttribute(name);
  return value && value.length > 0 ? value : null;
}

function positiveSpan(element: Element, name: 'colspan' | 'rowspan'): number {
  const parsed = Number.parseInt(rawAttribute(element, name), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function tableSection(tagName: string): TableRowNode['section'] | null {
  if (tagName === 'THEAD') return 'head';
  if (tagName === 'TFOOT') return 'foot';
  if (tagName === 'TBODY') return 'body';
  return null;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}
