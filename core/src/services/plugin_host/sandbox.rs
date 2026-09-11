use rquickjs::{Context, Ctx, Function, Object, Runtime, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::models::plugin::{PluginInfo, PluginManifest, RegisteredCommandInfo};

use super::permissions;

// Limits apply per plugin. Runtime creation remains lazy (only on plugin load).
const PLUGIN_MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const PLUGIN_STACK_LIMIT: usize = 256 * 1024;
const PLUGIN_EXECUTION_LIMIT: Duration = Duration::from_millis(500);
// Rust-owned result copies are not charged to QuickJS's heap. Bound them too,
// including repeated references to the same JS string and sparse arrays.
const PLUGIN_TRANSFER_LIMIT: usize = 8 * 1024 * 1024;
const PLUGIN_RESULT_LIMIT: u32 = 10_000;
const PLUGIN_ERROR_CHARS: usize = 256;

/// Armed outside Context::with, so Drop never re-locks an already-held runtime.
/// The same deadline covers injected code, plugin code, getters and conversion.
struct ExecutionBudget {
    runtime: Runtime,
    deadline: Instant,
}

impl ExecutionBudget {
    fn arm(runtime: &Runtime) -> Self {
        let deadline = Instant::now() + PLUGIN_EXECUTION_LIMIT;
        runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
        Self {
            runtime: runtime.clone(),
            deadline,
        }
    }

    fn check(&self) -> rquickjs::Result<()> {
        if Instant::now() >= self.deadline {
            return Err(rquickjs::Error::new_from_js_message(
                "plugin execution",
                "host result",
                "execution deadline exceeded",
            ));
        }
        Ok(())
    }

    fn run<T>(
        &self,
        context: &Context,
        phase: &str,
        operation: impl for<'js> FnOnce(Ctx<'js>, &Self) -> rquickjs::Result<T>,
    ) -> Result<T, String> {
        let result = context.with(|ctx| {
            self.check()
                .and_then(|()| operation(ctx.clone(), self))
                .map_err(|error| self.describe_error(&ctx, phase, error))
        });
        // Native conversions may not poll QuickJS's interrupt hook. Do not
        // publish a result that finished after the deadline either.
        if self.check().is_err() {
            return Err(format!(
                "{phase}: plugin execution time limit ({} ms) exceeded; reduce the work per command or fix an infinite loop",
                PLUGIN_EXECUTION_LIMIT.as_millis()
            ));
        }
        result
    }

    fn describe_error(&self, ctx: &Ctx<'_>, phase: &str, error: rquickjs::Error) -> String {
        // Never stringify a plugin-controlled exception or its stack: both can
        // execute JS and produce arbitrarily large Rust strings. Reading a
        // message getter is still covered by the armed deadline.
        let thrown = ctx.catch();
        let message = if let Some(string) = thrown.as_string() {
            string.clone().to_cstring().ok()
        } else if let Some(object) = thrown.as_object() {
            object
                .get::<_, rquickjs::String>("message")
                .and_then(|string| string.to_cstring())
                .ok()
        } else {
            None
        };
        let detail: String = match message.as_ref() {
            Some(message) => match checked_js_string(message) {
                Ok(message) => message.chars().take(PLUGIN_ERROR_CHARS).collect(),
                Err(_) => {
                    "Plugin exception contains invalid UTF-8 (unpaired UTF-16 surrogate)".into()
                }
            },
            None => error.to_string().chars().take(PLUGIN_ERROR_CHARS).collect(),
        };
        // Clear any exception raised while inspecting the original failure.
        drop(ctx.catch());
        if matches!(error, rquickjs::Error::Allocation) || detail.contains("out of memory") {
            format!("{phase}: plugin memory limit (64 MiB) exhausted; reduce allocations or document size")
        } else if detail.contains("stack overflow")
            || detail.contains("Maximum call stack size exceeded")
        {
            format!("{phase}: plugin stack limit (256 KiB) exceeded; reduce recursion")
        } else {
            format!("{phase}: {detail}; plugin limits: 64 MiB heap, 256 KiB stack, 500 ms execution; reduce plugin work if resource-limited")
        }
    }
}

impl Drop for ExecutionBudget {
    fn drop(&mut self) {
        self.runtime.set_interrupt_handler(None);
    }
}

fn checked_js_string<'a>(
    string: &'a rquickjs::CString<'_>,
) -> Result<&'a str, std::str::Utf8Error> {
    // QuickJS may encode unpaired UTF-16 surrogates as non-UTF-8 bytes.
    // rquickjs 0.9's CString::as_str uses from_utf8_unchecked, so do not use it.
    // SAFETY: CString owns a live allocation containing len() readable bytes;
    // this slice borrows it and never includes or scans beyond its terminator.
    let bytes = unsafe { std::slice::from_raw_parts(string.as_ptr().cast::<u8>(), string.len()) };
    std::str::from_utf8(bytes)
}

fn read_result_string<'js>(
    object: &Object<'js>,
    key: &str,
    remaining: &mut usize,
) -> rquickjs::Result<String> {
    let string: rquickjs::String = object.get(key)?;
    let string = string.to_cstring()?;
    if string.len() > *remaining {
        return Err(rquickjs::Error::new_from_js_message(
            "plugin string",
            "host result",
            "8 MiB result transfer limit exceeded; return less text",
        ));
    }
    *remaining -= string.len();
    let text = checked_js_string(&string).map_err(|_| {
        rquickjs::Error::new_from_js_message(
            "plugin string",
            "host result",
            "invalid UTF-8 (unpaired UTF-16 surrogate)",
        )
    })?;
    Ok(text.to_owned())
}

fn result_length(object: &Object<'_>) -> rquickjs::Result<u32> {
    let length: Value = object.get("length")?;
    let length = length.as_number().filter(|length| {
        length.is_finite()
            && *length >= 0.0
            && length.fract() == 0.0
            && *length <= f64::from(PLUGIN_RESULT_LIMIT)
    });
    length.map(|length| length as u32).ok_or_else(|| {
        rquickjs::Error::new_from_js_message(
            "plugin results",
            "host results",
            "invalid result length or 10000-item result limit exceeded",
        )
    })
}

fn bind_document<'js>(
    ctx: &Ctx<'js>,
    novelist: &Object<'js>,
    document: &str,
    selection: (usize, usize),
    word_count: usize,
) -> rquickjs::Result<()> {
    // Capture document text inside the limited JS heap, not inside Rust
    // callbacks that a plugin could retain across arbitrarily many commands.
    let bind: Function = ctx.eval(
        r#"(function(novelist, document, from, to, wordCount) {
            novelist.getDocument = function() { return document; };
            novelist.getSelection = function() { return {from: from, to: to}; };
            novelist.getWordCount = function() { return wordCount; };
        })"#,
    )?;
    bind.call((
        novelist.clone(),
        document,
        selection.0,
        selection.1,
        word_count,
    ))
}

/// A loaded plugin instance with its own QuickJS context.
pub struct PluginInstance {
    pub manifest: PluginManifest,
    pub context: Context,
    pub active: bool,
}

/// Registered command from a plugin.
struct RegisteredCommand {
    plugin_id: String,
    command_id: String,
    label: String,
}

struct PluginHostInner {
    // Each Context owns its runtime. A failed plugin can release its entire
    // heap (including queued promise jobs) without disrupting other plugins.
    plugins: HashMap<String, PluginInstance>,
    document_content: String,
    selection: (usize, usize),
    word_count: usize,
    registered_commands: Vec<RegisteredCommand>,
}

/// A text replacement produced by a plugin command (replaceSelection / replaceRange).
#[derive(Debug, Clone)]
pub struct PendingReplacement {
    pub from: usize,
    pub to: usize,
    pub text: String,
}

macro_rules! lock_inner {
    ($self:expr) => {
        $self
            .inner
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))
    };
}

/// Thread-safe plugin host managed by Tauri.
pub struct PluginHostState {
    inner: Mutex<PluginHostInner>,
}

impl PluginHostState {
    pub fn new() -> Self {
        // No QuickJS allocation until a plugin is actually loaded.
        Self {
            inner: Mutex::new(PluginHostInner {
                plugins: HashMap::new(),
                document_content: String::new(),
                selection: (0, 0),
                word_count: 0,
                registered_commands: Vec::new(),
            }),
        }
    }

    /// Update the document state that plugins can read.
    pub fn set_document_state(
        &self,
        content: String,
        selection_from: usize,
        selection_to: usize,
        word_count: usize,
    ) {
        let mut inner = lock_inner!(self).unwrap();
        inner.document_content = content;
        inner.selection = (selection_from, selection_to);
        inner.word_count = word_count;
    }

    /// Load a plugin from its manifest and source code.
    pub fn load_plugin(&self, manifest: PluginManifest, source: &str) -> Result<(), String> {
        let mut inner = lock_inner!(self)?;
        if source.len() > PLUGIN_TRANSFER_LIMIT {
            return Err("Plugin source exceeds the 8 MiB input limit; reduce plugin size".into());
        }
        let runtime =
            Runtime::new().map_err(|error| format!("Failed to create QuickJS runtime: {error}"))?;
        runtime.set_memory_limit(PLUGIN_MEMORY_LIMIT);
        runtime.set_max_stack_size(PLUGIN_STACK_LIMIT);
        let budget = ExecutionBudget::arm(&runtime);
        let context = Context::full(&runtime).map_err(|error| {
            format!("QuickJS context creation failed within the 64 MiB memory limit: {error}")
        })?;
        let plugin_id = &manifest.plugin.id;
        let new_commands = budget.run(&context, "Plugin load", |ctx, budget| {
            let globals = ctx.globals();
            let novelist = Object::new(ctx.clone())?;
            bind_document(
                &ctx,
                &novelist,
                &inner.document_content,
                inner.selection,
                inner.word_count,
            )?;
            globals.set("novelist", novelist)?;
            ctx.eval::<(), _>(
                r#"
                var __registered_commands = [];
                novelist.registerCommand = function(id, label, handler) {
                    __registered_commands.push({id: id, label: label});
                    globalThis["__cmd_" + id] = handler;
                };
                "#,
            )?;
            ctx.eval::<(), _>(source)?;

            let commands: Object = globals.get("__registered_commands")?;
            let count = result_length(&commands)?;
            let mut remaining = PLUGIN_TRANSFER_LIMIT;
            let mut registered = Vec::new();
            for index in 0..count {
                budget.check()?;
                let command: Object = commands.get(index)?;
                registered.push(RegisteredCommand {
                    plugin_id: plugin_id.clone(),
                    command_id: read_result_string(&command, "id", &mut remaining)?,
                    label: read_result_string(&command, "label", &mut remaining)?,
                });
            }
            Ok(registered)
        })?;
        drop(budget);

        // Commit registration only once source and metadata conversion both
        // succeed. A failed reload leaves the previous instance untouched.
        inner
            .registered_commands
            .retain(|c| c.plugin_id != *plugin_id);
        inner.registered_commands.extend(new_commands);
        inner.plugins.insert(
            plugin_id.clone(),
            PluginInstance {
                manifest,
                context,
                active: true,
            },
        );
        Ok(())
    }

    /// Unload a plugin.
    pub fn unload_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut inner = lock_inner!(self)?;
        inner.plugins.remove(plugin_id);
        inner
            .registered_commands
            .retain(|c| c.plugin_id != plugin_id);
        Ok(())
    }

    /// List all loaded plugins.
    pub fn list_loaded_plugins(&self) -> Vec<PluginInfo> {
        let inner = lock_inner!(self).unwrap_or_else(|e| panic!("{}", e));
        inner
            .plugins
            .values()
            .map(|p| PluginInfo {
                id: p.manifest.plugin.id.clone(),
                name: p.manifest.plugin.name.clone(),
                version: p.manifest.plugin.version.clone(),
                permissions: p.manifest.plugin.permissions.clone(),
                active: p.active,
                ui: p.manifest.ui.clone(),
                description: p.manifest.plugin.description.clone(),
                author: p.manifest.plugin.author.clone(),
                icon: p.manifest.plugin.icon.clone(),
                builtin: false,
                enabled: p.active,
            })
            .collect()
    }

    /// Get all registered commands.
    pub fn get_registered_commands(&self) -> Vec<RegisteredCommandInfo> {
        let inner = lock_inner!(self).unwrap_or_else(|e| panic!("{}", e));
        inner
            .registered_commands
            .iter()
            .map(|c| RegisteredCommandInfo {
                plugin_id: c.plugin_id.clone(),
                command_id: c.command_id.clone(),
                label: c.label.clone(),
            })
            .collect()
    }

    /// Invoke a registered plugin command. Returns any pending text replacements.
    pub fn invoke_command(
        &self,
        plugin_id: &str,
        command_id: &str,
    ) -> Result<Vec<PendingReplacement>, String> {
        if !command_id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!("Invalid command ID: {command_id}"));
        }
        let mut inner = lock_inner!(self)?;
        let plugin = inner
            .plugins
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin not found: {plugin_id}"))?;
        if !plugin.active {
            return Err(format!("Plugin is not active: {plugin_id}"));
        }
        let budget = ExecutionBudget::arm(plugin.context.runtime());
        let result = budget.run(&plugin.context, "Plugin command", |ctx, budget| {
            let novelist: Object = ctx.globals().get("novelist")?;
            bind_document(
                &ctx,
                &novelist,
                &inner.document_content,
                inner.selection,
                inner.word_count,
            )?;
            let has_write =
                permissions::has_permission(&plugin.manifest.plugin.permissions, "write");
            if has_write {
                let (sel_from, sel_to) = inner.selection;
                ctx.eval::<(), _>("var __pending_replacements = [];")?;
                ctx.eval::<(), _>(format!(
                    r#"
                    novelist.replaceSelection = function(text) {{
                        __pending_replacements.push({{from: {sel_from}, to: {sel_to}, text: text}});
                    }};
                    novelist.replaceRange = function(from, to, text) {{
                        __pending_replacements.push({{from: from, to: to, text: text}});
                    }};
                    "#
                ))?;
            }

            let handler: Function = ctx.globals().get(format!("__cmd_{command_id}"))?;
            let returned: Value = handler.call(())?;
            if returned.is_promise() {
                return Err(rquickjs::Error::new_from_js_message(
                    "Promise",
                    "plugin command result",
                    "commands must complete synchronously",
                ));
            }
            let mut replacements = Vec::new();
            if has_write {
                let pending: Object = ctx.globals().get("__pending_replacements")?;
                let count = result_length(&pending)?;
                let mut remaining = PLUGIN_TRANSFER_LIMIT;
                for index in 0..count {
                    budget.check()?;
                    let replacement: Object = pending.get(index)?;
                    replacements.push(PendingReplacement {
                        from: replacement.get("from")?,
                        to: replacement.get("to")?,
                        text: read_result_string(&replacement, "text", &mut remaining)?,
                    });
                }
            }
            Ok(replacements)
        });
        drop(budget);
        if result.is_err() {
            // A command may have queued replacements, jobs or retained a full
            // heap before failing. Never reuse that partially mutated context.
            // Dropping its isolated runtime discards jobs and runs QuickJS GC.
            inner.plugins.remove(plugin_id);
            inner
                .registered_commands
                .retain(|c| c.plugin_id != plugin_id);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::plugin::{PluginManifest, PluginMeta};

    fn make_manifest(id: &str, permissions: Vec<&str>) -> PluginManifest {
        PluginManifest {
            plugin: PluginMeta {
                id: id.to_string(),
                name: format!("Test Plugin {}", id),
                version: "1.0.0".to_string(),
                permissions: permissions.into_iter().map(|s| s.to_string()).collect(),
                description: None,
                author: None,
                icon: None,
            },
            ui: None,
        }
    }

    #[test]
    fn test_plugin_host_new() {
        let host = PluginHostState::new();
        assert!(host.list_loaded_plugins().is_empty());
        assert!(host.get_registered_commands().is_empty());
    }

    #[test]
    fn test_set_document_state() {
        let host = PluginHostState::new();
        host.set_document_state("Hello World".to_string(), 0, 5, 2);
        // Verify by loading a plugin that reads it
        let manifest = make_manifest("reader", vec!["read"]);
        let source = r#"
            var doc = novelist.getDocument();
            var sel = novelist.getSelection();
            var wc = novelist.getWordCount();
            globalThis.__test_doc = doc;
            globalThis.__test_sel_from = sel.from;
            globalThis.__test_sel_to = sel.to;
            globalThis.__test_wc = wc;
        "#;
        host.load_plugin(manifest, source).unwrap();
        // Plugin loaded successfully means document state was accessible
        let plugins = host.list_loaded_plugins();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "reader");
    }

    #[test]
    fn test_load_plugin_basic() {
        let host = PluginHostState::new();
        let manifest = make_manifest("hello", vec!["read"]);
        let source = r#"
            novelist.registerCommand("greet", "Greet", function() {});
        "#;
        host.load_plugin(manifest, source).unwrap();

        let plugins = host.list_loaded_plugins();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "hello");
        assert_eq!(plugins[0].name, "Test Plugin hello");
        assert!(plugins[0].active);

        let commands = host.get_registered_commands();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].plugin_id, "hello");
        assert_eq!(commands[0].command_id, "greet");
        assert_eq!(commands[0].label, "Greet");
    }

    #[test]
    fn test_load_plugin_multiple_commands() {
        let host = PluginHostState::new();
        let manifest = make_manifest("multi", vec!["read"]);
        let source = r#"
            novelist.registerCommand("cmd1", "Command 1", function() {});
            novelist.registerCommand("cmd2", "Command 2", function() {});
            novelist.registerCommand("cmd3", "Command 3", function() {});
        "#;
        host.load_plugin(manifest, source).unwrap();

        let commands = host.get_registered_commands();
        assert_eq!(commands.len(), 3);
    }

    #[test]
    fn test_load_plugin_eval_error() {
        let host = PluginHostState::new();
        let manifest = make_manifest("bad", vec!["read"]);
        let source = "this is not valid javascript {{{";
        let result = host.load_plugin(manifest, source);
        assert!(result.is_err());
    }

    #[test]
    fn test_unload_plugin() {
        let host = PluginHostState::new();
        let manifest = make_manifest("temp", vec!["read"]);
        let source = r#"
            novelist.registerCommand("cmd1", "Cmd", function() {});
        "#;
        host.load_plugin(manifest, source).unwrap();
        assert_eq!(host.list_loaded_plugins().len(), 1);
        assert_eq!(host.get_registered_commands().len(), 1);

        host.unload_plugin("temp").unwrap();
        assert_eq!(host.list_loaded_plugins().len(), 0);
        assert_eq!(host.get_registered_commands().len(), 0);
    }

    #[test]
    fn test_invoke_command_read_only() {
        let host = PluginHostState::new();
        host.set_document_state("test content".to_string(), 0, 4, 2);
        let manifest = make_manifest("readonly", vec!["read"]);
        let source = r#"
            novelist.registerCommand("noop", "No-op", function() {
                var doc = novelist.getDocument();
            });
        "#;
        host.load_plugin(manifest, source).unwrap();

        let replacements = host.invoke_command("readonly", "noop").unwrap();
        assert!(replacements.is_empty());
    }

    #[test]
    fn test_invoke_command_with_write() {
        let host = PluginHostState::new();
        host.set_document_state("Hello World".to_string(), 0, 5, 2);
        let manifest = make_manifest("writer", vec!["write"]);
        let source = r#"
            novelist.registerCommand("upper", "Uppercase", function() {
                novelist.replaceSelection("HELLO");
            });
        "#;
        host.load_plugin(manifest, source).unwrap();

        let replacements = host.invoke_command("writer", "upper").unwrap();
        assert_eq!(replacements.len(), 1);
        assert_eq!(replacements[0].from, 0);
        assert_eq!(replacements[0].to, 5);
        assert_eq!(replacements[0].text, "HELLO");
    }

    #[test]
    fn test_invoke_command_replace_range() {
        let host = PluginHostState::new();
        host.set_document_state("Hello World".to_string(), 0, 0, 2);
        let manifest = make_manifest("ranger", vec!["write"]);
        let source = r#"
            novelist.registerCommand("fix", "Fix", function() {
                novelist.replaceRange(6, 11, "Rust");
            });
        "#;
        host.load_plugin(manifest, source).unwrap();

        let replacements = host.invoke_command("ranger", "fix").unwrap();
        assert_eq!(replacements.len(), 1);
        assert_eq!(replacements[0].from, 6);
        assert_eq!(replacements[0].to, 11);
        assert_eq!(replacements[0].text, "Rust");
    }

    #[test]
    fn test_invoke_nonexistent_plugin() {
        let host = PluginHostState::new();
        let result = host.invoke_command("nonexistent", "cmd");
        assert!(result.is_err());
    }

    #[test]
    fn test_multiple_plugins() {
        let host = PluginHostState::new();

        let m1 = make_manifest("plugin1", vec!["read"]);
        let s1 = r#"novelist.registerCommand("a", "A", function() {});"#;
        host.load_plugin(m1, s1).unwrap();

        let m2 = make_manifest("plugin2", vec!["read"]);
        let s2 = r#"novelist.registerCommand("b", "B", function() {});"#;
        host.load_plugin(m2, s2).unwrap();

        assert_eq!(host.list_loaded_plugins().len(), 2);
        assert_eq!(host.get_registered_commands().len(), 2);

        // Unload one
        host.unload_plugin("plugin1").unwrap();
        assert_eq!(host.list_loaded_plugins().len(), 1);
        assert_eq!(host.get_registered_commands().len(), 1);
        assert_eq!(host.get_registered_commands()[0].command_id, "b");
    }

    #[test]
    fn test_reload_plugin_replaces_commands() {
        let host = PluginHostState::new();

        let m1 = make_manifest("reload_me", vec!["read"]);
        let s1 = r#"novelist.registerCommand("old_cmd", "Old", function() {});"#;
        host.load_plugin(m1, s1).unwrap();
        assert_eq!(host.get_registered_commands()[0].command_id, "old_cmd");

        // Reload with new source
        let m2 = make_manifest("reload_me", vec!["read"]);
        let s2 = r#"novelist.registerCommand("new_cmd", "New", function() {});"#;
        host.load_plugin(m2, s2).unwrap();

        let cmds = host.get_registered_commands();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].command_id, "new_cmd");
    }

    /// Run adversarial JS in a killable copy of this test binary. A missing
    /// interrupt must fail the regression rather than hang the entire suite.
    fn isolated_resource_case(test: impl FnOnce()) {
        let name = std::thread::current().name().unwrap().to_owned();
        const CHILD_CASE: &str = "NOVELIST_SANDBOX_RESOURCE_CASE";
        if std::env::var(CHILD_CASE).as_deref() == Ok(name.as_str()) {
            test();
            return;
        }
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--nocapture", "--test-threads=1"])
            .env(CHILD_CASE, &name)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "sandbox regression failed: {status}");
                return;
            }
            if Instant::now() >= deadline {
                let killed = child.kill();
                let waited = child.wait();
                panic!("sandbox child exceeded 8 seconds: kill={killed:?}, wait={waited:?}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn load_healthy(host: &PluginHostState, id: &str) {
        host.load_plugin(
            make_manifest(id, vec!["write"]),
            r#"novelist.registerCommand("healthy", "Healthy", function() {
                novelist.replaceRange(0, 1, "健康");
            });"#,
        )
        .unwrap();
    }

    fn assert_healthy(host: &PluginHostState, id: &str) {
        let replacements = host.invoke_command(id, "healthy").unwrap();
        assert_eq!(replacements.len(), 1);
        assert_eq!(replacements[0].from, 0);
        assert_eq!(replacements[0].to, 1);
        assert_eq!(replacements[0].text, "健康");
    }

    fn assert_failed_command_recovers(host: &PluginHostState, source: &str, cause: &str) {
        load_healthy(host, "healthy");
        host.load_plugin(make_manifest("bad", vec!["write"]), source)
            .unwrap();
        let error = host.invoke_command("bad", "bad").unwrap_err();
        assert!(error.contains(cause), "{error}");
        assert!(host.list_loaded_plugins().iter().all(|p| p.id != "bad"));
        assert!(host
            .get_registered_commands()
            .iter()
            .all(|c| c.plugin_id != "bad"));
        assert_healthy(host, "healthy");
        // A fresh copy of the failed ID must not inherit pending edits, jobs,
        // an expired deadline or an exhausted heap from the failed instance.
        load_healthy(host, "bad");
        assert_healthy(host, "bad");
        assert_healthy(host, "bad");
    }

    #[test]
    fn resource_limit_interrupts_infinite_source_and_preserves_previous_plugin() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            load_healthy(&host, "reload");
            let error = host
                .load_plugin(
                    make_manifest("reload", vec!["write"]),
                    r#"novelist.registerCommand("partial", "Partial", function() {});
                    while (true) {}"#,
                )
                .unwrap_err();
            assert!(error.contains("time limit"), "{error}");
            assert_eq!(host.get_registered_commands().len(), 1);
            assert_eq!(host.get_registered_commands()[0].command_id, "healthy");
            assert_healthy(&host, "reload");
            load_healthy(&host, "new");
            assert_healthy(&host, "new");
        });
    }

    #[test]
    fn resource_limit_interrupts_command_without_leaking_pending_replacements() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {
                    novelist.replaceSelection("must not escape");
                    while (true) {}
                });"#,
                "time limit",
            );
        });
    }

    #[test]
    fn resource_limit_rejects_allocation_exhaustion_on_load() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            load_healthy(&host, "healthy");
            let error = host
                .load_plugin(
                    make_manifest("bad", vec!["read"]),
                    "globalThis.retained = new ArrayBuffer(128 * 1024 * 1024);",
                )
                .unwrap_err();
            assert!(error.contains("memory limit"), "{error}");
            assert_healthy(&host, "healthy");
            load_healthy(&host, "bad");
            assert_healthy(&host, "bad");
        });
    }

    #[test]
    fn resource_limit_reclaims_failed_heap_and_queued_jobs() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {
                    novelist.replaceSelection("must not escape");
                    var retained = {buffer: new ArrayBuffer(16 * 1024 * 1024)};
                    retained.self = retained;
                    Promise.resolve().then(function() { return retained; });
                    globalThis.exhausted = new ArrayBuffer(128 * 1024 * 1024);
                });"#,
                "memory limit",
            );
        });
    }

    #[test]
    fn resource_limit_rejects_stack_exhaustion_and_recovers() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function recur() {
                    return 1 + recur();
                });"#,
                "stack limit",
            );
        });
    }

    #[test]
    fn resource_limit_covers_injected_api_setters() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {});
                Object.defineProperty(novelist, "replaceSelection", {
                    set: function() { while (true) {} }
                });"#,
                "time limit",
            );
        });
    }

    #[test]
    fn resource_limit_covers_registration_conversion() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            let error = host
                .load_plugin(
                    make_manifest("bad", vec!["read"]),
                    r#"__registered_commands.push({id: "bad", get label() { while (true) {} }});"#,
                )
                .unwrap_err();
            assert!(error.contains("time limit"), "{error}");
            assert!(host.get_registered_commands().is_empty());
            load_healthy(&host, "healthy");
            assert_healthy(&host, "healthy");
        });
    }

    #[test]
    fn resource_limit_covers_replacement_conversion_and_discards_partial_results() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {
                    novelist.replaceSelection("must not escape");
                    __pending_replacements.push({from: 0, to: 1, get text() { while (true) {} }});
                });"#,
                "time limit",
            );
        });
    }

    #[test]
    fn resource_limit_bounds_repeated_result_strings() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {
                    var text = "x".repeat(1024 * 1024);
                    for (var i = 0; i < 9; i++) novelist.replaceSelection(text);
                });"#,
                "result transfer limit",
            );
        });
    }

    #[test]
    fn resource_limit_rejects_sparse_result_arrays() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {
                    __pending_replacements.length = 0xffffffff;
                });"#,
                "result limit",
            );
        });
    }

    #[test]
    fn resource_limit_covers_exception_message_getters() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {
                    throw {get message() { while (true) {} }};
                });"#,
                "time limit",
            );
        });
    }

    #[test]
    fn resource_limit_bounds_exception_diagnostics() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            let error = host
                .load_plugin(
                    make_manifest("bad", vec!["read"]),
                    "throw 'x'.repeat(1024 * 1024);",
                )
                .unwrap_err();
            assert!(error.len() < 512);
            load_healthy(&host, "healthy");
            assert_healthy(&host, "healthy");
        });
    }

    #[test]
    fn resource_limit_async_failure_cannot_publish_partial_replacements() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", async function() {
                    novelist.replaceSelection("must not escape");
                    throw new Error("failed asynchronously");
                });"#,
                "must complete synchronously",
            );
        });
    }

    #[test]
    fn resource_limit_conversion_allocation_failure_cannot_publish_partial_replacements() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {
                    novelist.replaceSelection("must not escape");
                    __pending_replacements.push({from: 0, to: 1, get text() {
                        return new ArrayBuffer(128 * 1024 * 1024);
                    }});
                });"#,
                "memory limit",
            );
        });
    }

    #[test]
    fn resource_limit_rejects_unpaired_surrogate_replacements_without_partial_results() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {
                    novelist.replaceSelection("must not escape");
                    novelist.replaceSelection("\ud800");
                });"#,
                "invalid UTF-8",
            );
        });
    }

    #[test]
    fn resource_limit_reports_unpaired_surrogate_exceptions_safely_and_recovers() {
        isolated_resource_case(|| {
            let host = PluginHostState::new();
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {
                    throw "\ud800";
                });"#,
                "invalid UTF-8",
            );
            assert_failed_command_recovers(
                &host,
                r#"novelist.registerCommand("bad", "Bad", function() {
                    throw {message: "\ud800"};
                });"#,
                "invalid UTF-8",
            );
        });
    }
}
