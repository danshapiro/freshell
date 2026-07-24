//! Global hotkey — the Rust analog of `electron/hotkey.ts` (`createHotkeyManager`)
//! plus the Electron→Tauri **accelerator translation** the mapping table calls out
//! (`electron-tauri.md §3.2`, §6 "Global hotkey" row: *"Accelerator grammar differs
//! — translate `CommandOrControl+\`` → plugin shortcut"*).
//!
//! Two pieces, both headlessly unit-tested (the live OS keypress capture needs a
//! display/session — `electron-tauri.md §8` item 7 "⚠️ partial"):
//!
//!  1. [`translate_accelerator`] — converts an **Electron accelerator string**
//!     (`CommandOrControl+\``, `Alt+Shift+K`, `Super+Space`, …) into the grammar
//!     `tauri-plugin-global-shortcut` accepts (which wraps the `global-hotkey`
//!     crate). The crate parses modifiers case-insensitively (it even understands
//!     `CommandOrControl`/`CmdOrCtrl`) but the **key** must be a W3C
//!     `KeyboardEvent.code` name (`Backquote`, `KeyA`, `Digit1`, `ArrowUp`, …),
//!     NOT the character Electron uses. Getting that key mapping wrong is the whole
//!     reason the wiring would silently no-op, so it is the primary tested surface.
//!
//!  2. [`HotkeyManager`] — the `register`/`unregister`/`update`/`current` state
//!     machine of `hotkey.ts:20-56`, generic over a [`ShortcutBackend`] so the
//!     manager logic (including the live re-register = unregister-then-register of
//!     `set-global-hotkey`, `entry.ts:620-633`) is tested with a fake backend. The
//!     real backend (the plugin) is wired in `lib.rs` behind the same trait.

use std::collections::BTreeMap;

/// Why an Electron accelerator could not be translated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcceleratorError {
    /// The accelerator was empty or had no non-modifier key token.
    NoKey,
    /// A key token had no known W3C `KeyboardEvent.code` mapping.
    UnknownKey(String),
    /// A token was empty (e.g. a trailing/double `+`).
    EmptyToken,
}

impl std::fmt::Display for AcceleratorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcceleratorError::NoKey => {
                write!(f, "accelerator has no key (only modifiers or empty)")
            }
            AcceleratorError::UnknownKey(k) => {
                write!(f, "accelerator key {k:?} has no W3C code mapping")
            }
            AcceleratorError::EmptyToken => write!(f, "accelerator has an empty token (stray '+')"),
        }
    }
}

impl std::error::Error for AcceleratorError {}

/// The canonical Tauri/`global-hotkey` spelling for an Electron modifier token
/// (case-insensitive match). `CommandOrControl`/`CmdOrCtrl` are preserved verbatim
/// because the `global-hotkey` parser resolves them per-OS itself (`SUPER` on
/// macOS, `CONTROL` elsewhere) — re-deciding that here would be a divergence.
fn modifier_token(token_upper: &str) -> Option<&'static str> {
    match token_upper {
        "COMMAND" | "CMD" => Some("Command"),
        "CONTROL" | "CTRL" => Some("Control"),
        "COMMANDORCONTROL" | "CMDORCTRL" | "COMMANDORCTRL" | "CMDORCONTROL" => {
            Some("CommandOrControl")
        }
        "ALT" | "OPTION" => Some("Alt"),
        "ALTGR" => Some("AltGr"),
        "SHIFT" => Some("Shift"),
        "SUPER" | "META" => Some("Super"),
        _ => None,
    }
}

/// Map an Electron **key** token to its W3C `KeyboardEvent.code` name (what the
/// `global-hotkey` crate's `Code::from_str` expects). Electron identifies keys by
/// character/name (`` ` ``, `A`, `1`, `Return`); the plugin needs the physical code
/// (`Backquote`, `KeyA`, `Digit1`, `Enter`). Returns `None` for an unknown key.
fn key_code(token: &str) -> Option<String> {
    // Single ASCII letter → KeyX (Electron accelerators are case-insensitive on
    // letters; the code is always the uppercase KeyA..KeyZ form).
    if token.len() == 1 {
        let c = token.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            return Some(format!("Key{}", c.to_ascii_uppercase()));
        }
        if c.is_ascii_digit() {
            return Some(format!("Digit{c}"));
        }
        if let Some(code) = punctuation_code(c) {
            return Some(code.to_string());
        }
    }

    // Function keys F1..F24 pass through unchanged (same spelling both sides).
    let upper = token.to_ascii_uppercase();
    if let Some(rest) = upper.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u8>() {
            if (1..=24).contains(&n) {
                return Some(format!("F{n}"));
            }
        }
    }

    // Named keys (Electron name → W3C code). Case-insensitive on the Electron side.
    let named: &str = match upper.as_str() {
        "SPACE" => "Space",
        "TAB" => "Tab",
        "ENTER" | "RETURN" => "Enter",
        "ESC" | "ESCAPE" => "Escape",
        "BACKSPACE" => "Backspace",
        "DELETE" | "DEL" => "Delete",
        "INSERT" => "Insert",
        "UP" => "ArrowUp",
        "DOWN" => "ArrowDown",
        "LEFT" => "ArrowLeft",
        "RIGHT" => "ArrowRight",
        "HOME" => "Home",
        "END" => "End",
        "PAGEUP" => "PageUp",
        "PAGEDOWN" => "PageDown",
        "CAPSLOCK" => "CapsLock",
        "NUMLOCK" => "NumLock",
        "SCROLLLOCK" => "ScrollLock",
        "PRINTSCREEN" => "PrintScreen",
        "PLUS" => "Equal", // Electron 'Plus' is Shift+= ; the physical code is Equal.
        _ => return spelled_punctuation(&upper),
    };
    Some(named.to_string())
}

/// Punctuation character → W3C code (US layout physical keys), mirroring the set
/// Electron accepts as literal accelerator keys.
fn punctuation_code(c: char) -> Option<&'static str> {
    Some(match c {
        '`' | '~' => "Backquote",
        '-' | '_' => "Minus",
        '=' => "Equal",
        '[' | '{' => "BracketLeft",
        ']' | '}' => "BracketRight",
        '\\' | '|' => "Backslash",
        ';' | ':' => "Semicolon",
        '\'' | '"' => "Quote",
        ',' | '<' => "Comma",
        '.' | '>' => "Period",
        '/' | '?' => "Slash",
        _ => return None,
    })
}

/// Multi-char punctuation names Electron allows (e.g. `Tilde` is not standard, but
/// be liberal about the common spelled forms).
fn spelled_punctuation(upper: &str) -> Option<String> {
    let code = match upper {
        "BACKQUOTE" | "TILDE" | "GRAVE" => "Backquote",
        "MINUS" | "DASH" | "HYPHEN" => "Minus",
        "EQUAL" | "EQUALS" => "Equal",
        "COMMA" => "Comma",
        "PERIOD" | "DOT" => "Period",
        "SLASH" => "Slash",
        "BACKSLASH" => "Backslash",
        "SEMICOLON" => "Semicolon",
        "QUOTE" | "APOSTROPHE" => "Quote",
        _ => return None,
    };
    Some(code.to_string())
}

/// Translate an Electron accelerator string into the grammar
/// `tauri-plugin-global-shortcut` accepts. Modifiers are canonicalized (preserving
/// `CommandOrControl`); the single non-modifier key is mapped to its W3C code.
/// Order: modifiers first (in Electron's given order), key last — the form the
/// plugin's `Shortcut::from_str` parses. Pure; unit-tested against the reference
/// default and the common shapes.
pub fn translate_accelerator(electron: &str) -> Result<String, AcceleratorError> {
    let mut parts: Vec<String> = Vec::new();
    let mut key: Option<String> = None;

    for raw in electron.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            return Err(AcceleratorError::EmptyToken);
        }
        if let Some(m) = modifier_token(&token.to_ascii_uppercase()) {
            parts.push(m.to_string());
            continue;
        }
        // Not a modifier → it must be the key. Electron allows exactly one key.
        let code =
            key_code(token).ok_or_else(|| AcceleratorError::UnknownKey(token.to_string()))?;
        key = Some(code);
    }

    let key = key.ok_or(AcceleratorError::NoKey)?;
    parts.push(key);
    Ok(parts.join("+"))
}

/// The outcome of a backend register/unregister — enough for the manager to keep
/// its `current` invariant and for callers/tests to assert behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterOutcome {
    Registered,
    Failed,
}

/// The side-effecting shortcut backend the [`HotkeyManager`] drives. The real impl
/// (in `lib.rs`) wraps `tauri-plugin-global-shortcut`; tests use a fake. `register`
/// receives the ALREADY-TRANSLATED (Tauri-grammar) accelerator.
pub trait ShortcutBackend {
    /// Register `translated`. Returns whether registration succeeded.
    fn register(&mut self, translated: &str) -> bool;
    /// Unregister a previously-registered `translated` accelerator.
    fn unregister(&mut self, translated: &str);
}

/// The `register`/`unregister`/`update`/`current` state machine of
/// `electron/hotkey.ts`, but translating Electron accelerators to Tauri grammar on
/// the way in. Holds the currently-registered **translated** accelerator so
/// `update` can unregister the old one first (`hotkey.ts:39-53`), matching the live
/// re-bind of `set-global-hotkey` (`entry.ts:620-633`).
pub struct HotkeyManager<B: ShortcutBackend> {
    backend: B,
    current: Option<String>,
}

impl<B: ShortcutBackend> HotkeyManager<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            current: None,
        }
    }

    /// Register `electron_accelerator` (translating it first). On success records
    /// it as current. Mirrors `hotkey.ts:register` (`:22-28`).
    pub fn register(
        &mut self,
        electron_accelerator: &str,
    ) -> Result<RegisterOutcome, AcceleratorError> {
        let translated = translate_accelerator(electron_accelerator)?;
        if self.backend.register(&translated) {
            self.current = Some(translated);
            Ok(RegisterOutcome::Registered)
        } else {
            Ok(RegisterOutcome::Failed)
        }
    }

    /// Unregister the current accelerator (if any). Mirrors `hotkey.ts:unregister`
    /// (`:31-36`) and the `entry.ts:667` stop-server unbind.
    pub fn unregister(&mut self) {
        if let Some(current) = self.current.take() {
            self.backend.unregister(&current);
        }
    }

    /// Change the accelerator: unregister the old, register the new. On failure the
    /// manager ends with NO current accelerator (matching `hotkey.ts:39-53`, which
    /// nulls `currentAccelerator` when the new registration fails).
    pub fn update(
        &mut self,
        electron_accelerator: &str,
    ) -> Result<RegisterOutcome, AcceleratorError> {
        let translated = translate_accelerator(electron_accelerator)?;
        if let Some(current) = self.current.take() {
            self.backend.unregister(&current);
        }
        if self.backend.register(&translated) {
            self.current = Some(translated);
            Ok(RegisterOutcome::Registered)
        } else {
            self.current = None;
            Ok(RegisterOutcome::Failed)
        }
    }

    /// The currently-registered **translated** accelerator (`hotkey.ts:current`).
    pub fn current(&self) -> Option<&str> {
        self.current.as_deref()
    }
}

/// The default global hotkey (`desktop-config.ts:16-27`, `types.ts:16`):
/// `CommandOrControl+\``. Exposed so the shell and tests share one source.
pub const DEFAULT_HOTKEY: &str = "CommandOrControl+`";

/// A small demonstration table (Electron → translated) for docs/tests: the shapes
/// the reference and the wizard's hotkey step can produce.
pub fn reference_translations() -> BTreeMap<&'static str, &'static str> {
    let mut m = BTreeMap::new();
    m.insert("CommandOrControl+`", "CommandOrControl+Backquote");
    m.insert("CmdOrCtrl+K", "CommandOrControl+KeyK");
    m.insert("Alt+Shift+D", "Alt+Shift+KeyD");
    m.insert("Super+Space", "Super+Space");
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_the_reference_default() {
        // The single most important case: the default `CommandOrControl+\``
        // (`types.ts:16`) → CommandOrControl + the Backquote physical code.
        assert_eq!(
            translate_accelerator(DEFAULT_HOTKEY).unwrap(),
            "CommandOrControl+Backquote"
        );
    }

    #[test]
    fn command_or_control_variants_canonicalize() {
        for input in ["CmdOrCtrl+K", "commandorcontrol+k", "CMDORCTRL+K"] {
            assert_eq!(
                translate_accelerator(input).unwrap(),
                "CommandOrControl+KeyK",
                "input: {input}"
            );
        }
    }

    #[test]
    fn maps_modifiers_to_tauri_spelling() {
        assert_eq!(translate_accelerator("Option+A").unwrap(), "Alt+KeyA");
        assert_eq!(translate_accelerator("Alt+A").unwrap(), "Alt+KeyA");
        assert_eq!(translate_accelerator("Meta+A").unwrap(), "Super+KeyA");
        assert_eq!(translate_accelerator("Super+A").unwrap(), "Super+KeyA");
        assert_eq!(translate_accelerator("Command+A").unwrap(), "Command+KeyA");
        assert_eq!(translate_accelerator("Control+A").unwrap(), "Control+KeyA");
    }

    #[test]
    fn preserves_modifier_order_and_stacks() {
        assert_eq!(
            translate_accelerator("Control+Alt+Shift+Delete").unwrap(),
            "Control+Alt+Shift+Delete"
        );
    }

    #[test]
    fn maps_letters_digits_and_function_keys() {
        assert_eq!(translate_accelerator("Control+z").unwrap(), "Control+KeyZ");
        assert_eq!(translate_accelerator("Control+Z").unwrap(), "Control+KeyZ");
        assert_eq!(
            translate_accelerator("Control+1").unwrap(),
            "Control+Digit1"
        );
        assert_eq!(translate_accelerator("Control+F5").unwrap(), "Control+F5");
        assert_eq!(translate_accelerator("Control+F12").unwrap(), "Control+F12");
    }

    #[test]
    fn maps_named_and_arrow_keys() {
        assert_eq!(translate_accelerator("Alt+Space").unwrap(), "Alt+Space");
        assert_eq!(translate_accelerator("Alt+Enter").unwrap(), "Alt+Enter");
        assert_eq!(translate_accelerator("Alt+Return").unwrap(), "Alt+Enter");
        assert_eq!(translate_accelerator("Alt+Esc").unwrap(), "Alt+Escape");
        assert_eq!(
            translate_accelerator("Control+Up").unwrap(),
            "Control+ArrowUp"
        );
        assert_eq!(
            translate_accelerator("Control+PageDown").unwrap(),
            "Control+PageDown"
        );
    }

    #[test]
    fn maps_punctuation_keys() {
        assert_eq!(translate_accelerator("Control+-").unwrap(), "Control+Minus");
        assert_eq!(translate_accelerator("Control+=").unwrap(), "Control+Equal");
        assert_eq!(translate_accelerator("Control+/").unwrap(), "Control+Slash");
        assert_eq!(
            translate_accelerator("Control+\\").unwrap(),
            "Control+Backslash"
        );
        assert_eq!(
            translate_accelerator("Control+.").unwrap(),
            "Control+Period"
        );
    }

    #[test]
    fn a_bare_key_needs_no_modifier() {
        assert_eq!(translate_accelerator("`").unwrap(), "Backquote");
        assert_eq!(translate_accelerator("F1").unwrap(), "F1");
    }

    #[test]
    fn rejects_modifier_only_and_empty() {
        assert_eq!(
            translate_accelerator("Control").err(),
            Some(AcceleratorError::NoKey)
        );
        assert_eq!(
            translate_accelerator("Control+Shift").err(),
            Some(AcceleratorError::NoKey)
        );
        assert_eq!(
            translate_accelerator("").err(),
            Some(AcceleratorError::EmptyToken)
        );
    }

    #[test]
    fn rejects_unknown_key_and_stray_plus() {
        assert!(matches!(
            translate_accelerator("Control+NoSuchKey").err(),
            Some(AcceleratorError::UnknownKey(_))
        ));
        assert_eq!(
            translate_accelerator("Control++A").err(),
            Some(AcceleratorError::EmptyToken)
        );
    }

    #[test]
    fn reference_table_all_translate() {
        for (electron, expected) in reference_translations() {
            assert_eq!(translate_accelerator(electron).unwrap(), expected);
        }
    }

    // ---- HotkeyManager (backend-fake) tests -----------------------------------

    /// A fake backend recording registrations, with a scriptable failure.
    struct FakeBackend {
        registered: Vec<String>,
        unregistered: Vec<String>,
        fail_next: bool,
    }
    impl FakeBackend {
        fn new() -> Self {
            Self {
                registered: Vec::new(),
                unregistered: Vec::new(),
                fail_next: false,
            }
        }
    }
    impl ShortcutBackend for FakeBackend {
        fn register(&mut self, translated: &str) -> bool {
            if self.fail_next {
                self.fail_next = false;
                return false;
            }
            self.registered.push(translated.to_string());
            true
        }
        fn unregister(&mut self, translated: &str) {
            self.unregistered.push(translated.to_string());
        }
    }

    #[test]
    fn manager_registers_translated_accelerator() {
        let mut mgr = HotkeyManager::new(FakeBackend::new());
        assert_eq!(
            mgr.register(DEFAULT_HOTKEY).unwrap(),
            RegisterOutcome::Registered
        );
        assert_eq!(mgr.current(), Some("CommandOrControl+Backquote"));
    }

    #[test]
    fn manager_update_unregisters_old_then_registers_new() {
        let mut mgr = HotkeyManager::new(FakeBackend::new());
        mgr.register("Control+K").unwrap();
        mgr.update("Alt+J").unwrap();
        assert_eq!(mgr.current(), Some("Alt+KeyJ"));
        // The old one was unregistered before the new registration.
        assert_eq!(mgr.backend.unregistered, vec!["Control+KeyK"]);
        assert_eq!(mgr.backend.registered, vec!["Control+KeyK", "Alt+KeyJ"]);
    }

    #[test]
    fn manager_update_failure_clears_current() {
        // Mirrors hotkey.ts:39-53 — a failed new registration leaves NO current.
        let mut mgr = HotkeyManager::new(FakeBackend::new());
        mgr.register("Control+K").unwrap();
        mgr.backend.fail_next = true;
        assert_eq!(mgr.update("Alt+J").unwrap(), RegisterOutcome::Failed);
        assert_eq!(mgr.current(), None);
    }

    #[test]
    fn manager_unregister_clears_current_and_is_idempotent() {
        let mut mgr = HotkeyManager::new(FakeBackend::new());
        mgr.register("Control+K").unwrap();
        mgr.unregister();
        assert_eq!(mgr.current(), None);
        // A second unregister is a no-op (no extra backend call).
        mgr.unregister();
        assert_eq!(mgr.backend.unregistered, vec!["Control+KeyK"]);
    }
}
