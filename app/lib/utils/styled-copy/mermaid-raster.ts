import type { MermaidConfig } from 'mermaid';

export const MAX_MERMAID_SOURCE_CHARS = 50_000;
export const MAX_MERMAID_CSS_DIMENSION = 4_096;
export const MAX_MERMAID_RASTER_PIXELS = 16_000_000;
const MAX_MERMAID_SCALE = 2;
const MAX_MERMAID_SVG_CHARS = 5_000_000;
const FORBIDDEN_SVG_ELEMENTS = new Set([
  'animate',
  'animatemotion',
  'animatetransform',
  'discard',
  'embed',
  'foreignobject',
  'iframe',
  'object',
  'script',
  'set',
]);
const SECURE_MERMAID_CONFIG = Object.freeze([
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'maxEdges',
  'suppressErrorRendering',
  'htmlLabels',
  'flowchart',
  'deterministicIds',
  'deterministicIDSeed',
]);

let renderCounter = 0;
let renderBoundary: Promise<void> = Promise.resolve();

export type MermaidRasterFailureReason =
  | 'source_too_large'
  | 'unsafe_svg'
  | 'invalid_dimensions'
  | 'render_failed';

export class MermaidRasterError extends Error {
  constructor(readonly reason: MermaidRasterFailureReason) {
    super('Mermaid rasterization failed');
    this.name = 'MermaidRasterError';
  }
}

export interface MermaidRasterInput {
  source: string;
  background: string;
  theme: MermaidConfig['theme'];
  scale?: number;
}

export interface MermaidRasterOutput {
  bytes: Uint8Array;
  mime: 'image/png';
}

export interface OpaqueSvgRasterInput {
  svg: string;
  widthCss: number;
  heightCss: number;
  scale: number;
  background: string;
}

export interface MermaidRasterizerDependencies {
  loadMermaid?: () => Promise<MermaidRenderApi>;
  rasterizeSvg?: (input: OpaqueSvgRasterInput) => Promise<Uint8Array>;
}

export interface MermaidRenderApi {
  initialize(config: MermaidConfig): void;
  render(id: string, source: string, container?: Element): Promise<{ svg: string }>;
}

export interface OpaqueSvgRasterDependencies {
  createCanvas: () => HTMLCanvasElement;
  loadSvgImage: (svg: string) => Promise<CanvasImageSource>;
  encodePng: (canvas: HTMLCanvasElement) => Promise<Uint8Array>;
}

export type MermaidRasterizer = (
  input: MermaidRasterInput,
) => Promise<MermaidRasterOutput>;

interface SanitizedSvg {
  svg: string;
  widthCss: number;
  heightCss: number;
}

export function createMermaidRasterizer(
  dependencies: MermaidRasterizerDependencies = {},
): MermaidRasterizer {
  const loadMermaid = dependencies.loadMermaid ?? defaultLoadMermaid;
  const rasterizeSvg = dependencies.rasterizeSvg ?? rasterizeSvgToOpaquePng;

  return async (input) => {
    if (input.source.length > MAX_MERMAID_SOURCE_CHARS) {
      throw new MermaidRasterError('source_too_large');
    }
    const scale = boundedScale(input.scale);
    const rendered = await serializeRenderBoundary(async () => {
      try {
        const mermaid = await loadMermaid();
        const id = `novelist-styled-copy-mermaid-${renderCounter++}`;
        mermaid.initialize(strictMermaidConfig(input.theme, id));
        const { svg } = await mermaid.render(id, input.source);
        return sanitizeRenderedSvg(svg);
      } catch (error) {
        if (error instanceof MermaidRasterError) throw error;
        throw new MermaidRasterError('render_failed');
      }
    });
    validateRasterDimensions(rendered.widthCss, rendered.heightCss, scale);

    try {
      const bytes = await rasterizeSvg({
        ...rendered,
        scale,
        background: input.background,
      });
      if (bytes.length === 0) throw new MermaidRasterError('render_failed');
      return { bytes, mime: 'image/png' };
    } catch (error) {
      if (error instanceof MermaidRasterError) throw error;
      throw new MermaidRasterError('render_failed');
    }
  };
}

export const rasterizeMermaid = createMermaidRasterizer();

export async function rasterizeSvgToOpaquePng(
  input: OpaqueSvgRasterInput,
  dependencies: OpaqueSvgRasterDependencies = DEFAULT_OPAQUE_RASTER_DEPENDENCIES,
): Promise<Uint8Array> {
  if (!/^#[0-9a-f]{6}$/i.test(input.background)) {
    throw new MermaidRasterError('render_failed');
  }
  validateRasterDimensions(input.widthCss, input.heightCss, input.scale);
  const width = Math.ceil(input.widthCss * input.scale);
  const height = Math.ceil(input.heightCss * input.scale);
  const canvas = dependencies.createCanvas();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new MermaidRasterError('render_failed');
  const image = await dependencies.loadSvgImage(input.svg);
  context.fillStyle = input.background;
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const bytes = await dependencies.encodePng(canvas);
  if (bytes.length === 0) throw new MermaidRasterError('render_failed');
  return bytes;
}

const DEFAULT_OPAQUE_RASTER_DEPENDENCIES: OpaqueSvgRasterDependencies = {
  createCanvas: () => document.createElement('canvas'),
  loadSvgImage: loadSvgImage,
  encodePng: encodeCanvasPng,
};

async function defaultLoadMermaid(): Promise<MermaidRenderApi> {
  return (await import('mermaid')).default;
}

function strictMermaidConfig(
  theme: MermaidConfig['theme'],
  deterministicIDSeed: string,
): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    secure: [...SECURE_MERMAID_CONFIG],
    maxTextSize: MAX_MERMAID_SOURCE_CHARS,
    maxEdges: 1_000,
    deterministicIds: true,
    deterministicIDSeed,
    theme: theme ?? 'neutral',
  };
}

function serializeRenderBoundary<T>(operation: () => Promise<T>): Promise<T> {
  const result = renderBoundary.then(operation, operation);
  renderBoundary = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function sanitizeRenderedSvg(svg: string): SanitizedSvg {
  if (
    !svg
    || svg.length > MAX_MERMAID_SVG_CHARS
    || /<!DOCTYPE|<!ENTITY/i.test(svg)
  ) {
    throw new MermaidRasterError('unsafe_svg');
  }
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (
    parsed.getElementsByTagName('parsererror').length > 0
    || parsed.documentElement.localName.toLowerCase() !== 'svg'
    || parsed.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg'
  ) {
    throw new MermaidRasterError('unsafe_svg');
  }

  const root = parsed.documentElement;
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const elementName = element.localName.toLowerCase();
    if (FORBIDDEN_SVG_ELEMENTS.has(elementName)) {
      throw new MermaidRasterError('unsafe_svg');
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on') || name === 'xml:base') {
        throw new MermaidRasterError('unsafe_svg');
      }
      if (name === 'href' || name === 'xlink:href' || name === 'src') {
        if (!safeLocalFragment(value)) throw new MermaidRasterError('unsafe_svg');
      }
      if ((name === 'style' || /url\s*\(/i.test(value)) && unsafeCss(value)) {
        throw new MermaidRasterError('unsafe_svg');
      }
    }
    if (elementName === 'style' && unsafeCss(element.textContent ?? '')) {
      throw new MermaidRasterError('unsafe_svg');
    }
  }

  const dimensions = svgDimensions(root);
  return {
    svg: new XMLSerializer().serializeToString(root),
    ...dimensions,
  };
}

function unsafeCss(css: string): boolean {
  if (
    /\\|@import|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:|blob\s*:|file\s*:|https?\s*:|\/\//i.test(css)
  ) {
    return true;
  }
  const urlPattern = /url\s*\(\s*([^)]+?)\s*\)/gi;
  let match: RegExpExecArray | null;
  let urlCount = 0;
  while ((match = urlPattern.exec(css)) !== null) {
    urlCount += 1;
    const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!safeLocalFragment(value)) return true;
  }
  return /url\s*\(/i.test(css) && urlCount === 0;
}

function safeLocalFragment(value: string): boolean {
  return /^#[A-Za-z0-9_.:-]+$/.test(value);
}

function svgDimensions(root: Element): Pick<SanitizedSvg, 'widthCss' | 'heightCss'> {
  const width = numericCssDimension(root.getAttribute('width'));
  const height = numericCssDimension(root.getAttribute('height'));
  if (width !== null && (width <= 0 || width > MAX_MERMAID_CSS_DIMENSION)) {
    throw new MermaidRasterError('invalid_dimensions');
  }
  if (height !== null && (height <= 0 || height > MAX_MERMAID_CSS_DIMENSION)) {
    throw new MermaidRasterError('invalid_dimensions');
  }

  let widthCss: number;
  let heightCss: number;
  if (width !== null && height !== null) {
    widthCss = width;
    heightCss = height;
  } else {
    const viewBox = parseViewBox(root.getAttribute('viewBox'));
    if (!viewBox) throw new MermaidRasterError('invalid_dimensions');
    widthCss = viewBox.width;
    heightCss = viewBox.height;
  }
  if (
    widthCss <= 0
    || heightCss <= 0
    || widthCss > MAX_MERMAID_CSS_DIMENSION
    || heightCss > MAX_MERMAID_CSS_DIMENSION
  ) {
    throw new MermaidRasterError('invalid_dimensions');
  }
  return { widthCss, heightCss };
}

function numericCssDimension(value: string | null): number | null {
  if (value === null || !/^\s*(?:\d+(?:\.\d+)?|\.\d+)(?:px)?\s*$/i.test(value)) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseViewBox(
  value: string | null,
): { width: number; height: number } | null {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  return { width: parts[2], height: parts[3] };
}

function boundedScale(value: number | undefined): number {
  const scale = value ?? MAX_MERMAID_SCALE;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new MermaidRasterError('invalid_dimensions');
  }
  return Math.min(scale, MAX_MERMAID_SCALE);
}

function validateRasterDimensions(widthCss: number, heightCss: number, scale: number): void {
  if (
    !Number.isFinite(widthCss)
    || !Number.isFinite(heightCss)
    || widthCss <= 0
    || heightCss <= 0
    || widthCss > MAX_MERMAID_CSS_DIMENSION
    || heightCss > MAX_MERMAID_CSS_DIMENSION
    || !Number.isFinite(scale)
    || scale <= 0
    || scale > MAX_MERMAID_SCALE
  ) {
    throw new MermaidRasterError('invalid_dimensions');
  }
  const width = Math.ceil(widthCss * scale);
  const height = Math.ceil(heightCss * scale);
  if (width * height > MAX_MERMAID_RASTER_PIXELS) {
    throw new MermaidRasterError('invalid_dimensions');
  }
}

async function loadSvgImage(svg: string): Promise<CanvasImageSource> {
  const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new MermaidRasterError('render_failed'));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function encodeCanvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new MermaidRasterError('render_failed'));
    }, 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}
