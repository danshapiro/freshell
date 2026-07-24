//! codex model / effort **normalization** — the codex slice of
//! `shared/fresh-agent-models.ts`, plus the wire-level effort mapping
//! `toCodexReasoningEffort` (`adapters/codex/adapter.ts:127-134`).
//!
//! Every freshcodex turn normalizes model+effort on the way in
//! (`adapter.ts:237-243`, and again in `send` `:961-963`). This crate is codex-only, so
//! the session type is always `freshcodex`; the ported functions specialise to that menu
//! but keep the reference's exact clamp semantics, in the reference's two stages:
//!
//! 1. **menu normalization** ([`normalize_freshcodex_model`] + [`normalize_freshcodex_effort`],
//!    `fresh-agent-models.ts:101-152`): clamp the model to the freshcodex allowlist
//!    (fallback `gpt-5.5`); rewrite codex `xhigh → max`; then clamp the effort to the
//!    (normalized) model's `thinkingEfforts`, else its `defaultEffort`, else the last menu
//!    entry.
//! 2. **wire mapping** ([`to_codex_reasoning_effort`], `adapter.ts:127-134`): `max`/`xhigh`
//!    → `xhigh`; **`none`/`minimal`/`low`/`medium`/`high` PASS THROUGH VERBATIM**; anything
//!    else is an error.
//!
//! ## DEV-0003 (REJECTED — `port/oracle/DEVIATIONS.md`)
//!
//! `CodexReasoningEffortSchema = z.enum(['none','minimal','low','medium','high','xhigh'])`
//! (`protocol.ts:26`) models `none`/`minimal` as VALID codex efforts, governing BOTH the
//! outbound `turn/start.effort` (`protocol.ts:312`) and the inbound `reasoningEffort` echo
//! (`protocol.ts:233`). The proposed "clamp none/minimal" fix was **rejected**: the port
//! MUST reproduce the original's **verbatim forwarding** and must NOT clamp. The differ
//! grants NO tolerance — any old-vs-new divergence here is a port defect. [`to_codex_reasoning_effort`]
//! is the function that must not regress; [`FRESHCODEX_EFFORTS_VERBATIM`] enumerates the
//! five values that pass through unchanged.

/// `FRESHCODEX_DEFAULT_MODEL` (`fresh-agent-models.ts:15`).
pub const FRESHCODEX_DEFAULT_MODEL: &str = "gpt-5.5";
/// `FRESHCODEX_DEFAULT_EFFORT` (`fresh-agent-models.ts:16`).
pub const FRESHCODEX_DEFAULT_EFFORT: &str = "max";

/// The cheapest GPT model REACHABLE through freshcodex — the T2 `codex-gptmini.json`
/// baseline model. `normalizeFreshcodexModel` clamps to the freshcodex allowlist, so this
/// is the only non-flagship model in BOTH the allowlist and the real codex catalog
/// (`codex-gptmini.json` provenance / `modelReachabilityNote`).
pub const CHEAPEST_T2_MODEL: &str = "gpt-5.3-codex-spark";

/// The five reasoning-effort values codex forwards VERBATIM on the wire (`adapter.ts:130`).
/// Pinned by DEV-0003: the port must not clamp/map any of these. `max`/`xhigh` are handled
/// separately (both map to `xhigh`, `adapter.ts:129`).
pub const FRESHCODEX_EFFORTS_VERBATIM: &[&str] = &["none", "minimal", "low", "medium", "high"];

/// One freshcodex model menu entry (`fresh-agent-models.ts:30-49`).
struct ModelOption {
    value: &'static str,
    thinking_efforts: &'static [&'static str],
    default_effort: &'static str,
}

/// The freshcodex menu (`FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshcodex`,
/// `fresh-agent-models.ts:30-49`). `gpt-5.5` and `gpt-5.3-codex-spark` share efforts
/// `[none,minimal,low,medium,high,max]` (default `max`); `gpt-5.4-flash` omits `max` and
/// defaults `high`.
const FRESHCODEX_MODEL_OPTIONS: &[ModelOption] = &[
    ModelOption {
        value: "gpt-5.5",
        thinking_efforts: &["none", "minimal", "low", "medium", "high", "max"],
        default_effort: "max",
    },
    ModelOption {
        value: "gpt-5.4-flash",
        thinking_efforts: &["none", "minimal", "low", "medium", "high"],
        default_effort: "high",
    },
    ModelOption {
        value: "gpt-5.3-codex-spark",
        thinking_efforts: &["none", "minimal", "low", "medium", "high", "max"],
        default_effort: "max",
    },
];

fn find_option(model: &str) -> Option<&'static ModelOption> {
    FRESHCODEX_MODEL_OPTIONS.iter().find(|o| o.value == model)
}

/// `normalizeFreshcodexModel(model)` (`fresh-agent-models.ts:101-104`): keep the model iff
/// it is in the freshcodex allowlist, else fall back to `gpt-5.5`. Consequence
/// (`codex-gptmini.json` provenance): `gpt-5.4-mini` is silently rewritten to `gpt-5.5`;
/// `gpt-5.3-codex-spark` is the only non-flagship model reachable through freshcodex.
pub fn normalize_freshcodex_model(model: Option<&str>) -> String {
    match model.and_then(find_option) {
        Some(option) => option.value.to_string(),
        None => FRESHCODEX_DEFAULT_MODEL.to_string(),
    }
}

/// `resolveFreshAgentModelOption(freshcodex, model)` (`fresh-agent-models.ts:93-99`): the
/// matching menu entry, else the default (first) entry. Since [`normalize_freshcodex_model`]
/// always returns an allowlisted value this resolves precisely, but the fallback mirrors
/// the reference for defensiveness.
fn resolve_option(model: &str) -> Option<&'static ModelOption> {
    find_option(model).or_else(|| FRESHCODEX_MODEL_OPTIONS.first())
}

/// `getFreshAgentThinkingOptions(freshcodex, 'codex', model)` (`fresh-agent-models.ts:121-129`):
/// the resolved (normalized) model's `thinkingEfforts`.
fn thinking_options(model: Option<&str>) -> &'static [&'static str] {
    let normalized = normalize_freshcodex_model(model);
    resolve_option(&normalized)
        .map(|o| o.thinking_efforts)
        .unwrap_or(&[])
}

/// `normalizeFreshAgentEffort(freshcodex, 'codex', model, effort)` — the MENU-level
/// normalization (`fresh-agent-models.ts:131-152`). Codex `xhigh → max` (`:142`), then
/// clamp to the model's `thinkingEfforts`, else the model's `defaultEffort` (if on the
/// menu), else the last menu entry.
///
/// This is stage 1; the wire value is then produced by [`to_codex_reasoning_effort`]
/// (stage 2, which maps the resulting `max` back to `xhigh`). Note `none`/`minimal` survive
/// stage 1 unchanged **because freshcodex declares them in the model's `thinkingEfforts`** —
/// consistent with the protocol treating them as valid (DEV-0003).
pub fn normalize_freshcodex_effort(model: Option<&str>, effort: Option<&str>) -> Option<String> {
    let options = thinking_options(model);

    // codex `xhigh → max` (`:142` guards on `provider === 'codex'`).
    let normalized_effort = match effort {
        Some("xhigh") => Some("max"),
        other => other,
    };
    if let Some(e) = normalized_effort {
        if options.contains(&e) {
            return Some(e.to_string());
        }
    }

    let normalized_model = normalize_freshcodex_model(model);
    if let Some(opt) = resolve_option(&normalized_model) {
        if options.contains(&opt.default_effort) {
            return Some(opt.default_effort.to_string());
        }
    }
    options.last().map(|s| s.to_string())
}

/// Raised when a reasoning-effort value cannot be mapped to the codex wire vocabulary —
/// the reference's `throw new Error('Freshcodex does not support reasoning effort "…"')`
/// (`adapter.ts:133`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexEffortError(pub String);

impl std::fmt::Display for CodexEffortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Freshcodex does not support reasoning effort \"{}\". Choose none, minimal, low, medium, high, or max.",
            self.0
        )
    }
}

impl std::error::Error for CodexEffortError {}

/// `toCodexReasoningEffort(value)` — the WIRE-level mapping (`adapter.ts:127-134`).
///
/// - `None` → `None` (omit `effort` from `turn/start`).
/// - `max` / `xhigh` → `xhigh` (`:129`).
/// - **`none` / `minimal` / `low` / `medium` / `high` → VERBATIM (`:130-131`).** ← DEV-0003.
/// - anything else → [`CodexEffortError`] (`:133`).
///
/// This function is the DEV-0003 seam: `none`/`minimal` MUST pass through unchanged. The
/// port must never clamp or remap them — the T2 codex differ grants no tolerance here.
pub fn to_codex_reasoning_effort(value: Option<&str>) -> Result<Option<String>, CodexEffortError> {
    match value {
        None => Ok(None),
        Some("max") | Some("xhigh") => Ok(Some("xhigh".to_string())),
        Some(v) if FRESHCODEX_EFFORTS_VERBATIM.contains(&v) => Ok(Some(v.to_string())),
        Some(other) => Err(CodexEffortError(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── DEV-0003: none/minimal are forwarded VERBATIM (no clamp) ───────────────────────

    #[test]
    fn dev_0003_none_and_minimal_forward_verbatim() {
        // The heart of DEV-0003: these five values must survive the wire mapping unchanged.
        assert_eq!(
            to_codex_reasoning_effort(Some("none")),
            Ok(Some("none".to_string()))
        );
        assert_eq!(
            to_codex_reasoning_effort(Some("minimal")),
            Ok(Some("minimal".to_string()))
        );
        assert_eq!(
            to_codex_reasoning_effort(Some("low")),
            Ok(Some("low".to_string()))
        );
        assert_eq!(
            to_codex_reasoning_effort(Some("medium")),
            Ok(Some("medium".to_string()))
        );
        assert_eq!(
            to_codex_reasoning_effort(Some("high")),
            Ok(Some("high".to_string()))
        );
    }

    #[test]
    fn dev_0003_full_pipeline_keeps_none_minimal_verbatim_for_spark() {
        // The exact T2 model. Menu-normalize (`none`/`minimal` are on spark's menu, so they
        // survive) THEN wire-map — still verbatim end-to-end. This is what the T2 differ grades.
        let spark = Some(CHEAPEST_T2_MODEL);
        for effort in ["none", "minimal", "low", "medium", "high"] {
            let menu = normalize_freshcodex_effort(spark, Some(effort));
            assert_eq!(
                menu.as_deref(),
                Some(effort),
                "menu stage must keep {effort} verbatim"
            );
            let wire = to_codex_reasoning_effort(menu.as_deref()).expect("wire map");
            assert_eq!(
                wire.as_deref(),
                Some(effort),
                "wire stage must keep {effort} verbatim"
            );
        }
    }

    #[test]
    fn max_and_xhigh_map_to_xhigh_on_the_wire() {
        // `max`/`xhigh` → `xhigh` (`adapter.ts:129`) — NOT a DEV-0003 value; correctly mapped.
        assert_eq!(
            to_codex_reasoning_effort(Some("max")),
            Ok(Some("xhigh".to_string()))
        );
        assert_eq!(
            to_codex_reasoning_effort(Some("xhigh")),
            Ok(Some("xhigh".to_string()))
        );
    }

    #[test]
    fn undefined_effort_stays_undefined() {
        assert_eq!(to_codex_reasoning_effort(None), Ok(None));
    }

    #[test]
    fn unsupported_effort_errors_like_the_reference() {
        assert_eq!(
            to_codex_reasoning_effort(Some("bogus")),
            Err(CodexEffortError("bogus".to_string()))
        );
        assert!(to_codex_reasoning_effort(Some("ultra")).is_err());
    }

    // ── model clamp (normalizeFreshcodexModel) ─────────────────────────────────────────

    #[test]
    fn model_clamps_to_freshcodex_allowlist() {
        // Allowlisted models pass through.
        assert_eq!(normalize_freshcodex_model(Some("gpt-5.5")), "gpt-5.5");
        assert_eq!(
            normalize_freshcodex_model(Some("gpt-5.4-flash")),
            "gpt-5.4-flash"
        );
        assert_eq!(
            normalize_freshcodex_model(Some("gpt-5.3-codex-spark")),
            "gpt-5.3-codex-spark"
        );
        // gpt-5.4-mini (in the codex catalog, NOT the freshcodex allowlist) → gpt-5.5.
        assert_eq!(normalize_freshcodex_model(Some("gpt-5.4-mini")), "gpt-5.5");
        // Unknown / missing → the freshcodex default.
        assert_eq!(
            normalize_freshcodex_model(Some("random")),
            FRESHCODEX_DEFAULT_MODEL
        );
        assert_eq!(normalize_freshcodex_model(None), FRESHCODEX_DEFAULT_MODEL);
    }

    // ── effort menu normalization (normalizeFreshAgentEffort, codex slice) ──────────────

    #[test]
    fn effort_menu_normalization_matches_reference() {
        let spark = Some("gpt-5.3-codex-spark");
        // On-menu efforts kept.
        assert_eq!(
            normalize_freshcodex_effort(spark, Some("low")).as_deref(),
            Some("low")
        );
        assert_eq!(
            normalize_freshcodex_effort(spark, Some("none")).as_deref(),
            Some("none")
        );
        assert_eq!(
            normalize_freshcodex_effort(spark, Some("max")).as_deref(),
            Some("max")
        );
        // codex xhigh → max at the menu stage (`:142`), and `max` is on spark's menu.
        assert_eq!(
            normalize_freshcodex_effort(spark, Some("xhigh")).as_deref(),
            Some("max")
        );
        // Absent effort → the model's defaultEffort (`max` for spark).
        assert_eq!(
            normalize_freshcodex_effort(spark, None).as_deref(),
            Some("max")
        );
        // Off-menu effort → clamped to the default (`max`).
        assert_eq!(
            normalize_freshcodex_effort(spark, Some("bogus")).as_deref(),
            Some("max")
        );
    }

    #[test]
    fn effort_menu_for_flash_omits_max_and_defaults_high() {
        let flash = Some("gpt-5.4-flash");
        // flash has no `max` on its menu; `xhigh → max` then clamps to defaultEffort `high`.
        assert_eq!(
            normalize_freshcodex_effort(flash, Some("xhigh")).as_deref(),
            Some("high")
        );
        assert_eq!(
            normalize_freshcodex_effort(flash, Some("max")).as_deref(),
            Some("high")
        );
        // On-menu efforts kept, including the DEV-0003 pair.
        assert_eq!(
            normalize_freshcodex_effort(flash, Some("none")).as_deref(),
            Some("none")
        );
        assert_eq!(
            normalize_freshcodex_effort(flash, Some("minimal")).as_deref(),
            Some("minimal")
        );
        assert_eq!(
            normalize_freshcodex_effort(flash, None).as_deref(),
            Some("high")
        );
    }

    #[test]
    fn effort_for_unknown_model_uses_default_model_menu() {
        // An unknown model normalizes to gpt-5.5, whose menu includes `max`.
        let unknown = Some("mystery-model");
        assert_eq!(
            normalize_freshcodex_effort(unknown, Some("medium")).as_deref(),
            Some("medium")
        );
        assert_eq!(
            normalize_freshcodex_effort(unknown, None).as_deref(),
            Some("max")
        );
    }
}
