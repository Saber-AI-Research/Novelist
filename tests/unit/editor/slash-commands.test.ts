import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';

/**
 * Slash command insertion tests.
 *
 * Tests the text insertion and cursor placement logic for slash commands
 * that insert tables, checklists, and images. The actual slash menu UI
 * (ViewPlugin + DOM widget) is browser-only; these tests verify the
 * document transformations and cursor positions.
 */

// ── Slash command templates (from slash-commands.ts) ──

const slashTemplates: Record<string, string> = {
  heading1: '# {cursor}',
  heading2: '## {cursor}',
  heading3: '### {cursor}',
  bulletList: '- {cursor}',
  numberedList: '1. {cursor}',
  taskList: '- [ ] {cursor}',
  codeBlock: '```\n{cursor}\n```',
  quote: '> {cursor}',
  divider: '---\n{cursor}',
  image: '![{cursor}]()',
  table: '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| {cursor} |  |  |',
  math: '$$\n{cursor}\n$$',
  callout: '> [!NOTE]\n> {cursor}',
};

/**
 * Simulate slash command insertion:
 * 1. User types "/" at some position (replaceFrom)
 * 2. User may type filter text ("tab" → "table")
 * 3. On selection, replace from "/" to current cursor with the template
 * 4. Place cursor at {cursor} marker position
 */
function applySlashCommand(
  doc: string,
  replaceFrom: number,
  replaceTo: number,
  templateId: string,
): { doc: string; cursor: number } {
  const template = slashTemplates[templateId];
  if (!template) throw new Error(`Unknown template: ${templateId}`);

  const cursorMarker = '{cursor}';
  const cursorOffset = template.indexOf(cursorMarker);
  const insertText = template.replace(cursorMarker, '');

  const before = doc.slice(0, replaceFrom);
  const after = doc.slice(replaceTo);
  const newDoc = before + insertText + after;
  const newCursor = replaceFrom + cursorOffset;

  return { doc: newDoc, cursor: newCursor };
}

// ── Table insertion tests ──

describe('slash command: table insertion', () => {
  it('inserts a 3-column table template on empty line', () => {
    const result = applySlashCommand('\n', 0, 1, 'table');
    expect(result.doc).toContain('| Column 1 | Column 2 | Column 3 |');
    expect(result.doc).toContain('| --- | --- | --- |');
    expect(result.doc).toContain('|  |  |');
  });

  it('places cursor in first data cell', () => {
    const result = applySlashCommand('/', 0, 1, 'table');
    // Cursor should be at the {cursor} position in the template
    // Template: "| Column 1 | ... |\n| --- | ... |\n| {cursor} |  |  |"
    // {cursor} is at position 57 in the template (after the "| " on line 3)
    const dataRowStart = result.doc.lastIndexOf('\n| ') + 3;
    expect(result.cursor).toBe(dataRowStart);
    // Verify cursor is on the data row
    const beforeCursor = result.doc.slice(0, result.cursor);
    expect(beforeCursor.endsWith('| ')).toBe(true);
  });

  it('replaces "/" + filter text with table', () => {
    const doc = '/table';
    const result = applySlashCommand(doc, 0, doc.length, 'table');
    expect(result.doc).not.toContain('/table');
    expect(result.doc).toContain('| Column 1 |');
  });

  it('inserted table is valid GFM (parseable)', () => {
    const result = applySlashCommand('/', 0, 1, 'table');
    // Verify the table structure: header, separator, data row
    const lines = result.doc.split('\n');
    expect(lines[0]).toMatch(/^\|.*\|$/);  // header row
    expect(lines[1]).toMatch(/^\| ---/);    // separator
    expect(lines[2]).toMatch(/^\|.*\|$/);  // data row
  });

  it('table after existing content preserves preceding text', () => {
    const doc = '# Title\n\n/';
    const result = applySlashCommand(doc, doc.length - 1, doc.length, 'table');
    expect(result.doc.startsWith('# Title\n\n')).toBe(true);
    expect(result.doc).toContain('| Column 1 |');
  });
});

// ── Checklist insertion tests ──

describe('slash command: task list insertion', () => {
  it('inserts "- [ ] " with cursor after bracket', () => {
    const result = applySlashCommand('/', 0, 1, 'taskList');
    expect(result.doc).toBe('- [ ] ');
    expect(result.cursor).toBe(6);  // right after "- [ ] "
  });

  it('cursor is positioned for immediate typing', () => {
    const result = applySlashCommand('/', 0, 1, 'taskList');
    // User should be able to type the task description immediately
    const withText = result.doc.slice(0, result.cursor) + 'Buy groceries' + result.doc.slice(result.cursor);
    expect(withText).toBe('- [ ] Buy groceries');
  });

  it('task list after heading', () => {
    const doc = '# TODO\n/';
    const result = applySlashCommand(doc, 7, 8, 'taskList');
    expect(result.doc).toBe('# TODO\n- [ ] ');
  });

  it('replaces filter text', () => {
    const result = applySlashCommand('/task', 0, 5, 'taskList');
    expect(result.doc).toBe('- [ ] ');
    expect(result.doc).not.toContain('/task');
  });
});

// ── Image insertion tests ──

describe('slash command: image insertion', () => {
  it('inserts image syntax with cursor at alt text position', () => {
    const result = applySlashCommand('/', 0, 1, 'image');
    expect(result.doc).toBe('![]()');
    expect(result.cursor).toBe(2);  // between [ and ]
  });

  it('user can type alt text at cursor position', () => {
    const result = applySlashCommand('/', 0, 1, 'image');
    const withAlt = result.doc.slice(0, result.cursor) + 'photo' + result.doc.slice(result.cursor);
    expect(withAlt).toBe('![photo]()');
  });

  it('image insertion on non-empty line', () => {
    const doc = 'Text before\n/';
    const result = applySlashCommand(doc, doc.length - 1, doc.length, 'image');
    expect(result.doc).toBe('Text before\n![]()');
  });
});

// ── Code block insertion ──

describe('slash command: code block insertion', () => {
  it('inserts fenced code block with cursor inside', () => {
    const result = applySlashCommand('/', 0, 1, 'codeBlock');
    expect(result.doc).toBe('```\n\n```');
    expect(result.cursor).toBe(4);  // empty line between fences
  });
});

// ── Math block insertion ──

describe('slash command: math block insertion', () => {
  it('inserts $$ block with cursor inside', () => {
    const result = applySlashCommand('/', 0, 1, 'math');
    expect(result.doc).toBe('$$\n\n$$');
    expect(result.cursor).toBe(3);  // empty line between $$
  });
});

// ── Heading insertion ──

describe('slash command: heading insertion', () => {
  it('inserts H1 with cursor after "# "', () => {
    const result = applySlashCommand('/', 0, 1, 'heading1');
    expect(result.doc).toBe('# ');
    expect(result.cursor).toBe(2);
  });

  it('inserts H2 with cursor after "## "', () => {
    const result = applySlashCommand('/', 0, 1, 'heading2');
    expect(result.doc).toBe('## ');
    expect(result.cursor).toBe(3);
  });

  it('inserts H3 with cursor after "### "', () => {
    const result = applySlashCommand('/', 0, 1, 'heading3');
    expect(result.doc).toBe('### ');
    expect(result.cursor).toBe(4);
  });
});

// ── Callout insertion ──

describe('slash command: callout insertion', () => {
  it('inserts callout with cursor on content line', () => {
    const result = applySlashCommand('/', 0, 1, 'callout');
    expect(result.doc).toBe('> [!NOTE]\n> ');
    expect(result.cursor).toBe(12);  // after "> " on second line
  });
});

// ── Full-width slash (CJK IME) support ──

describe('slash command: full-width slash trigger', () => {
  function shouldTriggerSlashMenu(text: string): boolean {
    return text === '/' || text === '\uFF0F';
  }

  it('triggers on half-width "/"', () => {
    expect(shouldTriggerSlashMenu('/')).toBe(true);
  });

  it('triggers on full-width "／" (U+FF0F)', () => {
    expect(shouldTriggerSlashMenu('\uFF0F')).toBe(true);
  });

  it('does not trigger on other characters', () => {
    expect(shouldTriggerSlashMenu('a')).toBe(false);
    expect(shouldTriggerSlashMenu('\\')).toBe(false);
    expect(shouldTriggerSlashMenu('、')).toBe(false);
  });
});

// ── Slash menu state validation (full-width support) ──

describe('slash command: menu state char validation', () => {
  function isSlashChar(char: string): boolean {
    return char === '/' || char === '\uFF0F';
  }

  it('accepts half-width slash in state validation', () => {
    expect(isSlashChar('/')).toBe(true);
  });

  it('accepts full-width slash in state validation', () => {
    expect(isSlashChar('\uFF0F')).toBe(true);
  });

  it('rejects non-slash characters', () => {
    expect(isSlashChar(' ')).toBe(false);
    expect(isSlashChar('a')).toBe(false);
    expect(isSlashChar('#')).toBe(false);
  });
});

// ── Fallback trigger detection (IME bypass) ──

describe('slash command: fallback trigger detection', () => {
  function shouldFallbackTrigger(
    docChanged: boolean,
    menuAlreadyActive: boolean,
    charBefore: string,
    textBeforeSlash: string,
  ): boolean {
    if (!docChanged || menuAlreadyActive) return false;
    if (charBefore !== '/' && charBefore !== '\uFF0F') return false;
    return textBeforeSlash.trim() === '';
  }

  it('triggers when "/" typed at empty line start (inputHandler bypassed)', () => {
    expect(shouldFallbackTrigger(true, false, '/', '')).toBe(true);
  });

  it('triggers when "／" typed at empty line start', () => {
    expect(shouldFallbackTrigger(true, false, '\uFF0F', '')).toBe(true);
  });

  it('triggers when "/" after whitespace-only prefix', () => {
    expect(shouldFallbackTrigger(true, false, '/', '  ')).toBe(true);
  });

  it('does not trigger if menu already active', () => {
    expect(shouldFallbackTrigger(true, true, '/', '')).toBe(false);
  });

  it('does not trigger if doc did not change', () => {
    expect(shouldFallbackTrigger(false, false, '/', '')).toBe(false);
  });

  it('does not trigger when "/" is after text', () => {
    expect(shouldFallbackTrigger(true, false, '/', 'hello')).toBe(false);
  });

  it('does not trigger for non-slash characters', () => {
    expect(shouldFallbackTrigger(true, false, 'a', '')).toBe(false);
  });
});

// ── EditorState integration ──

describe('slash command EditorState integration', () => {
  it('table insertion produces valid EditorState', () => {
    const result = applySlashCommand('/', 0, 1, 'table');
    const state = EditorState.create({
      doc: result.doc,
      selection: { anchor: result.cursor },
    });
    expect(state.doc.lines).toBeGreaterThanOrEqual(3);
    expect(state.selection.main.head).toBe(result.cursor);
    // Cursor should be within document bounds
    expect(result.cursor).toBeGreaterThanOrEqual(0);
    expect(result.cursor).toBeLessThanOrEqual(result.doc.length);
  });

  it('task list insertion produces valid EditorState', () => {
    const result = applySlashCommand('/', 0, 1, 'taskList');
    const state = EditorState.create({
      doc: result.doc,
      selection: { anchor: result.cursor },
    });
    expect(state.selection.main.head).toBe(6);
  });

  it('cursor after table insertion is on line 3 (data row)', () => {
    const result = applySlashCommand('/', 0, 1, 'table');
    const state = EditorState.create({
      doc: result.doc,
      selection: { anchor: result.cursor },
    });
    const cursorLine = state.doc.lineAt(result.cursor);
    expect(cursorLine.number).toBe(3);  // header=1, sep=2, data=3
  });

  it('all templates produce cursor within bounds', () => {
    for (const [id, _template] of Object.entries(slashTemplates)) {
      const result = applySlashCommand('/', 0, 1, id);
      expect(result.cursor).toBeGreaterThanOrEqual(0);
      expect(result.cursor).toBeLessThanOrEqual(result.doc.length);
    }
  });
});
