# Session-Actions Parity Fixes Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Bring the Rust Freshell server to parity with the frozen legacy server for four session-action defects: session **rename**, session **archive**, **generate-title**, and Claude session **title** parity — all backed by a persistent `sessionOverrides` config map that the session-directory read model overlays.

**Architecture:** Add a persistent `sessionOverrides` map to `SettingsStore` (mirroring the existing `terminalOverrides`), have `session_directory.rs` overlay those overrides onto each read item, and add a new `sessions` router exposing `PATCH /api/sessions/:id` and `POST /api/sessions/:id/generate-title`. The title-source ladder (`canUpgradeTitle`) governs title writes; all other override fields merge unconditionally.

**Tech Stack:** Rust (axum, serde_json, tokio), workspace crates `freshell-server` and `freshell-sessions`. Tests via `cargo test -p <crate>`; quality via `cargo fmt` + `cargo clippy`.

**Worktree:** `/home/dan/code/freshell/.worktrees/rust-tauri-port` on branch `feat/rust-tauri-port`.

---

## Global Constraints (apply to EVERY task)

These are non-negotiable invariants. Every handler and every test must respect them.

1. **FROZEN reference.** Do **not** modify `server/`, `shared/`, or `src/`. They are the legacy spec. All changes live in `crates/`.
2. **camelCase wire JSON.** Every field that crosses the HTTP boundary is camelCase (`titleOverride`, `titleSource`, `summaryOverride`, `createdAtOverride`, `cascadedTerminalId`, `sessionOverrides`). Use `#[serde(rename_all = "camelCase")]` or explicit `json!` keys.
3. **Auth gate on every route.** Every handler calls `is_authed(&headers, &state.auth_token)` first and returns `unauthorized()` on failure (imported from `crate::boot`). See the existing pattern in `session_directory.rs:271-273`.
4. **Do NOT set Content-Type manually.** The global `ensure_json_charset` layer (`main.rs:309`) normalizes every `application/json` response to `application/json; charset=utf-8`. Return `axum::Json`/`(StatusCode, Json(..))` and let the layer add the charset.
5. **PATCH semantics = legacy `SessionPatchSchema` + `cleanString`.** `cleanString(x)` trims; an empty or whitespace-only or null value **clears** the field (maps to `None`/removal). A present non-empty string sets it.
6. **Title-source ladder applies ONLY to the `titleOverride`/`titleSource` pair.** Port `canUpgradeTitle` from `shared/title-source.ts:50-57` (ranks: `user 5 > ai 4 > first-message 3 > legacy 2 > dir 1`, absence `0`; `user` always wins; a finalized source — anything other than `dir` — is never auto-overwritten; otherwise strictly-higher rank upgrades). When a title write is ladder-blocked, keep the existing title+source but STILL apply every other field in the patch. All non-title fields (`archived`, `deleted`, `summaryOverride`, `createdAtOverride`) merge unconditionally. Reference: legacy `config-store.ts:492-514`.
7. **No-op writes skip disk.** If the merged override equals the existing override (e.g. a ladder-rejected title-only patch), return the existing value WITHOUT persisting. Reference: `config-store.ts:507-509`.
8. **`generate-title` never returns 5xx.** Any internal failure resolves to `200 {"title": null, "source": "none"}`. A blank `firstMessage` is the ONLY 400 it emits (`{"error": "firstMessage is required"}`).
9. **`session_directory` GET shape is oracle-checked.** The `archived` field must remain **always-present** on every item (currently hardcoded `false` at `session_directory.rs:103`). Do not make it conditional/optional. All other existing field-presence rules in `to_value` stay exactly as they are.
10. **PATCH response = merged override + `cascadedTerminalId: null`.** The terminal-cascade rename (legacy `sessions-router.ts:141-164`) is out of scope for this port; emit `cascadedTerminalId: null` as a stable, always-present field so the wire shape matches.

---

## Task Order & Dependencies

```
Task 1 (SettingsStore session_overrides)  ──┬──> Task 2 (directory overlay)
                                            └──> Task 3 (sessions router)
Task 4 (Claude ai-title parity)  ── independent ── ⚠ see discrepancy callout
Task 5 (integration + redeploy verification) ── LAST, after 1–4
```

- Task 1 is the foundation; Tasks 2 and 3 both depend on it.
- Tasks 2 and 3 are independent of each other and may be done in either order after Task 1.
- Task 4 touches a different crate (`freshell-sessions`) and is independent — **but read its discrepancy callout before implementing.**
- Task 5 runs only after 1–4 are green.

---

## Task 1: `SettingsStore` `session_overrides` foundation

**Files:**
- Modify: `crates/freshell-server/src/settings_store.rs`
  - struct field alongside `terminal_overrides` (`:56-60`)
  - loader alongside `load_terminal_overrides` (`:297-312`)
  - persist doc (`:226-234`) — **fix the hardcoded `"sessionOverrides": {}` at `:229`**
  - new `patch_session_override` mirroring `patch_terminal_override` (`:259-291`) plus the ladder
- Test: same file, `#[cfg(test)] mod tests` (append new `#[tokio::test]` / `#[test]` cases)

### Step 1: Write the failing test — persistence roundtrip + corruption trap

Append to the `tests` module in `settings_store.rs`. This test proves (a) a session override survives a persist+reload, and (b) the corruption trap is fixed — persisting via the *settings* path no longer wipes session overrides, and persisting via a *terminal-override* path no longer wipes them either.

```rust
#[tokio::test]
async fn session_overrides_persist_and_survive_settings_and_terminal_writes() {
    let dir = std::env::temp_dir().join(format!("frs-sessov-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let store = store_at(&dir);

    // Write a session override.
    let next = store
        .patch_session_override(
            "claude:abc",
            &[
                ("titleOverride", Some(json!("Renamed"))),
                ("titleSource", Some(json!("user"))),
            ],
        )
        .await;
    assert_eq!(next["titleOverride"], json!("Renamed"));
    assert_eq!(next["titleSource"], json!("user"));

    // A SETTINGS patch must NOT wipe sessionOverrides (the :229 corruption trap).
    store.patch(&json!({ "safety": { "autoKillIdleMinutes": 25 } })).await.unwrap();
    // A TERMINAL-override patch must NOT wipe sessionOverrides either.
    store.patch_terminal_override("term-1", &[("deleted", Some(json!(true)))]).await;

    // Reload from disk (a "restart") and confirm the session override survived.
    let cfg: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(cfg["sessionOverrides"]["claude:abc"]["titleOverride"], json!("Renamed"));
    assert_eq!(cfg["sessionOverrides"]["claude:abc"]["titleSource"], json!("user"));
    assert_eq!(cfg["sessionOverrides"]["terminalOverrides"], Value::Null); // not clobbered by shape

    let restored = store_at(&dir);
    let snap = restored.session_overrides();
    assert_eq!(snap["claude:abc"]["titleOverride"], json!("Renamed"));
    std::fs::remove_dir_all(&dir).ok();
}
```

### Step 2: Run test to verify it fails

Run: `cargo test -p freshell-server session_overrides_persist_and_survive -- --nocapture`
Expected: FAIL — `patch_session_override` and `session_overrides` methods do not exist (compile error).

### Step 3: Write the failing ladder + clear-on-empty + no-op test

Append a second test covering the ladder cases, clear-on-empty, and no-op skip.

```rust
#[tokio::test]
async fn session_override_title_ladder_and_clear_and_noop() {
    let dir = std::env::temp_dir().join(format!("frs-sessov-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let store = store_at(&dir);

    // Seed a first-message title.
    store.patch_session_override("claude:x", &[
        ("titleOverride", Some(json!("From message"))),
        ("titleSource", Some(json!("first-message"))),
    ]).await;

    // ai (rank 4) beats first-message (rank 3): upgrade lands.
    let after_ai = store.patch_session_override("claude:x", &[
        ("titleOverride", Some(json!("AI name"))),
        ("titleSource", Some(json!("ai"))),
    ]).await;
    assert_eq!(after_ai["titleOverride"], json!("AI name"));
    assert_eq!(after_ai["titleSource"], json!("ai"));

    // first-message (3) does NOT downgrade a finalized ai (4): title unchanged...
    let blocked = store.patch_session_override("claude:x", &[
        ("titleOverride", Some(json!("late msg"))),
        ("titleSource", Some(json!("first-message"))),
        ("archived", Some(json!(true))), // ...but a non-title field STILL applies.
    ]).await;
    assert_eq!(blocked["titleOverride"], json!("AI name"));
    assert_eq!(blocked["titleSource"], json!("ai"));
    assert_eq!(blocked["archived"], json!(true));

    // user (5) beats ai (4).
    let user = store.patch_session_override("claude:x", &[
        ("titleOverride", Some(json!("User rename"))),
        ("titleSource", Some(json!("user"))),
    ]).await;
    assert_eq!(user["titleOverride"], json!("User rename"));
    assert_eq!(user["titleSource"], json!("user"));

    // Clear-on-empty: None removes the key from the merged override.
    let cleared = store.patch_session_override("claude:x", &[
        ("summaryOverride", None),
    ]).await;
    assert!(cleared.get("summaryOverride").is_none());

    // No-op skip: a ladder-blocked title-only patch that resolves to the
    // existing value returns without changing anything.
    let before_mtime = std::fs::metadata(dir.join(".freshell").join("config.json")).unwrap().modified().unwrap();
    let noop = store.patch_session_override("claude:x", &[
        ("titleOverride", Some(json!("ignored"))),
        ("titleSource", Some(json!("first-message"))), // < user, blocked
    ]).await;
    assert_eq!(noop["titleOverride"], json!("User rename")); // unchanged
    let after_mtime = std::fs::metadata(dir.join(".freshell").join("config.json")).unwrap().modified().unwrap();
    assert_eq!(before_mtime, after_mtime, "no-op patch must not rewrite config.json");

    std::fs::remove_dir_all(&dir).ok();
}
```

### Step 4: Run test to verify it fails

Run: `cargo test -p freshell-server session_override_title_ladder -- --nocapture`
Expected: FAIL — method not defined (compile error).

### Step 5: Implement the struct field + loader

In `settings_store.rs`, add a field beside `terminal_overrides` (`:60`):

```rust
    /// `config.sessionOverrides` (`server/config-store.ts:492-514`): per-session
    /// user overrides (`titleOverride`/`titleSource`/`summaryOverride`/`archived`/
    /// `deleted`/`createdAtOverride`) the `/api/sessions` router patches and the
    /// session-directory read model overlays. std `Mutex` so the sync `persist`
    /// path can snapshot it (same as `terminal_overrides`).
    session_overrides: Arc<std::sync::Mutex<serde_json::Map<String, Value>>>,
```

In `load()` (beside `let terminal_overrides = load_terminal_overrides(home);` at `:151`):

```rust
        let session_overrides = load_session_overrides(home);
```

and add it to the `Self { .. }` initializer (`:152-158`):

```rust
            session_overrides: Arc::new(std::sync::Mutex::new(session_overrides)),
```

Add the loader beside `load_terminal_overrides` (`:297`):

```rust
/// Load `config.sessionOverrides` from `<home>/.freshell/config.json` (tolerant:
/// any read/parse error or non-object degrades to empty, matching
/// `config-store.ts#readConfigFile`).
fn load_session_overrides(home: Option<&Path>) -> serde_json::Map<String, Value> {
    let Some(home) = home else {
        return serde_json::Map::new();
    };
    let config_path = home.join(".freshell").join("config.json");
    let Ok(text) = std::fs::read_to_string(&config_path) else {
        return serde_json::Map::new();
    };
    let Ok(doc) = serde_json::from_str::<Value>(&text) else {
        return serde_json::Map::new();
    };
    doc.get("sessionOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}
```

### Step 6: Fix the corruption trap in `persist`

In `persist` (`:226-234`), replace the hardcoded line `:229`:

```rust
        // BEFORE: "sessionOverrides": {},
        "sessionOverrides": Value::Object(self.session_overrides.lock().expect("session overrides lock").clone()),
```

(Leave `terminalOverrides` as-is; it already serializes the real map at `:230`.)

### Step 7: Implement `session_overrides()` snapshot + `patch_session_override`

Add beside `terminal_overrides()` / `patch_terminal_override` (`:245-291`):

```rust
    /// A snapshot of `config.sessionOverrides` (the session-directory read model
    /// overlays it; the `/api/sessions` router patches it).
    pub fn session_overrides(&self) -> serde_json::Map<String, Value> {
        self.session_overrides.lock().expect("session overrides lock").clone()
    }

    /// `configStore.patchSessionOverride(key, patch)` (`config-store.ts:492-514`):
    /// JS-spread merge `next = {...existing, ...patch}` (`Some(v)` sets, `None`
    /// clears a key), THEN the title-source ladder: a `(titleOverride, titleSource)`
    /// write only lands if `canUpgradeTitle(existing.titleSource, incoming)` — else
    /// the existing title+source are restored while every OTHER patched field still
    /// applies. A resolved-no-op (`next == existing`) skips the disk write.
    /// Returns the merged override (the PATCH response body).
    pub async fn patch_session_override(
        &self,
        key: &str,
        patch: &[(&str, Option<Value>)],
    ) -> Value {
        let (next, changed) = {
            let mut all = self.session_overrides.lock().expect("session overrides lock");
            let existing = all.get(key).and_then(Value::as_object).cloned().unwrap_or_default();
            let mut next = existing.clone();
            for (k, v) in patch {
                match v {
                    Some(v) => { next.insert((*k).to_string(), v.clone()); }
                    None => { next.remove(*k); }
                }
            }
            // Title-source ladder — only when BOTH title keys are present in the patch.
            let patches_title = patch.iter().any(|(k, _)| *k == "titleOverride")
                && patch.iter().any(|(k, _)| *k == "titleSource");
            if patches_title {
                let incoming = next.get("titleSource").and_then(Value::as_str);
                let existing_src = existing.get("titleSource").and_then(Value::as_str);
                if let Some(incoming) = incoming {
                    if !can_upgrade_title(existing_src, incoming) {
                        match existing.get("titleOverride") {
                            Some(v) => { next.insert("titleOverride".into(), v.clone()); }
                            None => { next.remove("titleOverride"); }
                        }
                        match existing.get("titleSource") {
                            Some(v) => { next.insert("titleSource".into(), v.clone()); }
                            None => { next.remove("titleSource"); }
                        }
                    }
                }
            }
            let changed = next != existing;
            if changed {
                all.insert(key.to_string(), Value::Object(next.clone()));
            }
            (Value::Object(next), changed)
        };
        if changed {
            let settings = self.get().await;
            self.persist(&settings);
        }
        next
    }
```

Add the ladder helper (private fn in the module, ported from `shared/title-source.ts:20-57`):

```rust
/// `canUpgradeTitle` (`shared/title-source.ts:50-57`): user always wins; a
/// finalized source (anything != "dir") is never auto-overwritten; otherwise a
/// strictly-higher rank upgrades. Absence ranks 0.
fn can_upgrade_title(existing: Option<&str>, incoming: &str) -> bool {
    fn rank(s: Option<&str>) -> i32 {
        match s {
            Some("user") => 5,
            Some("ai") => 4,
            Some("first-message") => 3,
            Some("legacy") => 2,
            Some("dir") => 1,
            _ => 0,
        }
    }
    if incoming == "user" {
        return true;
    }
    let finalized = matches!(existing, Some(s) if s != "dir");
    if finalized {
        return false;
    }
    rank(Some(incoming)) > rank(existing)
}
```

### Step 8: Run tests to verify they pass

Run: `cargo test -p freshell-server session_override -- --nocapture`
Expected: PASS (both new tests). Also run the existing `patch_write_through_reaches_get_and_config_json_and_restart` test — note its assertion `assert_eq!(cfg["sessionOverrides"], json!({}))` at `:816` still holds when no session override was written, because an empty map serializes to `{}`.

Run: `cargo test -p freshell-server settings_store`
Expected: PASS (all existing settings_store tests still green).

### Step 9: Format, lint, commit

```
cargo fmt -p freshell-server
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/settings_store.rs
git commit -m "feat(rust): persistent sessionOverrides in SettingsStore with title-source ladder"
```

---

## Task 2: `session_directory` override overlay

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
  - `SessionDirectoryState` (`:57-63`) — add access to the settings store
  - `to_value` `archived` hardcode (`:103`)
  - `apply_query` / item construction to overlay overrides
- Modify: `crates/freshell-server/src/main.rs` (`:230-233`) — pass the settings store into `SessionDirectoryState`
- Test: same `session_directory.rs` tests module

### Step 1: Write the failing test — overlay applied, archived surfaces, deleted filtered, shape unchanged

Append to the `tests` module in `session_directory.rs`. The overlay is a pure step over `Vec<DirItem>` keyed by `provider:sessionId` — test it directly against an overrides map.

```rust
#[test]
fn overrides_overlay_applies_title_summary_archived_and_filters_deleted() {
    // Two synthetic titled items.
    let mk = |sid: &str| DirItem {
        session_id: sid.into(), provider: "claude".into(), project_path: "/p".into(),
        title: Some("parsed".into()), summary: Some("parsed-sum".into()),
        first_user_message: None, last_activity_at: 100, created_at: None, cwd: Some("/p".into()),
        is_subagent: false, is_non_interactive: false, is_running: false,
        matched_in: None, snippet: None,
    };
    let items = vec![mk("keep"), mk("gone")];

    let mut overrides = serde_json::Map::new();
    overrides.insert("claude:keep".into(), json!({
        "titleOverride": "Renamed", "summaryOverride": "New sum", "archived": true
    }));
    overrides.insert("claude:gone".into(), json!({ "deleted": true }));

    let overlaid = apply_session_overrides(items, &overrides);
    assert_eq!(overlaid.len(), 1, "deleted item filtered out");
    let v = overlaid[0].to_value();
    assert_eq!(v["sessionId"], json!("keep"));
    assert_eq!(v["title"], json!("Renamed"));
    assert_eq!(v["summary"], json!("New sum"));
    assert_eq!(v["archived"], json!(true));
}

#[test]
fn overlay_shape_unchanged_when_no_overrides_archived_always_present() {
    let item = DirItem {
        session_id: "x".into(), provider: "claude".into(), project_path: "/p".into(),
        title: Some("t".into()), summary: None, first_user_message: None,
        last_activity_at: 1, created_at: None, cwd: None, is_subagent: false,
        is_non_interactive: false, is_running: false, matched_in: None, snippet: None,
    };
    let overlaid = apply_session_overrides(vec![item], &serde_json::Map::new());
    let v = overlaid[0].to_value();
    // Oracle-compat: archived is ALWAYS present, defaulted false.
    assert_eq!(v["archived"], json!(false));
    assert_eq!(v["title"], json!("t"));
}
```

### Step 2: Run test to verify it fails

Run: `cargo test -p freshell-server overrides_overlay_applies -- --nocapture`
Expected: FAIL — `apply_session_overrides` not defined.

### Step 3: Implement the overlay function

Add to `session_directory.rs` (near `apply_query`). It overlays by session key, defaulting `archived` from the override:

```rust
/// Overlay `config.sessionOverrides` onto parsed items (`service.ts` metadata-store
/// flavor merge): `title`/`summary` prefer the override; `archived` reflects the
/// override (default false); a `deleted: true` override removes the item. Keyed by
/// `provider:sessionId` (`buildSessionKey`, `service.ts:36-38`).
fn apply_session_overrides(
    items: Vec<DirItem>,
    overrides: &serde_json::Map<String, Value>,
) -> Vec<DirItem> {
    items
        .into_iter()
        .filter_map(|mut item| {
            let ov = overrides.get(&item.key()).and_then(Value::as_object);
            if let Some(ov) = ov {
                if ov.get("deleted").and_then(Value::as_bool).unwrap_or(false) {
                    return None;
                }
                if let Some(t) = ov.get("titleOverride").and_then(Value::as_str) {
                    item.title = Some(t.to_string());
                }
                if let Some(s) = ov.get("summaryOverride").and_then(Value::as_str) {
                    item.summary = Some(s.to_string());
                }
                item.archived = ov.get("archived").and_then(Value::as_bool).unwrap_or(false);
            }
            Some(item)
        })
        .collect()
}
```

Add an `archived: bool` field to `DirItem` (`:68-84`) — default `false` in `item_from_meta` (`:406-427`) and in every test constructor. Change `to_value` (`:101-103`) from the hardcoded:

```rust
        // BEFORE: o.insert("archived".into(), json!(false));
        o.insert("archived".into(), json!(self.archived));
```

> **Note:** the two existing synthetic test constructors (`cursor_paging_splits_and_round_trips` at `:759` and any others) must add `archived: false` — the compiler will flag each. That is expected TDD churn, not new behavior.

### Step 4: Wire the overlay into the request path

- Add a field to `SessionDirectoryState` (`:57-63`):
  ```rust
      pub settings: crate::settings_store::SettingsStore,
  ```
- In `main.rs` (`:230-233`), add `settings: settings_store.clone(),` to the `SessionDirectoryState { .. }` initializer. (`settings_store` is in scope — it is cloned into `TerminalsState` at `:253`.)
- In the `session_directory` handler (`:286-289`), after building `items` and BEFORE `apply_query`, overlay:
  ```rust
      let items = apply_session_overrides(items, &state.settings.session_overrides());
  ```

### Step 5: Run tests to verify they pass

Run: `cargo test -p freshell-server session_directory -- --nocapture`
Expected: PASS (new overlay tests + all existing session_directory tests, including `default_query_hides_non_interactive_fixtures` and the R10b pins).

### Step 6: Format, lint, commit

```
cargo fmt -p freshell-server
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/session_directory.rs crates/freshell-server/src/main.rs
git commit -m "feat(rust): overlay sessionOverrides onto session-directory read model"
```

---

## Task 3: New `sessions` router (`PATCH` + `generate-title`)

**Files:**
- Create: `crates/freshell-server/src/sessions.rs`
- Modify: `crates/freshell-server/src/main.rs` — declare `mod sessions;` and `.merge(sessions::router(..))` in the router chain (`:277-295`)
- Test: `#[cfg(test)] mod tests` inside `sessions.rs` (axum handler tests via `tower::ServiceExt::oneshot`)

Reference: legacy `server/sessions-router.ts:122-210` (`PATCH /sessions/:sessionId`, `POST /sessions/:sessionId/generate-title`). Composite-key resolution: `rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)` with `provider` from `?provider=` query, defaulting `claude` (`sessions-router.ts:124-125,169-170`).

### Step 1: Write the failing test — PATCH rename happy path + auth + url-encoded key

Create `crates/freshell-server/src/sessions.rs` with ONLY the test module first (so it compiles to a failing state via missing `router`). Use the same `oneshot` pattern the other routers' tests use. Tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn state(dir: &std::path::Path) -> SessionsState {
        SessionsState {
            auth_token: std::sync::Arc::new("tok".into()),
            settings: crate::settings_store::SettingsStore::load(Some(dir), vec!["claude".into()]),
        }
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn patch_rename_persists_and_returns_merged_plus_cascade_null() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc123?provider=claude")
                    .header("authorization", "Bearer tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"titleOverride":"My Title"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["titleOverride"], serde_json::json!("My Title"));
        assert_eq!(v["titleSource"], serde_json::json!("user"));
        assert_eq!(v["cascadedTerminalId"], serde_json::Value::Null);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn patch_requires_auth() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder().method("PATCH").uri("/api/sessions/abc")
                    .header("content-type", "application/json")
                    .body(Body::from("{}")).unwrap(),
            ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn patch_url_encoded_composite_key_is_decoded() {
        // A raw id already containing ':' (url-encoded %3A) is used verbatim.
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = router(state(&dir));
        let resp = app.oneshot(
            Request::builder().method("PATCH")
                .uri("/api/sessions/codex%3Axyz")
                .header("authorization", "Bearer tok")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"archived":true}"#)).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap()).unwrap();
        assert_eq!(cfg["sessionOverrides"]["codex:xyz"]["archived"], serde_json::json!(true));
        std::fs::remove_dir_all(&dir).ok();
    }

    fn uuid_like() -> String {
        format!("{}-{:?}", std::process::id(), std::time::SystemTime::now())
            .replace([':', '.', ' '], "-")
    }
}
```

### Step 2: Run test to verify it fails

Run: `cargo test -p freshell-server sessions:: -- --nocapture` (after adding `mod sessions;` to `main.rs`)
Expected: FAIL — `router`, `SessionsState` not defined (compile error).

### Step 3: Implement `SessionsState`, `router`, and the `PATCH` handler

Write the module body above the test block:

```rust
//! `/api/sessions/:sessionId` — session rename/archive/delete overrides and
//! AI/first-message title generation. Faithful port of the write half of
//! `server/sessions-router.ts` (`PATCH` :122-165, `POST generate-title` :167-210),
//! backed by `SettingsStore::patch_session_override`. The terminal-cascade rename
//! (`cascadeSessionRenameToTerminal`) is out of scope; `cascadedTerminalId` is
//! always emitted as `null` so the wire shape matches.

use std::sync::Arc;

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{patch, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::boot::{is_authed, unauthorized};
use crate::settings_store::SettingsStore;

#[derive(Clone)]
pub struct SessionsState {
    pub auth_token: Arc<String>,
    pub settings: SettingsStore,
}

pub fn router(state: SessionsState) -> Router {
    Router::new()
        .route("/api/sessions/{session_id}", patch(patch_session))
        .route("/api/sessions/{session_id}/generate-title", post(generate_title))
        .with_state(state)
}

/// `rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)` — the axum
/// path extractor already percent-decodes, so `codex%3Axyz` arrives as `codex:xyz`.
fn composite_key(raw: &str, provider: &str) -> String {
    if raw.contains(':') {
        raw.to_string()
    } else {
        format!("{provider}:{raw}")
    }
}

fn provider_of(q: &std::collections::HashMap<String, String>) -> String {
    q.get("provider").filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| "claude".into())
}

/// `cleanString` (`server/utils.ts`): trim; empty/whitespace/absent/null → clear.
fn clean_string(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}
```

`PATCH` handler (validate body, build the patch tuple list, persist, respond):

```rust
async fn patch_session(
    State(state): State<SessionsState>,
    AxumPath(raw_id): AxumPath<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // SessionPatchSchema shape validation (sessions-router.ts:31-63):
    // titleOverride/summaryOverride: string|null; archived/deleted: bool;
    // createdAtOverride: number. Any wrong type → 400 {error:"Invalid request",details:[...]}.
    if let Some(details) = validate_session_patch(&body) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid request", "details": details }))).into_response();
    }
    let key = composite_key(&raw_id, &provider_of(&q));

    let title = clean_string(body.get("titleOverride"));
    let mut patch: Vec<(&str, Option<Value>)> = Vec::new();
    if body.get("titleOverride").is_some() {
        patch.push(("titleOverride", title.clone().map(Value::from)));
        // titleSource:'user' only when a non-empty title is present (sessions-router.ts:132-133).
        if title.is_some() {
            patch.push(("titleSource", Some(json!("user"))));
        }
    }
    if body.get("summaryOverride").is_some() {
        patch.push(("summaryOverride", clean_string(body.get("summaryOverride")).map(Value::from)));
    }
    if let Some(a) = body.get("archived") {
        patch.push(("archived", Some(a.clone())));
    }
    if let Some(d) = body.get("deleted") {
        patch.push(("deleted", Some(d.clone())));
    }
    if let Some(c) = body.get("createdAtOverride") {
        patch.push(("createdAtOverride", Some(c.clone())));
    }

    let merged = state.settings.patch_session_override(&key, &patch).await;
    let mut out = merged.as_object().cloned().unwrap_or_default();
    out.insert("cascadedTerminalId".into(), Value::Null);
    Json(Value::Object(out)).into_response()
}
```

`validate_session_patch` (faithful subset of `SessionPatchSchema`) — returns zod-shaped `details` on type violation, `None` when valid:

```rust
fn validate_session_patch(body: &Value) -> Option<Value> {
    let Value::Object(map) = body else {
        return Some(json!([{ "code": "invalid_type", "expected": "object", "path": [], "message": "Invalid input: expected object" }]));
    };
    let mut issues: Vec<Value> = Vec::new();
    let str_or_null = |k: &str, issues: &mut Vec<Value>| {
        if let Some(v) = map.get(k) {
            if !v.is_string() && !v.is_null() {
                issues.push(json!({ "code": "invalid_type", "expected": "string", "path": [k], "message": "Invalid input: expected string" }));
            }
        }
    };
    let bool_field = |k: &str, issues: &mut Vec<Value>| {
        if let Some(v) = map.get(k) {
            if !v.is_boolean() {
                issues.push(json!({ "code": "invalid_type", "expected": "boolean", "path": [k], "message": "Invalid input: expected boolean" }));
            }
        }
    };
    str_or_null("titleOverride", &mut issues);
    str_or_null("summaryOverride", &mut issues);
    bool_field("archived", &mut issues);
    bool_field("deleted", &mut issues);
    if let Some(v) = map.get("createdAtOverride") {
        if !v.is_number() {
            issues.push(json!({ "code": "invalid_type", "expected": "number", "path": ["createdAtOverride"], "message": "Invalid input: expected number" }));
        }
    }
    if issues.is_empty() { None } else { Some(Value::Array(issues)) }
}
```

> **Note on details shape:** the legacy body validator emits zod v4 `issues`. The parity sweep in Task 5 curl-checks status codes and the happy-path shapes; the byte-exact `details` array for session-patch type errors was NOT captured in the investigation reports. Emit the shapes above (consistent with the session-directory validator style) and mark the exact `details` wording as an oracle-follow-up if the Task 5 sweep flags a mismatch. Do NOT invent a "byte-matched" claim in a comment.

### Step 4: Run PATCH tests to verify they pass

Run: `cargo test -p freshell-server sessions::tests::patch -- --nocapture`
Expected: PASS (rename, auth, url-encoded key).

### Step 5: Write the failing test — generate-title cases

Append to the `sessions.rs` test module:

```rust
#[tokio::test]
async fn generate_title_blank_first_message_is_400() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = router(state(&dir));
    let resp = app.oneshot(
        Request::builder().method("POST").uri("/api/sessions/abc/generate-title")
            .header("authorization", "Bearer tok").header("content-type", "application/json")
            .body(Body::from(r#"{"firstMessage":"   "}"#)).unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let v = body_json(resp).await;
    assert_eq!(v["error"], serde_json::json!("firstMessage is required"));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn generate_title_no_key_uses_first_message_heuristic() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let app = router(state(&dir));
    let resp = app.oneshot(
        Request::builder().method("POST").uri("/api/sessions/abc/generate-title")
            .header("authorization", "Bearer tok").header("content-type", "application/json")
            .body(Body::from(r#"{"firstMessage":"Fix the login bug\nmore detail"}"#)).unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["title"], serde_json::json!("Fix the login bug")); // first non-empty line
    assert_eq!(v["source"], serde_json::json!("first-message"));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn generate_title_after_user_rename_is_ladder_blocked() {
    let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
    std::fs::create_dir_all(dir.join(".freshell")).unwrap();
    let st = state(&dir);
    // Pre-seed a user rename (rank 5).
    st.settings.patch_session_override("claude:abc", &[
        ("titleOverride", Some(serde_json::json!("User Named"))),
        ("titleSource", Some(serde_json::json!("user"))),
    ]).await;
    let app = router(st);
    let resp = app.oneshot(
        Request::builder().method("POST").uri("/api/sessions/abc/generate-title")
            .header("authorization", "Bearer tok").header("content-type", "application/json")
            .body(Body::from(r#"{"firstMessage":"Some prompt"}"#)).unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    // first-message (3) cannot upgrade user (5): store keeps the user title; the
    // response reflects the STORED (merged) value, faithfully (sessions-router.ts:185-190).
    assert_eq!(v["title"], serde_json::json!("User Named"));
    assert_eq!(v["source"], serde_json::json!("user"));
    std::fs::remove_dir_all(&dir).ok();
}
```

### Step 6: Run test to verify it fails

Run: `cargo test -p freshell-server sessions::tests::generate_title -- --nocapture`
Expected: FAIL — `generate_title` handler not defined / returns wrong shape.

### Step 7: Implement `generate_title` + `extract_title_from_message`

Port `extractTitleFromMessage` from `shared/title-utils.ts:9-30` (maxLen 50; multi-line → first non-empty line; single-line → collapse whitespace; truncate to 50). Then the handler: blank → 400; empty heuristic result → `200 {title:null,source:'none'}`; else persist `titleSource:'first-message'` (ladder-gated) and return the STORED merged value; never 5xx. No Gemini path (no key in the QA env → heuristic, matching legacy no-key behavior at `sessions-router.ts:180-190`).

```rust
/// `extractTitleFromMessage` (`shared/title-utils.ts:9-30`).
fn extract_title_from_message(content: &str, max_len: usize) -> String {
    let collapse = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = if content.contains('\n') {
        match content.lines().find(|l| !l.trim().is_empty()) {
            Some(first) => collapse(first.trim()),
            None => return String::new(),
        }
    } else {
        collapse(content.trim())
    };
    cleaned.chars().take(max_len).collect()
}

async fn generate_title(
    State(state): State<SessionsState>,
    AxumPath(raw_id): AxumPath<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let first_message = body.get("firstMessage").and_then(Value::as_str).unwrap_or("");
    if first_message.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "firstMessage is required" }))).into_response();
    }
    let key = composite_key(&raw_id, &provider_of(&q));
    // No Gemini key in env → first-message heuristic (sessions-router.ts:180-190).
    let heuristic = extract_title_from_message(first_message, 50);
    if heuristic.is_empty() {
        return Json(json!({ "title": null, "source": "none" })).into_response();
    }
    let stored = state.settings.patch_session_override(&key, &[
        ("titleOverride", Some(json!(heuristic))),
        ("titleSource", Some(json!("first-message"))),
    ]).await;
    // Respond with the STORED (ladder-resolved) value, faithfully.
    let title = stored.get("titleOverride").cloned().unwrap_or(Value::Null);
    let source = stored.get("titleSource").cloned().unwrap_or(json!("none"));
    Json(json!({ "title": title, "source": source })).into_response()
}
```

### Step 8: Register the router in `main.rs`

- Add `mod sessions;` beside the other `mod` declarations.
- Build the state and merge (near `:283-295`):
  ```rust
          .merge(sessions::router(sessions::SessionsState {
              auth_token: Arc::clone(&auth_token),
              settings: settings_store.clone(),
          }))
  ```

### Step 9: Run all sessions tests to verify they pass

Run: `cargo test -p freshell-server sessions`
Expected: PASS (all PATCH + generate-title cases).

### Step 10: Format, lint, commit

```
cargo fmt -p freshell-server
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/sessions.rs crates/freshell-server/src/main.rs
git commit -m "feat(rust): add /api/sessions PATCH + generate-title router"
```

---

## Task 4: Claude title parity  ⚠ INVESTIGATION DISCREPANCY — RESOLVE BEFORE IMPLEMENTING

**Read this callout in full before writing any code.** The task as originally scoped rests on a legacy reference that does not exist in the frozen source. Do not fabricate it.

### The discrepancy (verified, not assumed)

The task brief says: *"Parse the 'ai-title' JSONL record kind (legacy: `server/coding-cli/providers/claude.ts:416-419` `extractClaudeGeneratedTitleFromJsonlObject`)."*

Ground-truth checks of the frozen legacy source:

- `grep -rn "ai-title|aiTitle|GeneratedTitle|extractClaudeGeneratedTitle" server/ shared/` → **zero matches.** There is no `ai-title` JSONL record kind and no `extractClaudeGeneratedTitleFromJsonlObject` function.
- `server/coding-cli/providers/claude.ts:406-408` handles exactly two title records: `custom-title` → `customTitle` and `agent-name` → `agentName`.
- Legacy title precedence: `title: customTitle ?? agentName ?? title` (`claude.ts:501`).
- **AI titles in legacy are NOT stored in the transcript.** They are generated at runtime by `generateAiSessionTitle` (`server/ai-title.ts`) and persisted as a **`sessionOverride`** with `titleSource: 'ai'` (`server/index.ts:797`, `sessions-router.ts:200-202`).

The Rust parser ALREADY matches legacy precedence: `custom_title.or(agent_name).or(title)` (`crates/freshell-sessions/src/parse/claude.rs:459`), and already parses `custom-title` (`:335-338`) and `agent-name` (`:340-344`).

The bug-hunter root-cause report independently concluded that the "Claude session never indexed" symptom **does not reproduce** — the session IS indexed with the correct title; it is hidden only by the `isNonInteractive` (`≤1 user message`) filter, which is **identical and by-design on both legacy and Rust** (`claude.rs:424`, `session_directory.rs:476-478`).

### Conclusion

There is **no Claude parser change required** for title parity:
1. The nonexistent `ai-title` record cannot be ported.
2. Legacy AI titles arrive via the `sessionOverride` (`titleSource:'ai'`) path — which **Tasks 1–2 now implement and overlay.**
3. The parser's `custom-title`/`agent-name`/first-message precedence already matches legacy byte-for-byte.

**Recommended action:** Convert Task 4 from "add a parser" to a **regression-pin + adjudication** task. Add tests that lock in the existing parity, and surface the discrepancy to the orchestrator for an explicit decision rather than inventing a record kind. If the orchestrator has evidence of a real `ai-title` record in some transcript corpus, that evidence (a real fixture) must be provided before any parser change — per honest-stopping, do not implement against an unverified reference.

**Files (regression-pin version):**
- Test only: `crates/freshell-sessions/src/parse/claude.rs` `#[cfg(test)] mod tests`
- No production change unless the orchestrator supplies a real `ai-title` fixture.

### Step 1: Write the regression-pin test

Add to the claude parser tests (locate the existing `mod tests`; if none in this file, the parser tests live under the crate's test module — confirm with `grep -n "mod tests" crates/freshell-sessions/src/parse/claude.rs`). Pin the existing precedence so a future change cannot silently regress it:

```rust
#[test]
fn title_precedence_custom_then_agent_then_first_message() {
    // custom-title beats agent-name beats first user message (claude.ts:501 parity).
    let content = [
        r#"{"cwd":"/p","sessionId":"11111111-1111-4111-8111-111111111111","type":"user","message":{"role":"user","content":"first prompt here"},"timestamp":"2026-01-01T00:00:00.000Z"}"#,
        r#"{"cwd":"/p","sessionId":"11111111-1111-4111-8111-111111111111","type":"user","message":{"role":"user","content":"second prompt"},"timestamp":"2026-01-01T00:01:00.000Z"}"#,
        r#"{"type":"agent-name","agentName":"Agent Smith"}"#,
        r#"{"type":"custom-title","customTitle":"The Custom Title"}"#,
    ].join("\n");
    let meta = parse_session_content(&content, &ParseSessionOptions::default());
    assert_eq!(meta.title.as_deref(), Some("The Custom Title"));

    // Without custom-title, agent-name wins.
    let no_custom = [
        r#"{"cwd":"/p","sessionId":"11111111-1111-4111-8111-111111111111","type":"user","message":{"role":"user","content":"first prompt here"},"timestamp":"2026-01-01T00:00:00.000Z"}"#,
        r#"{"cwd":"/p","sessionId":"11111111-1111-4111-8111-111111111111","type":"user","message":{"role":"user","content":"second prompt"},"timestamp":"2026-01-01T00:01:00.000Z"}"#,
        r#"{"type":"agent-name","agentName":"Agent Smith"}"#,
    ].join("\n");
    let meta2 = parse_session_content(&no_custom, &ParseSessionOptions::default());
    assert_eq!(meta2.title.as_deref(), Some("Agent Smith"));

    // Without either, the first user message becomes the title.
    let plain = [
        r#"{"cwd":"/p","sessionId":"11111111-1111-4111-8111-111111111111","type":"user","message":{"role":"user","content":"just the first prompt"},"timestamp":"2026-01-01T00:00:00.000Z"}"#,
        r#"{"cwd":"/p","sessionId":"11111111-1111-4111-8111-111111111111","type":"user","message":{"role":"user","content":"second prompt"},"timestamp":"2026-01-01T00:01:00.000Z"}"#,
    ].join("\n");
    let meta3 = parse_session_content(&plain, &ParseSessionOptions::default());
    assert_eq!(meta3.title.as_deref(), Some("just the first prompt"));
}
```

### Step 2: Run the test to verify it passes AGAINST CURRENT CODE

Run: `cargo test -p freshell-sessions title_precedence_custom_then_agent -- --nocapture`
Expected: **PASS on the current parser** (this is a pin, not a red test). If it FAILS, the parser is NOT at parity and the orchestrator must be told — that failure is itself the finding.

### Step 3: Surface the discrepancy in the SDD status

When executing this task under subagent-driven-development, report status `DONE_WITH_CONCERNS`: the regression pin is green, but the originally-specified `ai-title` parser change was not implemented because the legacy reference does not exist. Await orchestrator adjudication (drop the task, or supply a real fixture).

### Step 4: Format, lint, commit

```
cargo fmt -p freshell-sessions
cargo clippy -p freshell-sessions --all-targets -- -D warnings
git add crates/freshell-sessions/src/parse/claude.rs
git commit -m "test(rust): pin Claude title precedence parity (custom-title > agent-name > first-message)"
```

---

## Task 5: Integration + redeploy verification (NOT cargo TDD — verification steps)

This task is a verification gate, not new code. Run it only after Tasks 1–4 are green. **The Rust QA server restart requires explicit user approval (the word "APPROVED") per repo Process Safety rules — do NOT stop+start without it.** Building is always fine.

### Step 1: Workspace test + quality gate

```
cargo test -p freshell-server -p freshell-sessions
cargo fmt --check
cargo clippy -p freshell-server -p freshell-sessions --all-targets -- -D warnings
```
Expected: all tests pass; fmt clean; clippy clean (no warnings).

### Step 2: Release build

```
cargo build --release -p freshell-server
```
Expected: builds clean. (This does NOT deploy — the running QA server is untouched.)

### Step 3: Redeploy the Rust QA server — REQUIRES "APPROVED"

The QA server pid is in `/tmp/freshell-qa-rust.pid`; the exact relaunch command is held by the orchestrator (do not guess it). Stop + relaunch ONLY after the user says "APPROVED". Confirm the pid belongs to the worktree (`ps -fp <pid>`) before stopping.

### Step 4: Curl-level acceptance (after redeploy)

Let `T=$(cat ~/freshell-qa/token.txt)` and `BASE=http://127.0.0.1:17872`. Pick a real `sessionId` from the directory first.

```bash
# 4a. Rename → directory shows the new title.
curl -s -X PATCH "$BASE/api/sessions/$SID?provider=claude" \
  -H "authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"titleOverride":"Parity Rename OK"}'
# expect: {"titleOverride":"Parity Rename OK","titleSource":"user",...,"cascadedTerminalId":null}
curl -s "$BASE/api/session-directory?priority=visible&includeNonInteractive=1" \
  -H "authorization: Bearer $T" | grep -o '"title":"Parity Rename OK"'
# expect: a match

# 4b. Archive → archived:true in the directory.
curl -s -X PATCH "$BASE/api/sessions/$SID?provider=claude" \
  -H "authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"archived":true}'
curl -s "$BASE/api/session-directory?priority=visible&includeNonInteractive=1" \
  -H "authorization: Bearer $T" | grep -o '"sessionId":"'"$SID"'"[^}]*"archived":true'
# expect: a match (archived:true present)

# 4c. generate-title on a fresh session → title set.
curl -s -X POST "$BASE/api/sessions/$FRESH_SID/generate-title" \
  -H "authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"firstMessage":"Investigate the deploy failure"}'
# expect: {"title":"Investigate the deploy failure","source":"first-message"}

# 4d. Settings PATCH does not wipe overrides (the :229 corruption trap).
curl -s -X PATCH "$BASE/api/settings" \
  -H "authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"safety":{"autoKillIdleMinutes":25}}' > /dev/null
curl -s "$BASE/api/session-directory?priority=visible&includeNonInteractive=1" \
  -H "authorization: Bearer $T" | grep -o '"title":"Parity Rename OK"'
# expect: STILL a match — the rename survived the settings write
```

Expected: all four acceptance checks pass. Capture the outputs as evidence for the parity report.

### Step 5: Update the parity report

Fill the Rust-defect rows for rename (SESSION-03), archive (SESSION-03), generate-title (SESSION-04), and the Claude-title note in `~/freshell-qa/PARITY-SMOKE-REPORT.md` — mark the three write actions RESOLVED with the curl evidence, and record the Task 4 discrepancy adjudication outcome.

---

## Verification Command Quick Reference

| Task | Command |
|------|---------|
| 1 | `cargo test -p freshell-server settings_store` |
| 2 | `cargo test -p freshell-server session_directory` |
| 3 | `cargo test -p freshell-server sessions` |
| 4 | `cargo test -p freshell-sessions title_precedence_custom_then_agent` |
| 5 | `cargo test -p freshell-server -p freshell-sessions && cargo fmt --check && cargo clippy -p freshell-server -p freshell-sessions --all-targets -- -D warnings` |

Per-task quality gate (run before every commit): `cargo fmt -p <crate>` then `cargo clippy -p <crate> --all-targets -- -D warnings`.
