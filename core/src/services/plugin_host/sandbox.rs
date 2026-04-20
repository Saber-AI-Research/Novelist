use rquickjs::{Context, Function, Runtime};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::models::plugin::{PluginInfo, PluginManifest, RegisteredCommandInfo};

use super::permissions;

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
    /// Lazily constructed — startup-critical path doesn't pay for QuickJS
    /// initialization until the first plugin load/exec.
    runtime: Option<Runtime>,
    plugins: HashMap<String, PluginInstance>,
    document_content: String,
    selection: (usize, usize),
    word_count: usize,
    registered_commands: Vec<RegisteredCommand>,
}

impl PluginHostInner {
    /// Create the runtime on first demand.
    fn ensure_runtime(&mut self) -> Result<&Runtime, String> {
        if self.runtime.is_none() {
            let rt = Runtime::new().map_err(|e| format!("Failed to create QuickJS runtime: {e}"))?;
            self.runtime = Some(rt);
        }
        Ok(self.runtime.as_ref().expect("runtime just set"))
    }
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
        // Runtime is deferred — see `PluginHostInner::ensure_runtime`.
        // Startup-critical path used to pay ~10-30 ms for Runtime::new()
        // even when no plugin was ever invoked.
        Self {
            inner: Mutex::new(PluginHostInner {
                runtime: None,
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
        let plugin_id = manifest.plugin.id.clone();

        // Create a new context for this plugin (spins up QuickJS on first load).
        let runtime = inner.ensure_runtime()?;
        let context =
            Context::full(runtime).map_err(|e| format!("QuickJS context error: {e}"))?;

        // Inject the novelist API and run plugin code
        let pid = plugin_id.clone();

        // We need to collect registered commands outside the context
        let doc_content = inner.document_content.clone();
        let sel = inner.selection;
        let wc = inner.word_count;

        // Store commands that will be registered
        let mut new_commands: Vec<RegisteredCommand> = Vec::new();

        context.with(|ctx| -> Result<(), String> {
            let globals = ctx.globals();

            // Create novelist object
            let novelist = rquickjs::Object::new(ctx.clone())
                .map_err(|e| format!("Failed to create novelist object: {e}"))?;

            // getDocument() -> string
            {
                let doc = doc_content.clone();
                let func = Function::new(ctx.clone(), move || -> String { doc.clone() })
                    .map_err(|e| format!("Failed to create getDocument: {e}"))?;
                novelist
                    .set("getDocument", func)
                    .map_err(|e| format!("Failed to set getDocument: {e}"))?;
            }

            // getSelection() -> { from, to }
            {
                let (sel_from, sel_to) = sel;
                let func = Function::new(ctx.clone(), move || -> HashMap<String, usize> {
                    let mut m = HashMap::new();
                    m.insert("from".to_string(), sel_from);
                    m.insert("to".to_string(), sel_to);
                    m
                })
                .map_err(|e| format!("Failed to create getSelection: {e}"))?;
                novelist
                    .set("getSelection", func)
                    .map_err(|e| format!("Failed to set getSelection: {e}"))?;
            }

            // getWordCount() -> number
            {
                let func = Function::new(ctx.clone(), move || -> usize { wc })
                    .map_err(|e| format!("Failed to create getWordCount: {e}"))?;
                novelist
                    .set("getWordCount", func)
                    .map_err(|e| format!("Failed to set getWordCount: {e}"))?;
            }

            // registerCommand(id, label, handler) — store the command metadata
            // The handler is stored in the JS context; we just record the command.
            {
                let func = Function::new(
                    ctx.clone(),
                    move |_id: String, _label: String, _handler: Function<'_>| {
                        // Placeholder; the real registration is handled by the JS override below
                    },
                )
                .map_err(|e| format!("Failed to create registerCommand: {e}"))?;
                novelist
                    .set("registerCommand", func)
                    .map_err(|e| format!("Failed to set registerCommand: {e}"))?;
            }

            // Set the novelist global
            globals
                .set("novelist", novelist)
                .map_err(|e| format!("Failed to set novelist global: {e}"))?;

            // Add a command registry array in JS
            ctx.eval::<(), _>(
                r#"
                var __registered_commands = [];
                var __novelist_original_register = novelist.registerCommand;
                novelist.registerCommand = function(id, label, handler) {
                    __registered_commands.push({id: id, label: label});
                    globalThis["__cmd_" + id] = handler;
                };
                "#,
            )
            .map_err(|e| format!("Failed to set up command registry: {e}"))?;

            // Run the plugin source
            ctx.eval::<(), _>(source)
                .map_err(|e| format!("Plugin eval error: {e}"))?;

            // Collect registered commands
            let cmds: Vec<HashMap<String, String>> =
                ctx.eval("__registered_commands").unwrap_or_default();

            for cmd in cmds {
                if let (Some(id), Some(label)) = (cmd.get("id"), cmd.get("label")) {
                    new_commands.push(RegisteredCommand {
                        plugin_id: pid.clone(),
                        command_id: id.clone(),
                        label: label.clone(),
                    });
                }
            }

            Ok(())
        })?;

        // Remove any old commands for this plugin
        inner
            .registered_commands
            .retain(|c| c.plugin_id != plugin_id);

        // Add new commands
        inner.registered_commands.extend(new_commands);

        inner.plugins.insert(
            plugin_id,
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
        let inner = lock_inner!(self)?;
        let plugin = inner
            .plugins
            .get(plugin_id)
            .ok_or_else(|| format!("Plugin not found: {plugin_id}"))?;

        if !plugin.active {
            return Err(format!("Plugin is not active: {plugin_id}"));
        }

        plugin
            .context
            .with(|ctx| -> Result<Vec<PendingReplacement>, String> {
                // Update the document state in JS before calling command
                let doc = inner.document_content.clone();
                let (sel_from, sel_to) = inner.selection;
                let wc = inner.word_count;

                // Re-bind getDocument with current state
                let novelist: rquickjs::Object = ctx
                    .globals()
                    .get("novelist")
                    .map_err(|e| format!("Failed to get novelist: {e}"))?;

                {
                    let doc_clone = doc.clone();
                    let func = Function::new(ctx.clone(), move || -> String { doc_clone.clone() })
                        .map_err(|e| format!("Failed to create getDocument: {e}"))?;
                    novelist
                        .set("getDocument", func)
                        .map_err(|e| format!("Failed to set getDocument: {e}"))?;
                }
                {
                    let func = Function::new(ctx.clone(), move || -> HashMap<String, usize> {
                        let mut m = HashMap::new();
                        m.insert("from".to_string(), sel_from);
                        m.insert("to".to_string(), sel_to);
                        m
                    })
                    .map_err(|e| format!("Failed to create getSelection: {e}"))?;
                    novelist
                        .set("getSelection", func)
                        .map_err(|e| format!("Failed to set getSelection: {e}"))?;
                }
                {
                    let func = Function::new(ctx.clone(), move || -> usize { wc })
                        .map_err(|e| format!("Failed to create getWordCount: {e}"))?;
                    novelist
                        .set("getWordCount", func)
                        .map_err(|e| format!("Failed to set getWordCount: {e}"))?;
                }

                // Set up replacement collector if plugin has write permission
                let has_write =
                    permissions::has_permission(&plugin.manifest.plugin.permissions, "write");
                if has_write {
                    ctx.eval::<(), _>("var __pending_replacements = [];")
                        .map_err(|e| format!("Failed to init replacements: {e}"))?;

                    let eval_code = format!(
                        r#"
                    novelist.replaceSelection = function(text) {{
                        __pending_replacements.push({{from: {sel_from}, to: {sel_to}, text: text}});
                    }};
                    novelist.replaceRange = function(from, to, text) {{
                        __pending_replacements.push({{from: from, to: to, text: text}});
                    }};
                    "#
                    );
                    ctx.eval::<(), _>(eval_code.as_bytes())
                        .map_err(|e| format!("Failed to set up write API: {e}"))?;
                }

                // Call the command handler
                let call_code = format!(
                    r#"
                (function() {{
                    var fn = globalThis["__cmd_{command_id}"];
                    if (fn) fn();
                }})()
                "#
                );
                ctx.eval::<(), _>(call_code.as_bytes())
                    .map_err(|e| format!("Command execution error: {e}"))?;

                // Collect replacements
                if has_write {
                    let replacements: Vec<HashMap<String, rquickjs::Value>> =
                        ctx.eval("__pending_replacements").unwrap_or_default();

                    let mut result = Vec::new();
                    for r in &replacements {
                        let from: usize = r
                            .get("from")
                            .and_then(|v| v.as_number().map(|n| n as usize))
                            .unwrap_or(0);
                        let to: usize = r
                            .get("to")
                            .and_then(|v| v.as_number().map(|n| n as usize))
                            .unwrap_or(0);
                        let text: String = r
                            .get("text")
                            .and_then(|v| v.as_string().map(|s| s.to_string().unwrap_or_default()))
                            .unwrap_or_default();
                        result.push(PendingReplacement { from, to, text });
                    }
                    Ok(result)
                } else {
                    Ok(vec![])
                }
            })
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
}
