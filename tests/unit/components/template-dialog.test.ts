import { describe, expect, it } from 'vitest';
import type { TemplateFile } from '$lib/ipc/commands';
import { templateDialogPrefill, templateFrontMatter } from '$lib/components/template-dialog';

describe('template edit', () => {
  it('saving an unchanged template keeps its mode, description and default filename', () => {
    const file: TemplateFile = {
      summary: {
        id: 'character',
        source: 'project',
        name: '人物设定',
        mode: 'new-file',
        description: '主要人物卡片',
        defaultFilename: '人物/{title}.md',
      },
      body: '# {title}\n',
    };
    const prefill = templateDialogPrefill(file);
    // The dialog falls back to these defaults for fields the caller omits.
    const saved = templateFrontMatter({
      name: prefill.name ?? '',
      mode: prefill.mode ?? 'insert',
      description: prefill.description ?? '',
      defaultFilename: prefill.defaultFilename ?? '',
    });
    expect(saved).toEqual({
      name: '人物设定',
      mode: 'new-file',
      description: '主要人物卡片',
      defaultFilename: '人物/{title}.md',
    });
    expect(prefill.body).toBe('# {title}\n');
  });

  it('keeps empty optional fields empty', () => {
    const file: TemplateFile = {
      summary: { id: 'scene', source: 'project', name: 'Scene', mode: 'insert', description: null, defaultFilename: null },
      body: '---',
    };
    const prefill = templateDialogPrefill(file);
    expect(templateFrontMatter({
      name: prefill.name!,
      mode: prefill.mode!,
      description: prefill.description!,
      defaultFilename: prefill.defaultFilename!,
    })).toEqual({ name: 'Scene', mode: 'insert', description: null, defaultFilename: null });
  });

  it('drops the default filename for insert templates', () => {
    expect(templateFrontMatter({ name: ' A ', mode: 'insert', description: ' ', defaultFilename: 'x.md' })).toEqual({
      name: 'A',
      mode: 'insert',
      description: null,
      defaultFilename: null,
    });
  });
});
