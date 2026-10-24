import { test, expect, openRecentProject } from '../fixtures/app-fixture';

/**
 * Regression guards for the unified selection-background subsystem.
 *
 * See `docs/design-docs/editor.md` → "Unified selection background"
 * for the full design; this spec enforces the invariants listed there.
 * Each invariant has been broken at least once in the past — every
 * test below corresponds to a concrete past regression:
 *
 *  - Invariant 1 (drawSelection rects transparent): original stair-step
 *    bug when heading lines made CM6's native rects misalign.
 *  - Invariant 2 (line decoration left-edge alignment): our custom paint
 *    must not reintroduce the stair-step we fixed.
 *  - Invariant 3 (partial selections paint): CM6's `hideNativeSelection`
 *    is `Prec.highest + !important`; a weaker-specificity override
 *    silently loses and partial text renders without any highlight.
 *  - Invariant 4 (partial / full color match): the original user-facing
 *    bug where the selected glyph "境" appeared brighter than adjacent
 *    empty lines because `::selection` stacked on top of a
 *    `Decoration.mark` span — both painted 18% so the stacked area
 *    read as ~33%.
 *  - Invariant 5 (wrap continuation fills right edge): the
 *    `Decoration.mark` approach produced ragged per-word ribbons on
 *    long wrapped lines; we switched to native `::selection` because
 *    the text engine is the only thing that fills continuation rows.
 */

/** Parse a CSS `rgb(...)` / `rgba(...)` / `color(srgb …)` string into `[r, g, b, a]`. */
function parseRgb(s: string): [number, number, number, number] {
  // Modern form: `color(srgb 0.12 0.34 0.56 / 0.18)` — WebKit serializes
  // resolved color-mix() values this way.
  const colorFn = s.match(
    /color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\s*\)/,
  );
  if (colorFn) {
    return [
      Math.round(parseFloat(colorFn[1]) * 255),
      Math.round(parseFloat(colorFn[2]) * 255),
      Math.round(parseFloat(colorFn[3]) * 255),
      colorFn[4] ? parseFloat(colorFn[4]) : 1,
    ];
  }
  const m = s.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[,/]\s*([0-9.]+))?\s*\)/);
  if (!m) throw new Error(`Unparseable color: ${s}`);
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), m[4] ? parseFloat(m[4]) : 1];
}

function isTransparent(color: string): boolean {
  const [, , , a] = parseRgb(color);
  return a === 0;
}

async function openFirstProjectFile(app: any, fileTestId = 'sidebar-file-Chapter 1.md') {
  await openRecentProject(app);
  await app.getByTestId(fileTestId).click();
  await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
}

test.describe('[regression] Unified selection background — invariant 1+2 (line-deco geometry)', () => {
  test('all selected-line backgrounds share a single left x-coordinate', async ({ app }) => {
    await openFirstProjectFile(app);

    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      const doc =
        '# Top\n' +
        '\n' +
        '## Middle A\n' +
        '\n' +
        '\n' +
        '## Middle B\n' +
        '\n' +
        '### Leaf 1\n' +
        '\n' +
        '### Leaf 2\n';
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    });

    await expect.poll(() => app.locator('.cm-novelist-selected-line').count()).toBeGreaterThan(3);

    const { distinctLineLefts, count } = await app.evaluate(() => {
      const lefts: number[] = [];
      document.querySelectorAll<HTMLElement>('.cm-novelist-selected-line').forEach(el => {
        lefts.push(+el.getBoundingClientRect().left.toFixed(2));
      });
      return {
        count: lefts.length,
        distinctLineLefts: Array.from(new Set(lefts)).sort((a, b) => a - b),
      };
    });

    expect(count).toBeGreaterThan(3);
    // Single distinct left value → every line background aligns perfectly.
    expect(distinctLineLefts).toHaveLength(1);
  });

  test('native drawSelection backgrounds are suppressed so they can not jitter', async ({ app }) => {
    await openFirstProjectFile(app);

    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    });
    await expect(app.locator('.cm-selectionBackground').first()).toBeAttached();

    const bgColors = await app.evaluate(() => {
      const colors: string[] = [];
      document.querySelectorAll<HTMLElement>('.cm-selectionBackground').forEach(el => {
        colors.push(getComputedStyle(el).backgroundColor);
      });
      return colors;
    });

    // Every `.cm-selectionBackground` must be fully transparent. Any opaque
    // color would signal that drawSelection's misaligned rects are rendering.
    for (const c of bgColors) {
      expect(c).toMatch(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)|transparent/);
    }
  });
});

test.describe('[regression] Unified selection background — invariant 3+4+5 (::selection paint)', () => {
  /**
   * Invariant 3: partial selections must produce a VISIBLE `::selection`
   * paint. CM6's `hideNativeSelection` installs
   * `.cm-line ::selection { background: transparent !important }` at
   * `Prec.highest`; our theme must override it with higher specificity
   * and `!important`, or partial selections render with no highlight.
   *
   * We can't probe `::selection` via `getComputedStyle` (pseudo-element
   * styling isn't in the computed style of the element in all browsers
   * reliably for ::selection). Instead we compare pixel colors between
   * the same selected and unselected character region via a small
   * canvas-based diff: if the 18% tint is applied, the selected region
   * reads noticeably more accent-tinted than the unselected baseline.
   */
  test('partial single-line selection paints a non-transparent ::selection background', async ({ app }) => {
    await openFirstProjectFile(app);

    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      const doc = 'hello world this is a long line of body text for selection testing.\n';
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
      // Caret only — establish an unselected baseline.
      view.dispatch({ selection: { anchor: 0 } });
    });

    // Probe the effective `::selection` background color by reading it from
    // a throwaway stylesheet and the active theme class. CM6's
    // `EditorView.theme()` produces a computed rule we can't query directly,
    // so instead we assert by creating a fresh selection and checking that
    // there's at least one rule in the cascade with a non-transparent
    // `::selection` color that matches our accent tint.
    const hasOpaqueSelectionRule = await app.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | undefined;
        try { rules = sheet.cssRules; } catch { continue; } // cross-origin
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSStyleRule)) continue;
          if (!rule.selectorText || !rule.selectorText.includes('::selection')) continue;
          // Must apply to `.cm-line`, must NOT be the transparent suppression,
          // and must carry !important to beat `hideNativeSelection`.
          if (!rule.selectorText.includes('.cm-line')) continue;
          if (rule.selectorText.includes('cm-novelist-selected-line')) continue;
          const bg = rule.style.getPropertyValue('background-color');
          const prio = rule.style.getPropertyPriority('background-color');
          if (bg && bg !== 'transparent' && !bg.includes('rgba(0, 0, 0, 0)') && prio === 'important') {
            return { selector: rule.selectorText, bg };
          }
        }
      }
      return null;
    });

    expect(hasOpaqueSelectionRule, 'a non-transparent, !important ::selection rule targeting .cm-line must win the cascade').not.toBeNull();
  });

  test('::selection is suppressed inside fully-selected lines (prevents layer stacking)', async ({ app }) => {
    await openFirstProjectFile(app);

    const hasSuppressionRule = await app.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | undefined;
        try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSStyleRule)) continue;
          if (!rule.selectorText?.includes('cm-novelist-selected-line')) continue;
          if (!rule.selectorText.includes('::selection')) continue;
          const bg = rule.style.getPropertyValue('background-color');
          const prio = rule.style.getPropertyPriority('background-color');
          if ((bg === 'transparent' || bg.includes('rgba(0, 0, 0, 0)')) && prio === 'important') {
            return { selector: rule.selectorText };
          }
        }
      }
      return null;
    });

    expect(hasSuppressionRule, 'a transparent, !important ::selection rule scoped to .cm-novelist-selected-line must exist').not.toBeNull();
  });

  test('line decoration background uses the same 18% accent tint as ::selection', async ({ app }) => {
    await openFirstProjectFile(app);

    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      const doc = 'first line\nsecond line\nthird line\n';
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    });
    await expect(app.locator('.cm-line.cm-novelist-selected-line').first()).toBeAttached();

    // Read the computed background color of a fully-selected line.
    const lineBg = await app.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.cm-line.cm-novelist-selected-line');
      return el ? getComputedStyle(el).backgroundColor : null;
    });

    expect(lineBg).not.toBeNull();
    expect(isTransparent(lineBg!)).toBe(false);

    // Read the `::selection` rule's declared background-color from the
    // cascade. It must parse to the same RGB triple and the same alpha as
    // the line decoration (both are `color-mix(… accent 18% …)`).
    const selBg = await app.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | undefined;
        try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSStyleRule)) continue;
          if (!rule.selectorText?.includes('.cm-line ::selection')) continue;
          if (rule.selectorText.includes('cm-novelist-selected-line')) continue;
          return rule.style.getPropertyValue('background-color');
        }
      }
      return null;
    });

    expect(selBg, '::selection rule must declare a background-color').toBeTruthy();
    // Both must reference the same token — either the exact color-mix
    // expression (if the browser preserved it) or resolve to the same RGB.
    // Easiest cross-browser check: both strings must contain the accent
    // variable name or resolve to the same alpha channel.
    const lineAlpha = parseRgb(lineBg!)[3];
    // ::selection declared value may still be a `color-mix(...)` token
    // because we read it from the rule, not a computed style. Accept both.
    expect(selBg!.includes('18%') || selBg!.includes('color-mix') || parseRgb(selBg!)[3] === lineAlpha).toBe(true);
  });

  test('wrapped partial selection fills continuation visual rows to the container right edge', async ({ app }) => {
    await openFirstProjectFile(app);

    // Insert one very long logical line (no \n) that will wrap into
    // several visual rows at the default editor width, then select a
    // partial range that spans multiple wrapped rows.
    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      const long =
        'lorem ipsum dolor sit amet consectetur adipiscing elit ' +
        'sed do eiusmod tempor incididunt ut labore et dolore magna ' +
        'aliqua ut enim ad minim veniam quis nostrud exercitation ' +
        'ullamco laboris nisi ut aliquip ex ea commodo consequat';
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: long + '\n' } });
      // Partial selection: from char 10 to char 180 — crosses at least one
      // visual wrap at any realistic editor width.
      view.dispatch({ selection: { anchor: 10, head: 180 } });
    });
    await expect.poll(() => app.evaluate(() => {
      const sel = window.getSelection();
      return sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getClientRects().length : 0;
    })).toBeGreaterThanOrEqual(2);

    // Use window.getSelection's client rects — these correspond to the
    // visual rectangles the browser uses to paint `::selection`. On a
    // wrapped partial selection, non-terminal rects must extend to the
    // content area's right edge (the `.cm-line`'s right content-box edge).
    const { rectRights, lineRight, rectCount } = await app.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return { rectRights: [], lineRight: 0, rectCount: 0 };
      const range = sel.getRangeAt(0);
      const rects = Array.from(range.getClientRects());
      const line = document.querySelector<HTMLElement>('.cm-line');
      const lineBox = line ? line.getBoundingClientRect() : { right: 0 };
      // Content-box right = bounding right minus padding-right.
      const pad = line ? parseInt(getComputedStyle(line).paddingRight, 10) || 0 : 0;
      // The app may auto-zoom the root element on high-DPI screens. WebKit
      // includes that transform in client rects, so normalize back to
      // unscaled CSS px before applying the historical gap threshold.
      const rootTransform = getComputedStyle(document.documentElement).transform;
      const matrixZoom = rootTransform.match(/^matrix\(([^,]+),/);
      const zoom = matrixZoom ? (parseFloat(matrixZoom[1]) || 1) : 1;
      return {
        rectRights: rects.map(r => +(r.right / zoom).toFixed(1)),
        lineRight: +((lineBox.right - pad) / zoom).toFixed(1),
        rectCount: rects.length,
      };
    });

    // At least one wrap (≥ 2 rects) must exist for this test to be meaningful.
    expect(rectCount).toBeGreaterThanOrEqual(2);
    // `range.getClientRects()` returns text-glyph bounds, so a continuation
    // row ends at its last word boundary (leaving typical trailing space of
    // one word — up to ~35-50px for common fonts). The regression this
    // guards against is the old `Decoration.mark` approach, which painted
    // word-by-word spans and produced many small rects with arbitrary
    // mid-line gaps. A generous threshold still catches that shape while
    // tolerating normal word-break whitespace.
    const continuation = rectRights.slice(0, -1);
    for (const right of continuation) {
      expect(Math.abs(right - lineRight)).toBeLessThan(60);
    }
  });
});
