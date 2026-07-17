import { EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';
import type {
  EditorPublishDocumentSnapshot,
  RopePublishDocumentSnapshot,
} from '$lib/services/publish-document-snapshot';
import {
  createStyledCopyController,
  verifyFinalStyledCopyPayload,
  type StyledCopyControllerDependencies,
  type StyledCopyControllerState,
  type StyledCopyRuntimeError,
} from '$lib/services/styled-copy';
import type {
  StyledCopyAssetSession,
  StyledCopyAssetSessionInput,
} from '$lib/services/styled-copy-assets';
import {
  renderStyledCopyTarget,
  type StyledCopyTargetAdapterInput,
  type StyledCopyTargetAdapterResult,
} from '$lib/utils/styled-copy/targets';
import type {
  ResolvedStyledCopyAssetUrls,
  SemanticDocument,
  StyledCopyBlockingError,
  StyledCopyResult,
  StyledCopyWarning,
} from '$lib/utils/styled-copy/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function editorSource(
  fullText = '# Full document',
  selectionText: string | null = 'Selected text',
): EditorPublishDocumentSnapshot {
  const editorGeneration = EditorState.create({ doc: fullText });
  return {
    kind: 'editor',
    paneId: 'pane-1',
    tabId: 'tab-1',
    filePath: '/project/chapter.md',
    documentDir: '/project',
    projectDir: '/project',
    fullText,
    mainSelection: selectionText === null
      ? null
      : { from: 0, to: selectionText.length, text: selectionText },
    editorGeneration,
  };
}

function ropeSource(selectionText: string | null = null): RopePublishDocumentSnapshot {
  return {
    kind: 'rope',
    paneId: 'pane-1',
    tabId: 'tab-rope',
    fileId: 'rope-1',
    filePath: '/project/large.md',
    documentDir: '/project',
    projectDir: '/project',
    mainSelection: selectionText === null
      ? null
      : { from: 4, to: 4 + selectionText.length, text: selectionText },
  };
}

const SEMANTIC_DOCUMENT: SemanticDocument = {
  type: 'document',
  children: [{
    type: 'blockquote',
    children: [{
      type: 'paragraph',
      children: [{
        type: 'image',
        asset: {
          kind: 'image',
          id: 'image-1',
          source: './cover.png',
          alt: '封面',
          title: null,
        },
      }],
    }],
  }],
};

interface HarnessOptions {
  semanticDocument?: SemanticDocument;
  normalizeWarnings?: StyledCopyWarning[];
  previewWarnings?: StyledCopyWarning[];
  targetWarnings?: StyledCopyWarning[];
  finalResults?: Array<
    | { kind: 'ok'; value: ResolvedStyledCopyAssetUrls; warnings: StyledCopyWarning[] }
    | { kind: 'error'; error: StyledCopyBlockingError }
  >;
  finalGate?: Promise<void>;
  finalRenderError?: StyledCopyBlockingError;
  verifyError?: StyledCopyRuntimeError;
  clipboardError?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const clipboardCalls: Array<{ html: string; plainText: string }> = [];
  const assetSessions: StyledCopyAssetSession[] = [];
  const previewAssets: ResolvedStyledCopyAssetUrls = {
    'image-1': { kind: 'preview', url: 'data:image/png;base64,iVBORw==' },
  };
  const finalAssets: ResolvedStyledCopyAssetUrls = {
    'image-1': { kind: 'final', url: 'https://assets.example/cover.png' },
  };
  let currentEditorState: EditorState | undefined;

  const dependencies: StyledCopyControllerDependencies = {
    convertMarkdownToStyledHtml: vi.fn(async (markdown: string) => {
      order.push(`convert:${markdown}`);
      return { status: 'ok' as const, data: '<p>Pandoc</p>' };
    }),
    loadRopeSnapshot: vi.fn(async () => ({
      status: 'ok' as const,
      data: {
        text: '# Rope document',
        generation: 7,
        total_lines: 1,
        total_chars: 15,
      },
    })),
    getCurrentEditorState: vi.fn(() => currentEditorState),
    normalizePandocHtml: vi.fn((_html: string): StyledCopyResult<SemanticDocument> => {
      order.push('normalize');
      return {
        kind: 'ok',
        value: options.semanticDocument ?? SEMANTIC_DOCUMENT,
        warnings: options.normalizeWarnings ?? [],
      };
    }),
    createAssetSession: vi.fn((input: StyledCopyAssetSessionInput): StyledCopyAssetSession => {
      order.push(`assets:create:${input.assets.map((asset) => asset.id).join(',')}`);
      let finalCallIndex = 0;
      const session: StyledCopyAssetSession = {
        resolvePreview: vi.fn(async () => {
          order.push('assets:preview');
          return {
            kind: 'ok' as const,
            value: previewAssets,
            warnings: options.previewWarnings ?? [],
          };
        }),
        resolveFinal: vi.fn(async (hostId) => {
          order.push(`assets:final:${hostId ?? 'null'}`);
          if (options.finalGate) await options.finalGate;
          const result = options.finalResults?.[
            Math.min(finalCallIndex, options.finalResults.length - 1)
          ];
          finalCallIndex += 1;
          return result ?? { kind: 'ok' as const, value: finalAssets, warnings: [] };
        }),
      };
      assetSessions.push(session);
      return session;
    }),
    renderTarget: vi.fn((
      input: StyledCopyTargetAdapterInput,
    ): StyledCopyTargetAdapterResult => {
      order.push(`render:${input.assetMode}`);
      if (input.assetMode === 'final' && options.finalRenderError) {
        return { kind: 'error', error: options.finalRenderError };
      }
      return {
        kind: 'ok' as const,
        html: input.assetMode === 'final'
          ? '<section><p>Final</p></section>'
          : '<section style="color:#1f2328"><p>Preview</p></section>',
        plainText: input.assetMode === 'final' ? 'Final\n' : 'Preview\n',
        warnings: options.targetWarnings ?? [],
      };
    }),
    verifyFinalPayload: vi.fn(() => {
      order.push('verify');
      return options.verifyError ?? null;
    }),
    writeStyledClipboard: vi.fn(async (html: string, plainText: string) => {
      order.push('clipboard');
      clipboardCalls.push({ html, plainText });
      if (options.clipboardError) {
        return { status: 'error' as const, error: options.clipboardError };
      }
      return { status: 'ok' as const, data: null };
    }),
  };

  return {
    dependencies,
    order,
    clipboardCalls,
    assetSessions,
    setCurrentEditorState(state: EditorState | undefined) {
      currentEditorState = state;
    },
  };
}

describe('[contract] styled-copy controller preview orchestration', () => {
  it('exposes immutable Svelte-friendly initial state with the required defaults', () => {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);
    const states: StyledCopyControllerState[] = [];

    const unsubscribe = controller.subscribe((state) => states.push(state));

    expect(states).toEqual([controller.getState()]);
    expect(controller.getState()).toMatchObject({
      status: 'idle',
      selectionAvailable: true,
      options: {
        target: 'wechat',
        wechatTheme: 'minimal',
        linkMode: 'target-default',
        scope: 'selection',
      },
      warnings: [],
      error: null,
      previewSrcdoc: null,
    });
    expect(Object.isFrozen(controller.getState())).toBe(true);
    expect(Object.isFrozen(controller.getState().options)).toBe(true);
    expect(Object.isFrozen(controller.getState().warnings)).toBe(true);
    unsubscribe();
  });

  it('defaults to full document and cannot enable selection when none was frozen', async () => {
    const source = editorSource('# Full only', null);
    const harness = createHarness({ semanticDocument: { type: 'document', children: [] } });
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);

    expect(controller.getState().selectionAvailable).toBe(false);
    expect(controller.getState().options.scope).toBe('full-document');

    await controller.setOptions({ scope: 'selection' });

    expect(controller.getState().options.scope).toBe('full-document');
    expect(harness.order[0]).toBe('convert:# Full only');
  });

  it('orders stripped frozen source through Pandoc, normalization, assets, and preview render', async () => {
    const source = editorSource(
      '# Full document',
      '---\ntitle: Hidden\n---\n# 未保存选择',
    );
    const normalizationWarning: StyledCopyWarning = {
      code: 'relative_link_removed',
      payload: './local',
    };
    const mathWarning: StyledCopyWarning = { code: 'math_visual_degraded' };
    const harness = createHarness({
      normalizeWarnings: [normalizationWarning],
      previewWarnings: [mathWarning],
      targetWarnings: [normalizationWarning, mathWarning],
    });
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);
    const statuses: string[] = [];
    controller.subscribe((state) => statuses.push(state.status));

    await controller.requestPreview();

    expect(harness.order).toEqual([
      'convert:# 未保存选择',
      'normalize',
      'assets:create:image-1',
      'assets:preview',
      'render:preview',
    ]);
    expect(statuses).toEqual(['idle', 'converting', 'preview-ready']);
    expect(controller.getState().warnings).toEqual([
      normalizationWarning,
      mathWarning,
    ]);
    expect(controller.getState().previewSrcdoc).toContain('<!doctype html>');
    expect(controller.getState().previewSrcdoc).toContain('<meta charset="utf-8">');
    expect(controller.getState().previewSrcdoc).toContain(
      '<meta name="referrer" content="no-referrer">',
    );
    expect(controller.getState().previewSrcdoc).toContain(
      '<section style="color:#1f2328"><p>Preview</p></section>',
    );
    expect(controller.getState().previewSrcdoc).not.toContain('<script');
    expect(harness.clipboardCalls).toEqual([]);

    expect(harness.dependencies.renderTarget).toHaveBeenCalledWith(expect.objectContaining({
      target: 'wechat',
      wechatTheme: 'minimal',
      linkMode: undefined,
      assetMode: 'preview',
      resolvedAssets: previewAssetsForAssertion(),
    }));
  });

  it('loads and freezes Rope full text before conversion', async () => {
    const harness = createHarness({ semanticDocument: { type: 'document', children: [] } });
    const controller = createStyledCopyController({ source: ropeSource() }, harness.dependencies);

    await controller.requestPreview();

    expect(harness.dependencies.loadRopeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'rope-1' }),
      expect.any(AbortSignal),
    );
    expect(harness.order[0]).toBe('convert:# Rope document');
  });
});

describe('[contract] styled-copy controller unexpected dependency failures', () => {
  it('maps a thrown normalizer to a stable malformed-document error', async () => {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    harness.dependencies.normalizePandocHtml = vi.fn(() => {
      throw new Error('unbounded parser detail');
    });
    const controller = createStyledCopyController({ source }, harness.dependencies);

    await controller.requestPreview();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'malformed_document', reason: 'parser_error' },
    });
    expect(JSON.stringify(controller.getState())).not.toContain('unbounded parser detail');
    expect(harness.clipboardCalls).toEqual([]);
  });

  it.each(['create', 'resolve'] as const)('maps a thrown preview asset %s failure', async (stage) => {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    if (stage === 'create') {
      harness.dependencies.createAssetSession = vi.fn(() => {
        throw new Error('local path detail');
      });
    } else {
      harness.dependencies.createAssetSession = vi.fn((): StyledCopyAssetSession => ({
        resolvePreview: vi.fn(async () => {
          throw new Error('local path detail');
        }),
        resolveFinal: vi.fn(async () => ({ kind: 'ok' as const, value: {}, warnings: [] })),
      }));
    }
    const controller = createStyledCopyController({ source }, harness.dependencies);

    await controller.requestPreview();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'asset_resolution_failed', failures: [] },
    });
    expect(JSON.stringify(controller.getState())).not.toContain('local path detail');
    expect(harness.clipboardCalls).toEqual([]);
  });

  it('maps a thrown preview target render to a stable sanitizer error', async () => {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    harness.dependencies.renderTarget = vi.fn(() => {
      throw new Error('generated DOM detail');
    });
    const controller = createStyledCopyController({ source }, harness.dependencies);

    await controller.requestPreview();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'sanitizer_failure', reason: 'invalid_root' },
    });
    expect(JSON.stringify(controller.getState())).not.toContain('generated DOM detail');
    expect(harness.clipboardCalls).toEqual([]);
  });

  it('maps a thrown final payload verifier and never reaches clipboard', async () => {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    harness.dependencies.verifyFinalPayload = vi.fn(() => {
      throw new Error('payload detail');
    });
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();

    await controller.copy();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'invalid_clipboard_payload' },
    });
    expect(JSON.stringify(controller.getState())).not.toContain('payload detail');
    expect(harness.clipboardCalls).toEqual([]);
  });
});

describe('[contract] styled-copy controller clipboard transaction', () => {
  it('orders final assets, independent final render/plain, verification, and one native write', async () => {
    const source = editorSource();
    const harness = createHarness({
      normalizeWarnings: [{ code: 'relative_link_removed', payload: './local' }],
      targetWarnings: [{ code: 'math_visual_degraded' }],
    });
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController(
      { source, projectActiveHostId: 'project-host' },
      harness.dependencies,
    );
    await controller.requestPreview();
    harness.order.length = 0;
    const statuses: string[] = [];
    controller.subscribe((state) => statuses.push(state.status));

    await controller.copy();

    expect(harness.order).toEqual([
      'assets:final:project-host',
      'render:final',
      'verify',
      'clipboard',
    ]);
    expect(statuses).toEqual([
      'preview-ready',
      'finalizing-assets',
      'copying',
      'copied',
    ]);
    expect(harness.clipboardCalls).toEqual([{
      html: '<section><p>Final</p></section>',
      plainText: 'Final\n',
    }]);
    expect(harness.dependencies.renderTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      assetMode: 'final',
      resolvedAssets: {
        'image-1': { kind: 'final', url: 'https://assets.example/cover.png' },
      },
    }));
    expect(controller.getState().warnings).toEqual([
      { code: 'relative_link_removed', payload: './local' },
      { code: 'math_visual_degraded' },
    ]);
  });

  it('coalesces a double-click into one in-flight finalization and write', async () => {
    let releaseFinal!: () => void;
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const source = editorSource();
    const harness = createHarness({ finalGate });
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();
    harness.order.length = 0;

    const first = controller.copy();
    const second = controller.copy();

    expect(first).toBe(second);
    expect(harness.order).toEqual(['assets:final:null']);
    releaseFinal();
    await first;
    expect(harness.order).toEqual([
      'assets:final:null',
      'render:final',
      'verify',
      'clipboard',
    ]);
    expect(harness.clipboardCalls).toHaveLength(1);
  });

  it('retains one asset session so a failed finalization retry reuses its cache', async () => {
    const source = editorSource();
    const harness = createHarness({
      finalResults: [
        {
          kind: 'error',
          error: {
            code: 'asset_upload_failed',
            failures: [{ assetId: 'image-1', assetKind: 'image', reason: 'upload_failed' }],
          },
        },
        {
          kind: 'ok',
          value: {
            'image-1': { kind: 'final', url: 'https://assets.example/retry.png' },
          },
          warnings: [],
        },
      ],
    });
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();

    await controller.copy();
    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'asset_upload_failed' },
    });
    expect(harness.clipboardCalls).toEqual([]);

    await controller.copy();
    expect(controller.getState().status).toBe('copied');
    expect(harness.assetSessions).toHaveLength(1);
    expect(harness.assetSessions[0].resolveFinal).toHaveBeenCalledTimes(2);
    expect(harness.clipboardCalls).toHaveLength(1);
  });

  it.each([
    {
      name: 'final asset failure',
      options: {
        finalResults: [{
          kind: 'error' as const,
          error: {
            code: 'image_host_unavailable' as const,
          },
        }],
      },
      expected: 'image_host_unavailable',
    },
    {
      name: 'final target sanitizer failure',
      options: {
        finalRenderError: {
          code: 'sanitizer_failure' as const,
          reason: 'unsafe_image_url' as const,
        },
      },
      expected: 'sanitizer_failure',
    },
    {
      name: 'payload verification failure',
      options: {
        verifyError: { code: 'invalid_clipboard_payload' as const },
      },
      expected: 'invalid_clipboard_payload',
    },
  ])('blocks clipboard after $name', async ({ options, expected }) => {
    const source = editorSource();
    const harness = createHarness(options);
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();

    await controller.copy();

    expect(controller.getState()).toMatchObject({ status: 'error', error: { code: expected } });
    expect(harness.clipboardCalls).toEqual([]);
  });

  it('maps a failed native clipboard command without reporting copied', async () => {
    const source = editorSource();
    const harness = createHarness({ clipboardError: 'secret OS clipboard details' });
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();

    await controller.copy();

    expect(harness.clipboardCalls).toHaveLength(1);
    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'clipboard_write_failed' },
    });
    expect(JSON.stringify(controller.getState())).not.toContain('secret OS clipboard details');
  });

  it('performs zero finalization or clipboard work before a valid preview exists', async () => {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);

    await controller.copy();

    expect(harness.order).toEqual([]);
    expect(harness.clipboardCalls).toEqual([]);
    expect(controller.getState().status).toBe('idle');
  });
});

describe('[contract] styled-copy controller invalidation and source freshness', () => {
  it('reuses the exact asset session and preview resolvers for a link-only rerender', async () => {
    const normalizationWarning: StyledCopyWarning = {
      code: 'relative_link_removed',
      payload: './local',
    };
    const assetWarning: StyledCopyWarning = { code: 'math_visual_degraded' };
    const targetWarning: StyledCopyWarning = {
      code: 'table_structure_degraded',
      payload: 'wechat:table-foot-to-body',
    };
    const source = editorSource();
    const harness = createHarness({
      normalizeWarnings: [normalizationWarning],
      previewWarnings: [assetWarning],
      targetWarnings: [assetWarning, targetWarning],
      finalResults: [
        {
          kind: 'error',
          error: {
            code: 'asset_upload_failed',
            failures: [{ assetId: 'image-2', assetKind: 'image', reason: 'upload_failed' }],
          },
        },
        {
          kind: 'ok',
          value: {
            'image-1': { kind: 'final', url: 'https://assets.example/cached.png' },
          },
          warnings: [],
        },
      ],
    });
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();
    const session = harness.assetSessions[0];

    await controller.copy();
    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'asset_upload_failed' },
    });

    await controller.setOptions({ linkMode: 'anchors' });

    expect(harness.assetSessions).toEqual([session]);
    expect(harness.dependencies.convertMarkdownToStyledHtml).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.normalizePandocHtml).toHaveBeenCalledTimes(1);
    expect(session.resolvePreview).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.renderTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      linkMode: 'anchors',
      assetMode: 'preview',
      resolvedAssets: previewAssetsForAssertion(),
    }));
    expect(controller.getState()).toMatchObject({
      status: 'preview-ready',
      warnings: [normalizationWarning, assetWarning, targetWarning],
    });

    await controller.copy();

    expect(controller.getState().status).toBe('copied');
    expect(session.resolveFinal).toHaveBeenCalledTimes(2);
    expect(harness.clipboardCalls).toHaveLength(1);
  });

  it('drops the reusable artifact when a link-only rerender fails', async () => {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    const renderTarget = harness.dependencies.renderTarget;
    harness.dependencies.renderTarget = vi.fn((input: StyledCopyTargetAdapterInput) => {
      if (input.assetMode === 'preview' && input.linkMode === 'anchors') {
        return {
          kind: 'error' as const,
          error: { code: 'sanitizer_failure' as const, reason: 'invalid_root' as const },
        };
      }
      return renderTarget(input);
    });
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();

    await controller.setOptions({ linkMode: 'anchors' });
    await controller.copy();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'sanitizer_failure' },
    });
    expect(harness.assetSessions).toHaveLength(1);
    expect(harness.assetSessions[0].resolveFinal).not.toHaveBeenCalled();
    expect(harness.clipboardCalls).toEqual([]);
  });

  it('aborts and suppresses a late conversion after a target change', async () => {
    const firstConversion = deferred<{
      status: 'ok';
      data: string;
    }>();
    const secondConversion = deferred<{
      status: 'ok';
      data: string;
    }>();
    const conversions = [firstConversion, secondConversion];
    const signals: AbortSignal[] = [];
    const source = editorSource();
    const harness = createHarness({ semanticDocument: { type: 'document', children: [] } });
    harness.setCurrentEditorState(source.editorGeneration);
    harness.dependencies.convertMarkdownToStyledHtml = vi.fn((_markdown, signal) => {
      signals.push(signal);
      return conversions.shift()!.promise;
    });
    harness.dependencies.renderTarget = vi.fn((
      input: StyledCopyTargetAdapterInput,
    ): StyledCopyTargetAdapterResult => ({
      kind: 'ok' as const,
      html: `<section><p>${input.target}</p></section>`,
      plainText: `${input.target}\n`,
      warnings: [],
    }));
    const controller = createStyledCopyController({ source }, harness.dependencies);

    const stalePreview = controller.requestPreview();
    await Promise.resolve();
    const currentPreview = controller.setOptions({ target: 'zhihu' });

    expect(signals[0].aborted).toBe(true);
    secondConversion.resolve({ status: 'ok', data: '<p>new</p>' });
    await currentPreview;
    expect(controller.getState()).toMatchObject({
      status: 'preview-ready',
      options: { target: 'zhihu' },
    });
    expect(controller.getState().previewSrcdoc).toContain('<p>zhihu</p>');

    firstConversion.resolve({ status: 'ok', data: '<p>old</p>' });
    await stalePreview;
    expect(controller.getState()).toMatchObject({
      status: 'preview-ready',
      options: { target: 'zhihu' },
    });
    expect(controller.getState().previewSrcdoc).toContain('<p>zhihu</p>');
    expect(harness.dependencies.normalizePandocHtml).toHaveBeenCalledTimes(1);
  });

  it('schedules deterministic previews for scope, theme, link, and target changes', async () => {
    const source = editorSource('# Full document', '# Selected');
    const harness = createHarness({ semanticDocument: { type: 'document', children: [] } });
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);

    await controller.requestPreview();
    await controller.setOptions({ scope: 'full-document' });
    await controller.setOptions({ wechatTheme: 'technical' });
    await controller.setOptions({ linkMode: 'anchors' });
    await controller.setOptions({ target: 'zhihu' });

    expect(harness.dependencies.convertMarkdownToStyledHtml).toHaveBeenCalledTimes(4);
    expect(harness.dependencies.createAssetSession).toHaveBeenCalledTimes(4);
    expect(harness.assetSessions).toHaveLength(4);
    expect(harness.dependencies.renderTarget).toHaveBeenCalledTimes(5);
    expect(harness.dependencies.convertMarkdownToStyledHtml).toHaveBeenNthCalledWith(
      2,
      '# Full document',
      expect.any(AbortSignal),
    );
    expect(harness.dependencies.renderTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      target: 'zhihu',
      wechatTheme: 'technical',
      linkMode: 'anchors',
      assetMode: 'preview',
    }));
  });

  it('replaces the frozen source and resets unavailable selection scope', async () => {
    const firstSource = editorSource('# First', '# First selection');
    const secondSource = {
      ...editorSource('# Second document', null),
      tabId: 'tab-2',
    };
    const harness = createHarness({ semanticDocument: { type: 'document', children: [] } });
    harness.setCurrentEditorState(firstSource.editorGeneration);
    const controller = createStyledCopyController({ source: firstSource }, harness.dependencies);
    await controller.requestPreview();
    harness.setCurrentEditorState(secondSource.editorGeneration);

    await controller.setSource(secondSource);

    expect(controller.getState()).toMatchObject({
      status: 'preview-ready',
      selectionAvailable: false,
      options: { scope: 'full-document' },
    });
    expect(harness.dependencies.convertMarkdownToStyledHtml).toHaveBeenLastCalledWith(
      '# Second document',
      expect.any(AbortSignal),
    );
  });

  it('host changes create a fresh preview generation and pass only the new host to finalization', async () => {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController(
      { source, projectActiveHostId: 'host-old' },
      harness.dependencies,
    );
    await controller.requestPreview();

    await controller.setProjectActiveHostId('host-new');
    await controller.copy();

    expect(harness.assetSessions).toHaveLength(2);
    expect(harness.assetSessions[0].resolveFinal).not.toHaveBeenCalled();
    expect(harness.assetSessions[1].resolveFinal).toHaveBeenCalledWith('host-new');
    expect(harness.clipboardCalls).toHaveLength(1);
  });

  it('invalidates an in-flight finalization when options change', async () => {
    let releaseFinal!: () => void;
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const source = editorSource();
    const harness = createHarness({ finalGate });
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();

    const staleCopy = controller.copy();
    await controller.setOptions({ target: 'zhihu' });
    releaseFinal();
    await staleCopy;

    expect(controller.getState()).toMatchObject({
      status: 'preview-ready',
      options: { target: 'zhihu' },
    });
    expect(harness.clipboardCalls).toEqual([]);
  });

  it('destroy aborts current work and suppresses every late state and clipboard effect', async () => {
    const conversion = deferred<{ status: 'ok'; data: string }>();
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    const signals: AbortSignal[] = [];
    harness.dependencies.convertMarkdownToStyledHtml = vi.fn((_markdown, operationSignal) => {
      signals.push(operationSignal);
      return conversion.promise;
    });
    const controller = createStyledCopyController({ source }, harness.dependencies);
    const statuses: string[] = [];
    controller.subscribe((state) => statuses.push(state.status));

    const preview = controller.requestPreview();
    await Promise.resolve();
    controller.destroy();
    conversion.resolve({ status: 'ok', data: '<p>late</p>' });
    await preview;

    expect(signals[0]?.aborted).toBe(true);
    expect(statuses).toEqual(['idle', 'converting']);
    expect(harness.dependencies.normalizePandocHtml).not.toHaveBeenCalled();
    expect(harness.clipboardCalls).toEqual([]);
  });

  it('destroy during final asset work suppresses late state and clipboard commit', async () => {
    let releaseFinal!: () => void;
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const source = editorSource();
    const harness = createHarness({ finalGate });
    harness.setCurrentEditorState(source.editorGeneration);
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();
    const statuses: string[] = [];
    controller.subscribe((state) => statuses.push(state.status));

    const copy = controller.copy();
    expect(harness.order.at(-1)).toBe('assets:final:null');
    expect(statuses).toEqual(['preview-ready', 'finalizing-assets']);
    controller.destroy();
    const notificationCountAtDestroy = statuses.length;
    releaseFinal();
    await copy;

    expect(statuses).toHaveLength(notificationCountAtDestroy);
    expect(harness.order).not.toContain('render:final');
    expect(harness.order).not.toContain('verify');
    expect(harness.clipboardCalls).toEqual([]);
  });

  it('blocks a changed editor state immediately before native clipboard commit', async () => {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    harness.dependencies.verifyFinalPayload = vi.fn(() => {
      harness.setCurrentEditorState(EditorState.create({ doc: '# changed' }));
      return null;
    });
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();

    await controller.copy();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'source_stale' },
    });
    expect(harness.clipboardCalls).toEqual([]);
  });
});

describe('[contract] styled-copy controller Rope generations', () => {
  function ropeSnapshotResult(generation: number, text = '# Rope document') {
    return {
      status: 'ok' as const,
      data: { text, generation, total_lines: 1, total_chars: text.length },
    };
  }

  it('loads Rope even for selection scope and converts the frozen selected text', async () => {
    const harness = createHarness({ semanticDocument: { type: 'document', children: [] } });
    harness.dependencies.loadRopeSnapshot = vi.fn(async () => ropeSnapshotResult(7));
    const controller = createStyledCopyController(
      { source: ropeSource('选中的 Rope 文本') },
      harness.dependencies,
    );

    await controller.requestPreview();

    expect(harness.dependencies.loadRopeSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.convertMarkdownToStyledHtml).toHaveBeenCalledWith(
      '选中的 Rope 文本',
      expect.any(AbortSignal),
    );
  });

  it('blocks a Rope preview whose generation changes during async work', async () => {
    const harness = createHarness({ semanticDocument: { type: 'document', children: [] } });
    harness.dependencies.loadRopeSnapshot = vi.fn()
      .mockResolvedValueOnce(ropeSnapshotResult(7, '# Original'))
      .mockResolvedValueOnce(ropeSnapshotResult(8, '# Changed'));
    const controller = createStyledCopyController({ source: ropeSource() }, harness.dependencies);

    await controller.requestPreview();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'source_stale' },
    });
    expect(harness.clipboardCalls).toEqual([]);
  });

  it('checks the retained Rope generation again immediately before clipboard commit', async () => {
    const harness = createHarness({ semanticDocument: { type: 'document', children: [] } });
    harness.dependencies.loadRopeSnapshot = vi.fn()
      .mockResolvedValueOnce(ropeSnapshotResult(7))
      .mockResolvedValueOnce(ropeSnapshotResult(7))
      .mockResolvedValueOnce(ropeSnapshotResult(8));
    const controller = createStyledCopyController({ source: ropeSource() }, harness.dependencies);
    await controller.requestPreview();

    await controller.copy();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'source_stale' },
    });
    expect(harness.clipboardCalls).toEqual([]);
    expect(harness.dependencies.loadRopeSnapshot).toHaveBeenCalledTimes(3);
  });

  it('maps unavailable Rope snapshots without exposing native details', async () => {
    const harness = createHarness();
    harness.dependencies.loadRopeSnapshot = vi.fn(async () => ({
      status: 'error' as const,
      error: '/private/project path and native details',
    }));
    const controller = createStyledCopyController({ source: ropeSource() }, harness.dependencies);

    await controller.requestPreview();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: 'rope_snapshot_unavailable' },
    });
    expect(JSON.stringify(controller.getState())).not.toContain('/private/project');
    expect(harness.clipboardCalls).toEqual([]);
  });
});

describe('[contract] styled-copy controller bounded native error mapping', () => {
  async function stateForPandocError(nativeError: string) {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    harness.dependencies.convertMarkdownToStyledHtml = vi.fn(async () => ({
      status: 'error' as const,
      error: nativeError,
    }));
    const controller = createStyledCopyController({ source }, harness.dependencies);
    await controller.requestPreview();
    return controller.getState();
  }

  it('retains conservative unsupported extension names as immutable parameters', async () => {
    const state = await stateForPandocError(
      'unsupported_pandoc_extensions: mark, footnotes, raw_attribute, gfm+alerts, east-asian_width',
    );

    expect(state).toMatchObject({
      status: 'error',
      error: {
        code: 'unsupported_pandoc_extensions',
        extensions: ['mark', 'footnotes', 'raw_attribute', 'gfm+alerts', 'east-asian_width'],
      },
    });
    const error = state.error;
    expect(error?.code).toBe('unsupported_pandoc_extensions');
    if (!error || error.code !== 'unsupported_pandoc_extensions') return;
    expect(Object.isFrozen(error.extensions)).toBe(true);
    expect(Reflect.set(error.extensions, 0, 'changed')).toBe(false);
    expect(error.extensions[0]).toBe('mark');
  });

  it.each([
    ['empty suffix', 'unsupported_pandoc_extensions:'],
    ['empty member', 'unsupported_pandoc_extensions: mark,,footnotes'],
    ['path text', 'unsupported_pandoc_extensions: mark, ../../private/file'],
    ['spaced name', 'unsupported_pandoc_extensions: mark, foot notes'],
    ['secret assignment', 'unsupported_pandoc_extensions: mark, token=top-secret'],
    ['secret-like identifier', 'unsupported_pandoc_extensions: mark, api_key'],
    ['uppercase diagnostic', 'unsupported_pandoc_extensions: mark, Authorization'],
    [
      'too many names',
      `unsupported_pandoc_extensions: ${Array.from({ length: 17 }, (_, index) => `ext_${index}`).join(', ')}`,
    ],
    [
      'excessive retained size',
      `unsupported_pandoc_extensions: ${Array.from(
        { length: 9 },
        (_, index) => `ext_${index}_${'x'.repeat(56)}`,
      ).join(', ')}`,
    ],
  ])('discards $0', async (_name, nativeError) => {
    const state = await stateForPandocError(nativeError);

    expect(state).toMatchObject({
      status: 'error',
      error: { code: 'unsupported_pandoc_extensions', extensions: [] },
    });
    const unsafeSuffix = nativeError.slice(
      'unsupported_pandoc_extensions:'.length,
    ).trim();
    if (unsafeSuffix) expect(JSON.stringify(state)).not.toContain(unsafeSuffix);
  });

  it.each([
    ['pandoc_not_found', 'pandoc_not_found'],
    ['unsupported_pandoc_extensions: mark, footnotes', 'unsupported_pandoc_extensions'],
    ['pandoc_timeout', 'pandoc_timeout'],
    ['pandoc_capability_probe_timeout', 'pandoc_timeout'],
    ['pandoc_input_too_large', 'pandoc_input_too_large'],
    ['pandoc_output_too_large', 'pandoc_output_too_large'],
    ['pandoc_spawn_failed', 'pandoc_conversion_failed'],
    ['pandoc_wait_failed', 'pandoc_conversion_failed'],
    ['pandoc_input_write_failed', 'pandoc_conversion_failed'],
    ['pandoc_output_invalid_utf8', 'pandoc_conversion_failed'],
    ['pandoc_capability_probe_failed', 'pandoc_conversion_failed'],
    ['pandoc_failed: Authorization Bearer secret', 'pandoc_conversion_failed'],
    ['unknown native failure with /private/path', 'pandoc_conversion_failed'],
  ])('maps %s to %s', async (nativeError, expectedCode) => {
    const source = editorSource();
    const harness = createHarness();
    harness.setCurrentEditorState(source.editorGeneration);
    harness.dependencies.convertMarkdownToStyledHtml = vi.fn(async () => ({
      status: 'error' as const,
      error: nativeError,
    }));
    const controller = createStyledCopyController({ source }, harness.dependencies);

    await controller.requestPreview();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: { code: expectedCode },
    });
    if (nativeError !== expectedCode) {
      expect(JSON.stringify(controller.getState())).not.toContain(nativeError);
    }
    expect(harness.clipboardCalls).toEqual([]);
  });
});

describe('[contract] styled-copy final payload verification', () => {
  it('accepts independently sanitized Task 4 output with authored inline styles', () => {
    const rendered = renderStyledCopyTarget({
      document: {
        type: 'document',
        children: [{
          type: 'paragraph',
          children: [
            { type: 'text', value: '正文 ' },
            {
              type: 'link',
              href: 'http://example.com/article',
              title: null,
              children: [{ type: 'text', value: '链接' }],
            },
          ],
        }],
      },
      target: 'zhihu',
      wechatTheme: 'minimal',
      assetMode: 'final',
      resolvedAssets: {},
    });
    expect(rendered.kind).toBe('ok');
    if (rendered.kind !== 'ok') return;

    expect(verifyFinalStyledCopyPayload(rendered.html, rendered.plainText)).toBeNull();
  });

  it('accepts an HTTPS image and absolute HTTP(S) anchors without source metadata', () => {
    const html = [
      '<section>',
      '<p><a href="https://example.com/a">HTTPS</a></p>',
      '<p><a href="http://example.com/b">HTTP</a></p>',
      '<img src="https://assets.example/image.png" alt="封面">',
      '</section>',
    ].join('');

    expect(verifyFinalStyledCopyPayload(html, 'HTTPS\n\nHTTP\n\n封面\n')).toBeNull();
  });

  it.each([
    ['script tag', '<section><script>alert(1)</script></section>'],
    ['iframe tag', '<section><iframe src="https://example.com"></iframe></section>'],
    ['SVG tag', '<section><svg><script>alert(1)</script></svg></section>'],
    ['form tag', '<section><form><input></form></section>'],
    ['event handler', '<section><p onclick="alert(1)">x</p></section>'],
    ['class provenance', '<section><p class="source">x</p></section>'],
    ['id provenance', '<section><p id="source">x</p></section>'],
    ['data provenance', '<section><p data-secret="x">x</p></section>'],
    ['srcset attribute', '<section><img src="https://a.example/a.png" srcset="https://b.example/b.png" alt="x"></section>'],
    ['unknown inline style', '<section><p style="color:red">x</p></section>'],
    ['scriptable inline style', '<section><p style="background-image:url(javascript:alert(1))">x</p></section>'],
    ['javascript anchor', '<section><a href="javascript:alert(1)">x</a></section>'],
    ['encoded javascript anchor', '<section><a href="javascript&#58;alert(1)">x</a></section>'],
    ['relative anchor', '<section><a href="../private">x</a></section>'],
    ['mailto anchor', '<section><a href="mailto:x@example.com">x</a></section>'],
    ['data anchor', '<section><a href="data:text/html,bad">x</a></section>'],
    ['blob anchor', '<section><a href="blob:https://example.com/id">x</a></section>'],
    ['file anchor', '<section><a href="file:///private/file">x</a></section>'],
    ['HTTP image', '<section><img src="http://assets.example/a.png" alt="x"></section>'],
    ['relative image', '<section><img src="./a.png" alt="x"></section>'],
    ['data image', '<section><img src="data:image/png;base64,iVBORw==" alt="x"></section>'],
    ['blob image', '<section><img src="blob:https://example.com/id" alt="x"></section>'],
    ['file image', '<section><img src="file:///private/a.png" alt="x"></section>'],
    ['multiple roots', '<section><p>a</p></section><section><p>b</p></section>'],
    ['document metadata', '<meta charset="utf-8"><section><p>x</p></section>'],
  ])('blocks %s', (_name, html) => {
    expect(verifyFinalStyledCopyPayload(html, 'plain')).toEqual({
      code: 'invalid_clipboard_payload',
    });
  });

  it('rejects resource-bearing disallowed tags before DOM parsing can load them', () => {
    const parser = vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(() => {
      throw new Error('DOMParser must not receive resource-bearing disallowed tags');
    });
    try {
      expect(verifyFinalStyledCopyPayload(
        '<section><iframe src="https://network.example/private"></iframe></section>',
        'plain',
      )).toEqual({ code: 'invalid_clipboard_payload' });
      expect(parser).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
    }
  });

  it('uses the independent verifier by default before calling the native writer', async () => {
    const source = editorSource();
    const harness = createHarness({ semanticDocument: { type: 'document', children: [] } });
    harness.setCurrentEditorState(source.editorGeneration);
    const dependencies: StyledCopyControllerDependencies = {
      ...harness.dependencies,
      verifyFinalPayload: undefined,
    };
    const controller = createStyledCopyController({ source }, dependencies);
    await controller.requestPreview();

    await controller.copy();

    expect(controller.getState().status).toBe('copied');
    expect(harness.clipboardCalls).toHaveLength(1);
  });
});

function previewAssetsForAssertion(): ResolvedStyledCopyAssetUrls {
  return {
    'image-1': { kind: 'preview', url: 'data:image/png;base64,iVBORw==' },
  };
}
