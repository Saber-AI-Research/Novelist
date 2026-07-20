// @ts-nocheck -- Vitest runs this Node-only source-policy test outside the app browser type environment.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const paths = {
  commands: 'core/src/commands/mod.rs',
  e2e: 'core/src/commands/e2e.rs',
  lib: 'core/src/lib.rs',
  supervisor: 'tests/e2e/native/macos-app-supervisor.swift',
  supervisorPolicy: 'tests/e2e/native/macos-supervisor-policy.swift',
};

async function source(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
}

describe('Task 24 visual native activation policy', () => {
  it('compiles and invokes the hook only for an explicitly propagated macOS visual native run with an ID', async () => {
    const [commands, e2e, lib, supervisor, policy] = await Promise.all([
      source(paths.commands),
      source(paths.e2e),
      source(paths.lib),
      source(paths.supervisor),
      source(paths.supervisorPolicy),
    ]);
    const cfg = '#[cfg(all(target_os = "macos", feature = "e2e-testing"))]';

    expect(commands).toContain(`${cfg}\npub mod e2e;`);
    expect(e2e).toContain(`${cfg}\npub(crate) fn request_visual_native_activation_once`);
    expect(e2e).toContain('std::env::var("NOVELIST_NATIVE_RUN_ID")');
    expect(e2e).toContain('std::env::var("NOVELIST_NATIVE_MODE")');
    expect(e2e).toMatch(/\.compare_exchange\(\s*false,\s*true,/);
    expect(lib).toMatch(
      /#\[cfg\(all\(target_os = "macos", feature = "e2e-testing"\)\)\]\s*if matches!\(event, tauri::RunEvent::Ready\) \{\s*commands::e2e::request_visual_native_activation_once\(app\);\s*\}/,
    );
    expect(supervisor).toMatch(
      /configuration\.environment = nativeApplicationEnvironment\(\s*inherited: ProcessInfo\.processInfo\.environment,\s*mode: mode\s*\)/,
    );
    expect(supervisor).toContain('resolvedNativeReadinessMode(environment: environment)');
    expect(policy).toContain('environment["NOVELIST_NATIVE_MODE"] = mode.rawValue');
  });

  it('orders window visibility, AppKit activation, and Tauri focus without retries', async () => {
    const e2e = await source(paths.e2e);
    const hookStart = e2e.indexOf('pub(crate) fn request_visual_native_activation_once');
    const hookEnd = e2e.indexOf('\n#[tauri::command]', hookStart);
    const hook = e2e.slice(hookStart, hookEnd);

    expect(hookStart).toBeGreaterThan(-1);
    expect(hookEnd).toBeGreaterThan(hookStart);
    const orderedCalls = [
      'get_webview_window("main")',
      '.show()',
      '.unminimize()',
      'activate_macos_application()',
      '.set_focus()',
    ].map((call) => hook.indexOf(call));
    expect(orderedCalls.every((index) => index >= 0)).toBe(true);
    expect(orderedCalls).toEqual([...orderedCalls].sort((left, right) => left - right));
    expect(hook).not.toMatch(/\b(loop|while|for)\b/);
    expect(hook).not.toContain('sleep');

    const appkitStart = e2e.indexOf('fn activate_macos_application');
    const appkitEnd = e2e.indexOf('\n' + '#[cfg(all(target_os = "macos", feature = "e2e-testing"))]', appkitStart);
    const appkit = e2e.slice(appkitStart, appkitEnd);
    expect(appkit).toContain('respondsToSelector(sel!(activate))');
    expect(appkit).toContain('fn activate_macos_application_legacy');
    const modern = appkit.indexOf('MacosActivationApi::Modern => app.activate()');
    const legacy = appkit.indexOf('app.activateIgnoringOtherApps(true);');
    expect(modern).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(modern);
    for (const forbidden of [
      /\bretry\b/i,
      /\b(loop|while|for)\b/,
      /\bsleep\b/i,
      /async_runtime::spawn/,
      /dispatch_after/i,
      /DispatchQueue/,
      /DispatchSource(?:Timer)?/,
      /performSelector.*afterDelay/i,
      /\bTimer\b/,
    ]) {
      expect(appkit).not.toMatch(forbidden);
    }
  });

  it('leaves the supervisor active, frontmost, visible, and five-second checks authoritative', async () => {
    const [supervisor, policy] = await Promise.all([
      source(paths.supervisor),
      source(paths.supervisorPolicy),
    ]);

    expect(supervisor).toContain('isActive: application.isActive');
    expect(supervisor).toContain('ownsMenuBar: ownsMenuBar');
    expect(supervisor).toContain('hasVisibleWindow: visibleWindow');
    expect(policy).toContain('isActive && ownsMenuBar && hasVisibleWindow ? .visualReady : .visualUnavailable');
    expect(policy).toContain('interactive ? 120 : 5');
  });
});
