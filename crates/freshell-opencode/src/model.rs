//! opencode model / effort **normalization** — the opencode slice of
//! `shared/fresh-agent-models.ts`, plus `splitOpencodeModel` from
//! `serve-events.ts:7-12`.
//!
//! Every opencode turn normalizes model+effort on the way in
//! (`adapters/opencode/adapter.ts:80-83` → `normalizeFreshAgentModel` +
//! `normalizeFreshAgentEffort`). This crate is opencode-only, so the session type is
//! always `freshopencode`; the ported functions specialise to that menu but keep the
//! reference's exact clamp semantics:
//!
//! - **model** (`fresh-agent-models.ts:114-117`): trim; a non-empty trimmed value is
//!   kept verbatim (opencode accepts any `provider/model`), else fall back to the
//!   freshopencode default model (`FRESHOPENCODE_DEFAULT_MODEL`, `:18`).
//! - **effort** (`fresh-agent-models.ts:131-152`): resolve the (normalized) model's
//!   `thinkingEfforts` menu; if the requested effort is on it keep it, else the model's
//!   `defaultEffort` if on the menu, else the last menu entry. opencode does NOT apply
//!   the codex `xhigh→max` rewrite (`:142` is `provider === 'codex'` only).
//! - **wire split** (`serve-events.ts:7-12`): `provider/model` splits on the FIRST
//!   slash into `{ providerID, modelID }`; blank / slashless / edge-slash values yield
//!   `None` so the caller omits `model` and the serve session default applies.

/// `FRESHOPENCODE_DEFAULT_MODEL` (`fresh-agent-models.ts:18`).
pub const FRESHOPENCODE_DEFAULT_MODEL: &str = "opencode-go/glm-5.2";
/// `FRESHOPENCODE_DEFAULT_EFFORT` (`fresh-agent-models.ts:19`).
pub const FRESHOPENCODE_DEFAULT_EFFORT: &str = "max";

/// One freshopencode model menu entry (`fresh-agent-models.ts:58-83`).
struct ModelOption {
    value: &'static str,
    thinking_efforts: &'static [&'static str],
    default_effort: &'static str,
}

/// The freshopencode menu (`FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshopencode`,
/// `fresh-agent-models.ts:58-83`). All four share efforts `[minimal,low,medium,high,max]`
/// with default `max`. The Kimi entry (`:78`) is the cheapest T2 model.
const FRESHOPENCODE_MODEL_OPTIONS: &[ModelOption] = &[
    ModelOption {
        value: "opencode-go/glm-5.2",
        thinking_efforts: &["minimal", "low", "medium", "high", "max"],
        default_effort: "max",
    },
    ModelOption {
        value: "opencode-go/glm-5.1",
        thinking_efforts: &["minimal", "low", "medium", "high", "max"],
        default_effort: "max",
    },
    ModelOption {
        value: "opencode-go/deepseek-v4-flash",
        thinking_efforts: &["minimal", "low", "medium", "high", "max"],
        default_effort: "max",
    },
    ModelOption {
        value: "umans-ai-coding-plan/umans-kimi-k2.7",
        thinking_efforts: &["minimal", "low", "medium", "high", "max"],
        default_effort: "max",
    },
];

/// `defaultModelForSession(freshopencode)?.value` (`fresh-agent-models.ts:89-91`) — the
/// first menu entry.
fn default_model() -> &'static str {
    FRESHOPENCODE_MODEL_OPTIONS
        .first()
        .map(|o| o.value)
        .unwrap_or(FRESHOPENCODE_DEFAULT_MODEL)
}

/// `resolveFreshAgentModelOption(freshopencode, model)` (`fresh-agent-models.ts:93-99`):
/// the matching menu entry, else the default (first) entry.
fn resolve_model_option(model: &str) -> Option<&'static ModelOption> {
    FRESHOPENCODE_MODEL_OPTIONS
        .iter()
        .find(|o| o.value == model)
        .or_else(|| FRESHOPENCODE_MODEL_OPTIONS.first())
}

/// `normalizeFreshAgentModel(freshopencode, 'opencode', model)` (`fresh-agent-models.ts:114-117`).
pub fn normalize_opencode_model(model: Option<&str>) -> Option<String> {
    let trimmed = model.map(str::trim).unwrap_or("");
    if !trimmed.is_empty() {
        Some(trimmed.to_string())
    } else {
        Some(default_model().to_string())
    }
}

/// `getFreshAgentThinkingOptions(freshopencode, 'opencode', model)` (`fresh-agent-models.ts:121-129`):
/// the resolved (normalized) model's `thinkingEfforts`.
fn thinking_options(model: Option<&str>) -> &'static [&'static str] {
    let normalized = normalize_opencode_model(model);
    let option = normalized.as_deref().and_then(resolve_model_option);
    option.map(|o| o.thinking_efforts).unwrap_or(&[])
}

/// `normalizeFreshAgentEffort(freshopencode, 'opencode', model, effort)`
/// (`fresh-agent-models.ts:131-152`).
pub fn normalize_opencode_effort(model: Option<&str>, effort: Option<&str>) -> Option<String> {
    let options = thinking_options(model);

    // opencode-with-no-menu → trim or the freshopencode default (`:138-141`). Defensive:
    // the populated freshopencode menu never yields an empty option list.
    if options.is_empty() {
        let trimmed = effort.map(str::trim).unwrap_or("");
        return Some(if trimmed.is_empty() {
            FRESHOPENCODE_DEFAULT_EFFORT.to_string()
        } else {
            trimmed.to_string()
        });
    }

    // opencode does NOT apply the codex `xhigh→max` rewrite (`:142` guards on codex).
    let normalized_effort = effort;
    if let Some(e) = normalized_effort {
        if options.contains(&e) {
            return Some(e.to_string());
        }
    }

    let model_option = normalize_opencode_model(model)
        .as_deref()
        .and_then(resolve_model_option);
    if let Some(opt) = model_option {
        if options.contains(&opt.default_effort) {
            return Some(opt.default_effort.to_string());
        }
    }
    options.last().map(|s| s.to_string())
}

/// A `{ providerID, modelID }` split of a `provider/model` string
/// (`OpencodeModelObject`, `serve-events.ts:1`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpencodeModel {
    pub provider_id: String,
    pub model_id: String,
}

/// `splitOpencodeModel(value)` (`serve-events.ts:7-12`): split on the FIRST slash.
/// `None` for blank, slashless, or edge-slash values (so the caller omits `model`).
pub fn split_opencode_model(value: Option<&str>) -> Option<OpencodeModel> {
    let value = value?;
    if value.trim().is_empty() {
        return None;
    }
    let slash = value.find('/')?;
    // Reject leading (`slash <= 0`) or trailing (`slash >= len-1`) slash.
    if slash == 0 || slash >= value.len() - 1 {
        return None;
    }
    Some(OpencodeModel {
        provider_id: value[..slash].to_string(),
        model_id: value[slash + 1..].to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_trims_or_falls_back_to_default() {
        // Non-empty trimmed values pass through verbatim (opencode accepts any id).
        assert_eq!(
            normalize_opencode_model(Some("opencode-go/glm-5.1")).as_deref(),
            Some("opencode-go/glm-5.1")
        );
        assert_eq!(
            normalize_opencode_model(Some("  provider/model  ")).as_deref(),
            Some("provider/model")
        );
        // The T2 baseline Kimi id survives normalization unchanged.
        assert_eq!(
            normalize_opencode_model(Some("umans-ai-coding-plan/umans-kimi-k2.7")).as_deref(),
            Some("umans-ai-coding-plan/umans-kimi-k2.7")
        );
        // Blank / missing → the freshopencode default model.
        assert_eq!(
            normalize_opencode_model(Some("   ")).as_deref(),
            Some(FRESHOPENCODE_DEFAULT_MODEL)
        );
        assert_eq!(
            normalize_opencode_model(None).as_deref(),
            Some(FRESHOPENCODE_DEFAULT_MODEL)
        );
    }

    #[test]
    fn effort_clamps_to_menu_with_kimi() {
        let kimi = Some("umans-ai-coding-plan/umans-kimi-k2.7");
        // On-menu effort is kept.
        assert_eq!(
            normalize_opencode_effort(kimi, Some("low")).as_deref(),
            Some("low")
        );
        assert_eq!(
            normalize_opencode_effort(kimi, Some("minimal")).as_deref(),
            Some("minimal")
        );
        assert_eq!(
            normalize_opencode_effort(kimi, Some("max")).as_deref(),
            Some("max")
        );
        // Absent effort → the model's defaultEffort ("max").
        assert_eq!(
            normalize_opencode_effort(kimi, None).as_deref(),
            Some("max")
        );
        // Off-menu effort → clamped to the default ("max").
        assert_eq!(
            normalize_opencode_effort(kimi, Some("bogus")).as_deref(),
            Some("max")
        );
        // 'xhigh' is NOT rewritten for opencode (codex-only) → off-menu → clamps to default.
        assert_eq!(
            normalize_opencode_effort(kimi, Some("xhigh")).as_deref(),
            Some("max")
        );
    }

    #[test]
    fn effort_for_unknown_model_uses_default_menu() {
        // An unknown-but-nonempty model resolves to the first menu option's efforts.
        let unknown = Some("some-other/model");
        assert_eq!(
            normalize_opencode_effort(unknown, Some("high")).as_deref(),
            Some("high")
        );
        assert_eq!(
            normalize_opencode_effort(unknown, None).as_deref(),
            Some("max")
        );
    }

    #[test]
    fn split_model_uses_first_slash_and_rejects_edges() {
        assert_eq!(
            split_opencode_model(Some("umans-ai-coding-plan/umans-kimi-k2.7")),
            Some(OpencodeModel {
                provider_id: "umans-ai-coding-plan".into(),
                model_id: "umans-kimi-k2.7".into(),
            })
        );
        // Split on FIRST slash only — the model id keeps later slashes.
        assert_eq!(
            split_opencode_model(Some("prov/a/b")),
            Some(OpencodeModel {
                provider_id: "prov".into(),
                model_id: "a/b".into()
            })
        );
        // Rejected: blank, slashless, leading/trailing slash.
        assert_eq!(split_opencode_model(None), None);
        assert_eq!(split_opencode_model(Some("")), None);
        assert_eq!(split_opencode_model(Some("   ")), None);
        assert_eq!(split_opencode_model(Some("noslash")), None);
        assert_eq!(split_opencode_model(Some("/leading")), None);
        assert_eq!(split_opencode_model(Some("trailing/")), None);
    }
}
