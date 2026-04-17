import type { MockFileEntry, MockRecentProject } from './mock-data';

export interface TauriMockConfig {
  files: MockFileEntry[];
  fileContents: Record<string, string>;
  recentProjects: MockRecentProject[];
  projectDir: string;
  projectConfig: unknown;
}

export function buildTauriMockScript(config: TauriMockConfig): string {
  return `
    (() => {
      const files = ${JSON.stringify(config.files)};
      const fileContents = ${JSON.stringify(config.fileContents)};
      const recentProjects = ${JSON.stringify(config.recentProjects)};
      const projectDir = ${JSON.stringify(config.projectDir)};
      const projectConfig = ${JSON.stringify(config.projectConfig)};
      const writtenFiles = {};
      const createdFiles = [];
      const deletedFiles = [];
      const eventListeners = {};
      const scaffoldedPlugins = [];

      function handleInvoke(cmd, args) {
        switch (cmd) {
          case 'read_file': return writtenFiles[args.path] ?? fileContents[args.path] ?? '';
          case 'write_file': writtenFiles[args.path] = args.content; return null;
          case 'get_file_encoding': return 'utf-8';
          case 'list_directory': {
            const prefix = args.path.endsWith('/') ? args.path : args.path + '/';
            return files.filter(f => {
              if (!f.path.startsWith(prefix)) return false;
              const rest = f.path.slice(prefix.length);
              return rest.length > 0 && !rest.includes('/');
            });
          }
          case 'create_file': {
            const p = args.parentDir + '/' + args.filename;
            createdFiles.push(p);
            fileContents[p] = '';
            files.push({ name: args.filename, path: p, is_dir: false, size: 0 });
            return p;
          }
          case 'create_scratch_file': {
            const p = '/tmp/scratch-' + Date.now() + '.md';
            fileContents[p] = '';
            return p;
          }
          case 'create_directory': return args.parentDir + '/' + args.name;
          case 'rename_item': return args.oldPath.replace(/[^\\/]+$/, args.newName);
          case 'move_item': {
            const src = args.sourcePath;
            const parent = args.targetDir.endsWith('/') ? args.targetDir : args.targetDir + '/';
            const name = src.slice(src.lastIndexOf('/') + 1);
            const dest = parent + name;
            for (let i = 0; i < files.length; i++) {
              if (files[i].path === src) {
                files[i] = { ...files[i], path: dest };
              } else if (files[i].path.startsWith(src + '/')) {
                files[i] = { ...files[i], path: dest + files[i].path.slice(src.length) };
              }
            }
            return dest;
          }
          case 'delete_item': deletedFiles.push(args.path); return null;
          case 'duplicate_file': return args.path.replace('.md', ' copy.md');
          case 'detect_project': return projectConfig;
          case 'read_project_config': return projectConfig;
          case 'start_file_watcher': case 'stop_file_watcher':
          case 'register_open_file': case 'unregister_open_file':
          case 'register_write_ignore': return null;
          case 'get_recent_projects': return recentProjects;
          case 'add_recent_project': case 'remove_recent_project': return null;
          case 'check_pandoc': return { installed: false, version: null };
          case 'export_project': return 'mock-export.pdf';
          case 'list_plugins': return scaffoldedPlugins.slice();
          case 'get_plugin_commands': return [];
          case 'scaffold_plugin': {
            const id = args.id;
            const name = args.displayName || id;
            const p = '/mock/home/.novelist/plugins/' + id;
            scaffoldedPlugins.push({
              id, name, version: '0.1.0', description: '', author: '',
              enabled: false, builtin: false, path: p, permissions: [],
            });
            return p;
          }
          case 'get_plugins_dir': return '/mock/home/.novelist/plugins';
          case 'load_plugin': case 'unload_plugin': case 'set_plugin_document_state': return null;
          case 'rope_open': return { file_id: 'mock-rope-id', total_lines: 100, total_chars: 5000 };
          case 'rope_get_lines': return { lines: 'Mock content\\n', first_line: args.startLine, line_count: args.endLine - args.startLine };
          case 'rope_close': case 'rope_save': return null;
          case 'read_draft_note': return null;
          case 'write_draft_note': case 'delete_draft_note': return null;
          case 'has_draft_note': return false;
          case 'search_in_project': return [];
          case 'list_snapshots': return [];
          case 'create_snapshot': return { id: 'snap-1', name: args.name, timestamp: Date.now(), file_count: 3, total_bytes: 1024 };
          case 'delete_snapshot': case 'restore_snapshot': return null;
          case 'record_writing_stats': return null;
          case 'get_writing_stats': return { daily: [], total_words: 0, chapters: [], streak_days: 0, today_words: 0, today_minutes: 0 };
          case 'list_templates': return [];
          case 'get_sync_config': return { enabled: false, webdav_url: '', username: '', has_password: false, interval_minutes: 30 };
          case 'save_sync_config': case 'sync_now': return null;
          case 'test_sync_connection': return true;
          case 'reveal_in_file_manager': return null;
          default:
            console.warn('[Tauri Mock] Unhandled command:', cmd, args);
            return null;
        }
      }

      window.__TAURI_MOCK_STATE__ = {
        get writtenFiles() { return { ...writtenFiles }; },
        get createdFiles() { return [...createdFiles]; },
        get deletedFiles() { return [...deletedFiles]; },
        emitEvent(event, payload) {
          const listeners = eventListeners[event] || [];
          listeners.forEach(cb => cb({ event, payload }));
        },
        reset() {
          Object.keys(writtenFiles).forEach(k => delete writtenFiles[k]);
          createdFiles.length = 0;
          deletedFiles.length = 0;
        },
      };

      window.__TAURI_INTERNALS__ = {
        transformCallback(callback, once) {
          const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
          window['_' + id] = (resp) => {
            if (once) delete window['_' + id];
            callback(resp);
          };
          return id;
        },
        invoke(cmd, args) {
          try {
            const result = handleInvoke(cmd, args || {});
            return Promise.resolve(result);
          } catch (e) {
            return Promise.reject(e.message || String(e));
          }
        },
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { label: 'main', windowLabel: 'main' },
        },
        convertFileSrc(filePath) {
          return 'asset://localhost/' + encodeURIComponent(filePath);
        },
      };

      // Wrap invoke to also handle event system commands
      const originalInvoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
      window.__TAURI_INTERNALS__.invoke = function(cmd, args) {
        if (cmd === 'plugin:event|listen') {
          const { event, handler } = args || {};
          if (event && handler) {
            if (!eventListeners[event]) eventListeners[event] = [];
            eventListeners[event].push(handler);
          }
          return Promise.resolve(Math.floor(Math.random() * 1000));
        }
        if (cmd === 'plugin:event|unlisten') {
          return Promise.resolve();
        }
        return originalInvoke(cmd, args);
      };
    })();
  `;
}
