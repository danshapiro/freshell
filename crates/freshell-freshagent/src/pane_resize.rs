//! `POST /api/panes/:id/resize` on the shared [`crate::layout_store::LayoutStore`]
//! (Task 15, AUTO-06): the Node route `router.ts:1452-1524` ported whole --
//! target resolution (`resolveResizeTarget`, `router.ts:621-647`), the full
//! validation matrix (`:1466-1495`, exact strings), the x/y/current-size
//! fallbacks and `normalizePairToHundred` (`:1497-1515`), the store mutation
//! (`layoutStore.resizePane`) and the `ui.command{pane.resize}` broadcast.
//! Split out of `pane_ops.rs` per this branch's file-size precedent
//! (`pane_ops_tests.rs`, `layout_store_content.rs`) to keep every file under
//! the 1,000-line ceiling. This retires the Slice 3b-2 honest-400 deferral:
//! `ui.layout.sync` ingestion (Task 13) now teaches the server the REAL
//! client-minted split ids the deferral was waiting on.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use serde_json::{json, Value};

use freshell_protocol::{ServerMessage, UiCommand};

use crate::layout_store::{is_valid_percent, normalize_pair_to_hundred};
use crate::{authorized, fail_json, ok_json, FreshAgentState};

/// `POST /api/panes/:id/resize` (`router.ts:1452-1524`). `:id` may be a
/// splitId (resized directly) or a paneId (its PARENT split is resized, with
/// the `'pane matched; resized parent split'` message); an unresolvable
/// target is Node's graceful 200 `{message:'split not found'}`, an ambiguous
/// pane-title target is 409.
pub(crate) async fn resize_pane(
    State(state): State<FreshAgentState>,
    Path(raw_target): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let requested_tab_id = body
        .get("tabId")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty());

    let (tab_id, split_id, current) = match state
        .layout
        .resolve_resize_target(&raw_target, requested_tab_id)
    {
        Ok(resolved) => resolved,
        // `isAmbiguousTargetMessage` -> `rejectPaneTargetError` 409
        // (`router.ts:1455-1457`).
        Err(message) if message.contains("ambiguous") => {
            return fail_json(StatusCode::CONFLICT, message.to_string())
        }
        // `'split not found'` is a 200 with that message, not an error
        // (`router.ts:1459-1461`).
        Err(message) => return ok_json(json!({ "message": message }), message),
    };

    // Node's `'pane matched; resized parent split'` (`router.ts:637-641`):
    // the store resolver reports a pane-parent hit by returning a split id
    // DIFFERENT from the raw target (a direct splitId hit echoes it back).
    let resolved_message = (split_id != raw_target).then_some("pane matched; resized parent split");

    // ── validation matrix (`router.ts:1466-1495`, exact strings + order) ──
    let sizes_field = body.get("sizes").and_then(Value::as_array);
    if let Some(sizes) = sizes_field {
        if sizes.len() != 2 {
            return fail_json(
                StatusCode::BAD_REQUEST,
                "sizes must contain exactly two values".to_string(),
            );
        }
    }
    let explicit_tuple =
        sizes_field.map(|s| (parse_optional_number(&s[0]), parse_optional_number(&s[1])));
    if let Some((a, b)) = explicit_tuple {
        let (Some(a), Some(b)) = (a, b) else {
            return fail_json(
                StatusCode::BAD_REQUEST,
                "sizes values must be numeric".to_string(),
            );
        };
        if !is_valid_percent(a) || !is_valid_percent(b) {
            return fail_json(
                StatusCode::BAD_REQUEST,
                "sizes values must be within 1..99".to_string(),
            );
        }
    }

    let explicit_x = body.get("x").map(parse_optional_number);
    let explicit_y = body.get("y").map(parse_optional_number);
    if explicit_x == Some(None) {
        return fail_json(StatusCode::BAD_REQUEST, "x must be numeric".to_string());
    }
    if explicit_y == Some(None) {
        return fail_json(StatusCode::BAD_REQUEST, "y must be numeric".to_string());
    }
    let explicit_x = explicit_x.flatten();
    let explicit_y = explicit_y.flatten();
    if let Some(x) = explicit_x {
        if !is_valid_percent(x) {
            return fail_json(
                StatusCode::BAD_REQUEST,
                "x must be within 1..99".to_string(),
            );
        }
    }
    if let Some(y) = explicit_y {
        if !is_valid_percent(y) {
            return fail_json(
                StatusCode::BAD_REQUEST,
                "y must be within 1..99".to_string(),
            );
        }
    }

    // ── normalized sizes (`router.ts:1497-1512`): tuple, x&y, x->[x,100-x],
    // y->[100-y,y], neither -> the split's CURRENT sizes ──
    let sizes = if let Some((a, b)) = explicit_tuple {
        let (a, b) = (a.expect("validated above"), b.expect("validated above"));
        normalize_pair_to_hundred(a, b)
    } else {
        match (explicit_x, explicit_y) {
            (Some(x), Some(y)) => normalize_pair_to_hundred(x, y),
            (Some(x), None) => normalize_pair_to_hundred(x, 100.0 - x),
            (None, Some(y)) => normalize_pair_to_hundred(100.0 - y, y),
            (None, None) => normalize_pair_to_hundred(current[0], current[1]),
        }
    };

    // `layoutStore.resizePane(tabId, splitId, normalizedSizes)`. A miss here
    // means the snapshot was concurrently replaced between resolution and
    // mutation -- report `resizePane`'s own `{message:'split not found'}`
    // (`layout-store.ts:668`), no broadcast, exactly like Node's
    // `if (result?.tabId)` guard.
    if !state.layout.resize_split(&tab_id, &split_id, sizes) {
        return ok_json(
            json!({ "message": "split not found" }),
            resolved_message.unwrap_or("split not found"),
        );
    }

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "pane.resize".to_string(),
        payload: Some(json!({
            "tabId": tab_id,
            "splitId": split_id,
            "sizes": sizes_value(sizes),
        })),
    }));

    ok_json(
        json!({ "tabId": tab_id }),
        resolved_message.unwrap_or("pane resized"),
    )
}

/// `parseOptionalNumber` (`router.ts:598-601`): JS `Number(value)` with the
/// non-finite results mapped to `None`. Scalar coercions are Node-exact
/// (`Number(null)` is 0, `Number(true)` is 1, `Number('')` is 0, strings
/// trim + parse); composite values (arrays/objects, never sent by real
/// automation clients) coerce to `None` rather than reimplementing JS
/// `ToPrimitive`.
fn parse_optional_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return Some(0.0);
            }
            trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
        }
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}

/// `JSON.stringify(60)` is `60`, not `60.0` -- integral sizes serialize as
/// JSON integers (same convention as `layout_tree`'s node serialization).
fn sizes_value(sizes: [f64; 2]) -> Value {
    Value::Array(
        sizes
            .iter()
            .map(|s| {
                if s.fract() == 0.0 && s.is_finite() {
                    json!(*s as i64)
                } else {
                    json!(s)
                }
            })
            .collect(),
    )
}
