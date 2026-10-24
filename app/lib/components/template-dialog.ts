import type { TemplateFile, TemplateFrontMatterInput, TemplateMode } from '$lib/ipc/commands';

/** Initial values for TemplateDialog; omitted fields use the dialog defaults. */
export interface TemplateDialogPrefill {
  name?: string;
  body?: string;
  mode?: TemplateMode;
  description?: string;
  defaultFilename?: string;
}

export interface TemplateDialogFields {
  name: string;
  mode: TemplateMode;
  description: string;
  defaultFilename: string;
}

/** Prefill for editing an existing template: every saved field, not just name and body. */
export function templateDialogPrefill(file: TemplateFile): TemplateDialogPrefill {
  return {
    name: file.summary.name,
    body: file.body,
    mode: file.summary.mode,
    description: file.summary.description ?? '',
    defaultFilename: file.summary.defaultFilename ?? '',
  };
}

/** Front matter the dialog saves for its current field values. */
export function templateFrontMatter(fields: TemplateDialogFields): TemplateFrontMatterInput {
  const description = fields.description.trim();
  const defaultFilename = fields.defaultFilename.trim();
  return {
    name: fields.name.trim(),
    mode: fields.mode,
    description: description || null,
    defaultFilename: fields.mode === 'new-file' && defaultFilename ? defaultFilename : null,
  };
}
