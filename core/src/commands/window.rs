//! Native window tweaks that Tauri doesn't expose as config.

/// Match the NSWindow's appearance to the app theme so the system-drawn
/// title-bar chrome (top-edge highlight, traffic-light hover states) blends
/// in. Without this, a dark-themed app on a default-appearance NSWindow gets
/// a bright 1px highlight at the very top, because macOS draws the highlight
/// for *light* windows.
///
/// No-op on non-macOS and on macOS versions predating `NSAppearance` (which
/// effectively means no-op if the selector doesn't exist).
#[tauri::command]
#[specta::specta]
pub fn set_window_appearance(window: tauri::WebviewWindow, dark: bool) {
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::{Object, Sel};
        use objc::{class, msg_send, sel, sel_impl};

        let ptr = match window.ns_window() {
            Ok(p) => p,
            Err(_) => return,
        };
        let ns_window = ptr as *mut Object;
        unsafe {
            let sel: Sel = sel!(setAppearance:);
            let responds: bool = msg_send![ns_window, respondsToSelector: sel];
            if !responds {
                return;
            }
            // NSAppearanceNameDarkAqua / NSAppearanceNameAqua
            let name_cls = class!(NSString);
            let name_bytes: &[u8] = if dark {
                b"NSAppearanceNameDarkAqua\0"
            } else {
                b"NSAppearanceNameAqua\0"
            };
            let name_ptr: *mut Object =
                msg_send![name_cls, stringWithUTF8String: name_bytes.as_ptr()];
            let appearance_cls = class!(NSAppearance);
            let appearance: *mut Object = msg_send![appearance_cls, appearanceNamed: name_ptr];
            if !appearance.is_null() {
                let _: () = msg_send![ns_window, setAppearance: appearance];
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Suppress unused-param warnings on non-macOS.
        let _ = (window, dark);
    }
}

/// Open the native WebView developer tools for this window. Compiled in all
/// builds because the `devtools` Cargo feature is enabled by default (see
/// Cargo.toml). Gated in the UI behind Developer Mode (F12).
#[tauri::command]
#[specta::specta]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}
