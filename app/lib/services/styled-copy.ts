import type { EditorState } from '@codemirror/state';
import { commands, type RopeSnapshot } from '$lib/ipc/commands';
import type {
  EditorPublishDocumentSnapshot,
  RopePublishDocumentSnapshot,
} from '$lib/services/publish-document-snapshot';
import { stripFrontMatter } from '$lib/services/publish';
import {
  createStyledCopyAssetSession,
  type StyledCopyAssetSession,
  type StyledCopyAssetSessionInput,
} from '$lib/services/styled-copy-assets';
import {
  getEditorView,
  getViewportSnapshotMetadata,
} from '$lib/stores/tabs.svelte';
import { normalizePandocHtml } from '$lib/utils/styled-copy/normalize';
import { ALLOWED_FINAL_TAGS } from '$lib/utils/styled-copy/sanitize';
import {
  renderStyledCopyTarget,
  type StyledCopyTargetAdapterInput,
  type StyledCopyTargetAdapterResult,
} from '$lib/utils/styled-copy/targets';
import {
  PUBLICATION_STYLE_PROPERTIES,
  PUBLICATION_STYLE_ROLES,
  WECHAT_STYLE_MAPS,
  ZHIHU_STYLE_MAP,
} from '$lib/utils/styled-copy/themes';
import type {
  CopyScope,
  LinkMode,
  LogicalAsset,
  ResolvedStyledCopyAssetUrls,
  SemanticDocument,
  SemanticNode,
  StyledCopyAssetFailure,
  StyledCopyBlockingError,
  StyledCopyResult,
  StyledCopyTarget,
  StyledCopyWarning,
  WechatTheme,
} from '$lib/utils/styled-copy/types';
import { createWarningCollector } from '$lib/utils/styled-copy/warnings';

export type StyledCopySource =
  | EditorPublishDocumentSnapshot
  | RopePublishDocumentSnapshot;

export type StyledCopyControllerStatus =
  | 'idle'
  | 'converting'
  | 'preview-ready'
  | 'finalizing-assets'
  | 'copying'
  | 'copied'
  | 'error';

export type StyledCopyLinkMode = 'target-default' | LinkMode;

export interface StyledCopyControllerOptions {
  readonly target: StyledCopyTarget;
  readonly wechatTheme: WechatTheme;
  readonly linkMode: StyledCopyLinkMode;
  readonly scope: CopyScope;
}

export type StyledCopyRuntimeError =
  | { readonly code: 'source_stale' }
  | { readonly code: 'rope_snapshot_unavailable' }
  | { readonly code: 'pandoc_not_found' }
  | {
      readonly code: 'unsupported_pandoc_extensions';
      readonly extensions: readonly string[];
    }
  | { readonly code: 'pandoc_timeout' }
  | { readonly code: 'pandoc_input_too_large' }
  | { readonly code: 'pandoc_output_too_large' }
  | { readonly code: 'pandoc_conversion_failed' }
  | { readonly code: 'clipboard_write_failed' }
  | { readonly code: 'invalid_clipboard_payload' };

type StyledCopyFailureError = {
  readonly code: 'asset_resolution_failed' | 'asset_upload_failed';
  readonly failures: readonly Readonly<StyledCopyAssetFailure>[];
};

export type StyledCopyControllerError =
  | Exclude<
      StyledCopyBlockingError,
      { code: 'asset_resolution_failed' | 'asset_upload_failed' }
    >
  | StyledCopyFailureError
  | StyledCopyRuntimeError;

export interface StyledCopyControllerState {
  readonly status: StyledCopyControllerStatus;
  readonly selectionAvailable: boolean;
  readonly options: Readonly<StyledCopyControllerOptions>;
  readonly previewSrcdoc: string | null;
  readonly warnings: readonly StyledCopyWarning[];
  readonly error: Readonly<StyledCopyControllerError> | null;
}

type NativeResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'error'; error: string };

export interface StyledCopyControllerDependencies {
  convertMarkdownToStyledHtml(
    markdown: string,
    signal: AbortSignal,
  ): Promise<NativeResult<string>>;
  loadRopeSnapshot(
    source: RopePublishDocumentSnapshot,
    signal: AbortSignal,
  ): Promise<NativeResult<RopeSnapshot>>;
  getCurrentEditorState(tabId: string): EditorState | undefined;
  normalizePandocHtml(html: string): StyledCopyResult<SemanticDocument>;
  createAssetSession(input: StyledCopyAssetSessionInput): StyledCopyAssetSession;
  renderTarget(input: StyledCopyTargetAdapterInput): StyledCopyTargetAdapterResult;
  verifyFinalPayload?(html: string, plainText: string): StyledCopyRuntimeError | null;
  writeStyledClipboard?(
    html: string,
    plainText: string,
  ): Promise<NativeResult<null>>;
}

export interface CreateStyledCopyControllerInput {
  source: StyledCopySource;
  projectActiveHostId?: string | null;
}

export interface StyledCopyController {
  subscribe(listener: (state: StyledCopyControllerState) => void): () => void;
  getState(): StyledCopyControllerState;
  requestPreview(): Promise<StyledCopyControllerState>;
  copy(): Promise<StyledCopyControllerState>;
  setOptions(
    options: Partial<StyledCopyControllerOptions>,
  ): Promise<StyledCopyControllerState>;
  setSource(source: StyledCopySource): Promise<StyledCopyControllerState>;
  setProjectActiveHostId(hostId: string | null): Promise<StyledCopyControllerState>;
  destroy(): void;
}

interface PreviewArtifact {
  document: SemanticDocument;
  assetSession: StyledCopyAssetSession;
  previewAssets: ResolvedStyledCopyAssetUrls;
  normalizationWarnings: readonly StyledCopyWarning[];
  previewWarnings: readonly StyledCopyWarning[];
  ropeGeneration: number | null;
}

const FINAL_TAGS = new Set<string>(ALLOWED_FINAL_TAGS);
const AUTHORED_FINAL_STYLES = collectAuthoredFinalStyles();
const UNSAFE_ATTRIBUTE_CHARACTER = /[\\\u0000-\u001f\u007f]/;
const UNSUPPORTED_EXTENSIONS_PREFIX = 'unsupported_pandoc_extensions:';
const SAFE_EXTENSION_NAME = /^[a-z0-9][a-z0-9_+-]{0,63}$/;
const SECRET_LIKE_EXTENSION_NAME = /(?:api[_+-]?key|authorization|bearer|credential|password|passwd|secret|token)/;
const MAX_UNSUPPORTED_EXTENSION_COUNT = 16;
const MAX_UNSUPPORTED_EXTENSION_TEXT = 512;
const NO_UNSUPPORTED_EXTENSIONS: readonly string[] = Object.freeze([]);

const DEFAULT_DEPENDENCIES: StyledCopyControllerDependencies = {
  convertMarkdownToStyledHtml(markdown) {
    return commands.convertMarkdownToStyledHtml(markdown);
  },
  async loadRopeSnapshot(source) {
    const manager = getViewportSnapshotMetadata(source.tabId)?.manager;
    if (manager?.fileId === source.fileId) {
      try {
        const data = await manager.snapshot();
        return { status: 'ok', data };
      } catch {
        return { status: 'error', error: 'rope_snapshot_unavailable' };
      }
    }
    return commands.ropeSnapshot(source.fileId);
  },
  getCurrentEditorState(tabId) {
    return getEditorView(tabId)?.state;
  },
  normalizePandocHtml,
  createAssetSession: createStyledCopyAssetSession,
  renderTarget: renderStyledCopyTarget,
  verifyFinalPayload: verifyFinalStyledCopyPayload,
  writeStyledClipboard(html, plainText) {
    return commands.writeStyledClipboard(html, plainText);
  },
};

export function createStyledCopyController(
  input: CreateStyledCopyControllerInput,
  dependencies: StyledCopyControllerDependencies = DEFAULT_DEPENDENCIES,
): StyledCopyController {
  let source = input.source;
  let projectActiveHostId = input.projectActiveHostId ?? null;
  let operationGeneration = 0;
  let operationController: AbortController | null = null;
  let copyPromise: Promise<StyledCopyControllerState> | null = null;
  let destroyed = false;
  let previewArtifact: PreviewArtifact | null = null;
  const listeners = new Set<(state: StyledCopyControllerState) => void>();
  let state = createState({
    status: 'idle',
    selectionAvailable: hasSelection(source),
    options: initialOptions(source),
    previewSrcdoc: null,
    warnings: [],
    error: null,
  });

  const publishState = (next: StyledCopyControllerState) => {
    if (destroyed) return;
    state = createState(next);
    for (const listener of listeners) listener(state);
  };

  const requestPreview = async (): Promise<StyledCopyControllerState> => {
    if (destroyed) return state;
    operationController?.abort();
    copyPromise = null;
    const controller = new AbortController();
    operationController = controller;
    const generation = ++operationGeneration;
    previewArtifact = null;

    if (!sourceIsCurrent(source, dependencies)) {
      publishState(errorState(state, { code: 'source_stale' }));
      return state;
    }

    publishState(createState({
      ...state,
      status: 'converting',
      previewSrcdoc: null,
      warnings: [],
      error: null,
    }));

    const resolved = await resolveScopedMarkdown(source, state.options.scope, dependencies, controller.signal);
    if (!isActive(generation, controller.signal)) return state;
    if (resolved.kind === 'error') {
      publishState(errorState(state, resolved.error));
      return state;
    }

    let converted: NativeResult<string>;
    try {
      converted = await dependencies.convertMarkdownToStyledHtml(
        stripFrontMatter(resolved.markdown),
        controller.signal,
      );
    } catch {
      converted = { status: 'error', error: 'pandoc_conversion_failed' };
    }
    if (!isActive(generation, controller.signal)) return state;
    if (converted.status !== 'ok') {
      publishState(errorState(state, mapPandocError(converted.error)));
      return state;
    }

    let normalized: StyledCopyResult<SemanticDocument>;
    try {
      normalized = dependencies.normalizePandocHtml(converted.data);
    } catch {
      normalized = {
        kind: 'error',
        error: { code: 'malformed_document', reason: 'parser_error' },
      };
    }
    if (!isActive(generation, controller.signal)) return state;
    if (normalized.kind === 'error') {
      publishState(errorState(state, normalized.error));
      return state;
    }

    let assetSession: StyledCopyAssetSession;
    try {
      assetSession = dependencies.createAssetSession({
        assets: collectLogicalAssets(normalized.value),
        documentDir: source.documentDir,
        projectDir: source.projectDir,
        target: state.options.target,
        wechatTheme: state.options.wechatTheme,
      });
    } catch {
      publishState(errorState(state, { code: 'asset_resolution_failed', failures: [] }));
      return state;
    }
    let previewAssets: Awaited<ReturnType<StyledCopyAssetSession['resolvePreview']>>;
    try {
      previewAssets = await assetSession.resolvePreview();
    } catch {
      previewAssets = {
        kind: 'error',
        error: { code: 'asset_resolution_failed', failures: [] },
      };
    }
    if (!isActive(generation, controller.signal)) return state;
    if (previewAssets.kind === 'error') {
      publishState(errorState(state, previewAssets.error));
      return state;
    }

    let rendered: StyledCopyTargetAdapterResult;
    try {
      rendered = dependencies.renderTarget({
        document: normalized.value,
        target: state.options.target,
        wechatTheme: state.options.wechatTheme,
        linkMode: explicitLinkMode(state.options.linkMode),
        assetMode: 'preview',
        resolvedAssets: previewAssets.value,
      });
    } catch {
      rendered = {
        kind: 'error',
        error: { code: 'sanitizer_failure', reason: 'invalid_root' },
      };
    }
    if (!isActive(generation, controller.signal)) return state;
    if (rendered.kind === 'error') {
      publishState(errorState(state, rendered.error));
      return state;
    }

    const sourceError = await currentSourceError(
      source,
      resolved.ropeGeneration,
      dependencies,
      controller.signal,
    );
    if (!isActive(generation, controller.signal)) return state;
    if (sourceError) {
      publishState(errorState(state, sourceError));
      return state;
    }

    previewArtifact = Object.freeze({
      document: normalized.value,
      assetSession,
      previewAssets: freezeResolvedAssets(previewAssets.value),
      normalizationWarnings: freezeWarnings(normalized.warnings),
      previewWarnings: freezeWarnings(previewAssets.warnings),
      ropeGeneration: resolved.ropeGeneration,
    });
    publishState(createState({
      ...state,
      status: 'preview-ready',
      previewSrcdoc: buildPreviewSrcdoc(rendered.html),
      warnings: mergeWarnings(
        normalized.warnings,
        previewAssets.warnings,
        rendered.warnings,
      ),
      error: null,
    }));
    return state;
  };

  const rerenderPreviewForLinkMode = async (
    artifact: PreviewArtifact,
  ): Promise<StyledCopyControllerState> => {
    if (destroyed) return state;
    operationController?.abort();
    copyPromise = null;
    const controller = new AbortController();
    operationController = controller;
    const generation = ++operationGeneration;
    previewArtifact = null;

    if (!sourceIsCurrent(source, dependencies)) {
      publishState(errorState({ ...state, previewSrcdoc: null }, { code: 'source_stale' }));
      return state;
    }

    publishState(createState({
      ...state,
      status: 'converting',
      previewSrcdoc: null,
      warnings: [],
      error: null,
    }));

    let rendered: StyledCopyTargetAdapterResult;
    try {
      rendered = dependencies.renderTarget({
        document: artifact.document,
        target: state.options.target,
        wechatTheme: state.options.wechatTheme,
        linkMode: explicitLinkMode(state.options.linkMode),
        assetMode: 'preview',
        resolvedAssets: artifact.previewAssets,
      });
    } catch {
      rendered = {
        kind: 'error',
        error: { code: 'sanitizer_failure', reason: 'invalid_root' },
      };
    }
    if (!isActive(generation, controller.signal)) return state;
    if (rendered.kind === 'error') {
      publishState(errorState(state, rendered.error));
      return state;
    }

    const sourceError = await currentSourceError(
      source,
      artifact.ropeGeneration,
      dependencies,
      controller.signal,
    );
    if (!isActive(generation, controller.signal)) return state;
    if (sourceError) {
      publishState(errorState(state, sourceError));
      return state;
    }

    previewArtifact = artifact;
    publishState(createState({
      ...state,
      status: 'preview-ready',
      previewSrcdoc: buildPreviewSrcdoc(rendered.html),
      warnings: mergeWarnings(
        artifact.normalizationWarnings,
        artifact.previewWarnings,
        rendered.warnings,
      ),
      error: null,
    }));
    return state;
  };

  const copy = (): Promise<StyledCopyControllerState> => {
    if (copyPromise) return copyPromise;
    if (destroyed || !previewArtifact) return Promise.resolve(state);
    const artifact = previewArtifact;
    const options = state.options;
    const activeHostId = projectActiveHostId;
    operationController?.abort();
    const controller = new AbortController();
    operationController = controller;
    const generation = ++operationGeneration;

    const transaction = runCopyTransaction(
      artifact,
      options,
      activeHostId,
      generation,
      controller.signal,
    );
    copyPromise = transaction;
    void transaction.then(
      () => {
        if (copyPromise === transaction) copyPromise = null;
      },
      () => {
        if (copyPromise === transaction) copyPromise = null;
      },
    );
    return transaction;
  };

  async function runCopyTransaction(
    artifact: PreviewArtifact,
    options: Readonly<StyledCopyControllerOptions>,
    projectActiveHostId: string | null,
    generation: number,
    signal: AbortSignal,
  ): Promise<StyledCopyControllerState> {
    if (source.kind === 'editor' && !sourceIsCurrent(source, dependencies)) {
      publishState(errorState(state, { code: 'source_stale' }));
      return state;
    }
    publishState(createState({ ...state, status: 'finalizing-assets', error: null }));

    let finalAssets: Awaited<ReturnType<StyledCopyAssetSession['resolveFinal']>>;
    try {
      finalAssets = await artifact.assetSession.resolveFinal(projectActiveHostId);
    } catch {
      finalAssets = {
        kind: 'error',
        error: { code: 'asset_upload_failed', failures: [] },
      };
    }
    if (!isActive(generation, signal)) return state;
    if (finalAssets.kind === 'error') {
      publishState(errorState(state, finalAssets.error));
      return state;
    }

    let rendered: StyledCopyTargetAdapterResult;
    try {
      rendered = dependencies.renderTarget({
        document: artifact.document,
        target: options.target,
        wechatTheme: options.wechatTheme,
        linkMode: explicitLinkMode(options.linkMode),
        assetMode: 'final',
        resolvedAssets: finalAssets.value,
      });
    } catch {
      rendered = {
        kind: 'error',
        error: { code: 'sanitizer_failure', reason: 'invalid_root' },
      };
    }
    if (!isActive(generation, signal)) return state;
    if (rendered.kind === 'error') {
      publishState(errorState(state, rendered.error));
      return state;
    }

    const verifyFinalPayload = dependencies.verifyFinalPayload
      ?? verifyFinalStyledCopyPayload;
    let verificationError: StyledCopyRuntimeError | null;
    try {
      verificationError = verifyFinalPayload(rendered.html, rendered.plainText);
    } catch {
      verificationError = { code: 'invalid_clipboard_payload' };
    }
    if (verificationError) {
      publishState(errorState(state, verificationError));
      return state;
    }
    if (!isActive(generation, signal)) return state;
    const sourceError = await currentSourceError(
      source,
      artifact.ropeGeneration,
      dependencies,
      signal,
    );
    if (!isActive(generation, signal)) return state;
    if (sourceError) {
      publishState(errorState(state, sourceError));
      return state;
    }
    if (!dependencies.writeStyledClipboard) {
      publishState(errorState(state, { code: 'clipboard_write_failed' }));
      return state;
    }

    publishState(createState({ ...state, status: 'copying', error: null }));
    let clipboardResult: NativeResult<null>;
    try {
      clipboardResult = await dependencies.writeStyledClipboard(
        rendered.html,
        rendered.plainText,
      );
    } catch {
      clipboardResult = { status: 'error', error: 'clipboard_write_failed' };
    }
    if (!isActive(generation, signal)) return state;
    if (clipboardResult.status !== 'ok') {
      publishState(errorState(state, { code: 'clipboard_write_failed' }));
      return state;
    }

    publishState(createState({
      ...state,
      status: 'copied',
      warnings: mergeWarnings(
        artifact.normalizationWarnings,
        finalAssets.warnings,
        rendered.warnings,
      ),
      error: null,
    }));
    return state;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    getState() {
      return state;
    },
    requestPreview,
    copy,
    setOptions(nextOptions) {
      const previousOptions = state.options;
      const selectionAvailable = hasSelection(source);
      const requestedScope = nextOptions.scope ?? state.options.scope;
      const scope = requestedScope === 'selection' && !selectionAvailable
        ? 'full-document'
        : requestedScope;
      state = createState({
        ...state,
        selectionAvailable,
        options: {
          ...state.options,
          ...nextOptions,
          scope,
        },
      });
      if (previewArtifact && isLinkModeOnlyChange(previousOptions, state.options)) {
        return rerenderPreviewForLinkMode(previewArtifact);
      }
      return requestPreview();
    },
    setSource(nextSource) {
      source = nextSource;
      const selectionAvailable = hasSelection(source);
      state = createState({
        ...state,
        selectionAvailable,
        options: {
          ...state.options,
          scope: state.options.scope === 'selection' && !selectionAvailable
            ? 'full-document'
            : state.options.scope,
        },
      });
      return requestPreview();
    },
    setProjectActiveHostId(hostId) {
      projectActiveHostId = hostId;
      return requestPreview();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      operationGeneration += 1;
      operationController?.abort();
      operationController = null;
      copyPromise = null;
      previewArtifact = null;
      listeners.clear();
    },
  };

  function isActive(generation: number, signal: AbortSignal): boolean {
    return !destroyed
      && !signal.aborted
      && generation === operationGeneration;
  }
}

export function verifyFinalStyledCopyPayload(
  html: string,
  _plainText: string,
): StyledCopyRuntimeError | null {
  if (
    !html
    || html !== html.trim()
    || !html.startsWith('<section')
    || !html.endsWith('</section>')
    || containsDisallowedRawTag(html)
  ) {
    return invalidClipboardPayload();
  }

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const bodyChildren = Array.from(parsed.body.childNodes);
  if (
    bodyChildren.length !== 1
    || bodyChildren[0].nodeType !== Node.ELEMENT_NODE
    || (bodyChildren[0] as Element).tagName !== 'SECTION'
  ) {
    return invalidClipboardPayload();
  }

  const stack = [...bodyChildren];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) return invalidClipboardPayload();
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (!FINAL_TAGS.has(tag)) return invalidClipboardPayload();

    for (const attribute of Array.from(element.attributes)) {
      if (!verifyFinalAttribute(tag, attribute.name.toLowerCase(), attribute.value)) {
        return invalidClipboardPayload();
      }
    }
    if (tag === 'a' && !element.hasAttribute('href')) return invalidClipboardPayload();
    if (tag === 'img' && (!element.hasAttribute('src') || !element.hasAttribute('alt'))) {
      return invalidClipboardPayload();
    }
    stack.push(...Array.from(element.childNodes));
  }
  return null;
}

function containsDisallowedRawTag(html: string): boolean {
  for (const match of html.matchAll(/<\s*\/?\s*([A-Za-z][A-Za-z0-9-]*)\b/g)) {
    if (!FINAL_TAGS.has(match[1].toLowerCase())) return true;
  }
  return false;
}

function verifyFinalAttribute(tag: string, name: string, value: string): boolean {
  if (name === 'style') return Boolean(value) && AUTHORED_FINAL_STYLES.has(value);
  if (name === 'href') return tag === 'a' && isAbsoluteHttpUrl(value);
  if (name === 'src') return tag === 'img' && isAbsoluteHttpsImageUrl(value);
  if (name === 'alt') return tag === 'img' && !UNSAFE_ATTRIBUTE_CHARACTER.test(value);
  if (name === 'title') {
    return (tag === 'a' || tag === 'img') && !UNSAFE_ATTRIBUTE_CHARACTER.test(value);
  }
  if (name === 'start') return tag === 'ol' && isCanonicalInteger(value, false);
  if (name === 'colspan' || name === 'rowspan') {
    return (tag === 'th' || tag === 'td') && isCanonicalInteger(value, true);
  }
  return false;
}

function isAbsoluteHttpUrl(value: string): boolean {
  if (!value || value !== value.trim() || UNSAFE_ATTRIBUTE_CHARACTER.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isAbsoluteHttpsImageUrl(value: string): boolean {
  if (!isAbsoluteHttpUrl(value)) return false;
  const parsed = new URL(value);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
}

function isCanonicalInteger(value: string, positive: boolean): boolean {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed)
    && String(parsed) === value
    && (!positive || parsed > 0);
}

function collectAuthoredFinalStyles(): ReadonlySet<string> {
  const values = new Set<string>();
  for (const styleMap of [
    WECHAT_STYLE_MAPS.minimal,
    WECHAT_STYLE_MAPS.magazine,
    WECHAT_STYLE_MAPS.technical,
    ZHIHU_STYLE_MAP,
  ]) {
    for (const role of PUBLICATION_STYLE_ROLES) {
      const declarations: string[] = [];
      for (const property of PUBLICATION_STYLE_PROPERTIES) {
        const value = styleMap[role][property];
        if (value !== undefined) declarations.push(`${property}:${value}`);
      }
      if (declarations.length > 0) values.add(declarations.join(';'));
    }
  }
  return values;
}

function invalidClipboardPayload(): StyledCopyRuntimeError {
  return { code: 'invalid_clipboard_payload' };
}

function initialOptions(source: StyledCopySource): StyledCopyControllerOptions {
  return {
    target: 'wechat',
    wechatTheme: 'minimal',
    linkMode: 'target-default',
    scope: hasSelection(source) ? 'selection' : 'full-document',
  };
}

function isLinkModeOnlyChange(
  previous: Readonly<StyledCopyControllerOptions>,
  next: Readonly<StyledCopyControllerOptions>,
): boolean {
  return previous.linkMode !== next.linkMode
    && previous.target === next.target
    && previous.wechatTheme === next.wechatTheme
    && previous.scope === next.scope;
}

function hasSelection(source: StyledCopySource): boolean {
  return Boolean(source.mainSelection?.text.length);
}

function sourceIsCurrent(
  source: StyledCopySource,
  dependencies: StyledCopyControllerDependencies,
): boolean {
  return source.kind === 'rope'
    || dependencies.getCurrentEditorState(source.tabId) === source.editorGeneration;
}

async function resolveScopedMarkdown(
  source: StyledCopySource,
  scope: CopyScope,
  dependencies: StyledCopyControllerDependencies,
  signal: AbortSignal,
): Promise<
  | { kind: 'ok'; markdown: string; ropeGeneration: number | null }
  | { kind: 'error'; error: StyledCopyRuntimeError }
> {
  if (source.kind === 'editor') {
    const markdown = scope === 'selection' && source.mainSelection?.text.length
      ? source.mainSelection.text
      : source.fullText;
    return { kind: 'ok', markdown, ropeGeneration: null };
  }

  try {
    const snapshot = await dependencies.loadRopeSnapshot(source, signal);
    if (snapshot.status !== 'ok') {
      return { kind: 'error', error: { code: 'rope_snapshot_unavailable' } };
    }
    const frozen = Object.freeze({
      text: snapshot.data.text,
      generation: snapshot.data.generation,
    });
    return {
      kind: 'ok',
      markdown: scope === 'selection' && source.mainSelection?.text.length
        ? source.mainSelection.text
        : frozen.text,
      ropeGeneration: frozen.generation,
    };
  } catch {
    return { kind: 'error', error: { code: 'rope_snapshot_unavailable' } };
  }
}

async function currentSourceError(
  source: StyledCopySource,
  ropeGeneration: number | null,
  dependencies: StyledCopyControllerDependencies,
  signal: AbortSignal,
): Promise<StyledCopyRuntimeError | null> {
  if (source.kind === 'editor') {
    return sourceIsCurrent(source, dependencies) ? null : { code: 'source_stale' };
  }
  if (ropeGeneration === null) return { code: 'rope_snapshot_unavailable' };
  try {
    const current = await dependencies.loadRopeSnapshot(source, signal);
    if (current.status !== 'ok') return { code: 'rope_snapshot_unavailable' };
    return current.data.generation === ropeGeneration ? null : { code: 'source_stale' };
  } catch {
    return { code: 'rope_snapshot_unavailable' };
  }
}

function mapPandocError(nativeError: string): StyledCopyRuntimeError {
  if (nativeError === 'pandoc_not_found') return { code: 'pandoc_not_found' };
  if (nativeError.startsWith(UNSUPPORTED_EXTENSIONS_PREFIX)) {
    return {
      code: 'unsupported_pandoc_extensions',
      extensions: parseUnsupportedExtensions(nativeError),
    };
  }
  if (nativeError === 'pandoc_timeout' || nativeError === 'pandoc_capability_probe_timeout') {
    return { code: 'pandoc_timeout' };
  }
  if (nativeError === 'pandoc_input_too_large') return { code: 'pandoc_input_too_large' };
  if (nativeError === 'pandoc_output_too_large') return { code: 'pandoc_output_too_large' };
  return { code: 'pandoc_conversion_failed' };
}

function parseUnsupportedExtensions(nativeError: string): readonly string[] {
  const suffix = nativeError.slice(UNSUPPORTED_EXTENSIONS_PREFIX.length);
  if (!suffix || suffix.length > MAX_UNSUPPORTED_EXTENSION_TEXT) {
    return NO_UNSUPPORTED_EXTENSIONS;
  }
  const extensions = suffix.split(',').map((extension) => extension.trim());
  if (
    extensions.length > MAX_UNSUPPORTED_EXTENSION_COUNT
    || extensions.some((extension) => (
      !SAFE_EXTENSION_NAME.test(extension)
      || SECRET_LIKE_EXTENSION_NAME.test(extension)
    ))
    || extensions.reduce((total, extension) => total + extension.length, 0)
      > MAX_UNSUPPORTED_EXTENSION_TEXT
  ) {
    return NO_UNSUPPORTED_EXTENSIONS;
  }
  return Object.freeze([...extensions]);
}

function collectLogicalAssets(document: SemanticDocument): LogicalAsset[] {
  const assets: LogicalAsset[] = [];
  const stack = [...document.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'image' || node.type === 'mermaid') {
      assets.push({ ...node.asset });
    }
    stack.push(...[...semanticChildren(node)].reverse());
  }
  return assets;
}

function semanticChildren(node: SemanticNode): readonly SemanticNode[] {
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
    case 'list':
    case 'list-item':
    case 'table':
    case 'table-row':
    case 'table-cell':
    case 'endnotes':
    case 'endnote':
      return node.children;
    default:
      return [];
  }
}

function explicitLinkMode(linkMode: StyledCopyLinkMode): LinkMode | undefined {
  return linkMode === 'target-default' ? undefined : linkMode;
}

function buildPreviewSrcdoc(article: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '</head><body>',
    article,
    '</body></html>',
  ].join('');
}

function mergeWarnings(
  ...groups: ReadonlyArray<readonly StyledCopyWarning[]>
): readonly StyledCopyWarning[] {
  const collector = createWarningCollector();
  for (const group of groups) {
    for (const warning of group) collector.add(warning);
  }
  return freezeWarnings(collector.values());
}

function freezeWarnings(warnings: readonly StyledCopyWarning[]): readonly StyledCopyWarning[] {
  return Object.freeze(warnings.map((warning) => Object.freeze({ ...warning })));
}

function freezeResolvedAssets(
  assets: ResolvedStyledCopyAssetUrls,
): ResolvedStyledCopyAssetUrls {
  const frozen: Record<string, { readonly kind: 'final' | 'preview'; readonly url: string }> = {};
  for (const [assetId, resolved] of Object.entries(assets)) {
    frozen[assetId] = Object.freeze({ ...resolved });
  }
  return Object.freeze(frozen);
}

function errorState(
  state: StyledCopyControllerState,
  error: StyledCopyControllerError,
): StyledCopyControllerState {
  return createState({
    ...state,
    status: 'error',
    warnings: [],
    error,
  });
}

function createState(state: StyledCopyControllerState): StyledCopyControllerState {
  return Object.freeze({
    ...state,
    options: Object.freeze({ ...state.options }),
    warnings: freezeWarnings(state.warnings),
    error: state.error === null ? null : freezeError(state.error),
  });
}

function freezeError(
  error: StyledCopyControllerError,
): Readonly<StyledCopyControllerError> {
  if ('failures' in error) {
    return Object.freeze({
      ...error,
      failures: Object.freeze(error.failures.map((failure) => Object.freeze({ ...failure }))),
    });
  }
  if (error.code === 'unsupported_pandoc_extensions') {
    return Object.freeze({
      ...error,
      extensions: Object.freeze([...error.extensions]),
    });
  }
  return Object.freeze({ ...error });
}
