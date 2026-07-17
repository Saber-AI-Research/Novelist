const FINAL_SANITIZED_DOM: unique symbol = Symbol('styled-copy-final-sanitized-dom');
const trustedRoots = new WeakSet<Node>();

export type FinalSanitizedDomRoot = DocumentFragment | Element;

export type FinalSanitizedDom = Readonly<{
  root: FinalSanitizedDomRoot;
  [FINAL_SANITIZED_DOM]: true;
}>;

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'UL',
]);

export function createFinalSanitizedDom(root: FinalSanitizedDomRoot): FinalSanitizedDom {
  trustedRoots.add(root);
  return Object.freeze({ root, [FINAL_SANITIZED_DOM]: true });
}

export function serializeFinalDomToPlainText(finalDom: FinalSanitizedDom): string {
  if (
    !finalDom
    || finalDom[FINAL_SANITIZED_DOM] !== true
    || !trustedRoots.has(finalDom.root)
  ) {
    throw new TypeError('Expected a final sanitized DOM root');
  }

  const serialized = serializeBlockContainer(finalDom.root);
  return serialized ? `${serialized}\n` : '';
}

function serializeBlockContainer(parent: Node): string {
  const blocks: string[] = [];
  let inline = '';

  const flushInline = () => {
    const value = inline.trim();
    if (value) blocks.push(value);
    inline = '';
  };

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE && isBlockElement(child as Element)) {
      flushInline();
      const block = serializeBlock(child as Element);
      if (block) blocks.push(block);
    } else {
      inline += serializeInline(child);
    }
  }
  flushInline();

  return blocks.join('\n\n');
}

function serializeBlock(element: Element): string {
  switch (element.tagName) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
    case 'P':
      return serializeInlineChildren(element).trim();
    case 'BLOCKQUOTE':
      return serializeBlockquote(element);
    case 'UL':
    case 'OL':
      return serializeList(element, 0);
    case 'TABLE':
      return serializeTable(element);
    case 'PRE':
      return normalizeLineEndings(element.textContent ?? '');
    case 'HR':
      return '---';
    default:
      return serializeBlockContainer(element);
  }
}

function serializeInlineChildren(parent: Node): string {
  let result = '';
  for (const child of Array.from(parent.childNodes)) result += serializeInline(child);
  return result;
}

function serializeInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeLineEndings((node as Text).data).replace(/\s+/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const element = node as Element;
  switch (element.tagName) {
    case 'BR':
      return '\n';
    case 'IMG':
      return element.getAttribute('alt') ?? '';
    case 'CODE':
      return normalizeLineEndings(element.textContent ?? '');
    default:
      return isBlockElement(element)
        ? serializeBlock(element)
        : serializeInlineChildren(element);
  }
}

function serializeBlockquote(element: Element): string {
  return serializeBlockContainer(element)
    .split('\n')
    .map((line) => line ? `> ${line}` : '>')
    .join('\n');
}

function serializeList(element: Element, depth: number): string {
  const ordered = element.tagName === 'OL';
  const rawStart = Number.parseInt(element.getAttribute('start') ?? '', 10);
  const start = ordered && Number.isSafeInteger(rawStart) ? rawStart : 1;
  const items = Array.from(element.children).filter((child) => child.tagName === 'LI');

  return items.map((item, index) => {
    const marker = ordered ? `${start + index}.` : '-';
    return serializeListItem(item, marker, depth);
  }).join('\n');
}

function serializeListItem(element: Element, marker: string, depth: number): string {
  const content: string[] = [];
  const nestedLists: Element[] = [];
  let inline = '';

  const flushInline = () => {
    const value = inline.trim();
    if (value) content.push(value);
    inline = '';
  };

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const childElement = child as Element;
      if (childElement.tagName === 'UL' || childElement.tagName === 'OL') {
        flushInline();
        nestedLists.push(childElement);
        continue;
      }
      if (isBlockElement(childElement)) {
        flushInline();
        const block = serializeBlock(childElement);
        if (block) content.push(block);
        continue;
      }
    }
    inline += serializeInline(child);
  }
  flushInline();

  const indent = '  '.repeat(depth);
  const continuationIndent = `${indent}${' '.repeat(marker.length + 1)}`;
  const lines = content.join('\n').split('\n');
  const output = lines[0]
    ? [`${indent}${marker} ${lines[0]}`]
    : [`${indent}${marker}`];
  for (const line of lines.slice(1)) output.push(`${continuationIndent}${line}`);
  for (const nested of nestedLists) output.push(serializeList(nested, depth + 1));
  return output.join('\n');
}

function serializeTable(element: Element): string {
  return tableRows(element).map((row) => (
    Array.from(row.children)
      .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
      .map((cell) => serializeBlockContainer(cell).replace(/\s*\n+\s*/g, ' ').trim())
      .join('\t')
  )).join('\n');
}

function tableRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of Array.from(table.children)) {
    if (child.tagName === 'TR') {
      rows.push(child);
      continue;
    }
    if (child.tagName !== 'THEAD' && child.tagName !== 'TBODY' && child.tagName !== 'TFOOT') {
      continue;
    }
    for (const row of Array.from(child.children)) {
      if (row.tagName === 'TR') rows.push(row);
    }
  }
  return rows;
}

function isBlockElement(element: Element): boolean {
  return BLOCK_TAGS.has(element.tagName);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}
