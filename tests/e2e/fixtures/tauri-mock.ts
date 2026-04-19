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
      const now = Date.now();
      const files = ${JSON.stringify(config.files)}.map(f => ({ ...f, mtime: f.mtime ?? now }));
      const fileContents = ${JSON.stringify(config.fileContents)};
      const recentProjects = ${JSON.stringify(config.recentProjects)};
      let projectDir = ${JSON.stringify(config.projectDir)};
      const projectConfig = ${JSON.stringify(config.projectConfig)};
      const writtenFiles = {};
      const createdFiles = [];
      const deletedFiles = [];
      const eventListeners = {};
      const scaffoldedPlugins = [
        // Pre-registered built-in plugins so file-handler routing works in tests.
        {
          id: 'kanban', name: 'Kanban', version: '0.1.0',
          description: 'Trello-style kanban board editor',
          author: 'Novelist Team', enabled: true, builtin: true,
          path: '/mock/home/.novelist/plugins/kanban',
          permissions: ['read', 'write', 'ui'],
          ui: { type: 'file-handler', entry: 'index.html', label: 'Kanban', file_extensions: ['.kanban'] },
        },
      ];

      function ensureMtime(entry) {
        if (entry && typeof entry.mtime !== 'number') entry.mtime = Date.now();
        return entry;
      }

      function handleInvoke(cmd, args) {
        switch (cmd) {
          case 'read_file': return writtenFiles[args.path] ?? fileContents[args.path] ?? '';
          case 'write_file': writtenFiles[args.path] = args.content; return null;
          case 'get_file_encoding': return 'utf-8';
          case 'list_directory': {
            const prefix = args.path.endsWith('/') ? args.path : args.path + '/';
            return files
              .filter(f => {
                if (!f.path.startsWith(prefix)) return false;
                const rest = f.path.slice(prefix.length);
                return rest.length > 0 && !rest.includes('/');
              })
              .map(f => ensureMtime({ ...f }));
          }
          case 'create_file': {
            const p = args.parentDir + '/' + args.filename;
            createdFiles.push(p);
            fileContents[p] = '';
            files.push({ name: args.filename, path: p, is_dir: false, size: 0, mtime: Date.now() });
            return p;
          }
          case 'create_scratch_file': {
            const p = '/tmp/scratch-' + Date.now() + '.md';
            fileContents[p] = '';
            return p;
          }
          case 'create_directory': return args.parentDir + '/' + args.name;
          case 'rename_item': {
            const oldPath = args.oldPath;
            const newName = args.newName;
            const allowCollisionBump = args.allowCollisionBump;
            const file = files.find(f => f.path === oldPath);
            if (!file) throw new Error('not found: ' + oldPath);
            const parent = oldPath.slice(0, oldPath.lastIndexOf('/'));
            let target = parent + '/' + newName;
            if (files.some(f => f.path === target && f.path !== oldPath)) {
              if (allowCollisionBump) {
                const dotIdx = newName.lastIndexOf('.');
                const base = dotIdx > 0 ? newName.slice(0, dotIdx) : newName;
                const ext = dotIdx > 0 ? newName.slice(dotIdx) : '';
                let n = 2;
                while (files.some(f => f.path === parent + '/' + base + ' ' + n + ext)) n++;
                target = parent + '/' + base + ' ' + n + ext;
              } else {
                throw new Error('Already exists: ' + target);
              }
            }
            const finalName = target.slice(target.lastIndexOf('/') + 1);
            // Update directory descendants if renaming a directory
            if (file.is_dir) {
              for (let i = 0; i < files.length; i++) {
                if (files[i].path.startsWith(oldPath + '/')) {
                  files[i] = { ...files[i], path: target + files[i].path.slice(oldPath.length) };
                }
              }
            }
            // Move fileContents key if present
            if (fileContents[oldPath] !== undefined) {
              fileContents[target] = fileContents[oldPath];
              delete fileContents[oldPath];
            }
            file.path = target;
            file.name = finalName;
            file.mtime = Date.now();
            return target;
          }
          case 'broadcast_file_renamed': return null;
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
          case 'get_recent_projects': {
            // Mirror Rust sort: pinned first, then sort_order asc, then last_opened desc.
            const sorted = recentProjects.slice().sort((a, b) => {
              if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
              const ax = a.sort_order, bx = b.sort_order;
              if (ax != null && bx != null) return ax - bx;
              if (ax != null) return -1;
              if (bx != null) return 1;
              return String(b.last_opened).localeCompare(String(a.last_opened));
            });
            return sorted;
          }
          case 'add_recent_project': case 'remove_recent_project': return null;
          case 'set_project_pinned': {
            const p = recentProjects.find(r => r.path === args.path);
            if (p) p.pinned = !!args.pinned;
            return null;
          }
          case 'reorder_recent_projects': {
            const ordered = Array.isArray(args.orderedPaths) ? args.orderedPaths : [];
            ordered.forEach((path, idx) => {
              const p = recentProjects.find(r => r.path === path);
              if (p) p.sort_order = idx;
            });
            return null;
          }
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
          case 'load_plugin': case 'unload_plugin': case 'reload_plugin': case 'set_plugin_document_state': return null;
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
        get files() { return files.map(f => ({ ...f })); },
        get projectDir() { return projectDir; },
        emitEvent(event, payload) {
          const listeners = eventListeners[event] || [];
          listeners.forEach(cb => cb({ event, payload }));
        },
        openProject(dirPath, newFiles) {
          projectDir = dirPath;
          files.length = 0;
          const nowTs = Date.now();
          for (const f of (newFiles || [])) {
            files.push({ ...f, mtime: f.mtime != null ? f.mtime : nowTs });
          }
        },
        renameFile(oldPath, newPath) {
          const f = files.find(x => x.path === oldPath);
          if (!f) return;
          const finalName = newPath.slice(newPath.lastIndexOf('/') + 1);
          if (f.is_dir) {
            for (let i = 0; i < files.length; i++) {
              if (files[i].path.startsWith(oldPath + '/')) {
                files[i] = { ...files[i], path: newPath + files[i].path.slice(oldPath.length) };
              }
            }
          }
          if (fileContents[oldPath] !== undefined) {
            fileContents[newPath] = fileContents[oldPath];
            delete fileContents[oldPath];
          }
          f.path = newPath;
          f.name = finalName;
          f.mtime = Date.now();
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
