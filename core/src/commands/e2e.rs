use serde::Serialize;

use crate::AppError;

static VISUAL_NATIVE_ACTIVATION_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MacosActivationApi {
    Modern,
    Legacy,
}

fn should_request_visual_native_activation(run_id: Option<&str>, mode: Option<&str>) -> bool {
    run_id.is_some_and(|run_id| !run_id.trim().is_empty()) && mode == Some("visual")
}

fn native_paste_mode_allowed(mode: Option<&str>) -> bool {
    mode == Some("nonvisual-behavior")
}

fn native_command_v_mode_allowed(mode: Option<&str>) -> bool {
    mode == Some("visual")
}

fn take_visual_native_activation_request(
    requested: &std::sync::atomic::AtomicBool,
    run_id: Option<&str>,
    mode: Option<&str>,
) -> bool {
    should_request_visual_native_activation(run_id, mode)
        && requested
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok()
}

fn activation_api(modern_selector_available: bool) -> MacosActivationApi {
    if modern_selector_available {
        MacosActivationApi::Modern
    } else {
        MacosActivationApi::Legacy
    }
}

fn activate_macos_application() -> Result<MacosActivationApi, &'static str> {
    use objc2::runtime::NSObjectProtocol;
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;

    let Some(main_thread) = MainThreadMarker::new() else {
        return Err("Ready activation callback was not on the AppKit main thread");
    };
    let app = NSApplication::sharedApplication(main_thread);
    let api = activation_api(app.respondsToSelector(sel!(activate)));
    match api {
        MacosActivationApi::Modern => app.activate(),
        MacosActivationApi::Legacy => activate_macos_application_legacy(&app),
    }
    Ok(api)
}

#[allow(deprecated)]
fn activate_macos_application_legacy(app: &objc2_app_kit::NSApplication) {
    app.activateIgnoringOtherApps(true);
}

#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
pub(crate) fn request_visual_native_activation_once(app: &tauri::AppHandle) {
    use tauri::Manager;

    let run_id = std::env::var("NOVELIST_NATIVE_RUN_ID").ok();
    let mode = std::env::var("NOVELIST_NATIVE_MODE").ok();
    if !take_visual_native_activation_request(
        &VISUAL_NATIVE_ACTIVATION_REQUESTED,
        run_id.as_deref(),
        mode.as_deref(),
    ) {
        return;
    }

    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!(
            target: "novelist::native_e2e",
            step = "obtain_main_window",
            "visual native activation skipped because the main window was unavailable"
        );
        return;
    };
    if let Err(error) = window.show() {
        tracing::warn!(
            target: "novelist::native_e2e",
            step = "show",
            error = %error,
            "visual native activation step failed"
        );
    }
    if let Err(error) = window.unminimize() {
        tracing::warn!(
            target: "novelist::native_e2e",
            step = "unminimize",
            error = %error,
            "visual native activation step failed"
        );
    }
    match activate_macos_application() {
        Ok(api) => tracing::info!(
            target: "novelist::native_e2e",
            ?api,
            "visual native AppKit activation requested"
        ),
        Err(error) => tracing::warn!(
            target: "novelist::native_e2e",
            step = "appkit_activate",
            error,
            "visual native activation step failed"
        ),
    }
    if let Err(error) = window.set_focus() {
        tracing::warn!(
            target: "novelist::native_e2e",
            step = "tauri_focus",
            error = %error,
            "visual native activation step failed"
        );
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct E2eSnapshotInfo {
    pub bytes: usize,
    pub pdf_bytes: usize,
    pub pdf_page_width: f64,
    pub pdf_page_height: f64,
    pub png_width: usize,
    pub png_height: usize,
    pub backing_scale: f64,
    pub app_active: bool,
    pub window_visible: bool,
    pub window_miniaturized: bool,
    pub window_on_active_space: bool,
    pub window_key: bool,
    pub window_main: bool,
    pub window_occluded: bool,
    pub window_number: isize,
    pub window_x: f64,
    pub window_y: f64,
    pub window_width: f64,
    pub window_height: f64,
    pub webview_hidden: bool,
    pub webview_attached: bool,
    pub webview_window_matches: bool,
    pub webview_width: f64,
    pub webview_height: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct E2eNativePasteInfo {
    pub action_accepted: bool,
    pub action_target_available: bool,
    pub app_active: bool,
    pub first_responder_accepted: bool,
    pub first_responder_is_webview: bool,
    pub untargeted_action_target_available: bool,
    pub untargeted_action_target_is_webview: bool,
    pub used_explicit_first_responder_target: bool,
    pub window_key: bool,
    pub window_number: isize,
    pub webview_attached: bool,
    pub webview_window_matches: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct E2eNativeCommandVInfo {
    pub app_active: bool,
    pub first_responder_accepted: bool,
    pub first_responder_is_webview: bool,
    pub key_down_sent: bool,
    pub key_up_sent: bool,
    pub window_key: bool,
    pub window_main: bool,
    pub window_number: isize,
    pub webview_attached: bool,
    pub webview_window_matches: bool,
}

#[tauri::command]
pub async fn perform_e2e_native_command_v(
    window: tauri::WebviewWindow,
) -> Result<E2eNativeCommandVInfo, AppError> {
    use std::sync::{Arc, Mutex};

    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSResponder, NSView, NSWindow,
    };
    use objc2_foundation::{NSPoint, NSString};
    use objc2_web_kit::WKWebView;

    let mode = std::env::var("NOVELIST_NATIVE_MODE").ok();
    if !native_command_v_mode_allowed(mode.as_deref()) {
        return Err(AppError::Custom(
            "native Command+V requires NOVELIST_NATIVE_MODE=visual".into(),
        ));
    }

    let (sender, receiver) =
        tokio::sync::oneshot::channel::<Result<E2eNativeCommandVInfo, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    window
        .with_webview(move |platform_webview| unsafe {
            let send = |result| {
                if let Some(sender) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = sender.send(result);
                }
            };
            let Some(main_thread) = MainThreadMarker::new() else {
                send(Err(
                    "native Command+V callback did not run on the main thread".into(),
                ));
                return;
            };
            let app = NSApplication::sharedApplication(main_thread);
            let webview: &WKWebView = &*platform_webview.inner().cast();
            let view: &NSView = &*platform_webview.inner().cast();
            let responder: &NSResponder = webview;
            let ns_window: &NSWindow = &*platform_webview.ns_window().cast();
            let attached_window = view.window();
            let webview_attached = attached_window.is_some();
            let webview_window_matches = attached_window
                .as_deref()
                .is_some_and(|attached| std::ptr::eq(attached, ns_window));
            if !webview_attached || !webview_window_matches {
                send(Err(
                    "native Command+V WKWebView is not attached to the invoking window".into(),
                ));
                return;
            }

            ns_window.makeKeyAndOrderFront(None);
            let first_responder_accepted = ns_window.makeFirstResponder(Some(responder));
            let first_responder_is_webview = ns_window
                .firstResponder()
                .as_deref()
                .is_some_and(|current| std::ptr::eq(current, responder));
            if !first_responder_accepted || !first_responder_is_webview {
                send(Err(
                    "native Command+V could not make the invoking WKWebView first responder".into(),
                ));
                return;
            }

            let characters = NSString::from_str("v");
            let make_event = |event_type| {
                NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                    event_type,
                    NSPoint::ZERO,
                    NSEventModifierFlags::Command,
                    0.0,
                    ns_window.windowNumber(),
                    None,
                    &characters,
                    &characters,
                    false,
                    9,
                )
            };
            let Some(key_down) = make_event(NSEventType::KeyDown) else {
                send(Err("AppKit could not create native Command+V key-down event".into()));
                return;
            };
            let Some(key_up) = make_event(NSEventType::KeyUp) else {
                send(Err("AppKit could not create native Command+V key-up event".into()));
                return;
            };

            app.sendEvent(&key_down);
            app.sendEvent(&key_up);
            send(Ok(E2eNativeCommandVInfo {
                app_active: app.isActive(),
                first_responder_accepted,
                first_responder_is_webview,
                key_down_sent: true,
                key_up_sent: true,
                window_key: ns_window.isKeyWindow(),
                window_main: ns_window.isMainWindow(),
                window_number: ns_window.windowNumber(),
                webview_attached,
                webview_window_matches,
            }));
        })
        .map_err(|error| AppError::Custom(format!("failed to access WKWebView: {error}")))?;

    tokio::time::timeout(std::time::Duration::from_secs(10), receiver)
        .await
        .map_err(|_| AppError::Custom("native Command+V action timed out".into()))?
        .map_err(|_| AppError::Custom("native Command+V callback was dropped".into()))?
        .map_err(AppError::Custom)
}

#[tauri::command]
pub async fn perform_e2e_native_paste(
    window: tauri::WebviewWindow,
) -> Result<E2eNativePasteInfo, AppError> {
    use std::sync::{Arc, Mutex};

    use objc2::{runtime::AnyObject, sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSResponder, NSView, NSWindow};
    use objc2_web_kit::WKWebView;

    let mode = std::env::var("NOVELIST_NATIVE_MODE").ok();
    if !native_paste_mode_allowed(mode.as_deref()) {
        return Err(AppError::Custom(
            "native paste requires NOVELIST_NATIVE_MODE=nonvisual-behavior".into(),
        ));
    }

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<E2eNativePasteInfo, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    window
        .with_webview(move |platform_webview| unsafe {
            let send = |result| {
                if let Some(sender) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = sender.send(result);
                }
            };
            let Some(main_thread) = MainThreadMarker::new() else {
                send(Err(
                    "native paste callback did not run on the main thread".into()
                ));
                return;
            };
            let app = NSApplication::sharedApplication(main_thread);
            let webview: &WKWebView = &*platform_webview.inner().cast();
            let view: &NSView = &*platform_webview.inner().cast();
            let responder: &NSResponder = webview;
            let ns_window: &NSWindow = &*platform_webview.ns_window().cast();
            let attached_window = view.window();
            let webview_attached = attached_window.is_some();
            let webview_window_matches = attached_window
                .as_deref()
                .is_some_and(|attached| std::ptr::eq(attached, ns_window));
            if !webview_attached || !webview_window_matches {
                send(Err(
                    "native paste WKWebView is not attached to the invoking window".into(),
                ));
                return;
            }

            ns_window.makeKeyWindow();
            let first_responder_accepted = ns_window.makeFirstResponder(Some(responder));
            let first_responder_is_webview = ns_window
                .firstResponder()
                .as_deref()
                .is_some_and(|current| std::ptr::eq(current, responder));
            if !first_responder_accepted || !first_responder_is_webview {
                send(Err(
                    "native paste could not make the invoking WKWebView first responder".into(),
                ));
                return;
            }

            let paste = sel!(paste:);
            let responder_object: &AnyObject = responder;
            let untargeted_action_target = app.targetForAction_to_from(paste, None, None);
            let untargeted_action_target_available = untargeted_action_target.is_some();
            let untargeted_action_target_is_webview = untargeted_action_target
                .as_deref()
                .is_some_and(|target| std::ptr::eq(target, responder_object));
            let explicit_target =
                (!untargeted_action_target_is_webview).then_some(responder_object);
            let action_target_available = app
                .targetForAction_to_from(paste, explicit_target, None)
                .is_some();
            if !action_target_available {
                send(Err(
                    "AppKit did not resolve the verified WKWebView first responder for paste:"
                        .into(),
                ));
                return;
            }
            let action_accepted = app.sendAction_to_from(paste, explicit_target, None);
            if !action_accepted {
                send(Err("AppKit rejected the standard paste: action".into()));
                return;
            }

            send(Ok(E2eNativePasteInfo {
                action_accepted,
                action_target_available,
                app_active: app.isActive(),
                first_responder_accepted,
                first_responder_is_webview,
                untargeted_action_target_available,
                untargeted_action_target_is_webview,
                used_explicit_first_responder_target: explicit_target.is_some(),
                window_key: ns_window.isKeyWindow(),
                window_number: ns_window.windowNumber(),
                webview_attached,
                webview_window_matches,
            }));
        })
        .map_err(|error| AppError::Custom(format!("failed to access WKWebView: {error}")))?;

    tokio::time::timeout(std::time::Duration::from_secs(10), receiver)
        .await
        .map_err(|_| AppError::Custom("native paste action timed out".into()))?
        .map_err(|_| AppError::Custom("native paste action callback was dropped".into()))?
        .map_err(AppError::Custom)
}

#[tauri::command]
pub async fn capture_e2e_webview_snapshot(
    window: tauri::WebviewWindow,
    path: String,
    prepare_only: Option<bool>,
) -> Result<E2eSnapshotInfo, AppError> {
    #[cfg(all(target_os = "macos", feature = "e2e-testing"))]
    {
        capture_macos_snapshot(window, path, prepare_only.unwrap_or(false)).await
    }
    #[cfg(not(all(target_os = "macos", feature = "e2e-testing")))]
    {
        let _ = (window, path, prepare_only);
        Err(AppError::Custom(
            "native WKWebView snapshots require macOS and the e2e-testing feature".into(),
        ))
    }
}

#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
async fn capture_macos_snapshot(
    window: tauri::WebviewWindow,
    path: String,
    prepare_only: bool,
) -> Result<E2eSnapshotInfo, AppError> {
    use std::sync::{Arc, Mutex};

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSView, NSWindow, NSWindowCollectionBehavior, NSWindowOcclusionState,
    };
    use objc2_foundation::{NSData, NSError};
    use objc2_web_kit::{WKPDFConfiguration, WKWebView};

    let expected = std::env::var("NOVELIST_NATIVE_SCREENSHOT")
        .map_err(|_| AppError::Custom("missing NOVELIST_NATIVE_SCREENSHOT".into()))?;
    if path != expected {
        return Err(AppError::PathNotAllowed(path));
    }

    type SnapshotResult = Result<(Option<Vec<u8>>, E2eSnapshotInfo), String>;
    let (sender, receiver) = tokio::sync::oneshot::channel::<SnapshotResult>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    window
        .with_webview(move |platform_webview| unsafe {
            let send = move |result| {
                if let Some(sender) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = sender.send(result);
                }
            };
            let Some(main_thread) = MainThreadMarker::new() else {
                send(Err(
                    "WKWebView snapshot callback did not run on the main thread".into(),
                ));
                return;
            };
            let app = NSApplication::sharedApplication(main_thread);
            let webview: &WKWebView = &*platform_webview.inner().cast();
            let view: &NSView = &*platform_webview.inner().cast();
            let ns_window: &NSWindow = &*platform_webview.ns_window().cast();
            app.unhideWithoutActivation();
            let mut collection_behavior = ns_window.collectionBehavior();
            collection_behavior.remove(NSWindowCollectionBehavior::CanJoinAllSpaces);
            collection_behavior.insert(NSWindowCollectionBehavior::MoveToActiveSpace);
            ns_window.setCollectionBehavior(collection_behavior);
            if ns_window.isMiniaturized() {
                ns_window.deminiaturize(None);
            }
            ns_window.setAlphaValue(1.0);
            view.setHidden(false);
            ns_window.orderFrontRegardless();
            let bounds = view.bounds();
            let frame = ns_window.frame();
            let attached_window = view.window();
            let diagnostics = E2eSnapshotInfo {
                bytes: 0,
                pdf_bytes: 0,
                pdf_page_width: 0.0,
                pdf_page_height: 0.0,
                png_width: 0,
                png_height: 0,
                backing_scale: ns_window.backingScaleFactor(),
                app_active: app.isActive(),
                window_visible: ns_window.isVisible(),
                window_miniaturized: ns_window.isMiniaturized(),
                window_on_active_space: ns_window.isOnActiveSpace(),
                window_key: ns_window.isKeyWindow(),
                window_main: ns_window.isMainWindow(),
                window_occluded: !ns_window
                    .occlusionState()
                    .contains(NSWindowOcclusionState::Visible),
                window_number: ns_window.windowNumber(),
                window_x: frame.origin.x,
                window_y: frame.origin.y,
                window_width: frame.size.width,
                window_height: frame.size.height,
                webview_hidden: view.isHiddenOrHasHiddenAncestor(),
                webview_attached: attached_window.is_some(),
                webview_window_matches: attached_window
                    .as_deref()
                    .is_some_and(|attached| std::ptr::eq(attached, ns_window)),
                webview_width: bounds.size.width,
                webview_height: bounds.size.height,
            };
            if !diagnostics.webview_attached
                || !diagnostics.webview_window_matches
                || diagnostics.webview_width <= 0.0
                || diagnostics.webview_height <= 0.0
            {
                send(Err(format!("WKWebView is not drawable: {diagnostics:?}")));
                return;
            }
            if prepare_only {
                send(Ok((None, diagnostics)));
                return;
            }

            let configuration = WKPDFConfiguration::new(main_thread);
            configuration.setRect(bounds);
            configuration.setAllowTransparentBackground(false);
            let completion = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                if let Some(error) = error.as_ref() {
                    send(Err(format!(
                        "WKWebView PDF capture failed: {}",
                        error.localizedDescription()
                    )));
                    return;
                }
                let Some(data) = data.as_ref() else {
                    send(Err("WKWebView PDF capture returned no data".into()));
                    return;
                };
                let pdf_len = match checked_pdf_length(data.len()) {
                    Ok(length) => length,
                    Err(error) => {
                        send(Err(error));
                        return;
                    }
                };
                let pdf = data.to_vec();
                let mut diagnostics = diagnostics.clone();
                diagnostics.pdf_bytes = pdf_len;
                match render_pdf_to_png(&pdf, diagnostics.backing_scale) {
                    Ok(rendered) => {
                        diagnostics.bytes = rendered.png.len();
                        diagnostics.pdf_page_width = rendered.page_width;
                        diagnostics.pdf_page_height = rendered.page_height;
                        diagnostics.png_width = rendered.width;
                        diagnostics.png_height = rendered.height;
                        send(Ok((Some(rendered.png), diagnostics)));
                    }
                    Err(error) => send(Err(error)),
                }
            });
            webview.createPDFWithConfiguration_completionHandler(Some(&configuration), &completion);
        })
        .map_err(|error| AppError::Custom(format!("failed to access WKWebView: {error}")))?;

    let (png, diagnostics) = tokio::time::timeout(std::time::Duration::from_secs(30), receiver)
        .await
        .map_err(|_| AppError::Custom("WKWebView snapshot timed out".into()))?
        .map_err(|_| AppError::Custom("WKWebView snapshot callback was dropped".into()))?
        .map_err(AppError::Custom)?;
    let Some(png) = png else {
        return Ok(diagnostics);
    };
    if !png.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Err(AppError::Custom(
            "WKWebView snapshot did not produce PNG bytes".into(),
        ));
    }
    write_atomically(std::path::Path::new(&path), &png)?;
    Ok(diagnostics)
}

#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
struct RenderedPdf {
    png: Vec<u8>,
    page_width: f64,
    page_height: f64,
    width: usize,
    height: usize,
}

#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
const MAX_PDF_BYTES: usize = 64 * 1024 * 1024;
#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
const MAX_RASTER_DIMENSION: usize = 16_384;
#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
const MAX_RASTER_PIXELS: usize = 64 * 1024 * 1024;
#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
const MAX_RASTER_BYTES: usize = 256 * 1024 * 1024;

#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
fn checked_pdf_length(bytes: usize) -> Result<usize, String> {
    if bytes > MAX_PDF_BYTES {
        return Err(format!("WKWebView PDF exceeds byte limit: {bytes}"));
    }
    Ok(bytes)
}

#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
fn checked_raster_dimensions(
    page_width: f64,
    page_height: f64,
    scale: f64,
) -> Result<(usize, usize, usize), String> {
    if !scale.is_finite() || !(0.25..=4.0).contains(&scale) {
        return Err(format!(
            "WKWebView snapshot has invalid backing scale: {scale}"
        ));
    }
    let scaled_width = page_width * scale;
    let scaled_height = page_height * scale;
    if !scaled_width.is_finite()
        || !scaled_height.is_finite()
        || scaled_width <= 0.0
        || scaled_height <= 0.0
        || scaled_width > MAX_RASTER_DIMENSION as f64
        || scaled_height > MAX_RASTER_DIMENSION as f64
    {
        return Err(format!(
            "WKWebView snapshot dimensions exceed bounds: {scaled_width}x{scaled_height}"
        ));
    }
    let width = scaled_width.ceil() as usize;
    let height = scaled_height.ceil() as usize;
    let pixels = width
        .checked_mul(height)
        .ok_or_else(|| "WKWebView snapshot pixel count overflowed".to_string())?;
    if pixels > MAX_RASTER_PIXELS {
        return Err(format!(
            "WKWebView snapshot pixel count exceeds limit: {pixels}"
        ));
    }
    let bytes = pixels
        .checked_mul(4)
        .ok_or_else(|| "WKWebView snapshot byte count overflowed".to_string())?;
    if bytes > MAX_RASTER_BYTES {
        return Err(format!(
            "WKWebView snapshot byte count exceeds limit: {bytes}"
        ));
    }
    Ok((width, height, bytes))
}

#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
fn render_pdf_to_png(pdf: &[u8], scale: f64) -> Result<RenderedPdf, String> {
    use std::ffi::c_void;

    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGDataProvider,
        CGImageAlphaInfo, CGPDFBox, CGPDFDocument, CGPDFPage,
    };
    use objc2_foundation::NSDictionary;

    if pdf.len() < 5 || !pdf.starts_with(b"%PDF-") {
        return Err("WKWebView returned missing or invalid PDF bytes".into());
    }
    checked_pdf_length(pdf.len())?;
    let provider = unsafe {
        CGDataProvider::with_data(
            std::ptr::null_mut(),
            pdf.as_ptr().cast::<c_void>(),
            pdf.len(),
            None,
        )
    }
    .ok_or_else(|| "failed to create PDF data provider".to_string())?;
    let document = CGPDFDocument::with_provider(Some(&provider))
        .ok_or_else(|| "failed to decode WKWebView PDF".to_string())?;
    if CGPDFDocument::number_of_pages(Some(&document)) == 0 {
        return Err("WKWebView PDF has no pages".into());
    }
    let page = CGPDFDocument::page(Some(&document), 1)
        .ok_or_else(|| "WKWebView PDF page 1 is missing".to_string())?;
    let crop = CGPDFPage::box_rect(Some(&page), CGPDFBox::CropBox);
    let rotation = CGPDFPage::rotation_angle(Some(&page)).rem_euclid(360);
    let (page_width, page_height) = if rotation == 90 || rotation == 270 {
        (crop.size.height, crop.size.width)
    } else {
        (crop.size.width, crop.size.height)
    };
    if !page_width.is_finite()
        || !page_height.is_finite()
        || page_width <= 0.0
        || page_height <= 0.0
    {
        return Err(format!("WKWebView PDF has invalid crop box: {crop:?}"));
    }
    let (width, height, _bytes) = checked_raster_dimensions(page_width, page_height, scale)?;
    let color_space = CGColorSpace::new_device_rgb()
        .ok_or_else(|| "failed to create RGB color space".to_string())?;
    let bitmap_info = CGImageAlphaInfo::PremultipliedLast.0;
    let context = unsafe {
        CGBitmapContextCreate(
            std::ptr::null_mut(),
            width,
            height,
            8,
            width
                .checked_mul(4)
                .ok_or_else(|| "WKWebView snapshot row byte count overflowed".to_string())?,
            Some(&color_space),
            bitmap_info,
        )
    }
    .ok_or_else(|| "failed to create PDF bitmap context".to_string())?;
    let pixel_target = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(width as f64, height as f64),
    );
    CGContext::set_rgb_fill_color(Some(&context), 1.0, 1.0, 1.0, 1.0);
    CGContext::fill_rect(Some(&context), pixel_target);
    CGContext::scale_ctm(Some(&context), scale, scale);
    let point_target = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(page_width, page_height));
    let transform =
        CGPDFPage::drawing_transform(Some(&page), CGPDFBox::CropBox, point_target, 0, true);
    CGContext::concat_ctm(Some(&context), transform);
    CGContext::draw_pdf_page(Some(&context), Some(&page));
    let image = CGBitmapContextCreateImage(Some(&context))
        .ok_or_else(|| "failed to create image from PDF bitmap".to_string())?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image);
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
    }
    .ok_or_else(|| "failed to encode PDF bitmap as PNG".to_string())?
    .to_vec();
    Ok(RenderedPdf {
        png,
        page_width,
        page_height,
        width,
        height,
    })
}

#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
fn write_atomically(path: &std::path::Path, bytes: &[u8]) -> Result<(), AppError> {
    use std::io::Write;

    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("snapshot path has no parent".into()))?;
    std::fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidInput("snapshot path has no UTF-8 file name".into()))?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    let result = (|| -> Result<(), AppError> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(all(test, target_os = "macos", feature = "e2e-testing"))]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::{
        activation_api, checked_pdf_length, checked_raster_dimensions,
        native_command_v_mode_allowed, native_paste_mode_allowed,
        should_request_visual_native_activation, take_visual_native_activation_request,
        MacosActivationApi, MAX_PDF_BYTES,
    };

    #[test]
    fn native_command_v_policy_requires_exact_visual_mode() {
        assert!(native_command_v_mode_allowed(Some("visual")));
        for mode in [
            None,
            Some("nonvisual-behavior"),
            Some(""),
            Some("Visual"),
            Some(" visual"),
            Some("visual "),
        ] {
            assert!(
                !native_command_v_mode_allowed(mode),
                "unexpectedly accepted {mode:?}"
            );
        }
    }

    #[test]
    fn native_paste_policy_requires_exact_nonvisual_mode() {
        assert!(native_paste_mode_allowed(Some("nonvisual-behavior")));
        for mode in [
            None,
            Some("visual"),
            Some(""),
            Some("Nonvisual-behavior"),
            Some("nonvisual_behavior"),
            Some(" nonvisual-behavior"),
            Some("nonvisual-behavior "),
        ] {
            assert!(
                !native_paste_mode_allowed(mode),
                "unexpectedly accepted {mode:?}"
            );
        }
    }

    #[test]
    fn visual_activation_policy_requires_exact_mode_and_nonempty_run_id() {
        assert!(should_request_visual_native_activation(
            Some("t24-run"),
            Some("visual")
        ));
        assert!(!should_request_visual_native_activation(
            None,
            Some("visual")
        ));
        assert!(!should_request_visual_native_activation(
            Some(""),
            Some("visual")
        ));
        assert!(!should_request_visual_native_activation(
            Some(" \t\n"),
            Some("visual")
        ));
        assert!(!should_request_visual_native_activation(
            Some("t24-run"),
            None
        ));
        assert!(!should_request_visual_native_activation(
            Some("t24-run"),
            Some("nonvisual-behavior")
        ));
    }

    #[test]
    fn visual_activation_request_is_taken_once_after_guards_pass() {
        let requested = AtomicBool::new(false);

        assert!(!take_visual_native_activation_request(
            &requested,
            None,
            Some("visual")
        ));
        assert!(!requested.load(Ordering::SeqCst));
        assert!(take_visual_native_activation_request(
            &requested,
            Some("t24-run"),
            Some("visual")
        ));
        assert!(!take_visual_native_activation_request(
            &requested,
            Some("t24-run"),
            Some("visual")
        ));
    }

    #[test]
    fn activation_api_uses_modern_selector_when_available() {
        assert_eq!(activation_api(true), MacosActivationApi::Modern);
        assert_eq!(activation_api(false), MacosActivationApi::Legacy);
    }

    #[test]
    fn checked_pdf_length_rejects_before_copy_above_limit() {
        assert_eq!(checked_pdf_length(MAX_PDF_BYTES).unwrap(), MAX_PDF_BYTES);
        assert!(checked_pdf_length(MAX_PDF_BYTES + 1).is_err());
    }

    #[test]
    fn checked_raster_dimensions_accepts_bounded_viewport() {
        assert_eq!(
            checked_raster_dimensions(1200.0, 800.0, 2.0).unwrap(),
            (2400, 1600, 15_360_000)
        );
    }

    #[test]
    fn checked_raster_dimensions_rejects_invalid_scale() {
        assert!(checked_raster_dimensions(1200.0, 800.0, 0.0).is_err());
        assert!(checked_raster_dimensions(1200.0, 800.0, 5.0).is_err());
    }

    #[test]
    fn checked_raster_dimensions_rejects_oversized_output() {
        assert!(checked_raster_dimensions(20_000.0, 800.0, 1.0).is_err());
        assert!(checked_raster_dimensions(10_000.0, 10_000.0, 1.0).is_err());
    }
}
