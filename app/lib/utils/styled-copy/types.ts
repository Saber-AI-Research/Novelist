export type StyledCopyTarget = 'wechat' | 'zhihu';

export type WechatTheme = 'minimal' | 'magazine' | 'technical';

export type LinkMode = 'anchors' | 'end-references';

export type CopyScope = 'selection' | 'full-document';

export type StyledCopyAssetMode = 'final' | 'preview';

export type ResolvedStyledCopyAssetUrl =
  | { readonly kind: 'final'; readonly url: string }
  | { readonly kind: 'preview'; readonly url: string };

export type ResolvedStyledCopyAssetUrls = Readonly<
  Record<string, ResolvedStyledCopyAssetUrl>
>;

export type StyledCopyWarningCode =
  | 'unsafe_link_removed'
  | 'relative_link_removed'
  | 'malformed_link'
  | 'malformed_footnote'
  | 'duplicate_footnote'
  | 'malformed_image'
  | 'table_structure_degraded'
  | 'math_visual_degraded';

export interface StyledCopyWarning {
  code: StyledCopyWarningCode;
  payload?: string;
}

export type ComplexityDimension = 'nodes' | 'depth' | 'table_rows' | 'table_columns';

export type StyledCopySanitizerFailureReason =
  | 'invalid_root'
  | 'disallowed_tag'
  | 'disallowed_attribute'
  | 'invalid_attribute'
  | 'unsafe_anchor_url'
  | 'unsafe_image_url'
  | 'unsafe_style';

export type StyledCopyBlockingError =
  | {
      code: 'document_too_complex';
      dimension: ComplexityDimension;
      maximum: number;
      actual: number;
      tableIndex?: number;
    }
  | {
      code: 'malformed_document';
      reason: 'parser_error' | 'missing_body';
    }
  | {
      code: 'malformed_table';
      tableIndex: number;
      reason: 'empty_row';
    }
  | {
      code: 'sanitizer_failure';
      reason: StyledCopySanitizerFailureReason;
    }
  | {
      code: 'unresolved_asset';
      assetId: string;
      assetKind: 'image' | 'mermaid';
    }
  | {
      code: 'resolved_asset_mode_mismatch';
      assetId: string;
      expected: StyledCopyAssetMode;
      actual: StyledCopyAssetMode;
    };

export type StyledCopyResult<T> =
  | { kind: 'ok'; value: T; warnings: StyledCopyWarning[] }
  | { kind: 'error'; error: StyledCopyBlockingError };

export interface LogicalImageAsset {
  kind: 'image';
  id: string;
  source: string;
  alt: string;
  title: string | null;
}

export interface LogicalMermaidAsset {
  kind: 'mermaid';
  id: string;
  source: string;
}

export type LogicalAsset = LogicalImageAsset | LogicalMermaidAsset;

export interface SemanticDocument {
  type: 'document';
  children: SemanticNode[];
}

export interface TextNode {
  type: 'text';
  value: string;
}

export interface ParagraphNode {
  type: 'paragraph';
  children: SemanticNode[];
}

export interface HeadingNode {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: SemanticNode[];
}

export interface EmphasisNode {
  type: 'emphasis';
  children: SemanticNode[];
}

export interface StrongNode {
  type: 'strong';
  children: SemanticNode[];
}

export interface DeleteNode {
  type: 'delete';
  children: SemanticNode[];
}

export interface MarkNode {
  type: 'mark';
  children: SemanticNode[];
}

export interface SuperscriptNode {
  type: 'superscript';
  children: SemanticNode[];
}

export interface SubscriptNode {
  type: 'subscript';
  children: SemanticNode[];
}

export interface LinkNode {
  type: 'link';
  href: string;
  title: string | null;
  children: SemanticNode[];
}

export interface ImageNode {
  type: 'image';
  asset: LogicalImageAsset;
}

export interface BlockquoteNode {
  type: 'blockquote';
  children: SemanticNode[];
}

export interface ListNode {
  type: 'list';
  ordered: boolean;
  start: number | null;
  children: ListItemNode[];
}

export interface ListItemNode {
  type: 'list-item';
  children: SemanticNode[];
}

export interface TableNode {
  type: 'table';
  children: TableRowNode[];
}

export interface TableRowNode {
  type: 'table-row';
  section: 'head' | 'body' | 'foot';
  children: TableCellNode[];
}

export interface TableCellNode {
  type: 'table-cell';
  header: boolean;
  colSpan: number;
  rowSpan: number;
  children: SemanticNode[];
}

export interface InlineCodeNode {
  type: 'inline-code';
  value: string;
}

export type PandocCodeTokenKind =
  | 'keyword'
  | 'data-type'
  | 'decimal'
  | 'base-n'
  | 'float'
  | 'constant'
  | 'char'
  | 'special-char'
  | 'string'
  | 'verbatim-string'
  | 'special-string'
  | 'import'
  | 'comment'
  | 'documentation'
  | 'annotation'
  | 'comment-variable'
  | 'other'
  | 'function'
  | 'variable'
  | 'control-flow'
  | 'operator'
  | 'built-in'
  | 'extension'
  | 'preprocessor'
  | 'attribute'
  | 'region-marker'
  | 'information'
  | 'warning'
  | 'alert'
  | 'error';

export interface CodeTokenNode {
  type: 'code-token';
  kind: PandocCodeTokenKind;
  value: string;
}

export interface CodeBlockNode {
  type: 'code-block';
  language: string | null;
  children: Array<TextNode | CodeTokenNode>;
}

export interface FootnoteReferenceNode {
  type: 'footnote-reference';
  number: number;
}

export interface EndnotesNode {
  type: 'endnotes';
  children: EndnoteNode[];
}

export interface EndnoteNode {
  type: 'endnote';
  number: number;
  children: SemanticNode[];
}

export interface MathNode {
  type: 'math';
  display: boolean;
  expression: string;
}

export interface MermaidNode {
  type: 'mermaid';
  asset: LogicalMermaidAsset;
}

export interface BreakNode {
  type: 'break';
  kind: 'soft' | 'hard';
}

export interface RuleNode {
  type: 'rule';
}

export type SemanticNode =
  | TextNode
  | ParagraphNode
  | HeadingNode
  | EmphasisNode
  | StrongNode
  | DeleteNode
  | MarkNode
  | SuperscriptNode
  | SubscriptNode
  | LinkNode
  | ImageNode
  | BlockquoteNode
  | ListNode
  | ListItemNode
  | TableNode
  | TableRowNode
  | TableCellNode
  | InlineCodeNode
  | CodeTokenNode
  | CodeBlockNode
  | FootnoteReferenceNode
  | EndnotesNode
  | EndnoteNode
  | MathNode
  | MermaidNode
  | BreakNode
  | RuleNode;
