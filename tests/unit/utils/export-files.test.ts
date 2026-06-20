import { describe, it, expect } from 'vitest';
import { collectExportFiles, type ExportFileSource } from '$lib/utils/export-files';

const md = (name: string, path: string): ExportFileSource => ({ is_dir: false, name, path });

describe('collectExportFiles', () => {
  const projectFiles: ExportFileSource[] = [
    md('ch1.md', '/proj/ch1.md'),
    md('ch2.markdown', '/proj/ch2.markdown'),
    md('notes.txt', '/proj/notes.txt'),
    { is_dir: true, name: 'drafts', path: '/proj/drafts' },
  ];

  it('project mode: collects all markdown files, skipping dirs and non-markdown', () => {
    const files = collectExportFiles('/proj', projectFiles, { filePath: '/proj/ch1.md' });
    expect(files).toEqual(['/proj/ch1.md', '/proj/ch2.markdown']);
  });

  it('standalone mode: exports the active tab file (this is the bug fix)', () => {
    // No project dir, project file list is empty (single-file mode clears it).
    const files = collectExportFiles(null, [], { filePath: '/home/me/story.md' });
    expect(files).toEqual(['/home/me/story.md']);
  });

  it('standalone mode: ignores the empty project list even if populated', () => {
    const files = collectExportFiles(null, projectFiles, { filePath: '/home/me/story.md' });
    expect(files).toEqual(['/home/me/story.md']);
  });

  it('standalone mode: excludes scratch (never-saved) files', () => {
    const files = collectExportFiles(null, [], { filePath: '/tmp/novelist_scratch_1700000000000.md' });
    expect(files).toEqual([]);
  });

  it('standalone mode: empty when there is no active tab', () => {
    expect(collectExportFiles(null, [], null)).toEqual([]);
    expect(collectExportFiles(null, [], undefined)).toEqual([]);
  });

  it('standalone mode: empty when the active tab has no path', () => {
    expect(collectExportFiles(null, [], { filePath: '' })).toEqual([]);
  });
});
