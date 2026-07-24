//! Binary entry point for the `freshell-tauri` desktop shell. The shell logic lives
//! in the crate library (`freshell_tauri::run`) so it is unit- and
//! integration-testable headlessly; this file is the thin, GUI-only launcher
//! (Tauri v2's recommended lib+bin split).

// Suppress the extra console window on Windows release builds.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

fn main() {
    freshell_tauri::run();
}
