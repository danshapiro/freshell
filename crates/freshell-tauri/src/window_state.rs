//! Window-state persistence — the Rust analog of `electron/window-state.ts`
//! (`createWindowStatePersistence`, load/save of `desktop.json.windowState`), plus
//! the **off-screen clamp** on restore that `tauri-plugin-window-state` provides.
//!
//! **Faithful port, NOT the plugin (deliberate).** `electron-tauri.md §6` (the
//! window-state row) says: *"either adopt [`tauri-plugin-window-state`] or keep
//! writing `desktop.json.windowState` from Rust for parity."* The plugin persists
//! to its **own** store; the Electron shell persists to `desktop.json`, the SAME
//! file the headless server reads. To keep that single-source-of-truth parity the
//! port writes `desktop.json.windowState` itself (`window-state.ts:41-43` →
//! `patchDesktopConfig({windowState})`), so this is a faithful port rather than the
//! plugin. Schema = `types.ts:20-26` (`{x,y,width,height,maximized}`); defaults
//! 1200×800 not-maximized (`window-state.ts:19-23`).
//!
//! The [`clamp_to_monitors`] restore-guard has **no Electron equivalent** — the
//! reference restores saved bounds verbatim (`startup.ts:139-160`), so a window
//! saved on a since-disconnected monitor restores fully off-screen (unreachable).
//! That is a latent original gap; the plugin guards against it, so the port does
//! too. This is a deliberate improvement, flagged — not a silent divergence.
//
// CD candidate: window-state-offscreen-norestore — `window-state.ts` +
// `startup.ts:139-160` restore persisted bounds with no visibility check, so a
// window last positioned on a now-disconnected monitor restores off-screen and
// unreachable. The port clamps on restore (parity with tauri-plugin-window-state).
// Route to the antagonist before treating the clamp as reference behavior.

use serde::{Deserialize, Serialize};

/// Default window geometry — `window-state.ts:19-23` (1200×800, not maximized).
pub const DEFAULT_WIDTH: i32 = 1200;
pub const DEFAULT_HEIGHT: i32 = 800;

/// The loaded window state. `x`/`y` are optional (absent → the OS/centering picks a
/// position, exactly like `window-state.ts`'s optional `x?/y?`); width/height/
/// maximized always have values (defaults applied on load).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            maximized: false,
        }
    }
}

/// The bounds captured on `resize`/`move` (`startup.ts:189-201`) — all fields
/// present (a real window always has an x/y/size). Serialized as the persisted
/// `windowState` object (`types.ts:20-26`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
}

/// Load the window state from a parsed `desktop.json` value. Missing/invalid
/// `windowState` → defaults. Individual missing fields fall back to defaults,
/// mirroring `window-state.ts:29-40`'s per-field `?? DEFAULTS`.
pub fn load_from_config(config: &serde_json::Value) -> WindowState {
    let Some(ws) = config.get("windowState") else {
        return WindowState::default();
    };
    if !ws.is_object() {
        return WindowState::default();
    }
    let def = WindowState::default();
    WindowState {
        x: ws.get("x").and_then(|v| v.as_i64()).map(|v| v as i32),
        y: ws.get("y").and_then(|v| v.as_i64()).map(|v| v as i32),
        width: ws
            .get("width")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32)
            .unwrap_or(def.width),
        height: ws
            .get("height")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32)
            .unwrap_or(def.height),
        maximized: ws
            .get("maximized")
            .and_then(|v| v.as_bool())
            .unwrap_or(def.maximized),
    }
}

/// Patch `windowState` into a `desktop.json` value, preserving every other key —
/// the faithful analog of `patchDesktopConfig({ windowState })`
/// (`window-state.ts:41-43`, which merges into the existing config under the
/// atomic tmp+rename mutex). If `config` is not an object it is replaced with a
/// fresh object holding just `windowState` (defensive; the caller normally passes
/// a real config).
pub fn save_into_config(config: &mut serde_json::Value, bounds: &SavedBounds) {
    if !config.is_object() {
        *config = serde_json::json!({});
    }
    let obj = config.as_object_mut().expect("just ensured object");
    obj.insert(
        "windowState".to_string(),
        serde_json::to_value(bounds).expect("SavedBounds serializes"),
    );
}

/// A screen rectangle (a monitor's work area, or the desired window bounds).
/// Coordinates are the virtual-desktop space Tauri/Electron use (top-left origin,
/// monitors can be at negative offsets to the left/above the primary).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    fn right(&self) -> i32 {
        self.x + self.width
    }
    fn bottom(&self) -> i32 {
        self.y + self.height
    }
    /// The area of overlap between `self` and `other` (0 if disjoint).
    fn intersection_area(&self, other: &Rect) -> i64 {
        let ox = (self.right().min(other.right()) - self.x.max(other.x)).max(0) as i64;
        let oy = (self.bottom().min(other.bottom()) - self.y.max(other.y)).max(0) as i64;
        ox * oy
    }
}

/// The result of clamping desired bounds to the available monitors: the final
/// on-screen rect and whether any adjustment was made (so callers can log it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clamped {
    pub rect: Rect,
    pub adjusted: bool,
}

/// Clamp desired window `bounds` to the available `monitors` so the window is
/// always reachable on restore (the guard `tauri-plugin-window-state` provides and
/// the Electron shell lacks). Algorithm:
///
///  1. Pick the target monitor = the one with the greatest overlap with `bounds`;
///     if `bounds` overlaps none (fully off-screen), the **primary** (`monitors[0]`).
///  2. Clamp width/height to the target monitor (a window larger than the current
///     display is shrunk to fit).
///  3. If `bounds` had NO overlap, **center** it on the target monitor.
///     Otherwise **shift** x/y so the (possibly resized) window sits fully inside
///     the target monitor.
///
/// `monitors` must be non-empty; with an empty list the bounds are returned as-is
/// (the shell falls back to OS default placement).
pub fn clamp_to_monitors(bounds: Rect, monitors: &[Rect]) -> Clamped {
    let Some((_, primary)) = monitors.iter().enumerate().next() else {
        return Clamped {
            rect: bounds,
            adjusted: false,
        };
    };

    // 1. Target monitor by max overlap; None overlap → primary.
    let mut best: Option<(&Rect, i64)> = None;
    for m in monitors {
        let area = bounds.intersection_area(m);
        if area > 0 && best.map(|(_, a)| area > a).unwrap_or(true) {
            best = Some((m, area));
        }
    }
    let off_screen = best.is_none();
    let target = best.map(|(m, _)| m).unwrap_or(primary);

    // 2. Clamp size to the target monitor.
    let width = bounds.width.min(target.width).max(1);
    let height = bounds.height.min(target.height).max(1);

    // 3. Position.
    let (x, y) = if off_screen {
        // Center on the target monitor.
        (
            target.x + (target.width - width) / 2,
            target.y + (target.height - height) / 2,
        )
    } else {
        // Shift into view: clamp x/y to [monitor origin, monitor far edge - size].
        let max_x = target.x + (target.width - width).max(0);
        let max_y = target.y + (target.height - height).max(0);
        (
            bounds.x.clamp(target.x, max_x),
            bounds.y.clamp(target.y, max_y),
        )
    };

    let rect = Rect {
        x,
        y,
        width,
        height,
    };
    Clamped {
        rect,
        adjusted: rect != bounds,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(json: serde_json::Value) -> serde_json::Value {
        json
    }

    #[test]
    fn load_missing_window_state_returns_defaults() {
        let c = cfg(serde_json::json!({ "serverMode": "app-bound" }));
        let ws = load_from_config(&c);
        assert_eq!(ws, WindowState::default());
        assert_eq!(ws.width, 1200);
        assert_eq!(ws.height, 800);
        assert!(!ws.maximized);
        assert_eq!(ws.x, None);
    }

    #[test]
    fn load_full_window_state_round_trips() {
        let c = cfg(serde_json::json!({
            "windowState": { "x": 100, "y": 200, "width": 1024, "height": 768, "maximized": true }
        }));
        let ws = load_from_config(&c);
        assert_eq!(
            ws,
            WindowState {
                x: Some(100),
                y: Some(200),
                width: 1024,
                height: 768,
                maximized: true,
            }
        );
    }

    #[test]
    fn load_partial_window_state_fills_defaults() {
        // Only width present → height/maximized default, x/y stay None
        // (mirrors window-state.ts per-field `?? DEFAULTS`).
        let c = cfg(serde_json::json!({ "windowState": { "width": 640 } }));
        let ws = load_from_config(&c);
        assert_eq!(ws.width, 640);
        assert_eq!(ws.height, 800);
        assert!(!ws.maximized);
        assert_eq!(ws.x, None);
    }

    #[test]
    fn save_preserves_other_config_keys() {
        let mut c = cfg(serde_json::json!({
            "serverMode": "app-bound",
            "port": 3001,
            "minimizeToTray": true
        }));
        save_into_config(
            &mut c,
            &SavedBounds {
                x: 5,
                y: 6,
                width: 800,
                height: 600,
                maximized: false,
            },
        );
        // Other keys intact.
        assert_eq!(c["serverMode"], "app-bound");
        assert_eq!(c["port"], 3001);
        assert_eq!(c["minimizeToTray"], true);
        // windowState written.
        assert_eq!(c["windowState"]["x"], 5);
        assert_eq!(c["windowState"]["width"], 800);
        assert_eq!(c["windowState"]["maximized"], false);
    }

    #[test]
    fn save_then_load_is_stable() {
        let mut c = serde_json::json!({});
        let bounds = SavedBounds {
            x: 12,
            y: 34,
            width: 1280,
            height: 720,
            maximized: false,
        };
        save_into_config(&mut c, &bounds);
        let ws = load_from_config(&c);
        assert_eq!(ws.x, Some(12));
        assert_eq!(ws.y, Some(34));
        assert_eq!(ws.width, 1280);
        assert_eq!(ws.height, 720);
    }

    // ---- clamp_to_monitors ----------------------------------------------------

    fn primary() -> Rect {
        Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }
    }

    #[test]
    fn on_screen_window_is_unchanged() {
        let bounds = Rect {
            x: 100,
            y: 100,
            width: 1200,
            height: 800,
        };
        let c = clamp_to_monitors(bounds, &[primary()]);
        assert_eq!(c.rect, bounds);
        assert!(!c.adjusted);
    }

    #[test]
    fn off_screen_window_recenters_on_primary() {
        // Saved on a monitor at x=3000 that no longer exists → off all monitors.
        let bounds = Rect {
            x: 3200,
            y: 200,
            width: 800,
            height: 600,
        };
        let c = clamp_to_monitors(bounds, &[primary()]);
        assert!(c.adjusted);
        // Centered on the primary 1920×1080.
        assert_eq!(c.rect.width, 800);
        assert_eq!(c.rect.height, 600);
        assert_eq!(c.rect.x, (1920 - 800) / 2);
        assert_eq!(c.rect.y, (1080 - 600) / 2);
    }

    #[test]
    fn partially_off_right_edge_shifts_into_view() {
        // Overlaps the primary but hangs off the right edge.
        let bounds = Rect {
            x: 1800,
            y: 100,
            width: 400,
            height: 300,
        };
        let c = clamp_to_monitors(bounds, &[primary()]);
        assert!(c.adjusted);
        // Shifted left so right edge == 1920.
        assert_eq!(c.rect.x, 1920 - 400);
        assert_eq!(c.rect.y, 100); // y was fine
        assert_eq!(c.rect.width, 400);
    }

    #[test]
    fn window_larger_than_monitor_is_shrunk() {
        let bounds = Rect {
            x: -50,
            y: -50,
            width: 4000,
            height: 3000,
        };
        let c = clamp_to_monitors(bounds, &[primary()]);
        assert!(c.adjusted);
        assert_eq!(c.rect.width, 1920);
        assert_eq!(c.rect.height, 1080);
        // Fully inside the primary.
        assert!(c.rect.x >= 0 && c.rect.y >= 0);
        assert!(c.rect.x + c.rect.width <= 1920);
        assert!(c.rect.y + c.rect.height <= 1080);
    }

    #[test]
    fn window_on_secondary_monitor_stays_there() {
        // Primary + a secondary to the right at x=1920.
        let secondary = Rect {
            x: 1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let bounds = Rect {
            x: 2000,
            y: 100,
            width: 1200,
            height: 800,
        };
        let c = clamp_to_monitors(bounds, &[primary(), secondary]);
        assert!(
            !c.adjusted,
            "a window fully inside the secondary is unchanged"
        );
        assert_eq!(c.rect, bounds);
    }

    #[test]
    fn empty_monitor_list_returns_bounds_unchanged() {
        let bounds = Rect {
            x: 10,
            y: 10,
            width: 100,
            height: 100,
        };
        let c = clamp_to_monitors(bounds, &[]);
        assert_eq!(c.rect, bounds);
        assert!(!c.adjusted);
    }
}
