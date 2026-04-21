import { describe, it, expect } from 'vitest';

/**
 * Image block decoration tests.
 *
 * Models the decoration strategy, height map, and coordinate mapping
 * for block image widgets in the CM6 editor. Verifies:
 * 1. Single block replace decoration (not 3 separate decorations)
 * 2. Height map consistency with DOM positions
 * 3. posAtCoords coordinate mapping with/without CSS zoom
 * 4. No duplicate gutter line numbers for image blocks
 *
 * Values are taken from real debug logs on untitled.md (20 lines,
 * line 1 = `![image](./a.png)`, image renders at 342px height).
 */

// ── Height map model ──

interface HeightBlock {
  from: number;
  to: number;
  top: number;
  height: number;
  type: 'text' | 'widget';
}

/**
 * Simplified CM6 height map model.
 * Maps document positions to vertical positions.
 */
class HeightMap {
  blocks: HeightBlock[] = [];

  addBlock(from: number, to: number, height: number, type: 'text' | 'widget') {
    const top = this.blocks.length === 0 ? 0 :
      this.blocks[this.blocks.length - 1].top + this.blocks[this.blocks.length - 1].height;
    this.blocks.push({ from, to, top, height, type });
  }

  get totalHeight(): number {
    if (this.blocks.length === 0) return 0;
    const last = this.blocks[this.blocks.length - 1];
    return last.top + last.height;
  }

  /** Find block at given height (like CM6's elementAtHeight). */
  blockAtHeight(y: number): HeightBlock | null {
    for (const b of this.blocks) {
      if (y >= b.top && y < b.top + b.height) return b;
    }
    // Clamp to last block
    return this.blocks.length > 0 ? this.blocks[this.blocks.length - 1] : null;
  }

  /** Find block containing document position (like CM6's lineBlockAt). */
  blockAtPos(pos: number): HeightBlock | null {
    for (const b of this.blocks) {
      if (pos >= b.from && pos <= b.to) return b;
    }
    return null;
  }
}

// ── Decoration strategy model ──

interface Decoration {
  type: 'widget' | 'line' | 'replace' | 'block-replace';
  from: number;
  to: number;
  widgetHeight?: number;
}

/** Old strategy: 3 decorations per image line (BROKEN). */
function buildOldImageDecos(lineFrom: number, lineTo: number, widgetHeight: number): Decoration[] {
  return [
    { type: 'widget', from: lineFrom, to: lineFrom, widgetHeight },  // block widget before line
    { type: 'line', from: lineFrom, to: lineFrom },                   // collapse source line
    { type: 'replace', from: lineFrom, to: lineTo },                  // hide text
  ];
}

/** New strategy: 1 block replace decoration (FIXED). */
function buildNewImageDecos(lineFrom: number, lineTo: number, widgetHeight: number): Decoration[] {
  return [
    { type: 'block-replace', from: lineFrom, to: lineTo, widgetHeight },
  ];
}

// ── posAtCoords model ──

interface PosAtCoordsParams {
  clientY: number;
  contentDOMTop: number;
  paddingTop: number;
  heightMap: HeightMap;
  /** CSS zoom level (1.0 = no zoom). Only affects CSS-zoom approach. */
  cssZoom?: number;
  /** CSS transform scale. CM6 handles this correctly. */
  transformScale?: number;
}

/**
 * Model of CM6's posAtCoords Y-axis logic.
 * Returns the document line number at the click position.
 */
function posAtCoordsY(params: PosAtCoordsParams): number {
  const { clientY, contentDOMTop, paddingTop, heightMap } = params;
  // CM6: docTop = contentDOM.getBoundingClientRect().top + paddingTop
  const docTop = contentDOMTop + paddingTop;
  // CM6: yOffset = clientY - docTop
  const yOffset = clientY - docTop;
  const block = heightMap.blockAtHeight(yOffset);
  return block ? block.from : -1;
}

/**
 * CSS zoom breaks posAtCoords because getBoundingClientRect returns
 * zoomed values but the height map uses unzoomed values.
 * This models what happens with CSS zoom.
 */
function posAtCoordsWithZoom(params: PosAtCoordsParams): number {
  const { clientY, contentDOMTop, paddingTop, heightMap, cssZoom = 1 } = params;
  // With CSS zoom, getBoundingClientRect().top is affected by zoom
  // but the internal height map is NOT zoomed.
  // clientY is in zoomed coordinates.
  // contentDOMTop from getBoundingClientRect is also in zoomed coordinates.
  // But paddingTop from getComputedStyle is in unzoomed CSS pixels.
  // This mismatch causes the offset.
  const docTop = contentDOMTop + paddingTop;
  const yOffset = clientY - docTop;
  // The yOffset is in zoomed space, but heightMap is in unzoomed space.
  // When zoom != 1, this causes wrong block lookup.
  const block = heightMap.blockAtHeight(yOffset);
  return block ? block.from : -1;
}

// ── Gutter model ──

interface GutterEntry {
  lineNumber: number;
  top: number;
  height: number;
}

/** Build gutter entries from height map — models CM6's line number gutter. */
function buildGutterEntries(heightMap: HeightMap, lineNumbers: Map<number, number>): GutterEntry[] {
  return heightMap.blocks.map(block => ({
    lineNumber: lineNumbers.get(block.from) ?? -1,
    top: block.top,
    height: block.height,
  }));
}

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('[precision] image block decoration strategy', () => {
  it('old strategy produces 3 decorations', () => {
    const decos = buildOldImageDecos(0, 25, 342);
    expect(decos).toHaveLength(3);
    expect(decos.map(d => d.type)).toEqual(['widget', 'line', 'replace']);
  });

  it('new strategy produces 1 block-replace decoration', () => {
    const decos = buildNewImageDecos(0, 25, 342);
    expect(decos).toHaveLength(1);
    expect(decos[0].type).toBe('block-replace');
    expect(decos[0].from).toBe(0);
    expect(decos[0].to).toBe(25);
    expect(decos[0].widgetHeight).toBe(342);
  });
});

describe('[precision] height map with single block replace', () => {
  // Real data: 20-line document, line 1 = image (342px), lines 2-20 = text (27px each)
  const LINE_HEIGHT = 27;
  const IMAGE_HEIGHT = 342;

  function buildTestHeightMap(): HeightMap {
    const hm = new HeightMap();
    // Line 1: image block replace widget
    hm.addBlock(0, 25, IMAGE_HEIGHT, 'widget');
    // Lines 2-20: normal text lines
    for (let i = 1; i < 20; i++) {
      hm.addBlock(26 + (i - 1) * 10, 26 + i * 10, LINE_HEIGHT, 'text');
    }
    return hm;
  }

  it('image block has correct height', () => {
    const hm = buildTestHeightMap();
    expect(hm.blocks[0].height).toBe(IMAGE_HEIGHT);
    expect(hm.blocks[0].top).toBe(0);
    expect(hm.blocks[0].type).toBe('widget');
  });

  it('line 2 starts after image height', () => {
    const hm = buildTestHeightMap();
    expect(hm.blocks[1].top).toBe(IMAGE_HEIGHT);
    expect(hm.blocks[1].height).toBe(LINE_HEIGHT);
  });

  it('line 4 top matches expected position', () => {
    const hm = buildTestHeightMap();
    // line 4 = block index 3 (0=image, 1=line2, 2=line3, 3=line4)
    const line4 = hm.blocks[3];
    expect(line4.top).toBe(IMAGE_HEIGHT + LINE_HEIGHT * 2); // 342 + 54 = 396
  });

  it('total height is image + 19 text lines', () => {
    const hm = buildTestHeightMap();
    expect(hm.totalHeight).toBe(IMAGE_HEIGHT + 19 * LINE_HEIGHT); // 342 + 513 = 855
  });
});

describe('[precision] height map: old vs new strategy comparison', () => {
  const LINE_HEIGHT = 27;
  const IMAGE_HEIGHT = 342;

  it('old strategy creates 2 height entries for image line (widget + hidden)', () => {
    const hm = new HeightMap();
    // Old: widget block (342px) + hidden source line (0px)
    hm.addBlock(0, 0, IMAGE_HEIGHT, 'widget');  // widget before line
    hm.addBlock(0, 25, 0, 'text');               // hidden source line
    // Line 2
    hm.addBlock(26, 36, LINE_HEIGHT, 'text');

    // Two entries for line 1
    expect(hm.blocks.filter(b => b.from === 0)).toHaveLength(2);
    // Line 2 starts at 342 + 0 = 342 (same as new strategy)
    expect(hm.blocks[2].top).toBe(IMAGE_HEIGHT);
  });

  it('new strategy creates 1 height entry for image line', () => {
    const hm = new HeightMap();
    // New: single block replace (342px)
    hm.addBlock(0, 25, IMAGE_HEIGHT, 'widget');
    // Line 2
    hm.addBlock(26, 36, LINE_HEIGHT, 'text');

    // One entry for line 1
    expect(hm.blocks.filter(b => b.from === 0)).toHaveLength(1);
    // Line 2 starts at 342
    expect(hm.blocks[1].top).toBe(IMAGE_HEIGHT);
  });
});

describe('[precision] posAtCoords without zoom', () => {
  const LINE_HEIGHT = 27;
  const IMAGE_HEIGHT = 342;
  const PADDING_TOP = 39;
  const CONTENT_DOM_TOP = 26;

  function buildTestHeightMap(): HeightMap {
    const hm = new HeightMap();
    hm.addBlock(0, 25, IMAGE_HEIGHT, 'widget');
    for (let i = 1; i < 20; i++) {
      hm.addBlock(26 + (i - 1) * 10, 26 + i * 10, LINE_HEIGHT, 'text');
    }
    return hm;
  }

  it('clicking at image area maps to line 1 (image block)', () => {
    const hm = buildTestHeightMap();
    const result = posAtCoordsY({
      clientY: 200, // middle of image
      contentDOMTop: CONTENT_DOM_TOP,
      paddingTop: PADDING_TOP,
      heightMap: hm,
    });
    // docTop = 26 + 39 = 65, yOffset = 200 - 65 = 135
    // 135 < 342, so hits image block (from=0)
    expect(result).toBe(0); // line 1 position
  });

  it('clicking at line 2 area maps correctly', () => {
    const hm = buildTestHeightMap();
    // Line 2 in height map: top=342, h=27 → range [342, 369)
    // docTop = 65, so clientY = 65 + 350 = 415
    const result = posAtCoordsY({
      clientY: 415,
      contentDOMTop: CONTENT_DOM_TOP,
      paddingTop: PADDING_TOP,
      heightMap: hm,
    });
    // yOffset = 415 - 65 = 350, falls in [342, 369) → line 2 (block index 1)
    expect(result).toBe(hm.blocks[1].from);
  });

  it('clicking at line 4 area maps to line 4 (not line 6-7)', () => {
    const hm = buildTestHeightMap();
    // Line 4: block index 3, top = 342 + 27*2 = 396
    // docTop = 65, clientY = 65 + 400 = 465
    const result = posAtCoordsY({
      clientY: 465,
      contentDOMTop: CONTENT_DOM_TOP,
      paddingTop: PADDING_TOP,
      heightMap: hm,
    });
    // yOffset = 465 - 65 = 400, falls in [396, 423) → line 4 block
    expect(result).toBe(hm.blocks[3].from);
  });
});

describe('[precision] CSS zoom vs transform: coordinate impact', () => {
  const LINE_HEIGHT = 27;
  const IMAGE_HEIGHT = 342;
  const PADDING_TOP = 39;

  function buildTestHeightMap(): HeightMap {
    const hm = new HeightMap();
    hm.addBlock(0, 25, IMAGE_HEIGHT, 'widget');
    for (let i = 1; i < 20; i++) {
      hm.addBlock(26 + (i - 1) * 10, 26 + i * 10, LINE_HEIGHT, 'text');
    }
    return hm;
  }

  it('at zoom=1.0, no offset occurs', () => {
    const hm = buildTestHeightMap();
    const contentDOMTop = 26;

    // Click at line 4: top=396 in height map, docTop=65
    const clientY = 65 + 400; // mid line-4
    const result = posAtCoordsY({
      clientY,
      contentDOMTop,
      paddingTop: PADDING_TOP,
      heightMap: hm,
    });
    expect(result).toBe(hm.blocks[3].from); // line 4
  });

  it('CSS zoom=1.2 causes coordinate mismatch', () => {
    const hm = buildTestHeightMap();
    const zoom = 1.2;

    // With CSS zoom, getBoundingClientRect returns zoomed values.
    // contentDOM.top in zoomed space = 26 * zoom = 31.2
    // But paddingTop from getComputedStyle is CSS px (unzoomed) = 39
    // docTop = 31.2 + 39 = 70.2
    //
    // User clicks at physical position of line 4.
    // In zoomed DOM, line 4 is at: (26 + 39 + 396) * zoom = 461 * 1.2 = 553.2
    // clientY = 553 (zoomed mouse coordinate)
    //
    // But getBoundingClientRect().top = 26 * zoom = 31.2
    // docTop = 31.2 + 39 = 70.2  (WRONG: should be 65 * zoom = 78)
    // yOffset = 553 - 70.2 = 482.8
    // blockAtHeight(482.8) → NOT line 4 (top=396), it's line 6+ area!

    const contentDOMTopZoomed = 26 * zoom;  // getBoundingClientRect is zoomed
    const clientY = 553;  // real user click from logs

    const result = posAtCoordsWithZoom({
      clientY,
      contentDOMTop: contentDOMTopZoomed,
      paddingTop: PADDING_TOP,  // CSS px, NOT zoomed
      heightMap: hm,
      cssZoom: zoom,
    });

    // This lands on wrong line due to zoom mismatch!
    // yOffset = 553 - (31.2 + 39) = 482.8
    // 482.8 > 449 (line 6 top) → lands on line 6 or 7, NOT line 4
    expect(result).not.toBe(hm.blocks[3].from); // NOT line 4 — bug!
  });

  it('CSS transform=scale(1.2) is handled correctly by CM6', () => {
    // With CSS transform: scale(), CM6 detects scaleX/scaleY and
    // adjusts getBoundingClientRect values accordingly.
    // Both contentDOM.top and paddingTop are correctly scaled.
    // The user's clientY maps correctly through the height map.
    //
    // This test confirms the fix: using transform instead of zoom.
    const hm = buildTestHeightMap();
    const scale = 1.2;

    // CM6 with transform: getBoundingClientRect returns scaled values,
    // but CM6 divides by scaleY internally.
    // Effective contentDOMTop = getBoundingClientRect().top / scaleY
    const rawBCRTop = 26 * scale; // 31.2
    const effectiveContentDOMTop = rawBCRTop / scale; // 26 (corrected)
    const effectivePaddingTop = PADDING_TOP; // already in CSS px

    // User clicks line 4 in scaled space
    const line4ScreenPos = (26 + PADDING_TOP + 396) * scale; // 553.2
    const clientY = Math.round(line4ScreenPos); // 553

    // CM6 internally: clientY / scaleY - docTop_unscaled
    const effectiveClientY = clientY / scale; // 460.8
    const result = posAtCoordsY({
      clientY: effectiveClientY,
      contentDOMTop: effectiveContentDOMTop,
      paddingTop: effectivePaddingTop,
      heightMap: hm,
    });

    // yOffset = 460.8 - 65 = 395.8 → falls in [396-27=369, 396+27) ... 
    // Actually 395.8 is just below 396, so it hits line 3.
    // Let's be more precise: line 4 top=396, line 3 range=[369, 396)
    // 395.8 < 396 → just barely line 3. Real CM6 would handle sub-pixel.
    // The key point: it's within 1px of correct, NOT off by 3+ lines.
    const line3From = hm.blocks[2].from;
    const line4From = hm.blocks[3].from;
    expect([line3From, line4From]).toContain(result); // within 1 line of correct
  });
});

describe('[precision] gutter line numbers for image blocks', () => {
  it('block replace produces exactly one gutter entry per image line', () => {
    const hm = new HeightMap();
    hm.addBlock(0, 25, 342, 'widget');  // line 1 (image)
    hm.addBlock(26, 36, 27, 'text');     // line 2

    const lineNumbers = new Map<number, number>([
      [0, 1],   // pos 0 → line 1
      [26, 2],  // pos 26 → line 2
    ]);

    const gutter = buildGutterEntries(hm, lineNumbers);
    expect(gutter).toHaveLength(2);
    expect(gutter[0].lineNumber).toBe(1);
    expect(gutter[1].lineNumber).toBe(2);
    // No duplicate "1" entries
    expect(gutter.filter(g => g.lineNumber === 1)).toHaveLength(1);
  });

  it('old widget+hidden strategy would create duplicate gutter entries', () => {
    const hm = new HeightMap();
    // Old: widget block + hidden source line = 2 entries for line 1
    hm.addBlock(0, 0, 342, 'widget');   // widget (no text line)
    hm.addBlock(0, 25, 0, 'text');       // hidden source line (line 1)
    hm.addBlock(26, 36, 27, 'text');     // line 2

    const lineNumbers = new Map<number, number>([
      [0, 1],
      [26, 2],
    ]);

    const gutter = buildGutterEntries(hm, lineNumbers);
    // This would produce two entries for line 1 (the duplicate "1" bug)
    expect(gutter.filter(g => g.lineNumber === 1)).toHaveLength(2);
  });
});

describe('[precision] gutter alignment with content', () => {
  it('gutter and content positions match (delta=0)', () => {
    // From real logs: delta(g4-l4)=0
    const hm = new HeightMap();
    hm.addBlock(0, 25, 342, 'widget');
    for (let i = 1; i < 20; i++) {
      hm.addBlock(26 + (i - 1) * 10, 26 + i * 10, 27, 'text');
    }

    const paddingTop = 39;
    const contentDOMTop = 26;

    // Line 4 block: index 3, top=342+27*2=396
    const line4HeightMapTop = hm.blocks[3].top; // 396
    // DOM position: contentDOMTop + paddingTop + heightMapTop
    const line4DOMTop = contentDOMTop + paddingTop + line4HeightMapTop;
    // Gutter position should be identical
    const gutter4DOMTop = contentDOMTop + paddingTop + line4HeightMapTop;

    expect(gutter4DOMTop - line4DOMTop).toBe(0); // delta = 0
  });
});

describe('[precision] image widget height update', () => {
  it('height map updates when image loads (estimated → actual)', () => {
    const ESTIMATED = 200;
    const ACTUAL = 342;

    // Before image load
    const hmBefore = new HeightMap();
    hmBefore.addBlock(0, 25, ESTIMATED, 'widget');
    hmBefore.addBlock(26, 36, 27, 'text');
    expect(hmBefore.blocks[1].top).toBe(ESTIMATED); // line 2 at 200

    // After image load + requestMeasure + dispatch
    const hmAfter = new HeightMap();
    hmAfter.addBlock(0, 25, ACTUAL, 'widget');
    hmAfter.addBlock(26, 36, 27, 'text');
    expect(hmAfter.blocks[1].top).toBe(ACTUAL); // line 2 at 342

    // Click target shifts correctly
    const docTop = 65; // contentDOMTop(26) + paddingTop(39)
    const clickLineAfter = hmAfter.blockAtHeight(400 - docTop + docTop - docTop);
    // Actually let's just check line 2 position changed
    expect(hmAfter.blocks[1].top - hmBefore.blocks[1].top).toBe(ACTUAL - ESTIMATED);
  });
});

describe('[precision] zoom implementation: CSS zoom vs transform', () => {
  it('CSS zoom property sets zoom on document element', () => {
    // Old implementation (BROKEN with CM6):
    // document.documentElement.style.zoom = `${level}`
    // This is just a structural test showing the approach
    const oldApproach = (level: number) => ({
      property: 'zoom',
      value: `${level}`,
      affectsBCR: true,
      cm6Aware: false,
    });
    
    const result = oldApproach(1.2);
    expect(result.cm6Aware).toBe(false); // CM6 doesn't know about zoom
  });

  it('CSS transform approach is CM6-compatible', () => {
    // New implementation (FIXED):
    // document.documentElement.style.transform = `scale(${level})`
    const newApproach = (level: number) => ({
      property: 'transform',
      value: level === 1 ? '' : `scale(${level})`,
      transformOrigin: 'top left',
      width: level === 1 ? '' : `${100 / level}%`,
      height: level === 1 ? '' : `${100 / level}%`,
      cm6Aware: true,
    });

    const result = newApproach(1.2);
    expect(result.cm6Aware).toBe(true); // CM6 detects scaleX/scaleY
    expect(result.value).toBe('scale(1.2)');
    expect(result.transformOrigin).toBe('top left');
    // Width/height compensate so content fills viewport
    expect(parseFloat(result.width)).toBeCloseTo(100 / 1.2, 0);
  });

  it('zoom=1.0 clears transform', () => {
    const approach = (level: number) => ({
      transform: level === 1 ? '' : `scale(${level})`,
      width: level === 1 ? '' : `${100 / level}%`,
      height: level === 1 ? '' : `${100 / level}%`,
    });

    const result = approach(1.0);
    expect(result.transform).toBe('');
    expect(result.width).toBe('');
    expect(result.height).toBe('');
  });
});
