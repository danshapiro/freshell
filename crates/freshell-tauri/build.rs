//! Tauri v2 build script. `tauri_build::build()` reads `tauri.conf.json` +
//! `capabilities/**` at compile time and emits the generated context consumed by
//! `tauri::generate_context!()` in `main.rs`. Additive; touches no reference source.
fn main() {
    tauri_build::build();
}
