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
//!   kept verbatim (opencode accepts any `provider/model`), else `None` (no
//!   hardcoded default — opencode applies its own configured default).
//! - **effort** (`fresh-agent-models.ts:131-152`): resolve the (normalized) model's
//!   `thinkingEfforts` menu; if the requested effort is on it keep it, else the model's
//!   `defaultEffort` if on the menu, else the last menu entry. opencode does NOT apply
//!   the codex `xhigh→max` rewrite (`:142` is `provider === 'codex'` only).
//! - **wire split** (`serve-events.ts:7-12`): `provider/model` splits on the FIRST
//!   slash into `{ providerID, modelID }`; blank / slashless / edge-slash values yield
//!   `None` so the caller omits `model` and the serve session default applies.

/// `FRESHOPENCODE_DEFAULT_EFFORT` (`fresh-agent-models.ts:19`).
pub const FRESHOPENCODE_DEFAULT_EFFORT: &str = "max";

/// One freshopencode model menu entry (`fresh-agent-models.ts:58-83`).
struct ModelOption {
    value: &'static str,
    thinking_efforts: &'static [&'static str],
    default_effort: &'static str,
}

/// The freshopencode menu (`FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshopencode`,
/// `fresh-agent-models.ts:58-83`). Empty — opencode models come from the live
/// catalog probe, not a static fallback. Kept as an empty slice so the
/// normalization logic (`hasStaticMenu` / `in_static_menu`) structurally
/// matches the TS reference and can accept entries again if needed.
const FRESHOPENCODE_MODEL_OPTIONS: &[ModelOption] = &[];

/// `defaultModelForSession(freshopencode)?.value` (`fresh-agent-models.ts:89-91`) — the
/// first menu entry, or `None` when the menu is empty (no hardcoded default).
fn default_model() -> Option<&'static str> {
    FRESHOPENCODE_MODEL_OPTIONS.first().map(|o| o.value)
}

/// `resolveFreshAgentModelOption(freshopencode, model)` (`fresh-agent-models.ts:93-99`):
/// the matching menu entry, or `None` (no fallback when the menu is empty).
fn resolve_model_option(model: &str) -> Option<&'static ModelOption> {
    FRESHOPENCODE_MODEL_OPTIONS
        .iter()
        .find(|o| o.value == model)
}

/// `normalizeFreshAgentModel(freshopencode, 'opencode', model)` (`fresh-agent-models.ts:114-117`).
pub fn normalize_opencode_model(model: Option<&str>) -> Option<String> {
    let trimmed = model.map(str::trim).unwrap_or("");
    if !trimmed.is_empty() {
        Some(trimmed.to_string())
    } else {
        default_model().map(|s| s.to_string())
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
/// (`fresh-agent-models.ts` — the `hasStaticMenu` opencode branch).
pub fn normalize_opencode_effort(model: Option<&str>, effort: Option<&str>) -> Option<String> {
    // The discriminator is STRICT static-menu membership of the *normalized* model
    // (`.some(option.value === normalizedModel)`), NOT `resolve_model_option`'s
    // fallback-to-first: a live-catalog model the static fallback menu does not
    // know has no declared levels to clamp against. Absent/blank effort there is
    // the model selector's explicit "Default" row → `None`, so NO `variant` is
    // sent and opencode applies the model's own provider-side default (this path
    // previously fabricated `max`). An explicit non-empty effort passes through
    // verbatim — provider-custom names like minimax-m3's `thinking` included.
    let normalized_model = normalize_opencode_model(model);
    let in_static_menu = normalized_model
        .as_deref()
        .map(|m| FRESHOPENCODE_MODEL_OPTIONS.iter().any(|o| o.value == m))
        .unwrap_or(false);
    if !in_static_menu {
        let trimmed = effort.map(str::trim).unwrap_or("");
        return if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }

    // Static-menu model → legacy clamp (a blank/unknown model resolved to the
    // default menu entry above, so it lands here too).
    let options = thinking_options(normalized_model.as_deref());

    // opencode does NOT apply the codex `xhigh→max` rewrite.
    if let Some(e) = effort {
        if options.contains(&e) {
            return Some(e.to_string());
        }
    }

    if let Some(opt) = normalized_model.as_deref().and_then(resolve_model_option) {
        if options.contains(&opt.default_effort) {
            return Some(opt.default_effort.to_string());
        }
    }
    options
        .last()
        .map(|s| s.to_string())
        .or_else(|| Some(FRESHOPENCODE_DEFAULT_EFFORT.to_string()))
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
    fn model_trims_or_returns_none_for_blank() {
        // Non-empty trimmed values pass through verbatim (opencode accepts any id).
        assert_eq!(
            normalize_opencode_model(Some("opencode-go/glm-5.1")).as_deref(),
            Some("opencode-go/glm-5.1")
        );
        assert_eq!(
            normalize_opencode_model(Some("  provider/model  ")).as_deref(),
            Some("provider/model")
        );
        // Blank / missing → None (no hardcoded default; opencode picks its own).
        assert_eq!(normalize_opencode_model(Some("   ")), None);
        assert_eq!(normalize_opencode_model(None), None);
    }

    #[test]
    fn effort_passes_through_for_all_opencode_models() {
        let model = Some("provider/model");
        // On-menu effort passes through verbatim.
        assert_eq!(
            normalize_opencode_effort(model, Some("low")).as_deref(),
            Some("low")
        );
        assert_eq!(
            normalize_opencode_effort(model, Some("max")).as_deref(),
            Some("max")
        );
        // Absent effort → None (explicit Default; no variant sent).
        assert_eq!(normalize_opencode_effort(model, None), None);
        assert_eq!(normalize_opencode_effort(model, Some("   ")), None);
        // Provider-custom effort names pass through verbatim.
        assert_eq!(
            normalize_opencode_effort(model, Some("thinking")).as_deref(),
            Some("thinking")
        );
    }

    #[test]
    fn effort_for_blank_model_is_none() {
        // No static menu → blank model resolves to None → pass-through →
        // absent effort is None (no fabricated default).
        assert_eq!(normalize_opencode_effort(None, None), None);
        assert_eq!(
            normalize_opencode_effort(Some("  "), Some("bogus")),
            Some("bogus".to_string())
        );
    }

    #[test]
    fn split_model_uses_first_slash_and_rejects_edges() {
        assert_eq!(
            split_opencode_model(Some("provider/model")),
            Some(OpencodeModel {
                provider_id: "provider".into(),
                model_id: "model".into(),
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
