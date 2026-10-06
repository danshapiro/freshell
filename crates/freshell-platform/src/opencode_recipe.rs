//! Private, unexpanded OpenCode recipes shared by controller and session host.
//! Expanded text is returned only to the caller's transient child environment.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedFileOccurrence {
    pub ordinal: usize,
    pub approved_alias: PathBuf,
    pub runtime_destination: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedFileRecipe {
    pub generated_name: String,
    pub unexpanded_source: String,
    pub declaring_config: PathBuf,
    pub cwd: PathBuf,
    pub original_home: PathBuf,
    pub occurrences: Vec<ApprovedFileOccurrence>,
}

/// Private filesystem metadata linking one native loader occurrence to its
/// original source view. Documents and expanded values are never in this DTO.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceManifest {
    pub version: u8,
    pub cwd: PathBuf,
    pub original_home: PathBuf,
    pub sources: Vec<SourceView>,
    pub files: Vec<SelectedSourceFile>,
    #[serde(default)]
    pub frozen_inputs: Vec<String>,
    #[serde(default)]
    pub user_owns_freshell_mcp: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceView {
    pub logical_path: PathBuf,
    pub lane: SourceLane,
    pub unexpanded_relative_path: String,
    pub template_relative_path: String,
    pub generated_name: Option<String>,
    pub occurrences: Vec<ApprovedFileOccurrence>,
    pub referenced_variables: Vec<String>,
    #[serde(default)]
    pub path_variables: Vec<String>,
    #[serde(default)]
    pub original_form: bool,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceLane {
    Main,
    Tui,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedSourceFile {
    pub source_id: u16,
    pub canonical_source: PathBuf,
}

/// Evaluate a generated child environment value under its 64 KiB value profile.
pub fn evaluate(
    recipe: &GeneratedFileRecipe,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<String, &'static str> {
    let text = evaluate_document(recipe, env)?;
    if text.len() > 64 * 1024 {
        return Err("generated configuration exceeds 64 KiB child value limit");
    }
    Ok(text)
}

/// Validate a direct source using the transformer’s 16 MiB document profile.
/// Direct filesystem sources never become child environment values.
pub fn evaluate_document(
    recipe: &GeneratedFileRecipe,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<String, &'static str> {
    use crate::opencode_config::{file_reference_path, transform_file_tokens, TokenTransformError};
    let changed = "configuration reference selection changed; reprepare before dispatch";
    let mut observed = 0;
    let text = transform_file_tokens(&recipe.unexpanded_source, env, |token| {
        let path = file_reference_path(
            token.path,
            &recipe.declaring_config,
            &recipe.cwd,
            &recipe.original_home,
        );
        let occurrence = recipe
            .occurrences
            .get(token.ordinal)
            .filter(|approved| approved.ordinal == token.ordinal && approved.approved_alias == path)
            .ok_or(changed)?;
        observed += 1;
        Ok(format!("{{file:{}}}", occurrence.runtime_destination))
    })
    .map_err(|error| match error {
        TokenTransformError::Selection(cause) => cause,
        TokenTransformError::Bound(_) => "configuration recipe profile limit exceeded",
    })?;
    if observed != recipe.occurrences.len() {
        return Err(changed);
    }
    Ok(text)
}
