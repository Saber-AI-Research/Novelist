import { serializeFinalDomToPlainText } from '../plain-text';
import {
  applyPublicationStyle,
  sanitizeGeneratedDom,
  serializeSanitizedDomToHtml,
  type AllowedFinalTag,
} from '../sanitize';
import {
  WECHAT_STYLE_MAPS,
  ZHIHU_STYLE_MAP,
  type PublicationStyleMap,
  type PublicationStyleRole,
} from '../themes';
import type {
  CodeBlockNode,
  EndnoteNode,
  EndnotesNode,
  LinkMode,
  LinkNode,
  LogicalAsset,
  PandocCodeTokenKind,
  ResolvedStyledCopyAssetUrls,
  SemanticDocument,
  SemanticNode,
  StyledCopyAssetMode,
  StyledCopyBlockingError,
  StyledCopyTarget,
  StyledCopyWarning,
  TableCellNode,
  TableNode,
  TableRowNode,
  WechatTheme,
} from '../types';
import { createWarningCollector, type WarningCollector } from '../warnings';

export interface StyledCopyTargetAdapterInput {
  document: SemanticDocument;
  target: StyledCopyTarget;
  wechatTheme: WechatTheme;
  linkMode?: LinkMode;
  assetMode?: StyledCopyAssetMode;
  resolvedAssets: ResolvedStyledCopyAssetUrls;
}

export type StyledCopyTargetAdapterResult =
  | {
      kind: 'ok';
      html: string;
      plainText: string;
      warnings: StyledCopyWarning[];
    }
  | { kind: 'error'; error: StyledCopyBlockingError };

export interface StyledCopyTargetAdapter {
  readonly target: StyledCopyTarget;
  readonly defaultLinkMode: LinkMode;
  render(
    input: Omit<StyledCopyTargetAdapterInput, 'target'>,
  ): StyledCopyTargetAdapterResult;
}

interface ReferenceEntry {
  href: string;
  number: number;
}

interface RenderContext {
  target: StyledCopyTarget;
  styleMap: PublicationStyleMap;
  linkMode: LinkMode;
  assetMode: StyledCopyAssetMode;
  resolvedAssets: ResolvedStyledCopyAssetUrls;
  warnings: WarningCollector;
  referenceByHref: Map<string, ReferenceEntry>;
  references: ReferenceEntry[];
}

interface RenderOptions {
  inEndnotes: boolean;
}

const KNOWN_CODE_LANGUAGES = new Set([
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'go',
  'html',
  'java',
  'javascript',
  'js',
  'json',
  'jsx',
  'kotlin',
  'lua',
  'markdown',
  'md',
  'php',
  'python',
  'ruby',
  'rust',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'typescript',
  'xml',
  'yaml',
  'yml',
]);

export const WECHAT_TARGET_ADAPTER: StyledCopyTargetAdapter = Object.freeze({
  target: 'wechat',
  defaultLinkMode: 'end-references',
  render(input: Omit<StyledCopyTargetAdapterInput, 'target'>) {
    return renderTarget({ ...input, target: 'wechat' }, 'end-references');
  },
});

export const ZHIHU_TARGET_ADAPTER: StyledCopyTargetAdapter = Object.freeze({
  target: 'zhihu',
  defaultLinkMode: 'anchors',
  render(input: Omit<StyledCopyTargetAdapterInput, 'target'>) {
    return renderTarget({ ...input, target: 'zhihu' }, 'anchors');
  },
});

export function renderStyledCopyTarget(
  input: StyledCopyTargetAdapterInput,
): StyledCopyTargetAdapterResult {
  const defaultLinkMode = input.target === 'wechat'
    ? WECHAT_TARGET_ADAPTER.defaultLinkMode
    : ZHIHU_TARGET_ADAPTER.defaultLinkMode;
  return renderTarget(input, defaultLinkMode);
}

function renderTarget(
  input: StyledCopyTargetAdapterInput,
  defaultLinkMode: LinkMode,
): StyledCopyTargetAdapterResult {
  const assetMode = input.assetMode ?? 'final';
  const preflightError = validateAdapterInput(input.document, input.resolvedAssets, assetMode);
  if (preflightError) return { kind: 'error', error: preflightError };

  const styleMap = input.target === 'wechat'
    ? WECHAT_STYLE_MAPS[input.wechatTheme]
    : ZHIHU_STYLE_MAP;
  const context: RenderContext = {
    target: input.target,
    styleMap,
    linkMode: input.linkMode ?? defaultLinkMode,
    assetMode,
    resolvedAssets: input.resolvedAssets,
    warnings: createWarningCollector(),
    referenceByHref: new Map(),
    references: [],
  };
  const root = styledElement('section', 'article', context);
  appendSemanticChildren(root, input.document.children, context, { inEndnotes: false });
  appendReferences(root, context);

  const sanitized = sanitizeGeneratedDom(root, assetMode);
  if (sanitized.kind === 'error') return sanitized;
  return {
    kind: 'ok',
    html: serializeSanitizedDomToHtml(sanitized.value),
    plainText: serializeFinalDomToPlainText(sanitized.value),
    warnings: context.warnings.values(),
  };
}

function validateAdapterInput(
  semanticDocument: SemanticDocument,
  resolvedAssets: ResolvedStyledCopyAssetUrls,
  assetMode: StyledCopyAssetMode,
): StyledCopyBlockingError | null {
  const stack = [...semanticDocument.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'link' && !safeHttpHref(node.href)) {
      return { code: 'sanitizer_failure', reason: 'unsafe_anchor_url' };
    }
    if (node.type === 'image' || node.type === 'mermaid') {
      const error = validateResolvedAsset(node.asset, resolvedAssets, assetMode);
      if (error) return error;
    }
    stack.push(...[...semanticChildren(node)].reverse());
  }
  return null;
}

function validateResolvedAsset(
  asset: LogicalAsset,
  resolvedAssets: ResolvedStyledCopyAssetUrls,
  assetMode: StyledCopyAssetMode,
): StyledCopyBlockingError | null {
  const resolved = resolvedAssets[asset.id];
  if (!resolved) {
    return { code: 'unresolved_asset', assetId: asset.id, assetKind: asset.kind };
  }
  if (resolved.kind !== assetMode) {
    return {
      code: 'resolved_asset_mode_mismatch',
      assetId: asset.id,
      expected: assetMode,
      actual: resolved.kind,
    };
  }
  return null;
}

function semanticChildren(node: SemanticNode): SemanticNode[] {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'emphasis':
    case 'strong':
    case 'delete':
    case 'mark':
    case 'superscript':
    case 'subscript':
    case 'link':
    case 'blockquote':
    case 'list-item':
    case 'table':
    case 'table-row':
    case 'table-cell':
    case 'endnotes':
    case 'endnote':
      return node.children;
    case 'list':
      return node.children;
    default:
      return [];
  }
}

function appendSemanticChildren(
  parent: Element,
  children: readonly SemanticNode[],
  context: RenderContext,
  options: RenderOptions,
): void {
  for (const child of children) parent.append(...renderSemanticNode(child, context, options));
}

function renderSemanticNode(
  node: SemanticNode,
  context: RenderContext,
  options: RenderOptions,
): Node[] {
  switch (node.type) {
    case 'text':
      return [document.createTextNode(node.value)];
    case 'paragraph':
      return [containerWithChildren('p', 'paragraph', node.children, context, options)];
    case 'heading':
      return [containerWithChildren(
        `h${node.level}` as AllowedFinalTag,
        `heading-${node.level}` as PublicationStyleRole,
        node.children,
        context,
        options,
      )];
    case 'emphasis':
      return [containerWithChildren('em', 'emphasis', node.children, context, options)];
    case 'strong':
      return [containerWithChildren('strong', 'strong', node.children, context, options)];
    case 'delete':
      return [containerWithChildren('del', 'delete', node.children, context, options)];
    case 'mark':
      return [containerWithChildren('mark', 'mark', node.children, context, options)];
    case 'superscript':
      return [containerWithChildren('sup', 'superscript', node.children, context, options)];
    case 'subscript':
      return [containerWithChildren('sub', 'subscript', node.children, context, options)];
    case 'link':
      return renderLink(node, context, options);
    case 'image':
      return [renderAssetImage(node.asset, node.asset.alt, node.asset.title, context)];
    case 'blockquote':
      return [containerWithChildren('blockquote', 'blockquote', node.children, context, options)];
    case 'list':
      return [renderList(node, context, options)];
    case 'list-item':
      return [containerWithChildren('li', 'list-item', node.children, context, options)];
    case 'table':
      return [renderTable(node, context, options)];
    case 'table-row':
      return [renderTableRow(node, context, options)];
    case 'table-cell':
      return [renderTableCell(node, context, options)];
    case 'inline-code': {
      const code = styledElement('code', 'inline-code', context);
      code.textContent = node.value;
      return [code];
    }
    case 'code-token':
      return [document.createTextNode(node.value)];
    case 'code-block':
      return [renderCodeBlock(node, context)];
    case 'footnote-reference': {
      const reference = styledElement('sup', 'footnote-reference', context);
      reference.textContent = `[${node.number}]`;
      return [reference];
    }
    case 'endnotes':
      return [renderEndnotes(node, context)];
    case 'endnote':
      return [renderEndnote(node, context)];
    case 'math': {
      context.warnings.add({ code: 'math_visual_degraded' });
      const math = styledElement(
        'span',
        node.display ? 'math-display' : 'math-inline',
        context,
      );
      math.textContent = node.display
        ? `\\[${node.expression}\\]`
        : `\\(${node.expression}\\)`;
      return [math];
    }
    case 'mermaid':
      return [renderAssetImage(node.asset, 'Mermaid diagram', null, context)];
    case 'break':
      return node.kind === 'hard'
        ? [document.createElement('br')]
        : [document.createTextNode(' ')];
    case 'rule':
      return [styledElement('hr', 'rule', context)];
  }
}

function containerWithChildren(
  tag: AllowedFinalTag,
  role: PublicationStyleRole,
  children: readonly SemanticNode[],
  context: RenderContext,
  options: RenderOptions,
): Element {
  const element = styledElement(tag, role, context);
  appendSemanticChildren(element, children, context, options);
  return element;
}

function renderLink(
  node: LinkNode,
  context: RenderContext,
  options: RenderOptions,
): Node[] {
  const href = node.href.trim();
  if (context.linkMode === 'anchors' || options.inEndnotes) {
    const anchor = styledElement('a', 'link', context);
    anchor.setAttribute('href', href);
    if (node.title) anchor.setAttribute('title', node.title);
    appendSemanticChildren(anchor, node.children, context, options);
    return [anchor];
  }

  const entry = referenceFor(href, context);
  const marker = styledElement('sup', 'reference-marker', context);
  marker.textContent = `[${entry.number}]`;
  return [
    ...node.children.flatMap((child) => renderSemanticNode(child, context, options)),
    marker,
  ];
}

function referenceFor(href: string, context: RenderContext): ReferenceEntry {
  const existing = context.referenceByHref.get(href);
  if (existing) return existing;
  const entry = { href, number: context.references.length + 1 };
  context.referenceByHref.set(href, entry);
  context.references.push(entry);
  return entry;
}

function renderList(
  node: Extract<SemanticNode, { type: 'list' }>,
  context: RenderContext,
  options: RenderOptions,
): Element {
  const tag = node.ordered ? 'ol' : 'ul';
  const list = styledElement(tag, node.ordered ? 'ordered-list' : 'unordered-list', context);
  if (node.ordered && node.start !== null) list.setAttribute('start', String(node.start));
  appendSemanticChildren(list, node.children, context, options);
  return list;
}

function renderTable(
  node: TableNode,
  context: RenderContext,
  options: RenderOptions,
): Element {
  if (node.children.some((row) => row.section === 'foot')) {
    context.warnings.add({
      code: 'table_structure_degraded',
      payload: `${context.target}:table-foot-to-body`,
    });
  }
  const table = styledElement('table', 'table', context);
  const headRows = node.children.filter((row) => row.section === 'head');
  const bodyRows = node.children.filter((row) => row.section !== 'head');
  if (headRows.length > 0) {
    const head = document.createElement('thead');
    for (const row of headRows) head.append(renderTableRow(row, context, options));
    table.append(head);
  }
  if (bodyRows.length > 0) {
    const body = document.createElement('tbody');
    for (const row of bodyRows) body.append(renderTableRow(row, context, options));
    table.append(body);
  }
  return table;
}

function renderTableRow(
  node: TableRowNode,
  context: RenderContext,
  options: RenderOptions,
): Element {
  const row = document.createElement('tr');
  for (const cell of node.children) row.append(renderTableCell(cell, context, options));
  return row;
}

function renderTableCell(
  node: TableCellNode,
  context: RenderContext,
  options: RenderOptions,
): Element {
  const cell = styledElement(node.header ? 'th' : 'td', node.header ? 'table-header' : 'table-cell', context);
  if (node.colSpan > 1) cell.setAttribute('colspan', String(node.colSpan));
  if (node.rowSpan > 1) cell.setAttribute('rowspan', String(node.rowSpan));
  appendSemanticChildren(cell, node.children, context, options);
  return cell;
}

function renderCodeBlock(node: CodeBlockNode, context: RenderContext): Element {
  const pre = styledElement('pre', 'code-block', context);
  const code = document.createElement('code');
  const knownLanguage = node.language !== null && KNOWN_CODE_LANGUAGES.has(node.language.toLowerCase());
  for (const child of node.children) {
    if (child.type === 'text' || !knownLanguage) {
      code.append(document.createTextNode(child.value));
      continue;
    }
    const role = tokenStyleRole(child.kind);
    if (!role) {
      code.append(document.createTextNode(child.value));
      continue;
    }
    const token = styledElement('span', role, context);
    token.textContent = child.value;
    code.append(token);
  }
  pre.append(code);
  return pre;
}

function tokenStyleRole(kind: PandocCodeTokenKind): PublicationStyleRole | null {
  switch (kind) {
    case 'keyword':
    case 'data-type':
    case 'import':
    case 'annotation':
    case 'control-flow':
    case 'built-in':
    case 'extension':
    case 'preprocessor':
    case 'attribute':
    case 'region-marker':
      return 'token-keyword';
    case 'decimal':
    case 'base-n':
    case 'float':
    case 'constant':
    case 'char':
    case 'special-char':
      return 'token-value';
    case 'string':
    case 'verbatim-string':
    case 'special-string':
      return 'token-string';
    case 'comment':
    case 'documentation':
    case 'comment-variable':
    case 'information':
      return 'token-comment';
    case 'function':
      return 'token-function';
    case 'variable':
    case 'other':
      return 'token-variable';
    case 'operator':
      return 'token-operator';
    case 'warning':
    case 'alert':
    case 'error':
      return 'token-alert';
    default:
      return null;
  }
}

function renderEndnotes(node: EndnotesNode, context: RenderContext): Element {
  const section = styledElement('section', 'endnotes', context);
  const list = styledElement('ol', 'ordered-list', context);
  const firstNumber = node.children[0]?.number;
  if (firstNumber !== undefined && firstNumber !== 1) list.setAttribute('start', String(firstNumber));
  for (const endnote of node.children) list.append(renderEndnote(endnote, context));
  section.append(list);
  return section;
}

function renderEndnote(node: EndnoteNode, context: RenderContext): Element {
  return containerWithChildren(
    'li',
    'list-item',
    node.children,
    context,
    { inEndnotes: true },
  );
}

function renderAssetImage(
  asset: LogicalAsset,
  alt: string,
  title: string | null,
  context: RenderContext,
): Element {
  const resolvedUrl = resolvedAssetUrl(asset, context);
  const image = styledElement('img', 'image', context);
  image.setAttribute('src', resolvedUrl);
  image.setAttribute('alt', alt);
  if (title) image.setAttribute('title', title);
  return image;
}

function resolvedAssetUrl(asset: LogicalAsset, context: RenderContext): string {
  const resolved = context.resolvedAssets[asset.id];
  if (!resolved || resolved.kind !== context.assetMode) {
    throw new TypeError(`Expected preflighted asset ${asset.id}`);
  }
  return resolved.url;
}

function appendReferences(root: Element, context: RenderContext): void {
  if (context.linkMode !== 'end-references' || context.references.length === 0) return;
  const section = styledElement('section', 'reference-section', context);
  const heading = styledElement('h2', 'heading-2', context);
  heading.textContent = '引用链接';
  const list = styledElement('ol', 'ordered-list', context);
  for (const reference of context.references) {
    const item = styledElement('li', 'list-item', context);
    const anchor = styledElement('a', 'link', context);
    anchor.setAttribute('href', reference.href);
    anchor.textContent = reference.href;
    item.append(anchor);
    list.append(item);
  }
  section.append(heading, list);
  root.append(section);
}

function styledElement(
  tag: AllowedFinalTag,
  role: PublicationStyleRole,
  context: RenderContext,
): Element {
  const element = document.createElement(tag);
  applyPublicationStyle(element, context.styleMap[role]);
  return element;
}

function safeHttpHref(rawHref: string): boolean {
  const href = rawHref.trim();
  if (!href || /[\\\u0000-\u001f\u007f]/.test(href)) return false;
  try {
    const protocol = new URL(href).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
