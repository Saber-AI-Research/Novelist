import App from "./App.svelte";
import { mount } from "svelte";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "$lib/i18n";
import { startupMark } from "$lib/utils/startup-timing";
import "./app.css";

// DEBUG: Mirror every startup phase to Rust tracing (`log_startup_phase`)
// so we can see progress in terminal logs even when devtools is unreachable.
// Remove once the startup path is confirmed healthy.
function logPhase(name: string, extra?: unknown) {
  startupMark(name);
  const payload = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  console.log(`[startup] ${name}${payload}`);
  invoke("log_startup_phase", { name, sinceStartMs: performance.now() }).catch(
    (err) => console.error("[startup] invoke(log_startup_phase) failed", err),
  );
}

logPhase("frontend.main.start");

// Global safety nets — these MUST be logged, otherwise a silent promise
// rejection during early boot leaves the user with a dead window.
window.addEventListener("error", (e) => {
  console.error("[startup] window.error", e.error ?? e.message);
  invoke("log_startup_phase", {
    name: `frontend.error:${(e.error?.message ?? e.message ?? "unknown").slice(0, 120)}`,
    sinceStartMs: performance.now(),
  }).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[startup] unhandledrejection", e.reason);
  invoke("log_startup_phase", {
    name: `frontend.reject:${String(e.reason).slice(0, 120)}`,
    sinceStartMs: performance.now(),
  }).catch(() => {});
});

// Ultimate safety net: if we haven't shown the window within 3s, force it.
// Protects against an awaited step hanging (e.g. a bad dynamic import) or
// requestAnimationFrame never firing for some reason.
const forceShowTimer = setTimeout(() => {
  logPhase("frontend.main.force-show-timeout");
  getCurrentWindow()
    .show()
    .catch((err) => console.error("[startup] force show() failed", err));
}, 3000);

void (async () => {
  try {
    logPhase("frontend.main.before-i18n");
    await i18n.init();
    logPhase("frontend.main.i18n-ready");

    const target = document.getElementById("app");
    logPhase("frontend.main.before-mount", { hasTarget: !!target });
    if (!target) throw new Error("#app target not found");
    mount(App, { target });
    logPhase("frontend.main.mounted");
  } catch (err) {
    // Surface the error instead of swallowing — `finally` alone doesn't tell
    // us why init failed.
    console.error("[startup] boot failed", err);
    invoke("log_startup_phase", {
      name: `frontend.main.boot-failed:${(err as Error)?.message ?? String(err)}`.slice(0, 120),
      sinceStartMs: performance.now(),
    }).catch(() => {});
  } finally {
    requestAnimationFrame(() => {
      clearTimeout(forceShowTimer);
      const win = getCurrentWindow();
      win.show().catch((err) => console.error("[startup] window.show failed", err));
      win.setFocus().catch((err) => console.error("[startup] window.setFocus failed", err));
      logPhase("frontend.main.window-shown");
    });
  }
})();
