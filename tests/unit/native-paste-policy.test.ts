// @ts-nocheck -- Vitest runs this Node-only source-policy test outside the app browser type environment.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const paths = {
  cargo: 'core/Cargo.toml',
  commands: 'core/src/commands/mod.rs',
  e2e: 'core/src/commands/e2e.rs',
  lib: 'core/src/lib.rs',
  nativeSpec: 'tests/e2e/native/specs/native-lifecycle.spec.ts',
};

async function source(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
}

describe('Task 24 native paste policy', () => {
  it('uses an AppKit Command+V key event for visual acceptance and direct paste only for nonvisual diagnostics', async () => {
    const [nativeSpec, e2e] = await Promise.all([source(paths.nativeSpec), source(paths.e2e)]);
    const nonvisualBranch = nativeSpec.search(
      /if\s*\(\s*process\.env\.NOVELIST_NATIVE_MODE\s*===\s*'nonvisual-behavior'\s*\)\s*{/,
    );
    const visualBranch = nativeSpec.indexOf('} else {', nonvisualBranch);
    const commonPasteAssertion = nativeSpec.indexOf('await expect.poll(', visualBranch);
    const directPaste = nativeSpec.indexOf("perform_e2e_native_paste', {})");
    const nativeCmdV = nativeSpec.indexOf("perform_e2e_native_command_v', {})");

    expect(nonvisualBranch).toBeGreaterThan(-1);
    expect(visualBranch).toBeGreaterThan(nonvisualBranch);
    expect(directPaste).toBeGreaterThan(nonvisualBranch);
    expect(directPaste).toBeLessThan(visualBranch);
    expect(nativeCmdV).toBeGreaterThan(visualBranch);
    expect(nativeCmdV).toBeLessThan(commonPasteAssertion);
    expect(nativeSpec.match(/perform_e2e_native_paste/g)).toHaveLength(1);
    expect(nativeSpec.match(/perform_e2e_native_command_v/g)).toHaveLength(1);
    expect(nativeSpec).toContain('native_paste_path=AppKit NSEvent Command+V');
    expect(nativeSpec).toContain('native_paste_path=direct AppKit diagnostic');
    expect(nativeSpec).not.toContain("dispatchEvent(new ClipboardEvent('paste'");
    expect(e2e).toContain('makeFirstResponder');
    expect(e2e).toContain('sendAction_to_from');
    expect(e2e).toContain('sel!(paste:)');
    expect(e2e).toContain('NSEventType::KeyDown');
    expect(e2e).toContain('NSEventType::KeyUp');
    expect(e2e).toContain('NSEventModifierFlags::Command');
    expect(e2e).toContain('app.sendEvent(&key_down)');
    expect(e2e).toContain('app.sendEvent(&key_up)');
    expect(e2e).toContain('untargeted_action_target_is_webview');
    expect(e2e).toContain('std::ptr::eq(target, responder_object)');
    expect(e2e).not.toContain('#[specta::specta]');
  });

  it('guards the Rust paste command with the exact nonvisual mode before AppKit access', async () => {
    const e2e = await source(paths.e2e);
    const predicate = e2e.indexOf('fn native_paste_mode_allowed(mode: Option<&str>) -> bool');
    const command = e2e.indexOf('pub async fn perform_e2e_native_paste(');
    const modeRead = e2e.indexOf('std::env::var("NOVELIST_NATIVE_MODE")', command);
    const guard = e2e.indexOf('if !native_paste_mode_allowed(mode.as_deref())', modeRead);
    const webview = e2e.indexOf('.with_webview(', command);

    expect(predicate).toBeGreaterThan(-1);
    expect(modeRead).toBeGreaterThan(command);
    expect(guard).toBeGreaterThan(modeRead);
    expect(webview).toBeGreaterThan(guard);
    expect(e2e).toContain('mode == Some("nonvisual-behavior")');
  });

  it('guards the native Command+V command with the exact visual mode before AppKit access', async () => {
    const e2e = await source(paths.e2e);
    const predicate = e2e.indexOf('fn native_command_v_mode_allowed(mode: Option<&str>) -> bool');
    const command = e2e.indexOf('pub async fn perform_e2e_native_command_v(');
    const modeRead = e2e.indexOf('std::env::var("NOVELIST_NATIVE_MODE")', command);
    const guard = e2e.indexOf('if !native_command_v_mode_allowed(mode.as_deref())', modeRead);
    const webview = e2e.indexOf('.with_webview(', command);

    expect(predicate).toBeGreaterThan(-1);
    expect(modeRead).toBeGreaterThan(command);
    expect(guard).toBeGreaterThan(modeRead);
    expect(webview).toBeGreaterThan(guard);
    expect(e2e).toContain('mode == Some("visual")');
  });

  it('compiles and registers native e2e commands only for macOS e2e builds', async () => {
    const [commands, lib] = await Promise.all([source(paths.commands), source(paths.lib)]);

    expect(commands).toMatch(/#\[cfg\(all\(target_os = "macos", feature = "e2e-testing"\)\)\]\s*pub mod e2e;/);
    expect(lib).toMatch(
      /#\[cfg\(all\(target_os = "macos", feature = "e2e-testing"\)\)\]\s*use commands::e2e::\{\s*capture_e2e_webview_snapshot, perform_e2e_native_command_v, perform_e2e_native_paste,\s*\};/,
    );
    expect(lib).not.toContain('let builder = builder.commands(collect_commands![');
    expect(lib).not.toContain('tauri::plugin::Builder::<tauri::Wry, ()>::new("e2e")');
    expect(lib).toContain('#[cfg(all(target_os = "macos", feature = "e2e-testing"))]\n    let invoke_handler = {');
    expect(lib).toContain('let e2e_handler: Box<tauri::ipc::InvokeHandler<tauri::Wry>>');
    expect(lib).toMatch(
      /tauri::generate_handler!\[\s*capture_e2e_webview_snapshot,\s*perform_e2e_native_command_v,\s*perform_e2e_native_paste,/,
    );
    expect(lib).toMatch(
      /"capture_e2e_webview_snapshot"\s*\|\s*"perform_e2e_native_command_v"\s*\|\s*"perform_e2e_native_paste"/,
    );
    expect(lib).toContain('core_handler(invoke)');
    expect(lib).toContain('.invoke_handler(invoke_handler)');
  });

  it('keeps capture-only native crates outside the production dependency graph', async () => {
    const cargo = await source(paths.cargo);

    for (const dependency of [
      'block2',
      'objc2',
      'objc2-app-kit',
      'objc2-core-foundation',
      'objc2-core-graphics',
      'objc2-foundation',
      'objc2-web-kit',
    ]) {
      expect(cargo).toMatch(new RegExp(`^${dependency.replaceAll('-', '\\-')} = \\{[^\\n]*optional = true`, 'm'));
      expect(cargo).toContain(`dep:${dependency}`);
    }
  });
});
