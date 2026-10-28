import App from "./App.svelte";
import { mount } from "svelte";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { i18n, t } from "$lib/i18n";
import { initPlatform, platform } from "$lib/stores/platform.svelte";
import { uiStore } from "$lib/stores/ui.svelte";
import { startupMark } from "$lib/utils/startup-timing";
import "./app.css";

const scheduleFirstFrame = (callback: FrameRequestCallback) => {
  if ((window as typeof window & { __PW_ACTIVE__?: boolean }).__PW_ACTIVE__) {
    window.setTimeout(() => callback(performance.now()), 0);
  } else {
    requestAnimationFrame(callback);
  }
};

/** Mobile has a single native-managed window; nothing to show/focus. */
const manageNativeWindow = () => !(platform.ready && platform.isMobile);

/**
 * Explicit, non-desktop-fallback failure screen for a platform probe error.
 * Running the desktop shell on a phone (or vice versa) would call commands
 * that do not exist there, so the app refuses to mount instead.
 */
function renderPlatformError(target: HTMLElement, error: unknown) {
  const message = (error as Error)?.message ?? String(error);
  target.replaceChildren();
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.dataset.testid = "platform-init-error";
  box.style.cssText = "box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom));text-align:center;font-size:15px;";
  const title = document.createElement("h1");
  title.style.cssText = "margin:0;font-size:18px;font-weight:600;";
  title.textContent = t("platform.initFailedTitle");
  const detail = document.createElement("p");
  detail.style.cssText = "margin:0;max-width:420px;color:var(--novelist-text-secondary);word-break:break-word;";
  detail.textContent = t("platform.initFailedMessage", { error: message });
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "novelist-btn novelist-btn-primary";
  retry.style.minHeight = "44px";
  retry.textContent = t("platform.retry");
  retry.addEventListener("click", () => window.location.reload());
  box.append(title, detail, retry);
  target.append(box);
}

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
  if (!manageNativeWindow()) return;
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
    // Preload the alternate locale chunk so the command palette can
    // render bilingual labels (active locale + alternate as subscript).
    // Fire-and-forget — palette renders are reactive, so labels appear
    // as soon as the chunk lands.
    void i18n.preloadAll();

    const target = document.getElementById("app");
    if (!target) throw new Error("#app target not found");

    // Capabilities decide which shell and commands exist. No fallback: a
    // failed probe renders an explicit error instead of a guessed platform.
    logPhase("frontend.main.before-platform");
    try {
      await initPlatform();
    } catch (err) {
      console.error("[startup] platform capabilities unavailable", err);
      renderPlatformError(target, err);
      throw err;
    }
    // Re-apply the persisted zoom now that the platform is known (mobile
    // WebViews must not get the root zoom transform).
    uiStore.setZoom(uiStore.zoomLevel);
    logPhase("frontend.main.platform-ready", { os: platform.os, mobile: platform.isMobile });

    logPhase("frontend.main.before-mount", { hasTarget: true });
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
    scheduleFirstFrame(() => {
      clearTimeout(forceShowTimer);
      if (manageNativeWindow()) {
        const win = getCurrentWindow();
        win.show().catch((err) => console.error("[startup] window.show failed", err));
        win.setFocus().catch((err) => console.error("[startup] window.setFocus failed", err));
      }
      logPhase("frontend.main.window-shown");
    });
  }
})();
