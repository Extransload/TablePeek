//! The window material the page picks in Settings → Appearance, on the app's
//! windows. Every window is built transparent (see window.rs); the page paints
//! its background with the opacity it picked, and here the window gets what
//! shows behind it:
//!
//! - solid: nothing (the page paints itself opaque);
//! - glass: the system's translucent material — macOS vibrancy behind the
//!   window, Windows 11 Mica;
//! - clear: the desktop blurred without the system's tint — on macOS the
//!   window server's background blur (`CGSSetWindowBackgroundBlurRadius`, the
//!   private call Ghostty uses), on Windows Acrylic (whose blur is fixed).
//!
//! The material and the title bar follow the page's theme (dark or light)
//! rather than the system's appearance, or the system's when the page
//! follows it (System in Settings). While the system's "Reduce
//! transparency" is on, every window is solid whatever the page asks for.

use std::sync::Mutex;

use tablepeek_server::window_material::{Material, WindowLook, WindowMaterial};
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, Manager, Theme, WebviewWindow};

pub struct WindowEffects {
    app: AppHandle,
    // The look the page last picked, for windows opened after it.
    current: Mutex<Option<WindowLook>>,
}

impl WindowEffects {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            current: Mutex::new(None),
        }
    }

    /// Gives a new window the look the others have, if the page picked one.
    pub fn apply_current(&self, window: &WebviewWindow) {
        let current = *self.current.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(look) = current {
            if let Err(err) = apply(window, shown(&self.app, look)) {
                eprintln!("창 재질을 바꿀 수 없습니다: {err}");
            }
        }
    }
}

impl WindowMaterial for WindowEffects {
    fn apply(&self, look: WindowLook) -> Result<(), String> {
        *self.current.lock().unwrap_or_else(|err| err.into_inner()) = Some(look);
        let look = shown(&self.app, look);
        // A window that can't take it (one closing, say) keeps its look;
        // the others still get theirs.
        for window in self.app.webview_windows().into_values() {
            if let Err(err) = apply(&window, look) {
                eprintln!("창 {} 재질을 바꿀 수 없습니다: {err}", window.label());
            }
        }
        Ok(())
    }

    fn transparency_reduced(&self) -> bool {
        transparency_reduced(&self.app)
    }
}

/// The look a window is given: solid while the system reduces transparency.
fn shown(app: &AppHandle, look: WindowLook) -> WindowLook {
    if look.material != Material::Solid && transparency_reduced(app) {
        WindowLook {
            material: Material::Solid,
            ..look
        }
    } else {
        look
    }
}

/// Whether the system's "Reduce transparency" is on, as AppKit says on the
/// main thread: read there directly, or waited for from another thread.
#[cfg(target_os = "macos")]
fn transparency_reduced(app: &AppHandle) -> bool {
    use std::sync::mpsc;
    use std::time::Duration;

    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send, MainThreadMarker};

    fn read() -> bool {
        // SAFETY: called on the main thread; the shared NSWorkspace lives as
        // long as the app.
        unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return false;
            }
            let reduced: Bool =
                msg_send![&*workspace, accessibilityDisplayShouldReduceTransparency];
            reduced.as_bool()
        }
    }

    if MainThreadMarker::new().is_some() {
        return read();
    }
    let (sender, receiver) = mpsc::channel();
    if app
        .run_on_main_thread(move || {
            let _ = sender.send(read());
        })
        .is_err()
    {
        return false;
    }
    receiver
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or(false)
}

// Elsewhere the page reads the system's setting itself (WebView2 answers
// `prefers-reduced-transparency`) and asks for solid.
#[cfg(not(target_os = "macos"))]
fn transparency_reduced(_app: &AppHandle) -> bool {
    false
}

fn apply(window: &WebviewWindow, look: WindowLook) -> tauri::Result<()> {
    // Following the system, the window keeps the system's appearance, which
    // the page then reads (prefers-color-scheme).
    window.set_theme(if look.system {
        None
    } else {
        Some(if look.dark { Theme::Dark } else { Theme::Light })
    })?;
    let effect = match look.material {
        Material::Solid => None,
        Material::Glass => Some(if cfg!(target_os = "macos") {
            Effect::UnderWindowBackground
        } else {
            Effect::Mica
        }),
        // macOS blurs a clear window in the window server instead (below).
        Material::Clear if cfg!(target_os = "macos") => None,
        Material::Clear => Some(Effect::Acrylic),
    };
    window.set_effects(effect.map(|effect| {
        EffectsBuilder::new()
            .effect(effect)
            .state(EffectState::Active)
            .build()
    }))?;
    #[cfg(target_os = "macos")]
    set_background_blur(
        window,
        if look.material == Material::Clear {
            look.blur
        } else {
            0
        },
    )?;
    Ok(())
}

/// Blurs what is behind the window by `radius` points (0: no blur), as the
/// window server draws it: no tint, unlike vibrancy.
#[cfg(target_os = "macos")]
fn set_background_blur(window: &WebviewWindow, radius: u32) -> tauri::Result<()> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    type ConnectionId = i32;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSDefaultConnectionForThread() -> ConnectionId;
        fn CGSSetWindowBackgroundBlurRadius(
            connection: ConnectionId,
            window: u32,
            radius: i32,
        ) -> i32;
    }

    let radius = i32::try_from(radius).unwrap_or(i32::MAX);
    let target = window.clone();
    window.run_on_main_thread(move || {
        // Taken here, on the main thread where AppKit releases windows: a
        // window closed meanwhile has no NSWindow to hand out.
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        // SAFETY: the NSWindow was just handed out on the main thread, and
        // nothing can release it before this closure returns.
        unsafe {
            let ns_window = &*(ns_window as *const AnyObject);
            let number: isize = msg_send![ns_window, windowNumber];
            let status = CGSSetWindowBackgroundBlurRadius(
                CGSDefaultConnectionForThread(),
                number as u32,
                radius,
            );
            if status != 0 {
                eprintln!("창 뒤를 흐리게 할 수 없습니다 (CGError {status})");
            }
        }
    })
}
