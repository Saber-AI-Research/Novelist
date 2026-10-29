import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';

/**
 * Behaviour tests for image handling in the real editor extensions
 * (`wysiwyg.ts`): block image widgets, paste/drop insertion with
 * auto-upload, and the image context menu. Only the IPC / network edges
 * (Tauri invoke, image-host service, settings command) are mocked.
 */

const { invoke, readLocalImageDataUri, uploadInlineBytes, uploadImage, getImageHostSettings } = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => null as unknown),
  readLocalImageDataUri: vi.fn(async (src: string) => `data:image/png;base64,${src}`),
  uploadInlineBytes: vi.fn(async (_bytes: Uint8Array, filename: string, _mime: string) => ({
    url: `https://cdn.example/${filename.replace(/^\d+-/, '')}`,
  })),
  uploadImage: vi.fn(async (src: string, _scope: unknown) => ({ url: `https://cdn.example/${src}` })),
  getImageHostSettings: vi.fn(async () => ({
    status: 'ok' as const,
    data: { auto_on_paste: true, active_host_id: 'host-1' },
  })),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('$lib/services/image-host', () => ({ readLocalImageDataUri, uploadInlineBytes, uploadImage }));
vi.mock('$lib/ipc/commands', () => ({ commands: { getImageHostSettings } }));

import {
  imageDocumentDirEffect,
  imageDocumentDirField,
  imagePastePlugin,
  setWysiwygProjectDir,
  wysiwygImageDocumentDir,
  wysiwygPlugin,
} from '$lib/editor/wysiwyg';

function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

let view: EditorView | null = null;

function mount(doc: string, extensions: Extension[] = []): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [markdown(), wysiwygPlugin, imagePastePlugin, ...extensions] }),
    parent,
  });
  return view;
}

function drop(target: EditorView, pos: number, files: File[]) {
  vi.spyOn(target, 'posAtCoords').mockReturnValue(pos);
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: { files }, clientX: 1, clientY: 1 });
  target.contentDOM.dispatchEvent(event);
}

const png = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

beforeEach(() => {
  setWysiwygProjectDir('/project');
  invoke.mockClear();
  uploadInlineBytes.mockClear();
  uploadImage.mockClear();
  readLocalImageDataUri.mockClear();
});

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('[regression] image document scope ownership', () => {
  it('keeps different nested document directories isolated per editor state', () => {
    const first = EditorState.create({ extensions: [imageDocumentDirField] });
    const second = EditorState.create({ extensions: [imageDocumentDirField] });
    const firstUpdated = first.update({ effects: imageDocumentDirEffect.of('/project/第一卷') }).state;
    const secondUpdated = second.update({ effects: imageDocumentDirEffect.of('/project/第二卷') }).state;

    expect(firstUpdated.field(imageDocumentDirField)).toBe('/project/第一卷');
    expect(secondUpdated.field(imageDocumentDirField)).toBe('/project/第二卷');
  });

  it('resolves local images against the directory given at state creation', () => {
    const errors = vi.spyOn(console, 'error');
    mount('intro\n\n![图](插图/a.png)\n', [wysiwygImageDocumentDir('/project/第一卷')]);

    expect(readLocalImageDataUri).toHaveBeenCalledWith('插图/a.png', { baseDir: '/project/第一卷' });
    expect(view!.dom.querySelector('.cm-novelist-image-error')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it('[regression] shows no "Image not found" while the document directory is still unknown', () => {
    mount('intro\n\n![图](插图/a.png)\n');

    expect(view!.dom.querySelector('.cm-novelist-image-widget')).not.toBeNull();
    expect(view!.dom.querySelector('.cm-novelist-image-error')).toBeNull();
    expect(readLocalImageDataUri).not.toHaveBeenCalled();
  });
});

describe('[regression] image widgets never reuse another image\'s DOM', () => {
  it('shows the right image after moving the caret between adjacent image lines', () => {
    const doc = '![one](https://img.example/1.png)\n![two](https://img.example/2.png)\nend';
    mount(doc);
    const shown = () => Array.from(view!.dom.querySelectorAll<HTMLImageElement>('.cm-novelist-image-widget img'), (img) => img.getAttribute('src'));

    const line2 = view!.state.doc.line(2).from + 1;
    view!.dispatch({ selection: { anchor: 1 } }); // keyboard onto line 1: its source shows
    expect(shown()).toEqual(['https://img.example/2.png']);
    view!.dispatch({ selection: { anchor: line2 } }); // ArrowDown
    expect(shown()).toEqual(['https://img.example/1.png']);
    view!.dispatch({ selection: { anchor: 1 } }); // ArrowUp
    expect(shown()).toEqual(['https://img.example/2.png']);
    view!.dispatch({ selection: { anchor: line2 } });
    expect(shown()).toEqual(['https://img.example/1.png']);
  });
});

describe('[regression] dropped images with auto-upload', () => {
  it('rewrites every dropped image link to its own URL', async () => {
    mount('before\n\nafter');
    drop(view!, 'before\n\n'.length, [png('a.png'), png('b.png'), png('c.png')]);

    await vi.waitFor(() => expect(uploadInlineBytes).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(view!.state.doc.toString()).toContain('https://cdn.example/c.png'));
    expect(view!.state.doc.toString()).toBe(
      'before\n\n![a.png](https://cdn.example/a.png)\n![b.png](https://cdn.example/b.png)\n![c.png](https://cdn.example/c.png)\nafter',
    );
  });

  it('inserts at the drop point even when text is typed above it during the file writes', async () => {
    const write = deferred();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'write_binary_file') await write.promise;
      return null;
    });
    mount('before\n\nafter');
    drop(view!, 'before\n\n'.length, [png('a.png')]);

    view!.dispatch({ changes: { from: 0, insert: '新的一行\n' } });
    write.resolve();

    await vi.waitFor(() => expect(view!.state.doc.toString()).toContain('https://cdn.example/a.png'));
    expect(view!.state.doc.toString()).toBe('新的一行\nbefore\n\n![a.png](https://cdn.example/a.png)\nafter');
    invoke.mockReset();
    invoke.mockImplementation(async () => null);
  });

  it('writes the URL into the link even when text is typed above it during the upload', async () => {
    const upload = deferred<{ url: string }>();
    uploadInlineBytes.mockImplementationOnce(() => upload.promise);
    mount('before\n\nafter');
    drop(view!, 'before\n\n'.length, [png('a.png')]);
    await vi.waitFor(() => expect(uploadInlineBytes).toHaveBeenCalledTimes(1));

    view!.dispatch({ changes: { from: 0, insert: 'typed ' } });
    upload.resolve({ url: 'https://cdn.example/a.png' });

    await vi.waitFor(() => expect(view!.state.doc.toString()).toContain('https://cdn.example/a.png'));
    expect(view!.state.doc.toString()).toBe('typed before\n\n![a.png](https://cdn.example/a.png)\nafter');
  });

  it('leaves the document alone when the link was deleted before the upload finished', async () => {
    const upload = deferred<{ url: string }>();
    uploadInlineBytes.mockImplementationOnce(() => upload.promise);
    mount('before\n');
    drop(view!, 'before\n'.length, [png('a.png')]);
    await vi.waitFor(() => expect(uploadInlineBytes).toHaveBeenCalledTimes(1));

    view!.dispatch({ changes: { from: 'before\n'.length, to: view!.state.doc.length } });
    const toast = deferred();
    window.addEventListener('image-host-toast', () => toast.resolve(), { once: true });
    upload.resolve({ url: 'https://cdn.example/a.png' });
    await toast.promise; // the success toast follows the (skipped) rewrite

    expect(view!.state.doc.toString()).toBe('before\n');
  });
});

describe('image context menu', () => {
  function openMenu(lineNumber: number): HTMLElement {
    const widgets = view!.dom.querySelectorAll<HTMLElement>('.cm-novelist-image-widget');
    const widget = Array.from(widgets).find((w) => view!.state.doc.lineAt(view!.posAtDOM(w)).number === lineNumber)!;
    widget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 }));
    return document.querySelector<HTMLElement>('.cm-image-context-menu')!;
  }

  function itemLabels(menu: HTMLElement): string[] {
    return Array.from(menu.querySelectorAll('.cm-image-context-menu-item'), (el) => el.textContent ?? '');
  }

  it('offers upload for local images and browser opening for remote ones', () => {
    mount('![local](img/a.png)\n![remote](https://img.example/b.png)\nend', [wysiwygImageDocumentDir('/project')]);

    const local = itemLabels(openMenu(1));
    expect(local).toContain('Upload to host');
    expect(local).not.toContain('Open in Browser');

    const remote = itemLabels(openMenu(2));
    expect(remote).toContain('Open in Browser');
    expect(remote).not.toContain('Upload to host');
  });

  it('[regression] never offers Reveal in file manager on mobile', async () => {
    const { platform } = await import('$lib/stores/platform.svelte');
    platform.setCapabilities({
      os: 'android', is_mobile: true, native_menu: false, multi_window: false, pick_directory: false,
      external_processes: false, self_update: false, cli_shim: false, file_watcher: false,
      plugin_install: true, export_formats: ['markdown', 'html'],
    });
    mount('![local](img/a.png)\nend', [wysiwygImageDocumentDir('/project')]);

    const labels = itemLabels(openMenu(1));
    for (const reveal of ['Reveal in Finder', 'Show in Explorer', 'Show in File Manager']) {
      expect(labels).not.toContain(reveal);
    }
    expect(labels).toEqual(expect.arrayContaining(['Copy Image Path', 'Upload to host', 'Edit Caption', 'Delete Image']));
  });

  it('positions the menu in layout coordinates at non-100% zoom', () => {
    document.documentElement.style.transform = 'scale(1.5)';
    try {
      mount('![local](img/a.png)\nend', [wysiwygImageDocumentDir('/project')]);
      const menu = openMenu(1);
      expect(parseFloat(menu.style.left)).toBeCloseTo(40 / 1.5);
      expect(parseFloat(menu.style.top)).toBeCloseTo(30 / 1.5);
    } finally {
      document.documentElement.style.transform = '';
    }
  });

  it('[regression] "Upload to host" rewrites the link even after typing above it during the upload', async () => {
    const upload = deferred<{ url: string }>();
    uploadImage.mockImplementationOnce(() => upload.promise);
    mount('![local](img/a.png)\nend', [wysiwygImageDocumentDir('/project')]);

    const item = Array.from(openMenu(1).querySelectorAll<HTMLElement>('.cm-image-context-menu-item'))
      .find((el) => el.textContent === 'Upload to host')!;
    item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(uploadImage).toHaveBeenCalledWith('img/a.png', { baseDir: '/project' }));

    view!.dispatch({ changes: { from: 0, insert: '第一章\n\n' } });
    upload.resolve({ url: 'https://cdn.example/a.png' });

    await vi.waitFor(() => expect(view!.state.doc.toString()).toBe('第一章\n\n![local](https://cdn.example/a.png)\nend'));
  });
});
