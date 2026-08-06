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
      const MOCK_FILES_KEY = '__novelist_mock_files__';
      const MOCK_CONTENTS_KEY = '__novelist_mock_contents__';
      function readJsonKey(key, fallback) {
        try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
      }
      let files = readJsonKey(MOCK_FILES_KEY, ${JSON.stringify(config.files)}).map(f => ({ ...f, mtime: f.mtime ?? now }));
      const fileContents = readJsonKey(MOCK_CONTENTS_KEY, ${JSON.stringify(config.fileContents)});
      function persistMockFiles() {
        try { localStorage.setItem(MOCK_FILES_KEY, JSON.stringify(files)); } catch {}
      }
      function persistMockContents() {
        try { localStorage.setItem(MOCK_CONTENTS_KEY, JSON.stringify(fileContents)); } catch {}
      }
      // Tests can seed a custom recent-projects list that survives a page reload by
      // writing to localStorage under this key before reloading.
      const MOCK_RECENT_SEED_KEY = '__novelist_mock_recent_seed__';
      let recentProjects = ${JSON.stringify(config.recentProjects)};
      try {
        const override = localStorage.getItem(MOCK_RECENT_SEED_KEY);
        if (override) recentProjects = JSON.parse(override);
      } catch {}
      let projectDir = ${JSON.stringify(config.projectDir)};
      let projectConfig = ${JSON.stringify(config.projectConfig)};
      const defaultLiteraryOverview = {
        schemaVersion: 3,
        sourcePath: '/mock/books/demo.txt',
        title: 'Demo Book',
        author: 'Demo Author',
        language: 'zh-CN',
        chapterCount: 2,
        completedChapters: 0,
        copiedCharacters: 4,
        totalCharacters: 12,
        mistakes: 1,
        pasted: 0,
        resumeChapterPath: '学习内容/第一章.litstudy',
        importOptions: {
          directoryMode: 'by-volume',
          numberingMode: 'global',
          cleanChapterTitles: true,
        },
        chapters: [
          {
            id: 'chapter-0001',
            title: '第一章',
            volume: null,
            index: 1,
            total: 2,
            relativePath: '学习内容/第一章.litstudy',
            sourceCharacters: 6,
            copiedCharacters: 4,
            mistakes: 1,
            pasted: 0,
            completed: false,
          },
          {
            id: 'chapter-0002',
            title: '第二章',
            volume: null,
            index: 2,
            total: 2,
            relativePath: '学习内容/第二章.litstudy',
            sourceCharacters: 6,
            copiedCharacters: 0,
            mistakes: 0,
            pasted: 0,
            completed: false,
          },
        ],
      };
      let literaryOverview = JSON.parse(JSON.stringify(defaultLiteraryOverview));
      const writtenFiles = {};
      const createdFiles = [];
      const deletedFiles = [];
      const eventListeners = {};
      const mockWindowLabel = 'main';
      let nextEventListenerId = 1;
      let aiStreamCounter = 0;
      let claudeCliDetectResult = null;
      let claudeCliSendError = null;
      const claudeCliSpawnUuidHistory = [];
      let claudeCliSendCount = 0;
      let claudeCliKillCount = 0;
      let claudeCliKillBlocked = false;
      const claudeCliKillWaiters = [];
      let codexCliTurnCount = 0;
      let codexCliTurnError = null;
      let codexCliKillCount = 0;
      let codexCliKillBlocked = false;
      const codexCliKillWaiters = [];
      let aiSessionWritesBlocked = false;
      let aiSessionWriteError = null;
      const aiSessionWriteWaiters = [];
      let aiSessionWriteCount = 0;
      let aiSessionDeletesBlocked = false;
      const aiSessionDeleteWaiters = [];
      let blockedReadPath = null;
      const blockedReadWaiters = [];
      let blockedConditionalWritePath = null;
      const blockedConditionalWriteWaiters = [];
      let conditionalWriteMutation = null;
      const conditionalWriteResolutions = {};
       const MOCK_PUBLISH_CHANNELS_KEY = '__novelist_mock_publish_channels__';
       const MOCK_PUBLISH_DRAFTS_KEY = '__novelist_mock_publish_drafts__';
       const MOCK_PUBLISH_COVERS_KEY = '__novelist_mock_publish_covers__';
       const MOCK_UPDATER_RESPONSES_KEY = '__novelist_mock_updater_responses__';
        let publishChannels = readJsonKey(MOCK_PUBLISH_CHANNELS_KEY, []);
        let deferredPublishSettingsReadCount = 0;
        const publishSettingsReadWaiters = [];
        let publishDraftsByDocument = readJsonKey(MOCK_PUBLISH_DRAFTS_KEY, {});
       let publishDraftInvalidChannelIds = [];
       let publishCoverState = readJsonKey(MOCK_PUBLISH_COVERS_KEY, { assets: {}, refs: {} });
       let publishCoverLoadBlocked = false;
       const publishCoverLoadWaiters = [];
       let publishClipboardImage = null;
       let publishClipboardReadBlocked = false;
       const publishClipboardReadWaiters = [];
       let publishBlocked = false;
        let publishError = null;
        let publishBindError = null;
        let publishBindBlocked = false;
        const publishBindWaiters = [];
        let publishPersistError = null;
        let publishPersistBlocked = false;
        const publishPersistWaiters = [];
       let publishSequence = 0;
       let publishResponses = [];
       let publishVerifyResponses = [];
       const publishRemotes = {};
       let deferredPublishRemoteReadCount = 0;
       const publishRemoteReadWaiters = [];
       const publishWaiters = [];
       let publishDraftWritesBlocked = false;
       let publishDraftWriteError = null;
       const publishDraftWriteWaiters = [];
       let managedNameWritesBlocked = false;
       const managedNameWriteWaiters = [];
       let styledConversionBlocked = false;
      let styledConversionError = null;
      let styledConversionHtml = null;
      let styledClipboardError = null;
      let styledImageResults = {};
      let styledImageHostSettings = { hosts: [], active_host_id: null, auto_on_paste: false };
       let styledUploadResults = {};
       const styledConversionWaiters = [];
       let pandocStatusResponse = {
         available: false,
         version: null,
         resolved_path: null,
         override_path: null,
       };
        let exportProjectResponse = {
          result: { message: 'Export complete: /mock/export.html' },
        };
         let exportProjectBlocked = false;
         const exportProjectWaiters = [];
          let cancelExportProjectResponse = { result: true };
         let exportCssWriteBlocked = false;
         const exportCssWriteWaiters = [];
       const invokeCalls = [];
       const unhandledCommands = [];
       let portableModeResponse = { enabled: false, data_root: '/mock/user-data' };
       let updaterResponses = readJsonKey(MOCK_UPDATER_RESPONSES_KEY, []);
       let updaterCheckCount = 0;
       const aiSessions = {};
       const aiSessionListErrors = {};
        const aiPromptAssetErrors = {};
        const aiPromptAssetBlockedProjects = {};
        const aiPromptAssetWaiters = [];
        const projectDetectBlockedProjects = {};
        const projectDetectWaiters = [];
        const watcherStartErrors = {};
      function aiSessionKey(project, kind, id) {
        return project + '\\0' + kind + ':' + id;
      }
      function aiSessionPrefix(project, kind) {
        return project + '\\0' + kind + ':';
      }
      // In-memory project snippet templates. Keyed by id.
      // Each entry: { summary: TemplateFileSummary, body: string }
      const mockTemplates = {};
      // In-memory settings store persisted across reloads via localStorage.
      // Mirrors the real split between ~/.novelist/settings.json (global) and
      // <project>/.novelist/project.toml (per-project overlay).
      const MOCK_GLOBAL_SETTINGS_KEY = '__novelist_mock_global_settings__';
      const MOCK_PROJECT_SETTINGS_KEY_PREFIX = '__novelist_mock_project_settings__:';
      const MOCK_NAMING_KEY_PREFIX = '__novelist_mock_naming__:';
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
            wrap_file_names: pick('wrap_file_names', false),
            sidebar_font_size: pick('sidebar_font_size', 14),
          },
          new_file: {
            // Mirror the production default (core/src/models/settings.rs
            // DEFAULT_TEMPLATE) so E2E exercises real out-of-the-box behavior.
            template: pickNF('template', '第{N}章-{title}'),
            detect_from_folder: pickNF('detect_from_folder', true),
            auto_rename_from_h1: pickNF('auto_rename_from_h1', true),
            default_dir: pickNF('default_dir', null),
            last_used_dir: pickNF('last_used_dir', null),
          },
          plugins: { enabled },
          is_project_scoped: dir != null,
        };
      }
      function documentKey(project, filePath) {
        const prefix = project.endsWith('/') ? project : project + '/';
        if (filePath === project || !filePath.startsWith(prefix)) throw new Error('path outside project: ' + filePath);
        return filePath.slice(prefix.length).split('/').map(s => s.replace(/%/g, '%25')).join('%2F');
      }
      function namingStorageKey(project, filePath) {
        return MOCK_NAMING_KEY_PREFIX + project + ':' + documentKey(project, filePath);
      }
      function readNaming(project, filePath) {
        const raw = localStorage.getItem(namingStorageKey(project, filePath));
        return raw ? JSON.parse(raw) : null;
      }
      function writeNaming(project, filePath, state) {
        const expected = documentKey(project, filePath);
        if (!state || state.version !== 1) throw new Error('Invalid managed-name version');
        if (state.status !== 'managed' && state.status !== 'detached') throw new Error('Invalid managed-name status');
        if (typeof state.templateRaw !== 'string' || !state.templateRaw.includes('{title}')) throw new Error('Invalid managed-name templateRaw');
        if (state.documentKey !== expected) throw new Error('Invalid managed-name documentKey');
        localStorage.setItem(namingStorageKey(project, filePath), JSON.stringify(state));
      }
      function deleteNaming(project, filePath) {
        localStorage.removeItem(namingStorageKey(project, filePath));
      }
      function migrateNaming(project, oldPath, newPath) {
        const oldKey = namingStorageKey(project, oldPath);
        const raw = localStorage.getItem(oldKey);
        if (!raw) return false;
        const state = JSON.parse(raw);
        state.documentKey = documentKey(project, newPath);
        localStorage.removeItem(oldKey);
        localStorage.setItem(namingStorageKey(project, newPath), JSON.stringify(state));
        return true;
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
        {
          id: 'literary-commentary', name: 'Literary Commentary', version: '0.2.5',
          description: 'Transcription and inline literary commentary',
          author: 'Novelist Team', enabled: false, builtin: true,
          path: '/mock/home/.novelist/plugins/literary-commentary',
          permissions: ['read', 'write', 'ui'],
          ui: {
            type: 'file-handler',
            entry: 'index.html',
            label: 'Literary Commentary',
            file_extensions: ['.litstudy'],
            creatable: false,
            requires_app_reload: false,
          },
        },
      ];
      const builtinScaffoldedPluginCount = scaffoldedPlugins.length;

      function ensureMtime(entry) {
        if (entry && typeof entry.mtime !== 'number') entry.mtime = Date.now();
        return entry;
      }

      function styledHtml(markdown) {
        const escaped = String(markdown)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/\\r?\\n/g, '<br>');
        return '<h1>Styled preview</h1><p>' + escaped + '</p>';
      }

      function persistPublishChannels() {
        try { localStorage.setItem(MOCK_PUBLISH_CHANNELS_KEY, JSON.stringify(publishChannels)); } catch {}
      }

       function persistPublishDrafts() {
         try { localStorage.setItem(MOCK_PUBLISH_DRAFTS_KEY, JSON.stringify(publishDraftsByDocument)); } catch {}
       }

      function persistUpdaterResponses() {
        try { localStorage.setItem(MOCK_UPDATER_RESPONSES_KEY, JSON.stringify(updaterResponses)); } catch {}
      }

       function publishRemoteKey(project, filePath, channelId) {
         return project + '\0' + filePath + '\0' + channelId;
       }

       function publishDraftDocumentKey(project, filePath) {
         return project + '\0' + filePath;
       }

       function publishDraftsFor(project, filePath) {
         return publishDraftsByDocument[publishDraftDocumentKey(project, filePath)] || {};
       }

      function publishChannel(channelId) {
        const channel = publishChannels.find(candidate => candidate.id === channelId);
        if (!channel) throw new Error("channel '" + channelId + "' not found");
        return channel;
      }

      function remoteFromPublishResult(channelId, result) {
        const channel = publishChannel(channelId);
        const revision = result.provider_revision || null;
        if (channel.platform !== 'medium' && !revision) {
          throw new Error('updatable publish result requires provider_revision');
        }
        let legacyRevision = null;
        if (revision?.provider === 'ghost') legacyRevision = revision.updated_at;
        if (revision?.provider === 'wordpress') {
          legacyRevision = revision.modified || revision.modified_gmt || null;
        }
        return {
          post_id: result.remote_id,
          url: result.url,
          revision: legacyRevision,
          provider_revision: revision,
          capability: channel.platform === 'medium'
            ? { kind: 'unsupported_update', data: { reason: 'create_only_api' } }
            : { kind: 'updatable' },
        };
      }

      function defaultPublishResult(platform, input) {
        publishSequence += 1;
        const updating = !!input.update_target;
        const remoteId = updating ? input.update_target.remote_id : platform + '-' + publishSequence;
        const providerRevision = platform === 'ghost'
          ? { provider: 'ghost', updated_at: 'revision-' + publishSequence }
          : platform === 'medium'
            ? null
            : {
                provider: 'wordpress',
                modified: 'revision-' + publishSequence,
                modified_gmt: null,
              };
        return {
          url: platform === 'medium'
            ? 'https://medium.com/@author/' + remoteId
            : 'https://' + platform + '.example/' + remoteId + '/',
          remote_id: remoteId,
          operation: updating ? 'updated' : 'created',
          provider_revision: providerRevision,
        };
      }

      function nextPublishResult(platform, input) {
        const queued = publishResponses.shift();
        if (queued?.error) throw queued.error;
        if (queued?.result) return JSON.parse(JSON.stringify(queued.result));
        if (publishError) throw publishError;
        return defaultPublishResult(platform, input);
      }

      function nextPublishVerification() {
        const queued = publishVerifyResponses.shift();
        if (queued?.error) throw queued.error;
        return null;
      }

      function persistPublishCoverState() {
        try { localStorage.setItem(MOCK_PUBLISH_COVERS_KEY, JSON.stringify(publishCoverState)); } catch {}
      }

      function publishCoverIdentity(project, filePath, channelId) {
        return project + '\\0' + filePath + '\\0' + channelId;
      }

      function detectPublishCover(bytes) {
        if (!Array.isArray(bytes) || bytes.length === 0) {
          throw new Error('Cover payload is empty');
        }
        if (bytes.length > 25 * 1024 * 1024) {
          throw new Error('Cover payload is ' + bytes.length + ' bytes; limit is 26214400');
        }
        const b = Uint8Array.from(bytes);
        if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
          && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
          return { mime: 'image/png', extension: 'png' };
        }
        if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
          return { mime: 'image/jpeg', extension: 'jpg' };
        }
        if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46
          && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
          return { mime: 'image/gif', extension: 'gif' };
        }
        if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
          && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
          return { mime: 'image/webp', extension: 'webp' };
        }
        throw new Error('Cover payload does not match a supported image format (png / jpeg / gif / webp)');
      }

      function assertPublishCoverMime(declaredMime, detectedMime) {
        const declared = String(declaredMime || '').trim().toLowerCase();
        if (!declared) return;
        const matches = declared === detectedMime
          || (detectedMime === 'image/jpeg' && declared === 'image/jpg');
        if (!matches) {
          throw new Error('Declared cover MIME "' + declaredMime + '" does not match detected ' + detectedMime);
        }
      }

      async function publishCoverHash(bytes) {
        const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      }

      function cleanupPublishCoverAssets() {
        const referenced = new Set(Object.values(publishCoverState.refs).map(ref =>
          String(ref.content_hash).toLowerCase() + '.' + ref.extension));
        for (const filename of Object.keys(publishCoverState.assets)) {
          if (!referenced.has(filename)) delete publishCoverState.assets[filename];
        }
      }

      async function storePublishCover(args) {
        const detected = detectPublishCover(args.bytes);
        assertPublishCoverMime(args.declaredMime, detected.mime);
        const hash = await publishCoverHash(args.bytes);
        const cover = {
          content_hash: hash,
          extension: detected.extension,
          mime: detected.mime,
          bytes: args.bytes.length,
        };
        const filename = hash + '.' + detected.extension;
        if (!publishCoverState.assets[filename]) {
          publishCoverState.assets[filename] = Array.from(args.bytes);
        }
        publishCoverState.refs[publishCoverIdentity(args.projectDir, args.filePath, args.channelId)] = cover;
        cleanupPublishCoverAssets();
        persistPublishCoverState();
        return { cover, bytes: Array.from(args.bytes), filename, mime: detected.mime };
      }

      async function loadPublishCover(args) {
        const key = publishCoverIdentity(args.projectDir, args.filePath, args.channelId);
        const cover = publishCoverState.refs[key];
        if (!cover) return null;
        const filename = String(cover.content_hash).toLowerCase() + '.' + cover.extension;
        const bytes = publishCoverState.assets[filename];
        if (!bytes) throw new Error('Referenced publish cover asset is missing: ' + filename);
        if (bytes.length !== cover.bytes) throw new Error('Cover asset length mismatch');
        const detected = detectPublishCover(bytes);
        if (detected.mime !== cover.mime || detected.extension !== cover.extension) {
          throw new Error('Cover asset MIME mismatch');
        }
        const hash = await publishCoverHash(bytes);
        if (hash.toLowerCase() !== String(cover.content_hash).toLowerCase()) {
          throw new Error('Cover asset content-hash mismatch');
        }
        return { cover: JSON.parse(JSON.stringify(cover)), bytes: Array.from(bytes), filename, mime: cover.mime };
      }

      function clearPublishCover(args) {
        delete publishCoverState.refs[publishCoverIdentity(args.projectDir, args.filePath, args.channelId)];
        cleanupPublishCoverAssets();
        persistPublishCoverState();
        return null;
      }

      function handleInvoke(cmd, args) {
        invokeCalls.push({
          command: cmd,
          args: JSON.parse(JSON.stringify(args || {})),
        });
        switch (cmd) {
          case 'plugin:path|resolve_directory': return '/mock/tmp';
          case 'plugin:path|join': return (Array.isArray(args.paths) ? args.paths : []).join('/');
          case 'read_file': {
            const effectivePath = conditionalWriteResolutions[args.path] ?? args.path;
            const read = () => writtenFiles[effectivePath] ?? fileContents[effectivePath] ?? '';
            if (blockedReadPath === args.path) {
              return new Promise((resolve, reject) => blockedReadWaiters.push({
                path: args.path,
                resolve: () => resolve(read()),
                reject,
              }));
            }
            return read();
          }
          case 'write_file': {
            const finish = () => {
              writtenFiles[args.path] = args.content;
              fileContents[args.path] = args.content;
              persistMockContents();
              return null;
            };
            if (exportCssWriteBlocked && String(args.path).includes('novelist-export-theme-')) {
              return new Promise(resolve => exportCssWriteWaiters.push(() => resolve(finish())));
            }
            return finish();
          }
          case 'write_file_if_unchanged': {
            const effectivePath = conditionalWriteResolutions[args.path] ?? args.path;
            const projectRoot = typeof args.projectDir === 'string'
              ? args.projectDir.replace(/\\/+$/, '')
              : '';
            if (!projectRoot || (effectivePath !== projectRoot && !effectivePath.startsWith(projectRoot + '/'))) {
              throw new Error('Conditional write target resolves outside active project');
            }
            const write = () => {
              if (conditionalWriteMutation?.path === args.path) {
                fileContents[effectivePath] = conditionalWriteMutation.content;
                writtenFiles[effectivePath] = conditionalWriteMutation.content;
                conditionalWriteMutation = null;
                persistMockContents();
              }
              const hasWritten = Object.prototype.hasOwnProperty.call(writtenFiles, effectivePath);
              const hasStored = Object.prototype.hasOwnProperty.call(fileContents, effectivePath);
              const current = hasWritten
                ? writtenFiles[effectivePath]
                : hasStored ? fileContents[effectivePath] : null;
              if (current !== args.expectedContent) return 'conflict';
              writtenFiles[effectivePath] = args.content;
              fileContents[effectivePath] = args.content;
              persistMockContents();
              return 'written';
            };
            if (blockedConditionalWritePath === args.path) {
              return new Promise((resolve, reject) => blockedConditionalWriteWaiters.push({
                path: args.path,
                resolve: () => {
                  try { resolve(write()); } catch (error) { reject(error); }
                },
                reject,
              }));
            }
            return write();
          }
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
            persistMockFiles(); persistMockContents();
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
              persistMockFiles();
            }
            return p;
          }
          case 'rename_item': {
            const projectRoot = args.projectDir;
            const oldPath = args.oldPath;
            const newName = args.newName;
            const allowCollisionBump = args.allowCollisionBump;
            if (!projectRoot) throw new Error('missing projectDir');
            if (oldPath !== projectRoot && !oldPath.startsWith(projectRoot.endsWith('/') ? projectRoot : projectRoot + '/')) {
              throw new Error('path outside project: ' + oldPath);
            }
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
              persistMockContents();
            }
            const migratedNaming = migrateNaming(projectRoot, oldPath, target);
            file.path = target;
            file.name = finalName;
            file.mtime = Date.now();
            persistMockFiles();
            return {
              new_path: target,
              migration: { status: 'full_success', migrated: migratedNaming ? 1 : 0, conflicts: 0, errors: [] },
            };
          }
          case 'compute_document_key': return documentKey(args.projectDir, args.filePath);
          case 'read_managed_name_state': return readNaming(args.projectDir, args.filePath);
          case 'write_managed_name_state': {
            const finish = () => {
              writeNaming(args.projectDir, args.filePath, args.state);
              return null;
            };
            if (!managedNameWritesBlocked) return finish();
            return new Promise((resolve, reject) => managedNameWriteWaiters.push({
              resolve: () => {
                try { resolve(finish()); } catch (error) { reject(error); }
              },
              reject,
            }));
          }
          case 'delete_managed_name_state': deleteNaming(args.projectDir, args.filePath); return null;
          case 'broadcast_file_renamed': return null;
          case 'move_item': {
            const projectRoot = args.projectDir;
            const src = args.sourcePath;
            const parent = args.targetDir.endsWith('/') ? args.targetDir : args.targetDir + '/';
            const name = src.slice(src.lastIndexOf('/') + 1);
            let dest = parent + name;
            if (files.some(file => file.path === dest)) {
              const dotIdx = name.lastIndexOf('.');
              const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
              const ext = dotIdx > 0 ? name.slice(dotIdx) : '';
              let n = 2;
              while (files.some(file => file.path === parent + base + ' ' + n + ext)) n++;
              dest = parent + base + ' ' + n + ext;
            }
            for (let i = 0; i < files.length; i++) {
              if (files[i].path === src) {
                files[i] = {
                  ...files[i],
                  name: dest.slice(dest.lastIndexOf('/') + 1),
                  path: dest,
                };
              } else if (files[i].path.startsWith(src + '/')) {
                files[i] = { ...files[i], path: dest + files[i].path.slice(src.length) };
              }
            }
            if (fileContents[src] !== undefined) {
              fileContents[dest] = fileContents[src];
              delete fileContents[src];
              persistMockContents();
            }
            const migratedNaming = migrateNaming(projectRoot, src, dest);
            persistMockFiles();
            return {
              new_path: dest,
              migration: {
                status: 'full_success',
                migrated: migratedNaming ? 1 : 0,
                conflicts: 0,
                errors: [],
              },
            };
          }
          case 'delete_item': {
            const target = args.path;
            deletedFiles.push(target);
            for (let i = files.length - 1; i >= 0; i--) {
              if (files[i].path === target || files[i].path.startsWith(target + '/')) files.splice(i, 1);
            }
            for (const path of Object.keys(fileContents)) {
              if (path === target || path.startsWith(target + '/')) delete fileContents[path];
            }
            persistMockFiles();
            persistMockContents();
            return null;
          }
          case 'duplicate_file': return args.path.replace('.md', ' copy.md');
        case 'detect_project': {
          const projectDir = args.path || args.dirPath;
          if (projectDetectBlockedProjects[projectDir]) {
            return new Promise(resolve => projectDetectWaiters.push({
              projectDir,
              release: () => resolve(projectConfig),
            }));
          }
          return projectConfig;
        }
          case 'start_file_watcher':
            if (watcherStartErrors[args.dirPath]) {
              throw new Error(watcherStartErrors[args.dirPath]);
            }
            return null;
          case 'stop_file_watcher':
          case 'register_open_file': case 'unregister_open_file':
          case 'register_write_ignore': return null;
          case 'poll_external_changes': return [];
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
           case 'check_pandoc': return JSON.parse(JSON.stringify(pandocStatusResponse));
           case 'stage_export_css': {
             const cssPath = '/mock/tmp/novelist-export-theme-' + args.requestId + '.html';
             const finish = () => {
               writtenFiles[cssPath] = args.css;
               return cssPath;
             };
             if (exportCssWriteBlocked) {
               return new Promise(resolve => exportCssWriteWaiters.push(() => resolve(finish())));
             }
             return finish();
           }
            case 'cancel_export_project': {
              if (cancelExportProjectResponse.error) throw new Error(cancelExportProjectResponse.error);
              return cancelExportProjectResponse.result;
            }
           case 'export_project': {
             const finish = () => {
               if (exportProjectResponse.error) throw new Error(exportProjectResponse.error);
               return JSON.parse(JSON.stringify(exportProjectResponse.result));
             };
             if (exportProjectBlocked) {
               return new Promise((resolve, reject) => exportProjectWaiters.push(() => {
                 try { resolve(finish()); } catch (error) { reject(error); }
               }));
             }
             return finish();
           }
           case 'get_publish_settings': {
             const finish = () => ({ channels: publishChannels.map(channel => ({ ...channel })) });
             if (deferredPublishSettingsReadCount > 0) {
               deferredPublishSettingsReadCount -= 1;
               return new Promise(resolve => publishSettingsReadWaiters.push(() => resolve(finish())));
             }
             return finish();
           }
          case 'set_publish_settings': publishChannels = (args.settings?.channels || []).map(channel => ({ ...channel })); persistPublishChannels(); return null;
          case 'read_publish_form_drafts': return {
            forms: JSON.parse(JSON.stringify(publishDraftsFor(args.projectDir, args.filePath))),
            invalid_channel_ids: [...publishDraftInvalidChannelIds],
          };
           case 'read_publish_remote_state': {
             const key = publishRemoteKey(args.projectDir, args.filePath, args.channelId);
             const finish = () => publishRemotes[key]
               ? JSON.parse(JSON.stringify(publishRemotes[key]))
               : null;
             if (deferredPublishRemoteReadCount > 0) {
               deferredPublishRemoteReadCount -= 1;
               return new Promise((resolve, reject) => publishRemoteReadWaiters.push({
                 resolve: () => resolve(finish()),
                 reject,
               }));
             }
             return finish();
           }
           case 'persist_publish_result': {
              const finish = () => {
                if (publishPersistError) throw new Error(publishPersistError);
                const key = publishRemoteKey(args.projectDir, args.filePath, args.channelId);
                const current = publishRemotes[key] || null;
                if (args.result.operation === 'updated') {
                  if (!current) throw new Error('cannot persist an update without tracked identity');
                  if (current.post_id !== args.result.remote_id) {
                    throw new Error('updated remote id does not match tracked identity');
                  }
                  if (current.capability?.kind !== 'updatable') {
                    throw new Error('tracked remote identity is not updatable');
                  }
                }
                const remote = remoteFromPublishResult(args.channelId, args.result);
                publishRemotes[key] = remote;
                return JSON.parse(JSON.stringify(remote));
              };
              if (!publishPersistBlocked) return finish();
              return new Promise((resolve, reject) => publishPersistWaiters.push(() => {
                try { resolve(finish()); } catch (error) { reject(error); }
              }));
           }
           case 'bind_legacy_publication': {
             const finish = () => {
               if (publishBindError) throw publishBindError;
               const channel = publishChannel(args.channelId);
               if (channel.platform === 'medium') {
                 throw JSON.stringify({
                   kind: 'unsupported_update',
                   data: { provider: 'medium', reason: 'insufficient_scope' },
                 });
               }
               const candidate = String(args.urlOrId || '').trim();
               if (!candidate) throw new Error('Remote URL or ID is required');
               const remoteId = candidate.includes('/')
                 ? decodeURIComponent((candidate.endsWith('/') ? candidate.slice(0, -1) : candidate).split('/').pop() || '')
                 : candidate;
               if (!remoteId) throw new Error('Remote URL or ID is invalid');
               const revision = channel.platform === 'ghost'
                 ? { provider: 'ghost', updated_at: 'bound-revision' }
                 : { provider: 'wordpress', modified: 'bound-revision', modified_gmt: null };
               const result = {
                 channel_id: args.channelId,
                 provider: channel.platform === 'wordpress_com'
                   ? 'wordpress_com'
                   : channel.platform === 'wordpress_self_hosted' ? 'wordpress' : 'ghost',
                 remote_id: remoteId,
                 url: candidate.includes('://')
                   ? candidate
                   : 'https://' + channel.platform + '.example/' + remoteId + '/',
                 revision,
                 capability: { kind: 'updatable' },
               };
               publishRemotes[publishRemoteKey(args.projectDir, args.filePath, args.channelId)] = {
                 post_id: result.remote_id,
                 url: result.url,
                 revision: revision.provider === 'ghost' ? revision.updated_at : revision.modified,
                 provider_revision: revision,
                 capability: result.capability,
               };
               return result;
             };
             if (!publishBindBlocked) return finish();
             return new Promise((resolve, reject) => publishBindWaiters.push(() => {
               try { resolve(finish()); } catch (error) { reject(error); }
             }));
           }
            case 'write_publish_form_draft': {
              const finish = () => {
                 if (publishDraftWriteError) throw new Error(publishDraftWriteError);
                 const documentKey = publishDraftDocumentKey(args.projectDir, args.filePath);
                 const documentDrafts = publishDraftsByDocument[documentKey] || {};
                 documentDrafts[args.channelId] = JSON.parse(JSON.stringify(args.form));
                 publishDraftsByDocument[documentKey] = documentDrafts;
                 persistPublishDrafts();
                return null;
            };
            if (!publishDraftWritesBlocked) return finish();
            return new Promise((resolve) => publishDraftWriteWaiters.push(() => resolve(finish())));
          }
          case 'store_publish_cover': return storePublishCover(args);
           case 'load_publish_cover': {
             const finish = () => loadPublishCover(args);
             if (!publishCoverLoadBlocked) return finish();
             return new Promise((resolve, reject) => publishCoverLoadWaiters.push(() => {
               try { resolve(finish()); } catch (error) { reject(error); }
             }));
           }
           case 'clear_publish_cover': return clearPublishCover(args);
           case 'read_clipboard_image': {
             const finish = () => {
               if (publishClipboardImage?.error) throw new Error(publishClipboardImage.error);
               if (!publishClipboardImage) throw new Error('no image on clipboard');
               return JSON.parse(JSON.stringify(publishClipboardImage));
             };
             if (!publishClipboardReadBlocked) return finish();
             return new Promise((resolve, reject) => publishClipboardReadWaiters.push(() => {
               try { resolve(finish()); } catch (error) { reject(error); }
             }));
           }
          case 'list_publish_tags': return ['restored', 'existing'];
          case 'convert_markdown_to_html': return '<p>Converted online body</p>';
          case 'convert_markdown_to_styled_html': {
            const finish = () => {
              if (styledConversionError) throw styledConversionError;
              return styledConversionHtml ?? styledHtml(args.markdown);
            };
            if (!styledConversionBlocked) return finish();
            return new Promise((resolve, reject) => styledConversionWaiters.push(() => {
              try { resolve(finish()); } catch (error) { reject(error); }
            }));
          }
          case 'write_styled_clipboard': {
            if (styledClipboardError) throw new Error(styledClipboardError);
            return null;
          }
          case 'read_styled_copy_image': {
            const result = styledImageResults[args.path];
            if (result?.error) throw new Error(result.error);
            return result ?? { bytes: [137, 80, 78, 71], mime: 'image/png' };
          }
          case 'get_image_host_settings': return JSON.parse(JSON.stringify(styledImageHostSettings));
          case 'upload_image_imgur': {
            const result = styledUploadResults[args.filename];
            if (result?.error) throw new Error(result.error);
            return {
              url: result?.url ?? 'https://imgur.example/' + args.filename,
              remote_key: null,
            };
          }
          case 'upload_post_image_ghost': return {
            url: 'https://ghost.example/assets/' + args.filename,
            attachment_id: 0,
          };
          case 'upload_post_image_wordpress_self_hosted':
          case 'upload_post_image_wordpress_com': return {
            url: 'https://wordpress.example/assets/' + args.filename,
            attachment_id: 91,
          };
          case 'upload_post_image_medium': return {
            url: 'https://medium.example/assets/' + args.filename,
            attachment_id: 0,
          };
           case 'publish_to_ghost': {
            const finish = () => {
              return nextPublishResult('ghost', args.input);
            };
            if (!publishBlocked) return finish();
            return new Promise((resolve, reject) => publishWaiters.push(() => {
              try { resolve(finish()); } catch (error) { reject(error); }
            }));
           }
           case 'verify_wordpress_self_hosted_update':
           case 'verify_wordpress_com_update': return nextPublishVerification();
           case 'publish_to_wordpress_self_hosted': return nextPublishResult('wordpress_self_hosted', args.input);
          case 'publish_to_wordpress_com': return nextPublishResult('wordpress_com', args.input);
          case 'publish_to_medium': return nextPublishResult('medium', args.input);
          case 'list_plugins': return scaffoldedPlugins.slice();
          case 'set_plugin_enabled': {
            const plugin = scaffoldedPlugins.find(candidate => candidate.id === args.pluginId);
            if (!plugin) throw new Error('Plugin not found: ' + args.pluginId);
            plugin.enabled = !!args.enabled;
            return null;
          }
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
          case 'inspect_literary_source': return {
            title: literaryOverview.title,
            author: literaryOverview.author,
            language: literaryOverview.language,
            sourcePath: args.path,
            chapters: literaryOverview.chapters.map((chapter, index) => ({
              id: chapter.id,
              volume: chapter.volume,
              title: chapter.title,
              text: index === 0 ? '天地玄黄宇宙' : '洪荒日月盈昃',
            })),
          };
          case 'create_literary_study_project': {
            const target = args.request.parentDir.replace(/[\\\\/]$/, '')
              + '/' + args.request.projectName;
            return {
              projectPath: target,
              firstChapterPath: target + '/学习内容/第一章.litstudy',
              chapterCount: args.request.chapters.length,
            };
          }
          case 'read_literary_study_overview':
            return JSON.parse(JSON.stringify(literaryOverview));
          case 'replace_literary_study_book': {
            const chapters = args.request.chapters || [];
            const first = chapters[0]?.title || '第一章';
            return {
              firstChapterPath: args.request.projectDir + '/学习内容/' + first + '.litstudy',
              resumeChapterPath: args.request.projectDir + '/学习内容/' + first + '.litstudy',
              chapterCount: chapters.length,
              preservedChapterCount: 0,
            };
          }
          case 'rope_open': return { file_id: 'mock-rope-id', total_lines: 100, total_bytes: 5000 };
          case 'rope_get_lines': return {
            text: 'Mock content\\n',
            start_line: args.startLine,
            end_line: args.endLine,
            total_lines: 100,
          };
          case 'rope_snapshot': return {
            text: 'Mock Rope snapshot\\n',
            generation: 7,
            total_lines: 2,
            total_chars: 19,
          };
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
            const dir = args.dir.endsWith('/') ? args.dir.slice(0, -1) : args.dir;
            if (dir !== projectDir && !files.some(f => f.is_dir && f.path === dir)) {
              throw new Error('parent directory does not exist: ' + dir);
            }
            const parent = dir + '/';
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
            persistMockFiles(); persistMockContents();
            return path;
          }
          case 'save_ai_chat': {
            const root = args.projectDir?.endsWith('/') ? args.projectDir.slice(0, -1) : args.projectDir;
            if (!root || (root !== projectDir && !files.some(f => f.path === root || f.path.startsWith(root + '/')))) {
              throw new Error('project directory does not exist: ' + root);
            }
            const filename = args.filename;
            const invalidFilename = typeof filename !== 'string'
              || !filename.endsWith('.md')
              || new TextEncoder().encode(filename).length > 240
              || filename.slice(0, -3).trim().length === 0
              || filename.includes('/')
              || filename.includes(String.fromCharCode(92))
              || /[\u0000-\u001f]/.test(filename);
            if (invalidFilename) throw new Error('invalid chat filename');
            if (typeof args.body !== 'string') throw new Error('invalid chat body');

            const novelistDir = root + '/.novelist';
            const chatsDir = novelistDir + '/chats';
            for (const directory of [novelistDir, chatsDir]) {
              if (files.some(f => !f.is_dir && f.path === directory)) {
                throw new Error('chat directory path is not a directory: ' + directory);
              }
              if (!files.some(f => f.is_dir && f.path === directory)) {
                files.push({
                  name: directory.slice(directory.lastIndexOf('/') + 1),
                  path: directory,
                  is_dir: true,
                  size: 0,
                  mtime: Date.now(),
                });
                createdFiles.push(directory);
              }
            }

            const stem = filename.slice(0, -3);
            let name = filename;
            let path = chatsDir + '/' + name;
            let suffix = 2;
            while (files.some(f => f.path === path) && suffix <= 9999) {
              name = stem + ' ' + suffix + '.md';
              path = chatsDir + '/' + name;
              suffix += 1;
            }
            if (files.some(f => f.path === path)) throw new Error('chat filename collision limit reached');

            files.push({ name, path, is_dir: false, size: args.body.length, mtime: Date.now() });
            fileContents[path] = args.body;
            writtenFiles[path] = args.body;
            createdFiles.push(path);
            persistMockFiles(); persistMockContents();
            return path;
          }
           case 'get_sync_config': return { enabled: false, webdav_url: '', username: '', has_password: false, interval_minutes: 30 };
          case 'save_sync_config': case 'sync_now': return null;
          case 'test_sync_connection': return true;
          case 'reveal_in_file_manager': return null;
           case 'log_startup_phase': return null;
           case 'plugin:window|set_title':
           case 'plugin:window|show':
           case 'plugin:window|set_focus':
           case 'plugin:window|start_dragging':
           case 'refresh_menu':
           case 'set_window_appearance': return null;
           case 'get_pending_open_projects':
           case 'get_pending_open_files': return [];
           case 'is_portable_mode': {
             if (portableModeResponse?.error) throw new Error(portableModeResponse.error);
             return JSON.parse(JSON.stringify(portableModeResponse));
           }
            case 'plugin:updater|check': {
              updaterCheckCount += 1;
              const response = updaterResponses.length > 0 ? updaterResponses.shift() : null;
              persistUpdaterResponses();
              if (response?.error) throw new Error(response.error);
             if (!response) return null;
             return {
               rid: updaterCheckCount,
               currentVersion: '0.3.2',
               version: response.version,
               date: null,
               body: response.body ?? null,
               rawJson: {},
             };
           }
           case 'plugin:dialog|message': return 'Ok';
           case 'plugin:dialog|save': return '/mock/export.html';
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
            const base = projectConfig && typeof projectConfig === 'object'
              ? JSON.parse(JSON.stringify(projectConfig))
              : {
                  project: { name: 'Mock', type: 'novel', version: '0.1.0' },
                  outline: { order: [] },
                  writing: { daily_goal: 2000, auto_save_minutes: 5 },
                };
            return {
              ...base,
              view: p?.view ?? {},
              new_file: p?.new_file ?? {},
              plugins: p?.plugins ?? { enabled: {} },
            };
          }
          case 'list_ai_sessions': {
            if (aiSessionListErrors[args.projectDir]) {
              throw new Error(aiSessionListErrors[args.projectDir]);
            }
            const prefix = aiSessionPrefix(args.projectDir, args.kind);
            return Object.keys(aiSessions)
              .filter(k => k.startsWith(prefix))
              .map(k => {
                const id = k.slice(prefix.length);
                return {
                  id,
                  kind: args.kind,
                  path: args.projectDir + '/.novelist/ai/sessions/' + args.kind + '-' + id + '.json',
                  updatedAt: aiSessions[k].updatedAt,
                };
              })
              .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          }
          case 'read_ai_session': {
            return aiSessions[aiSessionKey(args.projectDir, args.kind, args.id)]?.body ?? null;
          }
          case 'write_ai_session': {
            const write = () => {
              if (aiSessionWriteError) throw new Error(aiSessionWriteError);
              aiSessionWriteCount += 1;
              aiSessions[aiSessionKey(args.projectDir, args.kind, args.id)] = { body: args.bodyJson, updatedAt: Date.now() };
              const path = args.projectDir + '/.novelist/ai/sessions/' + args.kind + '-' + args.id + '.json';
              fileContents[path] = args.bodyJson;
              writtenFiles[path] = args.bodyJson;
              return null;
            };
            if (aiSessionWritesBlocked) {
              return new Promise((resolve, reject) => aiSessionWriteWaiters.push(() => {
                try { resolve(write()); } catch (e) { reject(e); }
              }));
            }
            return write();
          }
          case 'delete_ai_session': {
            const remove = () => {
              if (aiSessionWriteError) throw new Error(aiSessionWriteError);
              delete aiSessions[aiSessionKey(args.projectDir, args.kind, args.id)];
              return null;
            };
            if (aiSessionDeletesBlocked) {
              return new Promise((resolve, reject) => aiSessionDeleteWaiters.push(() => {
                try { resolve(remove()); } catch (e) { reject(e); }
              }));
            }
            return remove();
          }
          case 'list_ai_prompt_assets': {
            const loadAssets = () => {
              if (aiPromptAssetErrors[args.projectDir]) throw new Error(aiPromptAssetErrors[args.projectDir]);
              const root = args.projectDir + '/.novelist/ai/';
              const allContents = { ...fileContents, ...writtenFiles };
              const assetFor = (path, kind) => ({
                id: path.slice(root.length),
                kind,
                path,
                name: path.slice(path.lastIndexOf('/') + 1).replace(/\\.md$/, ''),
                content: allContents[path],
              });
              const commands = Object.keys(allContents)
                .filter(p => p.startsWith(root + 'commands/') && p.endsWith('.md') && !p.slice(root.length).split('/').some(part => part.startsWith('.')))
                .map(p => assetFor(p, 'command'));
              const skills = Object.keys(allContents)
                .filter(p => p.startsWith(root + 'skills/') && p.endsWith('.md') && !p.slice(root.length).split('/').some(part => part.startsWith('.')))
                .map(p => assetFor(p, 'skill'));
              const memoryPath = root + 'memory.md';
              return {
                commands,
                skills,
                memory: allContents[memoryPath] != null ? assetFor(memoryPath, 'memory') : null,
              };
            };
            if (!aiPromptAssetBlockedProjects[args.projectDir]) return loadAssets();
            return new Promise((resolve, reject) => aiPromptAssetWaiters.push({
              projectDir: args.projectDir,
              release() {
                try { resolve(loadAssets()); } catch (error) { reject(error); }
              },
            }));
          }
          case 'write_ai_memory': {
            const path = args.projectDir + '/.novelist/ai/memory.md';
            fileContents[path] = args.body;
            writtenFiles[path] = args.body;
            return null;
          }
          case 'ai_fetch_stream_start': return 'mock-stream-' + (++aiStreamCounter);
          case 'ai_fetch_stream_cancel': return null;
          case 'claude_cli_detect': return claudeCliDetectResult;
          case 'claude_cli_spawn': {
            const sessionUuid = args.req?.session_uuid || 'mock-claude-session';
            claudeCliSpawnUuidHistory.push(sessionUuid);
            return sessionUuid;
          }
          case 'claude_cli_send': {
            claudeCliSendCount += 1;
            if (claudeCliSendError) throw new Error(claudeCliSendError);
            return null;
          }
          case 'claude_cli_kill': {
            claudeCliKillCount += 1;
            if (!claudeCliKillBlocked) return null;
            return new Promise(resolve => claudeCliKillWaiters.push(resolve));
          }
          case 'codex_cli_detect': return null;
          case 'codex_cli_turn':
            codexCliTurnCount += 1;
            if (codexCliTurnError) throw new Error(codexCliTurnError);
            return 'mock-codex-turn';
           case 'codex_cli_kill':
             codexCliKillCount += 1;
             if (codexCliKillBlocked) {
               return new Promise(resolve => codexCliKillWaiters.push(() => resolve(null)));
              }
              return null;
           case 'plugin:shell|open': return null;
           default:
             unhandledCommands.push({ command: cmd, args: JSON.parse(JSON.stringify(args || {})) });
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
        get claudeCliSpawnUuidHistory() { return [...claudeCliSpawnUuidHistory]; },
        get claudeCliSendCount() { return claudeCliSendCount; },
        get claudeCliKillCount() { return claudeCliKillCount; },
        get codexCliTurnCount() { return codexCliTurnCount; },
        get codexCliKillCount() { return codexCliKillCount; },
         get aiSessionWriteCount() { return aiSessionWriteCount; },
         get invokeCalls() { return invokeCalls.map(call => ({ command: call.command, args: JSON.parse(JSON.stringify(call.args)) })); },
         get unhandledCommands() { return unhandledCommands.map(call => ({ command: call.command, args: JSON.parse(JSON.stringify(call.args)) })); },
         get publishCoverState() { return JSON.parse(JSON.stringify(publishCoverState)); },
         get publishRemotes() { return JSON.parse(JSON.stringify(publishRemotes)); },
         get residue() {
           return {
             writtenFileCount: Object.keys(writtenFiles).length,
             createdFileCount: createdFiles.length,
             deletedFileCount: deletedFiles.length,
             invokeCallCount: invokeCalls.length,
             unhandledCommandCount: unhandledCommands.length,
             aiSessionCount: Object.keys(aiSessions).length,
             publishDraftCount: Object.values(publishDraftsByDocument)
               .reduce((count, forms) => count + Object.keys(forms).length, 0),
             publishRemoteCount: Object.keys(publishRemotes).length,
              publishCoverAssetCount: Object.keys(publishCoverState.assets).length,
              publishCoverRefCount: Object.keys(publishCoverState.refs).length,
              publishChannelCount: publishChannels.length,
              publishResponseCount: publishResponses.length,
              templateCount: Object.keys(mockTemplates).length,
              scaffoldedPluginCount: Math.max(0, scaffoldedPlugins.length - builtinScaffoldedPluginCount),
              eventListenerCount: Object.values(eventListeners).reduce((count, listeners) => count + listeners.length, 0),
               pendingWaiterCount: claudeCliKillWaiters.length
                + codexCliKillWaiters.length
                + aiSessionWriteWaiters.length
                + aiSessionDeleteWaiters.length
                + blockedReadWaiters.length
                + blockedConditionalWriteWaiters.length
                 + publishCoverLoadWaiters.length
                 + publishClipboardReadWaiters.length
                 + publishSettingsReadWaiters.length
                 + publishRemoteReadWaiters.length
                 + publishWaiters.length
                 + publishBindWaiters.length
                  + publishPersistWaiters.length
                  + publishDraftWriteWaiters.length
                 + managedNameWriteWaiters.length
                 + aiPromptAssetWaiters.length
                 + styledConversionWaiters.length,
              updaterResponseCount: updaterResponses.length,
             updaterCheckCount,
           };
         },
        seedRecentProjects(list) {
          recentProjects.length = 0;
          for (const p of list) recentProjects.push({ ...p });
        },
        emitEvent(event, payload, targetLabel) {
          const isAiStream = event.startsWith('claude-stream://') || event.startsWith('codex-stream://');
          const routedPayload = isAiStream
            ? { ...payload, target_label: targetLabel ?? mockWindowLabel }
            : payload;
          const listeners = eventListeners[event] || [];
          for (const entry of listeners) {
            const h = entry.handler;
            // listener handle is either a direct fn or a Tauri transformCallback id
            if (typeof h === 'function') {
              h({ event, payload: routedPayload });
            } else if (typeof h === 'number' && typeof window['_' + h] === 'function') {
              window['_' + h]({ event, payload: routedPayload });
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
          persistMockFiles();
        },
        setProjectConfig(value) {
          projectConfig = JSON.parse(JSON.stringify(value));
        },
        setLiteraryOverview(value) {
          literaryOverview = JSON.parse(JSON.stringify(value));
        },
        seedFileContents(map) {
          for (const k of Object.keys(map || {})) fileContents[k] = map[k];
          persistMockContents();
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
            persistMockContents();
          }
          migrateNaming(projectDir, oldPath, newPath);
          f.path = newPath;
          f.name = finalName;
          f.mtime = Date.now();
          persistMockFiles();
        },
         reset() {
           Object.keys(writtenFiles).forEach(k => delete writtenFiles[k]);
           createdFiles.length = 0;
           deletedFiles.length = 0;
           invokeCalls.length = 0;
           unhandledCommands.length = 0;
           updaterCheckCount = 0;
           for (const path of Object.keys(conditionalWriteResolutions)) delete conditionalWriteResolutions[path];
           blockedConditionalWritePath = null;
           blockedConditionalWriteWaiters.length = 0;
         },
         resetAll() {
           this.reset();
           files.length = 0;
           for (const file of ${JSON.stringify(config.files)}) files.push({ ...file, mtime: file.mtime ?? Date.now() });
           for (const path of Object.keys(fileContents)) delete fileContents[path];
           Object.assign(fileContents, ${JSON.stringify(config.fileContents)});
           recentProjects.length = 0;
           for (const recent of ${JSON.stringify(config.recentProjects)}) recentProjects.push({ ...recent });
           projectDir = ${JSON.stringify(config.projectDir)};
           projectConfig = ${JSON.stringify(config.projectConfig)};
           literaryOverview = JSON.parse(JSON.stringify(defaultLiteraryOverview));

           aiStreamCounter = 0;
           claudeCliDetectResult = null;
           claudeCliSendError = null;
           claudeCliSpawnUuidHistory.length = 0;
           claudeCliSendCount = 0;
           claudeCliKillCount = 0;
           claudeCliKillBlocked = false;
           claudeCliKillWaiters.length = 0;
           codexCliTurnCount = 0;
           codexCliTurnError = null;
           codexCliKillCount = 0;
           codexCliKillBlocked = false;
           codexCliKillWaiters.length = 0;
           aiSessionWritesBlocked = false;
           aiSessionWriteError = null;
           aiSessionWriteWaiters.length = 0;
           aiSessionWriteCount = 0;
           aiSessionDeletesBlocked = false;
            aiSessionDeleteWaiters.length = 0;
            for (const key of Object.keys(aiSessions)) delete aiSessions[key];
            for (const key of Object.keys(aiSessionListErrors)) delete aiSessionListErrors[key];
             for (const key of Object.keys(aiPromptAssetErrors)) delete aiPromptAssetErrors[key];
             for (const key of Object.keys(aiPromptAssetBlockedProjects)) delete aiPromptAssetBlockedProjects[key];
             for (const waiter of aiPromptAssetWaiters.splice(0)) waiter.release();
             for (const key of Object.keys(watcherStartErrors)) delete watcherStartErrors[key];

           blockedReadPath = null;
           blockedReadWaiters.length = 0;
           blockedConditionalWritePath = null;
           blockedConditionalWriteWaiters.length = 0;
            conditionalWriteMutation = null;
            for (const path of Object.keys(conditionalWriteResolutions)) delete conditionalWriteResolutions[path];

            for (const event of Object.keys(eventListeners)) delete eventListeners[event];
            nextEventListenerId = 1;
            for (const key of Object.keys(mockTemplates)) delete mockTemplates[key];
            scaffoldedPlugins.length = builtinScaffoldedPluginCount;
            const literaryPlugin = scaffoldedPlugins.find(plugin => plugin.id === 'literary-commentary');
            if (literaryPlugin) literaryPlugin.enabled = false;
            const kanbanPlugin = scaffoldedPlugins.find(plugin => plugin.id === 'kanban');
            if (kanbanPlugin) kanbanPlugin.enabled = true;

             publishChannels = [];
             deferredPublishSettingsReadCount = 0;
             publishSettingsReadWaiters.length = 0;
             publishDraftsByDocument = {};
            publishDraftInvalidChannelIds = [];
           publishCoverState = { assets: {}, refs: {} };
           publishCoverLoadBlocked = false;
           publishCoverLoadWaiters.length = 0;
           publishClipboardImage = null;
           publishClipboardReadBlocked = false;
           publishClipboardReadWaiters.length = 0;
           publishBlocked = false;
            publishError = null;
            publishBindError = null;
            publishBindBlocked = false;
            publishBindWaiters.length = 0;
            publishPersistError = null;
            publishPersistBlocked = false;
            publishPersistWaiters.length = 0;
            publishSequence = 0;
            publishResponses = [];
            publishVerifyResponses = [];
           for (const key of Object.keys(publishRemotes)) delete publishRemotes[key];
           deferredPublishRemoteReadCount = 0;
           publishRemoteReadWaiters.length = 0;
            publishWaiters.length = 0;
             publishDraftWritesBlocked = false;
             publishDraftWriteError = null;
             publishDraftWriteWaiters.length = 0;
             managedNameWritesBlocked = false;
             managedNameWriteWaiters.length = 0;

           styledConversionBlocked = false;
           styledConversionError = null;
           styledConversionHtml = null;
           styledClipboardError = null;
           styledImageResults = {};
           styledImageHostSettings = { hosts: [], active_host_id: null, auto_on_paste: false };
           styledUploadResults = {};
           styledConversionWaiters.length = 0;
           pandocStatusResponse = {
             available: false,
             version: null,
             resolved_path: null,
             override_path: null,
           };
           exportProjectResponse = {
             result: { message: 'Export complete: /mock/export.html' },
           };

           portableModeResponse = { enabled: false, data_root: '/mock/user-data' };
           updaterResponses = [];
           updaterCheckCount = 0;
           persistMockFiles();
           persistMockContents();
           persistPublishChannels();
           persistPublishDrafts();
           persistPublishCoverState();
           persistUpdaterResponses();
         },
        // AI bridge test helpers — let specs simulate streamed responses
        // and control whether the Claude CLI is "installed".
        setClaudeCliDetectResult(v) { claudeCliDetectResult = v; },
        setClaudeCliSendError(message) { claudeCliSendError = message; },
        setAiSessionWriteError(message) { aiSessionWriteError = message; },
        setAiSessionWritesBlocked(blocked) {
          aiSessionWritesBlocked = blocked;
          if (!blocked) {
            for (const resolve of aiSessionWriteWaiters.splice(0)) resolve();
          }
        },
         setAiSessionDeletesBlocked(blocked) {
          aiSessionDeletesBlocked = blocked;
          if (!blocked) {
            for (const resolve of aiSessionDeleteWaiters.splice(0)) resolve();
           }
         },
          setAiSessionListError(projectDir, message) {
           if (message == null) delete aiSessionListErrors[projectDir];
           else aiSessionListErrors[projectDir] = String(message);
         },
         setReadFileBlocked(path, blocked) {
          blockedReadPath = blocked ? path : null;
          if (!blocked) {
            const pending = blockedReadWaiters.splice(0);
            for (const waiter of pending) waiter.resolve();
          }
        },
        releaseNextBlockedRead() {
          const waiter = blockedReadWaiters.shift();
          if (!waiter) throw new Error('No blocked read is pending');
          waiter.resolve();
        },
        failNextBlockedRead(message) {
          const waiter = blockedReadWaiters.shift();
          if (!waiter) throw new Error('No blocked read is pending');
          waiter.reject(message);
        },
        rejectBlockedRead(message) {
          blockedReadPath = null;
          for (const waiter of blockedReadWaiters.splice(0)) waiter.reject(new Error(message));
        },
        scheduleConditionalWriteMutation(path, content) {
          conditionalWriteMutation = { path, content };
        },
        setConditionalWriteBlocked(path, blocked) {
          blockedConditionalWritePath = blocked ? path : null;
          if (!blocked) {
            const pending = blockedConditionalWriteWaiters.splice(0);
            for (const waiter of pending) waiter.resolve();
          }
        },
        setConditionalWriteResolvedTarget(path, resolvedPath, content) {
          conditionalWriteResolutions[path] = resolvedPath;
          fileContents[resolvedPath] = content;
          persistMockContents();
        },
        getFileContent(path) {
          return writtenFiles[path] ?? fileContents[path] ?? null;
        },
        setFileContent(path, content) {
          fileContents[path] = content;
          delete writtenFiles[path];
          persistMockContents();
        },
        setPublishChannels(channels) {
          publishChannels = (channels || []).map(channel => ({ ...channel }));
          persistPublishChannels();
        },
        deferNextPublishSettingsRead() {
          deferredPublishSettingsReadCount += 1;
        },
        releaseNextPublishSettingsRead() {
          const release = publishSettingsReadWaiters.shift();
          if (!release) throw new Error('No deferred publish settings read is pending');
          release();
        },
        releaseAllPublishSettingsReads() {
          for (const release of publishSettingsReadWaiters.splice(0)) release();
          deferredPublishSettingsReadCount = 0;
        },
         setPublishDrafts(forms) {
           const documentKey = publishDraftDocumentKey(
             ${JSON.stringify(config.projectDir)},
             ${JSON.stringify(config.files.find((entry) => !entry.is_dir)?.path ?? '')},
           );
           publishDraftsByDocument[documentKey] = JSON.parse(JSON.stringify(forms || {}));
           persistPublishDrafts();
         },
         setPublishDraftInvalidChannelIds(channelIds) {
           publishDraftInvalidChannelIds = Array.isArray(channelIds) ? [...channelIds] : [];
         },
        setPublishRemote(project, filePath, channelId, remote) {
          const key = publishRemoteKey(project, filePath, channelId);
          if (remote == null) delete publishRemotes[key];
          else publishRemotes[key] = JSON.parse(JSON.stringify(remote));
        },
         setPublishResponses(responses) {
           publishResponses = JSON.parse(JSON.stringify(responses || []));
         },
         setPublishVerifyResponses(responses) {
           publishVerifyResponses = JSON.parse(JSON.stringify(responses || []));
         },
        deferNextPublishRemoteRead() {
          deferredPublishRemoteReadCount += 1;
        },
        releaseNextPublishRemoteRead() {
          const waiter = publishRemoteReadWaiters.shift();
          if (!waiter) throw new Error('No deferred publish remote-state read is pending');
          waiter.resolve();
        },
        rejectNextPublishRemoteRead(message) {
          const waiter = publishRemoteReadWaiters.shift();
          if (!waiter) throw new Error('No deferred publish remote-state read is pending');
          waiter.reject(new Error(message));
        },
        releaseAllPublishRemoteReads() {
          for (const waiter of publishRemoteReadWaiters.splice(0)) waiter.resolve();
          deferredPublishRemoteReadCount = 0;
        },
        setPublishBindError(message) { publishBindError = message; },
        setPublishBindBlocked(blocked) {
          publishBindBlocked = blocked;
          if (!blocked) {
            for (const release of publishBindWaiters.splice(0)) release();
          }
        },
        setPublishPersistError(message) { publishPersistError = message; },
        setPublishPersistBlocked(blocked) {
          publishPersistBlocked = blocked;
          if (!blocked) {
            for (const release of publishPersistWaiters.splice(0)) release();
          }
        },
         setPublishClipboardImage(image) {
           publishClipboardImage = image == null ? null : JSON.parse(JSON.stringify(image));
         },
         setPublishCoverLoadBlocked(blocked) {
           publishCoverLoadBlocked = blocked;
           if (!blocked) {
             for (const release of publishCoverLoadWaiters.splice(0)) release();
           }
         },
         releaseNextPublishCoverLoad() {
           const release = publishCoverLoadWaiters.shift();
           if (!release) throw new Error('No blocked publish cover load is pending');
           release();
         },
         setPublishClipboardReadBlocked(blocked) {
           publishClipboardReadBlocked = blocked;
           if (!blocked) {
             for (const release of publishClipboardReadWaiters.splice(0)) release();
           }
         },
         releaseNextPublishClipboardRead() {
           const release = publishClipboardReadWaiters.shift();
           if (!release) throw new Error('No blocked publish clipboard read is pending');
           release();
         },
         setPublishBlocked(blocked) {
          publishBlocked = blocked;
          if (!blocked) {
            for (const release of publishWaiters.splice(0)) release();
          }
        },
        setPublishError(message) { publishError = message; },
        setPublishDraftWritesBlocked(blocked) {
          publishDraftWritesBlocked = blocked;
          if (!blocked) {
            for (const release of publishDraftWriteWaiters.splice(0)) release();
          }
        },
         setPublishDraftWriteError(message) { publishDraftWriteError = message; },
         setManagedNameWritesBlocked(blocked) {
           managedNameWritesBlocked = blocked;
           if (!blocked) {
             for (const waiter of managedNameWriteWaiters.splice(0)) waiter.resolve();
           }
         },
         releaseNextManagedNameWrite() {
           const waiter = managedNameWriteWaiters.shift();
           if (!waiter) throw new Error('No blocked managed-name write is pending');
           waiter.resolve();
         },
         setStyledConversionBlocked(blocked) {
          styledConversionBlocked = blocked;
          if (!blocked) {
            for (const release of styledConversionWaiters.splice(0)) release();
          }
        },
         setStyledConversionError(message) { styledConversionError = message; },
         setStyledConversionHtml(html) { styledConversionHtml = html; },
         setStyledClipboardError(message) { styledClipboardError = message; },
         setStyledImageResults(results) { styledImageResults = JSON.parse(JSON.stringify(results || {})); },
         setStyledImageHostSettings(settings) { styledImageHostSettings = JSON.parse(JSON.stringify(settings)); },
          setStyledUploadResults(results) { styledUploadResults = JSON.parse(JSON.stringify(results || {})); },
          setPandocStatus(response) {
            pandocStatusResponse = JSON.parse(JSON.stringify(response));
          },
          setAiPromptAssetError(projectDir, message) {
            if (message == null) delete aiPromptAssetErrors[projectDir];
            else aiPromptAssetErrors[projectDir] = String(message);
          },
          setAiPromptAssetsBlocked(projectDir, blocked) {
            if (blocked) {
              aiPromptAssetBlockedProjects[projectDir] = true;
              return;
            }
            delete aiPromptAssetBlockedProjects[projectDir];
            const pending = aiPromptAssetWaiters.filter(waiter => waiter.projectDir === projectDir);
            for (let index = aiPromptAssetWaiters.length - 1; index >= 0; index -= 1) {
              if (aiPromptAssetWaiters[index].projectDir === projectDir) aiPromptAssetWaiters.splice(index, 1);
            }
            for (const waiter of pending) waiter.release();
          },
          setProjectDetectBlocked(projectDir, blocked) {
            if (blocked) {
              projectDetectBlockedProjects[projectDir] = true;
              return;
            }
            delete projectDetectBlockedProjects[projectDir];
            const pending = projectDetectWaiters.filter(waiter => waiter.projectDir === projectDir);
            for (let index = projectDetectWaiters.length - 1; index >= 0; index -= 1) {
              if (projectDetectWaiters[index].projectDir === projectDir) projectDetectWaiters.splice(index, 1);
            }
            for (const waiter of pending) waiter.release();
          },
          setWatcherStartError(projectDir, message) {
            if (message == null) delete watcherStartErrors[projectDir];
            else watcherStartErrors[projectDir] = String(message);
          },
          setExportProjectResponse(response) {
            exportProjectResponse = JSON.parse(JSON.stringify(response));
          },
          setExportProjectBlocked(blocked) {
            exportProjectBlocked = blocked;
            if (!blocked) {
              for (const release of exportProjectWaiters.splice(0)) release();
            }
          },
          setCancelExportProjectResponse(response) {
            cancelExportProjectResponse = response?.error
              ? { error: String(response.error) }
              : { result: !!response };
          },
          setExportCssWriteBlocked(blocked) {
            exportCssWriteBlocked = blocked;
            if (!blocked) {
              for (const release of exportCssWriteWaiters.splice(0)) release();
            }
          },
         setPortableMode(value) {
           portableModeResponse = value?.error
             ? { error: String(value.error) }
             : { enabled: !!value?.enabled, data_root: value?.dataRoot || '/mock/user-data' };
         },
         setUpdaterResponses(responses) {
           updaterResponses = JSON.parse(JSON.stringify(responses || []));
           persistUpdaterResponses();
         },
        setClaudeCliKillBlocked(blocked) {
          claudeCliKillBlocked = blocked;
          if (!blocked) {
            for (const resolve of claudeCliKillWaiters.splice(0)) resolve(null);
          }
        },
        setCodexCliKillBlocked(blocked) {
          codexCliKillBlocked = blocked;
          if (!blocked) {
            for (const resolve of codexCliKillWaiters.splice(0)) resolve();
          }
        },
        setCodexCliTurnError(message) { codexCliTurnError = message; },
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
          currentWindow: { label: mockWindowLabel },
          currentWebview: { label: mockWindowLabel, windowLabel: mockWindowLabel },
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
            const eventId = nextEventListenerId++;
            eventListeners[event].push({ eventId, handler });
            return Promise.resolve(eventId);
          }
          return Promise.resolve(nextEventListenerId++);
        }
        if (cmd === 'plugin:event|unlisten') {
          const { event, eventId } = args || {};
          if (eventListeners[event]) {
            eventListeners[event] = eventListeners[event].filter(entry => entry.eventId !== eventId);
          }
          return Promise.resolve();
        }
        return originalInvoke(cmd, args);
      };
    })();
  `;
}
