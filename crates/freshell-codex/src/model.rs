//! Codex selections are opaque native values. Static defaults apply only to an
//! omitted model; the installed runtime validates explicit model and effort IDs.

pub const FRESHCODEX_DEFAULT_MODEL: &str = "gpt-6-astra";
pub const FRESHCODEX_DEFAULT_EFFORT: &str = "max";
pub const CHEAPEST_T2_MODEL: &str = "gpt-5.3-codex-spark";
pub const FRESHCODEX_EFFORTS_VERBATIM: &[&str] = &["none", "minimal", "low", "medium", "high"];

pub fn normalize_freshcodex_model(model: Option<&str>) -> String {
    model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(FRESHCODEX_DEFAULT_MODEL)
        .to_string()
}

/// Omission leaves the native/configured effort default in control. A catalog
/// can describe a menu, but cannot prove a custom value invalid.
pub fn normalize_freshcodex_effort(_model: Option<&str>, effort: Option<&str>) -> Option<String> {
    effort
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexEffortError(pub String);
impl std::fmt::Display for CodexEffortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Codex reasoning effort must be a nonempty native value")
    }
}
impl std::error::Error for CodexEffortError {}

/// The wire carries every nonempty value verbatim. The legacy max alias is
/// resolved separately, only against capabilities of the installed selected model.
pub fn to_codex_reasoning_effort(value: Option<&str>) -> Result<Option<String>, CodexEffortError> {
    match value {
        None => Ok(None),
        Some(v) if !v.trim().is_empty() => Ok(Some(v.to_string())),
        Some(v) => Err(CodexEffortError(v.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_native_model_choices_are_never_replaced_by_static_defaults() {
        for model in [
            "provider-current",
            "gpt-6.1-sol",
            CHEAPEST_T2_MODEL,
            "gpt-5.4-mini",
        ] {
            assert_eq!(normalize_freshcodex_model(Some(model)), model);
            for effort in [
                "ultra", "none", "minimal", "low", "medium", "high", "xhigh", "max",
            ] {
                assert_eq!(
                    normalize_freshcodex_effort(Some(model), Some(effort)).as_deref(),
                    Some(effort)
                );
                assert_eq!(
                    to_codex_reasoning_effort(Some(effort)).unwrap().as_deref(),
                    Some(effort)
                );
            }
        }
    }
    #[test]
    fn omitted_model_uses_default_and_omitted_effort_uses_native_default() {
        assert_eq!(normalize_freshcodex_model(None), FRESHCODEX_DEFAULT_MODEL);
        assert_eq!(
            normalize_freshcodex_model(Some("  ")),
            FRESHCODEX_DEFAULT_MODEL
        );
        assert_eq!(
            normalize_freshcodex_effort(Some("provider-current"), None),
            None
        );
        assert_eq!(to_codex_reasoning_effort(None), Ok(None));
        assert!(to_codex_reasoning_effort(Some("  ")).is_err());
    }
}
