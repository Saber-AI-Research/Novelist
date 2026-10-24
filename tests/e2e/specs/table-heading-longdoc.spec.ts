import { test, expect, openRecentProject } from '../fixtures/app-fixture';

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
    await openRecentProject(app);
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

    const headingState = async () => app.evaluate(() => {
      const lines = [...document.querySelectorAll('.cm-content > .cm-line')] as HTMLElement[];
      const headings = lines
        .map(l => ({ t: l.innerText, h: Math.round(l.getBoundingClientRect().height), vis: getComputedStyle(l).visibility }))
        .filter(x => x.t.includes('节') && x.t.includes('标题'));
      return {
        count: headings.length,
        // No heading may leak its raw `##` marker, be zero-height, or be hidden.
        leaked: headings.filter(h => h.t.trimStart().startsWith('#')),
        broken: headings.filter(h => h.vis !== 'visible' || h.h === 0),
      };
    });
    await expect.poll(async () => (await headingState()).count).toBeGreaterThan(0);

    // Edit a table cell through its rendered widget and leave the table with
    // Escape, which commits the cell to the document. Then probe once the
    // background parser has settled: stale decorations never refresh, so the
    // settled state stays broken.
    await app.locator('table.cm-novelist-rendered-table td', { hasText: '小明' }).click();
    await app.keyboard.press('End');
    await app.keyboard.insertText('强壮');
    await app.keyboard.press('Escape');
    await expect.poll(() => app.evaluate(() => (window as any).__novelist_view.state.doc.toString().includes('| 小明强壮 |')))
      .toBe(true);

    await expect.poll(async () => {
      const { count, leaked, broken } = await headingState();
      return { onScreen: count > 0, leaked, broken };
    }).toEqual({ onScreen: true, leaked: [], broken: [] });
  });
});
