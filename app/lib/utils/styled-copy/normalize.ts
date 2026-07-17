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
import {
  validateSemanticComplexity,
  type SemanticComplexityMetrics,
} from './limits';
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

interface PreflightFrame {
  node: Node;
  parentDepth: number;
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
  const footnotes = indexFootnotes(sourceBody);
  const preflight = preflightSemanticDocument(sourceBody, footnotes);
  if (preflight.kind === 'error') return preflight;
  const context: NormalizeContext = {
    warnings,
    footnotes,
    imageCount: 0,
    mermaidCount: 0,
  };
  const value: SemanticDocument = {
    type: 'document',
    children: transformChildren(sourceBody, context),
  };

  return { kind: 'ok', value, warnings: warnings.values() };
}

function preflightSemanticDocument(
  sourceBody: Element,
  footnotes: FootnoteIndex,
): StyledCopyResult<void> {
  const metrics = {
    nodeCount: 0,
    maxDepth: 0,
    tables: [] as Array<{ rows: number; columns: number }>,
  };
  const stack: PreflightFrame[] = [];
  pushChildFrames(stack, sourceBody, 0);

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const sourceNode = frame.node;
    if (sourceNode.nodeType === Node.TEXT_NODE) {
      if (normalizedTextValue(sourceNode as Text) !== null) recordSemanticNode(metrics, frame.parentDepth + 1);
      continue;
    }
    if (sourceNode.nodeType !== Node.ELEMENT_NODE) continue;

    const element = sourceNode as Element;
    if (DROP_WITH_CONTENT_TAGS.has(element.tagName) || isFootnoteBacklink(element)) continue;

    if (isFootnotesContainer(element)) {
      const endnotesDepth = frame.parentDepth + 1;
      recordSemanticNode(metrics, endnotesDepth);
      const entries = footnotes.entries.filter((entry) => entry.container === element);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const endnoteDepth = endnotesDepth + 1;
        recordSemanticNode(metrics, endnoteDepth);
        pushChildFrames(stack, entries[index].element, endnoteDepth);
      }
      continue;
    }

    if (isFootnoteReference(element)) {
      const target = rawAttribute(element, 'href');
      if (target.startsWith('#') && footnotes.numberById.has(target.slice(1))) {
        recordSemanticNode(metrics, frame.parentDepth + 1);
      } else {
        pushChildFrames(stack, element, frame.parentDepth);
      }
      continue;
    }

    if (isMathElement(element) || isMermaidBlock(element) || element.tagName === 'IMG') {
      recordSemanticNode(metrics, frame.parentDepth + 1);
      continue;
    }

    const tag = element.tagName;
    if (tag === 'PRE') {
      const blockDepth = frame.parentDepth + 1;
      recordSemanticNode(metrics, blockDepth);
      const code = Array.from(element.children).find((child) => child.tagName === 'CODE') ?? element;
      const codeChildren = countCodeChildren(code);
      metrics.nodeCount += codeChildren;
      if (codeChildren > 0) metrics.maxDepth = Math.max(metrics.maxDepth, blockDepth + 1);
      continue;
    }

    if (tag === 'TABLE') {
      const tableDepth = frame.parentDepth + 1;
      recordSemanticNode(metrics, tableDepth);
      const rows = sourceTableRows(element);
      const tableIndex = metrics.tables.length;
      let columns = 0;

      for (const { element: row } of rows) {
        const cells = sourceTableCells(row);
        if (cells.length === 0) {
          return {
            kind: 'error',
            error: { code: 'malformed_table', tableIndex, reason: 'empty_row' },
          };
        }
        const rowDepth = tableDepth + 1;
        recordSemanticNode(metrics, rowDepth);
        let rowColumns = 0;
        for (const cell of cells) {
          const cellDepth = rowDepth + 1;
          recordSemanticNode(metrics, cellDepth);
          rowColumns += positiveSpan(cell, 'colspan');
        }
        columns = Math.max(columns, rowColumns);
      }

      metrics.tables.push({ rows: rows.length, columns });
      for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
        const cells = sourceTableCells(rows[rowIndex].element);
        for (let cellIndex = cells.length - 1; cellIndex >= 0; cellIndex -= 1) {
          pushChildFrames(stack, cells[cellIndex], tableDepth + 2);
        }
      }
      continue;
    }

    if (tag === 'UL' || tag === 'OL') {
      const listDepth = frame.parentDepth + 1;
      recordSemanticNode(metrics, listDepth);
      for (let child = element.lastElementChild; child; child = child.previousElementSibling) {
        if (child.tagName === 'LI') stack.push({ node: child, parentDepth: listDepth });
      }
      continue;
    }

    if (tag === 'A') {
      const intent = classifyLink(rawAttribute(element, 'href'));
      if (intent.kind === 'external') {
        const linkDepth = frame.parentDepth + 1;
        recordSemanticNode(metrics, linkDepth);
        pushChildFrames(stack, element, linkDepth);
      } else {
        pushChildFrames(stack, element, frame.parentDepth);
      }
      continue;
    }

    if (isSemanticContainerTag(tag)) {
      const nodeDepth = frame.parentDepth + 1;
      recordSemanticNode(metrics, nodeDepth);
      pushChildFrames(stack, element, nodeDepth);
      continue;
    }

    if (tag === 'CODE' || tag === 'BR' || tag === 'HR') {
      recordSemanticNode(metrics, frame.parentDepth + 1);
      continue;
    }

    pushChildFrames(stack, element, frame.parentDepth);
  }

  return validateSemanticComplexity(metrics);
}

function recordSemanticNode(metrics: SemanticComplexityMetrics, depth: number): void {
  metrics.nodeCount += 1;
  metrics.maxDepth = Math.max(metrics.maxDepth, depth);
}

function pushChildFrames(stack: PreflightFrame[], parent: Node, parentDepth: number): void {
  for (let child = parent.lastChild; child; child = child.previousSibling) {
    stack.push({ node: child, parentDepth });
  }
}

function isSemanticContainerTag(tag: string): boolean {
  return /^H[1-6]$/.test(tag) || [
    'B',
    'BLOCKQUOTE',
    'DEL',
    'EM',
    'I',
    'LI',
    'MARK',
    'P',
    'S',
    'STRIKE',
    'STRONG',
    'SUB',
    'SUP',
  ].includes(tag);
}

function countCodeChildren(parent: Node): number {
  const stack: Node[] = [];
  for (let child = parent.lastChild; child; child = child.previousSibling) stack.push(child);
  let count = 0;
  let previousWasText = false;

  while (stack.length > 0) {
    const sourceNode = stack.pop()!;
    if (sourceNode.nodeType === Node.TEXT_NODE) {
      if ((sourceNode as Text).data.length > 0) {
        if (!previousWasText) count += 1;
        previousWasText = true;
      }
      continue;
    }
    if (sourceNode.nodeType !== Node.ELEMENT_NODE) continue;
    const element = sourceNode as Element;
    if (codeTokenKind(element)) {
      count += 1;
      previousWasText = false;
      continue;
    }
    for (let child = element.lastChild; child; child = child.previousSibling) stack.push(child);
  }

  return count;
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
  const value = normalizedTextValue(sourceText);
  return value === null ? null : { type: 'text', value };
}

function normalizedTextValue(sourceText: Text): string | null {
  const value = normalizeLineEndings(sourceText.data).replace(/\s+/g, ' ');
  if (value.trim().length > 0) return value;
  const parentTag = sourceText.parentElement?.tagName;
  return parentTag && INLINE_WHITESPACE_PARENTS.has(parentTag) ? ' ' : null;
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
  const children = sourceTableRows(element).map(({ element: row, section }) => (
    transformTableRow(row, section, context)
  ));
  return { type: 'table' as const, children };
}

function sourceTableRows(element: Element): Array<{
  element: Element;
  section: TableRowNode['section'];
}> {
  const rows: Array<{ element: Element; section: TableRowNode['section'] }> = [];
  for (const child of Array.from(element.children)) {
    if (child.tagName === 'TR') {
      rows.push({ element: child, section: 'body' });
      continue;
    }
    const section = tableSection(child.tagName);
    if (!section) continue;
    for (const row of Array.from(child.children)) {
      if (row.tagName === 'TR') rows.push({ element: row, section });
    }
  }
  return rows;
}

function sourceTableCells(row: Element): Element[] {
  return Array.from(row.children).filter(
    (cell) => cell.tagName === 'TH' || cell.tagName === 'TD',
  );
}

function transformTableRow(
  element: Element,
  section: TableRowNode['section'],
  context: NormalizeContext,
): TableRowNode {
  const children = sourceTableCells(element).map((cell) => transformTableCell(cell, context));
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
  const intent = classifyLink(rawAttribute(element, 'href'));
  if (intent.kind === 'malformed') {
    context.warnings.add({ code: 'malformed_link' });
    return transformChildren(element, context);
  }
  if (intent.kind === 'external') {
    return [{
      type: 'link',
      href: intent.href,
      title: optionalRawAttribute(element, 'title'),
      children: transformChildren(element, context),
    }];
  }
  context.warnings.add({
    code: intent.kind === 'unsafe' ? 'unsafe_link_removed' : 'relative_link_removed',
    payload: intent.href,
  });
  return transformChildren(element, context);
}

type LinkIntent =
  | { kind: 'external'; href: string }
  | { kind: 'unsafe'; href: string }
  | { kind: 'relative'; href: string }
  | { kind: 'malformed' };

function classifyLink(rawHref: string): LinkIntent {
  const href = rawHref.trim();
  if (!href) return { kind: 'malformed' };
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? { kind: 'external', href }
      : { kind: 'unsafe', href };
  } catch {
    return { kind: 'relative', href };
  }
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
