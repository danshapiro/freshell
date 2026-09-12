# Controlled Rust workspace test receipt

- Date: 2026-09-01
- Commit under test: `707cfc34c`
- Command: `RUST_TEST_THREADS=1 npm run test:rust`
- Result: exit 0
- Build phase: `cargo build -p freshell-server --locked` — passed
- Test phase: `cargo test --workspace --locked` — passed
- Reported Rust results: 3,636 passed, 0 failed, 8 ignored across 119 result summaries
- Raw receipt: `/tmp/freshell-rust-tests-controlled-20260901-rebase.log`
- The host DBus/GLib/GTK/WebKit/JavaScriptCore/libsoup development dependencies were installed before this run. No live port 3001 was contacted or restarted.
