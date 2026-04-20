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
      // Tests can seed a custom recent-projects list that survives a page reload by
      // writing to localStorage under this key before reloading.
      const MOCK_RECENT_SEED_KEY = '__novelist_mock_recent_seed__';
      let recentProjects = ${JSON.stringify(config.recentProjects)};
      try {
        const override = localStorage.getItem(MOCK_RECENT_SEED_KEY);
        if (override) recentProjects = JSON.parse(override);
      } catch {}
      let projectDir = ${JSON.stringify(config.projectDir)};
      const projectConfig = ${JSON.stringify(config.projectConfig)};
      const writtenFiles = {};
      const createdFiles = [];
      const deletedFiles = [];
      const eventListeners = {};
      let aiStreamCounter = 0;
      let claudeCliDetectResult = null;
      // In-memory project snippet templates. Keyed by id.
      // Each entry: { summary: TemplateFileSummary, body: string }
      const mockTemplates = {};
      // In-memory settings store persisted across reloads via localStorage.
      // Mirrors the real split between ~/.novelist/settings.json (global) and
      // <project>/.novelist/project.toml (per-project overlay).
      const MOCK_GLOBAL_SETTINGS_KEY = '__novelist_mock_global_settings__';
      const MOCK_PROJECT_SETTINGS_KEY_PREFIX = '__novelist_mock_project_settings__:';
      function readMockGlobal() {
        try {
          const raw = localStorage.getItem(MOCK_GLOBAL_SETTINGS_KEY);
          return raw ? JSON.parse(raw) : { view: {}, new_file: {}, plugins: { enabled: {} } };
        } catch {
          return { view: {}, new_file: {}, plugins: { enabled: {} } };
        }
      }
      function writeMockGlobal(s) {
        try { localStorage.setItem(MOCK_GLOBAL_SETTINGS_KEY, JSON.stringify(s)); } catch {}
      }
      function readMockProject(dir) {
        try {
          const raw = localStorage.getItem(MOCK_PROJECT_SETTINGS_KEY_PREFIX + dir);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      }
      function writeMockProject(dir, s) {
        try { localStorage.setItem(MOCK_PROJECT_SETTINGS_KEY_PREFIX + dir, JSON.stringify(s)); } catch {}
      }
      function resolveMockEffective(dir) {
        const g = readMockGlobal();
        const p = dir ? (readMockProject(dir) || { view: {}, new_file: {}, plugins: { enabled: {} } }) : null;
        const pick = (k, d) => (p && p.view && p.view[k] != null) ? p.view[k] : (g.view && g.view[k] != null ? g.view[k] : d);
        const pickNF = (k, d) => (p && p.new_file && p.new_file[k] != null) ? p.new_file[k] : (g.new_file && g.new_file[k] != null ? g.new_file[k] : d);
        const enabled = { ...(g.plugins?.enabled || {}) };
        if (p && p.plugins?.enabled) Object.assign(enabled, p.plugins.enabled);
        return {
          view: {
            sort_mode: pick('sort_mode', 'numeric-asc'),
            show_hidden_files: pick('show_hidden_files', false),
          },
          new_file: {
            template: pickNF('template', 'Untitled {N}'),
            detect_from_folder: pickNF('detect_from_folder', true),
            auto_rename_from_h1: pickNF('auto_rename_from_h1', true),
          },
          plugins: { enabled },
          is_project_scoped: dir != null,
        };
      }
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
            const showHidden = args.showHidden === true;
            return files
              .filter(f => {
                if (!f.path.startsWith(prefix)) return false;
                const rest = f.path.slice(prefix.length);
                if (rest.length === 0 || rest.includes('/')) return false;
                // Hidden filter mirrors the Rust backend: every dotfile (including
                // .novelist) is dropped unless show_hidden is on.
                if (!showHidden && f.name.startsWith('.')) return false;
                return true;
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
          case 'create_directory': {
            const p = args.parentDir + '/' + args.name;
            // Persist in the mock tree so list_directory picks the new folder
            // up — keeps E2E consistent with the real backend.
            if (!files.some(f => f.path === p)) {
              files.push({ name: args.name, path: p, is_dir: true, size: 0, mtime: Date.now() });
              createdFiles.push(p);
            }
            return p;
          }
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

          // --- Snippet-template commands (bundled + project .md files) ---
          // Kept in an in-memory map scoped to this mock. Bundled set mirrors
          // what ships in core/bundled-templates/ (body omitted — body is only
          // sent back on read_template_file so tests that only exercise list
          // don't need to keep bodies in sync).
          case 'list_template_files': {
            const bundled = [
              { id: 'outline', source: 'bundled', name: '大纲', mode: 'new-file', description: '故事梗概、主题、主线与副线', defaultFilename: '大纲.md' },
              { id: 'characters', source: 'bundled', name: '人物设定', mode: 'new-file', description: '主角、配角、反派的基础设定', defaultFilename: '人物设定.md' },
              { id: 'worldbuilding', source: 'bundled', name: '世界观', mode: 'new-file', description: '时代、地理、社会结构与重要设定', defaultFilename: '世界观.md' },
              { id: 'chapter-skeleton', source: 'bundled', name: '章节骨架', mode: 'insert', description: '在光标处插入章节骨架', defaultFilename: null },
            ];
            const project = Object.keys(mockTemplates).map(id => ({ ...mockTemplates[id].summary }));
            const projectIds = new Set(project.map(s => s.id));
            return [
              ...bundled.filter(b => !projectIds.has(b.id)),
              ...project,
            ];
          }
          case 'read_template_file': {
            if (args.source === 'bundled') {
              const bodies = {
                'outline': '# 大纲\\n\\n## 故事梗概\\n\\n\\n',
                'characters': '# 人物设定\\n\\n## 主角\\n\\n**姓名**：\\n',
                'worldbuilding': '# 世界观\\n\\n## 时代背景\\n',
                'chapter-skeleton': '## 场景\\n\\n## 冲突\\n\\n$|$\\n\\n## 转折\\n',
              };
              const summaries = {
                'outline': { id: 'outline', source: 'bundled', name: '大纲', mode: 'new-file', description: null, defaultFilename: '大纲.md' },
                'characters': { id: 'characters', source: 'bundled', name: '人物设定', mode: 'new-file', description: null, defaultFilename: '人物设定.md' },
                'worldbuilding': { id: 'worldbuilding', source: 'bundled', name: '世界观', mode: 'new-file', description: null, defaultFilename: '世界观.md' },
                'chapter-skeleton': { id: 'chapter-skeleton', source: 'bundled', name: '章节骨架', mode: 'insert', description: null, defaultFilename: null },
              };
              const body = bodies[args.id];
              const summary = summaries[args.id];
              if (!body || !summary) throw new Error('no bundled template: ' + args.id);
              return { summary, body };
            }
            const t = mockTemplates[args.id];
            if (!t) throw new Error('no project template: ' + args.id);
            return { summary: { ...t.summary }, body: t.body };
          }
          case 'write_template_file': {
            const fm = args.frontMatter;
            const summary = {
              id: args.id,
              source: 'project',
              name: fm.name,
              mode: fm.mode,
              description: fm.description,
              defaultFilename: fm.defaultFilename,
            };
            mockTemplates[args.id] = { summary, body: args.body };
            return summary;
          }
          case 'rename_template_file': {
            const t = mockTemplates[args.oldId];
            if (!t) throw new Error('no template to rename: ' + args.oldId);
            if (mockTemplates[args.newId]) throw new Error('target exists: ' + args.newId);
            const summary = { ...t.summary, id: args.newId };
            delete mockTemplates[args.oldId];
            mockTemplates[args.newId] = { summary, body: t.body };
            return summary;
          }
          case 'delete_template_file': {
            if (!mockTemplates[args.id]) throw new Error('no template: ' + args.id);
            delete mockTemplates[args.id];
            return null;
          }
          case 'duplicate_bundled_template': {
            const id = args.newId ?? args.bundledId;
            if (mockTemplates[id]) throw new Error('target exists: ' + id);
            const summary = { id, source: 'project', name: id, mode: 'insert', description: null, defaultFilename: null };
            mockTemplates[id] = { summary, body: 'duplicated body\\n' };
            return summary;
          }
          case 'create_file_with_body': {
            const parent = args.dir.endsWith('/') ? args.dir : args.dir + '/';
            let name = args.filename;
            // collision bump
            const dot = name.lastIndexOf('.');
            const stem = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : '';
            let n = 2;
            while (files.some(f => f.path === parent + name)) {
              name = stem + ' ' + n + ext;
              n++;
            }
            const path = parent + name;
            files.push({ name, path, is_dir: false, size: args.body.length, mtime: Date.now() });
            fileContents[path] = args.body;
            createdFiles.push(path);
            return path;
          }
          case 'get_sync_config': return { enabled: false, webdav_url: '', username: '', has_password: false, interval_minutes: 30 };
          case 'save_sync_config': case 'sync_now': return null;
          case 'test_sync_connection': return true;
          case 'reveal_in_file_manager': return null;
          case 'log_startup_phase': return null;
          case 'get_effective_settings':
            return resolveMockEffective(args.dirPath ?? null);
          case 'get_global_settings':
            return readMockGlobal();
          case 'write_global_settings': {
            const current = readMockGlobal();
            if (args.view != null) current.view = args.view;
            if (args.newFile != null) current.new_file = args.newFile;
            if (args.plugins != null) current.plugins = args.plugins;
            writeMockGlobal(current);
            return null;
          }
          case 'write_project_settings': {
            const current = readMockProject(args.dirPath) || { view: {}, new_file: {}, plugins: { enabled: {} } };
            if (args.view != null) current.view = args.view;
            if (args.newFile != null) current.new_file = args.newFile;
            if (args.plugins != null) current.plugins = args.plugins;
            writeMockProject(args.dirPath, current);
            return null;
          }
          case 'read_project_config': {
            const p = readMockProject(args.dirPath);
            return {
              project: { name: 'Mock', type: 'novel', version: '0.1.0' },
              outline: { order: [] },
              writing: { daily_goal: 2000, auto_save_minutes: 5 },
              view: p?.view ?? {},
              new_file: p?.new_file ?? {},
              plugins: p?.plugins ?? { enabled: {} },
            };
          }
          case 'ai_fetch_stream_start': return 'mock-stream-' + (++aiStreamCounter);
          case 'ai_fetch_stream_cancel': return null;
          case 'claude_cli_detect': return claudeCliDetectResult;
          case 'claude_cli_spawn': return args.req?.session_uuid || 'mock-claude-session';
          case 'claude_cli_send': return null;
          case 'claude_cli_kill': return null;
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
        get recentProjects() { return recentProjects.map(p => ({ ...p })); },
        seedRecentProjects(list) {
          recentProjects.length = 0;
          for (const p of list) recentProjects.push({ ...p });
        },
        emitEvent(event, payload) {
          const listeners = eventListeners[event] || [];
          for (const h of listeners) {
            // listener handle is either a direct fn or a Tauri transformCallback id
            if (typeof h === 'function') {
              h({ event, payload });
            } else if (typeof h === 'number' && typeof window['_' + h] === 'function') {
              window['_' + h]({ event, payload });
            }
          }
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
        // AI bridge test helpers — let specs simulate streamed responses
        // and control whether the Claude CLI is "installed".
        setClaudeCliDetectResult(v) { claudeCliDetectResult = v; },
        emitAiChunk(streamId, text) {
          this.emitEvent('ai-stream://' + streamId, { kind: 'chunk', data: JSON.stringify({ choices: [{ delta: { content: text } }] }) });
        },
        emitAiDone(streamId) {
          this.emitEvent('ai-stream://' + streamId, { kind: 'done' });
        },
        emitAiError(streamId, message, status) {
          this.emitEvent('ai-stream://' + streamId, { kind: 'error', message, status });
        },
        emitClaudeStdout(sessionId, data) {
          this.emitEvent('claude-stream://' + sessionId, { kind: 'stdout-line', data });
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
