//! The window material Settings → Appearance picks: an opaque window, or one
//! the desktop shows through (glass: the system's translucent material; clear:
//! the desktop blurred without the system's tint). A page can't reach its
//! window, so it asks here (`PUT /api/window`) and the app that embeds the
//! server applies it through a [`WindowMaterial`]; a server without one
//! (`tablepeek serve`, whose pages live in browser tabs) answers that its
//! windows can't be see-through.

use serde::Deserialize;

/// What a window shows behind the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Material {
    Solid,
    Glass,
    Clear,
}

/// The look a page asks its windows for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct WindowLook {
    pub material: Material,
    /// The radius, in points, the desktop behind a clear window is blurred by.
    #[serde(default)]
    pub blur: u32,
    /// The page's theme is dark: the system's material and the title bar
    /// follow it rather than the system's appearance.
    pub dark: bool,
    /// The page follows the system's light or dark mode: the window keeps
    /// the system's appearance (which the page reads) instead of `dark`.
    #[serde(default)]
    pub system: bool,
}

/// The most blur a clear window takes.
pub const MAX_BLUR: u32 = 64;

impl WindowLook {
    /// The look with its blur kept within [`MAX_BLUR`].
    pub fn clamped(self) -> Self {
        Self {
            blur: self.blur.min(MAX_BLUR),
            ..self
        }
    }
}

/// How the embedding app gives its windows a look.
pub trait WindowMaterial: Send + Sync {
    /// Applies `look` to every window of the app; solid while the system
    /// reduces transparency. May wait on the app's main thread.
    fn apply(&self, look: WindowLook) -> Result<(), String>;
    /// Whether the system's "Reduce transparency" is on: the page can't tell
    /// in every webview (WebKit doesn't answer the media query). May wait on
    /// the app's main thread.
    fn transparency_reduced(&self) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_look_and_keeps_its_blur_in_range() {
        let look: WindowLook =
            serde_json::from_str(r#"{ "material": "clear", "blur": 500, "dark": true }"#).unwrap();
        assert_eq!(
            look.clamped(),
            WindowLook {
                material: Material::Clear,
                blur: MAX_BLUR,
                dark: true,
                system: false
            }
        );
        let glass: WindowLook =
            serde_json::from_str(r#"{ "material": "glass", "dark": false }"#).unwrap();
        assert_eq!(glass.material, Material::Glass);
        assert_eq!(glass.blur, 0);
        let follows: WindowLook =
            serde_json::from_str(r#"{ "material": "solid", "dark": false, "system": true }"#)
                .unwrap();
        assert!(follows.system);
        assert!(
            serde_json::from_str::<WindowLook>(r#"{ "material": "frosted", "dark": false }"#)
                .is_err()
        );
    }
}
