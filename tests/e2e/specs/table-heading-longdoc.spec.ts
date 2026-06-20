import { test, expect } from '../fixtures/app-fixture';

/**
 * [precision] Long-doc table edit must not break on-screen headings.
 *
 * Regression for: in a long document, editing a table left other headings
 * rendered on the same screen in a stale WYSIWYG state (raw `##` markers
 * showing / wrong decoration). Root cause: the WYSIWYG ViewPlugin only
 * rebuilt on doc/selection/viewport change, while the incremental Lezer
 * parser advances the syntax tree in the background via *tree-only*
 * transactions (no doc/selection change). A heavy structural edit (typing in
 * a table) exceeds the parser's per-slice budget, so the first rebuild runs
 * against an incomplete tree; the WYSIWYG decorations were then never
 * refreshed when parsing finished. The table plugins already guarded on this
 * (`syntaxTree(state) !== syntaxTree(startState)`); the WYSIWYG plugin now
 * does too.
 *
 * Note: the transient depends on the real-viewport + background-parser timing,
 * so this acts primarily as a settle-state correctness guard.
 */
test.describe('[precision] long-doc table edit keeps headings intact', () => {
  test.beforeEach(async ({ app }) => {
    const recentItem = app.getByTestId('recent-project-0');
    if (await recentItem.isVisible().catch(() => false)) {
      await recentItem.click();
      await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
    }
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
  });

  test('editing a table does not leave on-screen headings stale', async ({ app }) => {
    // ~3000 lines (< LARGE_DOC_LINES so WYSIWYG stays on), headings interspersed,
    // a table in the middle of a section that fits on one screen.
    const parts: string[] = [];
    for (let i = 1; i <= 300; i++) {
      parts.push(`## 第${i}节 标题文字`);
      for (let j = 0; j < 6; j++) parts.push(`第${i}节正文 ${j}：占位内容，填充行宽。`);
      parts.push('');
      if (i === 150) {
        parts.push('| 角色 | 描述 | 备注 |');
        parts.push('| --- | --- | --- |');
        parts.push('| 小明 | 主角 | 勇敢 |');
        parts.push('| 小红 | 配角 | 聪明 |');
        parts.push('');
      }
    }
    const doc = parts.join('\n');

    await app.evaluate((d: string) => {
      const view = (window as any).__novelist_view;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: d } });
      const pos = view.state.doc.toString().indexOf('| 小明');
      view.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
    }, doc);
    await app.waitForTimeout(500);

    const headingState = async () => app.evaluate(() => {
      const lines = [...document.querySelectorAll('.cm-content > .cm-line')] as HTMLElement[];
      return lines
        .map(l => ({ t: l.innerText, h: Math.round(l.getBoundingClientRect().height), vis: getComputedStyle(l).visibility }))
        .filter(x => x.t.includes('节') && x.t.includes('标题'));
    });

    // Edit a table cell, then probe after the parser settles.
    const cellPos = await app.evaluate(() => (window as any).__novelist_view.state.doc.toString().indexOf('小明'));
    await app.evaluate((p: number) => {
      const view = (window as any).__novelist_view;
      view.dispatch({ selection: { anchor: p + 2, head: p + 2 } });
    }, cellPos);
    await app.waitForTimeout(150);
    await app.keyboard.type('强壮');
    await app.waitForTimeout(600);

    const headings = await headingState();
    expect(headings.length).toBeGreaterThan(0);

    // No heading may leak its raw `##` marker, be zero-height, or be hidden.
    const leaked = headings.filter(h => h.t.trimStart().startsWith('#'));
    const broken = headings.filter(h => h.vis !== 'visible' || h.h === 0);
    expect(leaked, `headings leaked raw '##': ${JSON.stringify(leaked)}`).toEqual([]);
    expect(broken, `headings hidden/zero-height: ${JSON.stringify(broken)}`).toEqual([]);
  });
});
