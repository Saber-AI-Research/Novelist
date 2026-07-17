export const PUBLICATION_STYLE_PROPERTIES = [
  'background-color',
  'border',
  'border-bottom',
  'border-left',
  'border-top',
  'border-collapse',
  'box-sizing',
  'color',
  'display',
  'font-size',
  'font-weight',
  'height',
  'line-height',
  'margin',
  'margin-bottom',
  'margin-top',
  'max-width',
  'overflow-wrap',
  'overflow-x',
  'padding',
  'padding-left',
  'text-align',
  'text-decoration',
  'vertical-align',
  'white-space',
  'width',
  'word-break',
] as const;

export type PublicationStyleProperty = typeof PUBLICATION_STYLE_PROPERTIES[number];

export const PUBLICATION_STYLE_ROLES = [
  'article',
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
  'strong',
  'emphasis',
  'delete',
  'superscript',
  'subscript',
  'mark',
  'blockquote',
  'unordered-list',
  'ordered-list',
  'list-item',
  'link',
  'image',
  'table',
  'table-header',
  'table-cell',
  'code-block',
  'inline-code',
  'rule',
  'footnote-reference',
  'endnotes',
  'math-inline',
  'math-display',
  'reference-marker',
  'reference-section',
  'token-keyword',
  'token-value',
  'token-string',
  'token-comment',
  'token-function',
  'token-variable',
  'token-operator',
  'token-alert',
] as const;

export type PublicationStyleRole = typeof PUBLICATION_STYLE_ROLES[number];
export type PublicationStyleDeclaration = Readonly<
  Partial<Record<PublicationStyleProperty, string>>
>;
export type PublicationStyleMap = Readonly<
  Record<PublicationStyleRole, PublicationStyleDeclaration>
>;

interface StyleRecipe {
  ink: string;
  accent: string;
  secondary: string;
  divider: string;
  muted: string;
  softBackground: string;
  codeBackground: string;
  markBackground: string;
  articleFontSize: string;
  articleLineHeight: string;
  headingOneSize: string;
  headingOneBorder: string;
  headingTwoSize: string;
  headingTwoBorder: string;
  quoteBorder: string;
  tableHeaderBackground: string;
  tableHeaderColor: string;
  tablePadding: string;
  codeLineHeight: string;
}

function defineStyleMap(recipe: StyleRecipe): PublicationStyleMap {
  return Object.freeze({
    article: {
      'background-color': '#ffffff',
      color: recipe.ink,
      'font-size': recipe.articleFontSize,
      'line-height': recipe.articleLineHeight,
      'max-width': '100%',
      'overflow-wrap': 'break-word',
      'word-break': 'break-word',
    },
    paragraph: { margin: '0 0 16px' },
    'heading-1': {
      color: recipe.ink,
      'font-size': recipe.headingOneSize,
      'font-weight': '700',
      'line-height': '1.35',
      margin: '28px 0 18px',
      padding: '0 0 10px',
      'border-bottom': recipe.headingOneBorder,
    },
    'heading-2': {
      color: recipe.accent,
      'font-size': recipe.headingTwoSize,
      'font-weight': '700',
      'line-height': '1.4',
      margin: '24px 0 14px',
      'border-left': recipe.headingTwoBorder,
      'padding-left': '10px',
    },
    'heading-3': {
      color: recipe.secondary,
      'font-size': '20px',
      'font-weight': '700',
      'line-height': '1.45',
      margin: '22px 0 12px',
    },
    'heading-4': {
      color: recipe.ink,
      'font-size': '18px',
      'font-weight': '700',
      'line-height': '1.5',
      margin: '20px 0 10px',
    },
    'heading-5': {
      color: recipe.ink,
      'font-size': '16px',
      'font-weight': '700',
      'line-height': '1.5',
      margin: '18px 0 8px',
    },
    'heading-6': {
      color: recipe.muted,
      'font-size': '14px',
      'font-weight': '700',
      'line-height': '1.5',
      margin: '16px 0 8px',
    },
    strong: { color: recipe.accent },
    emphasis: { color: recipe.ink },
    delete: { color: recipe.muted },
    superscript: {
      color: recipe.ink,
      'font-size': '12px',
      'vertical-align': 'super',
    },
    subscript: {
      color: recipe.ink,
      'font-size': '12px',
      'vertical-align': 'sub',
    },
    mark: {
      'background-color': recipe.markBackground,
      color: recipe.ink,
      padding: '0 2px',
    },
    blockquote: {
      'background-color': recipe.softBackground,
      'border-left': recipe.quoteBorder,
      color: recipe.muted,
      margin: '18px 0',
      padding: '8px 14px',
    },
    'unordered-list': {
      margin: '0 0 16px',
      'padding-left': '26px',
    },
    'ordered-list': {
      margin: '0 0 16px',
      'padding-left': '26px',
    },
    'list-item': { margin: '4px 0' },
    link: {
      color: recipe.accent,
      'text-decoration': 'underline',
    },
    image: {
      display: 'block',
      height: 'auto',
      margin: '18px auto',
      'max-width': '100%',
    },
    table: {
      'border-collapse': 'collapse',
      margin: '18px 0',
      'max-width': '100%',
      width: '100%',
    },
    'table-header': {
      'background-color': recipe.tableHeaderBackground,
      border: `1px solid ${recipe.divider}`,
      color: recipe.tableHeaderColor,
      padding: recipe.tablePadding,
      'text-align': 'left',
      'vertical-align': 'top',
    },
    'table-cell': {
      border: `1px solid ${recipe.divider}`,
      padding: recipe.tablePadding,
      'vertical-align': 'top',
    },
    'code-block': {
      'background-color': recipe.codeBackground,
      'border-left': `3px solid ${recipe.secondary}`,
      'box-sizing': 'border-box',
      color: recipe.ink,
      'line-height': recipe.codeLineHeight,
      margin: '18px 0',
      'max-width': '100%',
      'overflow-x': 'auto',
      padding: '14px 16px',
      'white-space': 'pre',
    },
    'inline-code': {
      'background-color': recipe.codeBackground,
      color: recipe.accent,
      padding: '2px 4px',
      'white-space': 'pre-wrap',
    },
    rule: {
      border: '0',
      'border-top': `1px solid ${recipe.divider}`,
      margin: '24px 0',
    },
    'footnote-reference': {
      color: recipe.accent,
      'font-size': '12px',
      'vertical-align': 'super',
    },
    endnotes: {
      'border-top': `1px solid ${recipe.divider}`,
      color: recipe.muted,
      'font-size': '13px',
      'line-height': '1.65',
      'margin-top': '28px',
      'padding': '14px 0 0',
    },
    'math-inline': {
      color: recipe.ink,
      'white-space': 'pre-wrap',
    },
    'math-display': {
      'background-color': recipe.softBackground,
      color: recipe.ink,
      display: 'block',
      margin: '16px 0',
      'overflow-x': 'auto',
      padding: '10px 12px',
      'white-space': 'pre',
    },
    'reference-marker': {
      color: recipe.accent,
      'font-size': '12px',
      'vertical-align': 'super',
    },
    'reference-section': {
      'border-top': `1px solid ${recipe.divider}`,
      'margin-top': '28px',
      'padding': '14px 0 0',
    },
    'token-keyword': { color: '#6f42c1' },
    'token-value': { color: '#a45108' },
    'token-string': { color: '#18794e' },
    'token-comment': { color: '#667085' },
    'token-function': { color: '#1d4ed8' },
    'token-variable': { color: '#0f766e' },
    'token-operator': { color: '#7c3d3d' },
    'token-alert': { color: '#b42318' },
  });
}

export const WECHAT_STYLE_MAPS = Object.freeze({
  minimal: defineStyleMap({
    ink: '#1f2328',
    accent: '#2f6f5e',
    secondary: '#52606d',
    divider: '#d8dee4',
    muted: '#59636e',
    softBackground: '#f7faf9',
    codeBackground: '#f6f8fa',
    markBackground: '#e7f2ee',
    articleFontSize: '16px',
    articleLineHeight: '1.75',
    headingOneSize: '28px',
    headingOneBorder: '1px solid #d8dee4',
    headingTwoSize: '23px',
    headingTwoBorder: '3px solid #2f6f5e',
    quoteBorder: '3px solid #2f6f5e',
    tableHeaderBackground: '#f1f6f4',
    tableHeaderColor: '#1f2328',
    tablePadding: '8px 10px',
    codeLineHeight: '1.6',
  }),
  magazine: defineStyleMap({
    ink: '#222222',
    accent: '#9f3434',
    secondary: '#9a7b3f',
    divider: '#ded7ca',
    muted: '#665a50',
    softBackground: '#fbf8f3',
    codeBackground: '#f7f5f2',
    markBackground: '#f4ead7',
    articleFontSize: '16px',
    articleLineHeight: '1.8',
    headingOneSize: '30px',
    headingOneBorder: '3px solid #9a7b3f',
    headingTwoSize: '24px',
    headingTwoBorder: '4px solid #9f3434',
    quoteBorder: '4px solid #9f3434',
    tableHeaderBackground: '#9f3434',
    tableHeaderColor: '#ffffff',
    tablePadding: '9px 11px',
    codeLineHeight: '1.65',
  }),
  technical: defineStyleMap({
    ink: '#20252b',
    accent: '#2563eb',
    secondary: '#0f766e',
    divider: '#d5dbe3',
    muted: '#4d5b69',
    softBackground: '#f4f8fb',
    codeBackground: '#f3f6fa',
    markBackground: '#dff4ef',
    articleFontSize: '15px',
    articleLineHeight: '1.7',
    headingOneSize: '27px',
    headingOneBorder: '2px solid #0f766e',
    headingTwoSize: '22px',
    headingTwoBorder: '3px solid #2563eb',
    quoteBorder: '3px solid #0f766e',
    tableHeaderBackground: '#e9f0ff',
    tableHeaderColor: '#20252b',
    tablePadding: '6px 8px',
    codeLineHeight: '1.5',
  }),
});

export const ZHIHU_STYLE_MAP = defineStyleMap({
  ink: '#202124',
  accent: '#245ea8',
  secondary: '#416783',
  divider: '#d9dce1',
  muted: '#52606d',
  softBackground: '#f7f9fc',
  codeBackground: '#f6f8fa',
  markBackground: '#e8f1fb',
  articleFontSize: '16px',
  articleLineHeight: '1.75',
  headingOneSize: '28px',
  headingOneBorder: '1px solid #d9dce1',
  headingTwoSize: '23px',
  headingTwoBorder: '3px solid #245ea8',
  quoteBorder: '3px solid #245ea8',
  tableHeaderBackground: '#eef4fb',
  tableHeaderColor: '#202124',
  tablePadding: '8px 10px',
  codeLineHeight: '1.6',
});
