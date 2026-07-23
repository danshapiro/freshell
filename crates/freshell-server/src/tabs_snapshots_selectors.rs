//! Fail-closed snapshot selection parsing for the tabs-sync REST surface
//! (`tabs_snapshots.rs`). Split into its own `#[path]`-included module to keep
//! the handler file under the repo's 1,000-line-per-file limit. ONE code path
//! validates selectors for BOTH the GET read endpoints (query params) and the
//! POST restore endpoint (JSON body) — see [`parse_restore_selection`]'s doc
//! for how the body shares [`parse_selector`].

// The Err variant is a ready-to-send axum `Response` (the same pattern every
// handler in `tabs_snapshots.rs` uses); its size is irrelevant on this
// low-frequency, operator-driven path.
#![allow(clippy::result_large_err)]

use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde_json::{json, Value};

/// The parsed generation selector, or a 400 response. FAIL-CLOSED (`:1101`): an
/// invalid, negative, duplicated, or conflicting selector is a 400, never a
/// silent fall-through to the (broader) coherent union.
pub(super) enum Selector {
    Union,
    Index(usize),
    Id(String),
}

pub(super) fn parse_selector(params: &[(String, String)]) -> Result<Selector, Response> {
    let gens: Vec<&String> = params
        .iter()
        .filter(|(k, _)| k == "generation")
        .map(|(_, v)| v)
        .collect();
    let ids: Vec<&String> = params
        .iter()
        .filter(|(k, _)| k == "generationId")
        .map(|(_, v)| v)
        .collect();
    let bad = |msg: &str| (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
    if gens.len() > 1 {
        return Err(bad("duplicate `generation` selector"));
    }
    if ids.len() > 1 {
        return Err(bad("duplicate `generationId` selector"));
    }
    if !gens.is_empty() && !ids.is_empty() {
        return Err(bad("provide `generation` OR `generationId`, not both"));
    }
    if let Some(v) = gens.first() {
        // usize::from_str rejects negatives, non-numerics, and empty -> 400.
        return v
            .parse::<usize>()
            .map(Selector::Index)
            .map_err(|_| bad("`generation` must be a non-negative integer"));
    }
    if let Some(v) = ids.first() {
        if v.is_empty() {
            return Err(bad("`generationId` must be non-empty"));
        }
        return Ok(Selector::Id((*v).clone()));
    }
    Ok(Selector::Union)
}

/// The restore body's fail-closed snapshot selection (`:459`). Malformed
/// values are a 400, NEVER a silent fall-through to the (broader) coherent
/// union. `generation`/`generationId` REUSE the GET endpoint's
/// [`parse_selector`] by materializing the same query-param shape it
/// validates: a JSON value of the WRONG TYPE is serialized (`"3"` -> `"\"3\""`,
/// `1.5` -> `"1.5"`, `-1` -> `"-1"`, `true` -> `"true"`), all of which that
/// parser rejects, so both endpoints share ONE validation code path.
pub(super) struct RestoreSelection {
    pub components: Vec<String>,
    pub selector: Selector,
    pub panes: Option<std::collections::HashSet<String>>,
}

pub(super) fn parse_restore_selection(body: &Value) -> Result<RestoreSelection, Response> {
    let bad = |msg: &str| (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
    let components: Vec<String> = match body.get("components") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => {
            let mut out = Vec::new();
            for x in a {
                match x.as_str().filter(|s| !s.is_empty()) {
                    Some(s) => out.push(s.to_string()),
                    None => {
                        return Err(bad(
                            "`components` must be an array of non-empty generation-id strings",
                        ))
                    }
                }
            }
            if out.is_empty() {
                return Err(bad(
                    "`components` must be a non-empty array of generation-id strings",
                ));
            }
            out
        }
        Some(_) => {
            return Err(bad(
                "`components` must be an array of generation-id strings",
            ))
        }
    };
    let mut params: Vec<(String, String)> = Vec::new();
    match body.get("generation") {
        None | Some(Value::Null) => {}
        // A valid u64 serializes to the digits parse_selector accepts; EVERY
        // other JSON type serializes to something it rejects ("\"3\"", "1.5",
        // "-1", "true") — fail-closed by construction.
        Some(v) => params.push(("generation".to_string(), v.to_string())),
    }
    match body.get("generationId") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => params.push(("generationId".to_string(), s.clone())),
        Some(_) => return Err(bad("`generationId` must be a string")),
    }
    let selector = parse_selector(&params)?;
    if !components.is_empty() && !matches!(selector, Selector::Union) {
        return Err(bad(
            "provide `components` OR `generation`/`generationId`, not both",
        ));
    }
    let panes: Option<std::collections::HashSet<String>> = match body.get("panes") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => {
            let mut set = std::collections::HashSet::new();
            for x in a {
                match x.as_str().filter(|s| !s.is_empty()) {
                    Some(s) => {
                        set.insert(s.to_string());
                    }
                    None => {
                        return Err(bad(
                            "`panes` must be an array of non-empty \"tabKey#paneId\" strings",
                        ))
                    }
                }
            }
            if set.is_empty() {
                return Err(bad(
                    "`panes` must be a non-empty array of \"tabKey#paneId\" strings",
                ));
            }
            Some(set)
        }
        Some(_) => return Err(bad("`panes` must be an array of \"tabKey#paneId\" strings")),
    };
    Ok(RestoreSelection {
        components,
        selector,
        panes,
    })
}
