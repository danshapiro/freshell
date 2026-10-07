//! Origin-aware managed provider configuration references.
//! Plans retain approved source metadata and unexpanded templates, never payload bytes.
use std::path::{Path, PathBuf};

pub(crate) mod codex;
pub(crate) mod environment;
pub(crate) mod sources;

pub struct FileSourceOrigin<'a> {
    pub declaring_config: &'a Path,
    pub cwd: &'a Path,
    pub original_home: &'a Path,
}

#[derive(Debug)]
pub struct ReferenceError {
    pub operation: &'static str,
    pub field: &'static str,
    pub source_ordinal: usize,
    pub declaring_source: PathBuf,
    pub variables: Vec<String>,
    pub cause: &'static str,
}
impl std::fmt::Display for ReferenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {} occurrence {} in {}: {}",
            self.operation,
            self.field,
            self.source_ordinal,
            self.declaring_source.display(),
            self.cause
        )
    }
}
impl std::error::Error for ReferenceError {}

pub struct FileReferenceSelection {
    pub canonical_source: PathBuf,
    pub runtime_destination: String,
    pub source_ordinal: usize,
}

pub use freshell_platform::opencode_recipe::{ApprovedFileOccurrence, GeneratedFileRecipe};

#[derive(Clone, Copy)]
pub(crate) enum NativeAliasKind {
    Relative,
    Absolute,
    Home,
}

pub struct ResolvedFileReferencePlan {
    pub template: std::sync::Arc<String>,
    // Generated recipes already own the raw view. Keep one raw view for
    // direct references too; a rewritten template cannot revalidate selection.
    unexpanded_direct_source: Option<std::sync::Arc<String>>,
    pub selections: Vec<FileReferenceSelection>,
    pub referenced_variables: Vec<String>,
    pub path_variables: Vec<String>,
    pub recipes: Vec<GeneratedFileRecipe>,
    pub occurrences: Vec<ApprovedFileOccurrence>,
    pub substitution_events: usize,
    pub native_alias_kinds: std::collections::BTreeMap<usize, NativeAliasKind>,
}
impl ResolvedFileReferencePlan {
    pub fn unexpanded_source(&self) -> &str {
        self.unexpanded_direct_source.as_deref().unwrap_or_else(|| {
            &self
                .recipes
                .first()
                .expect("generated plan owns its source")
                .unexpanded_source
        })
    }
}

pub fn resolve_file_references(
    raw: &str,
    origin: FileSourceOrigin<'_>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<ResolvedFileReferencePlan, ReferenceError> {
    let mut next = 0usize;
    resolve_file_references_allocated(raw, origin, env, 0, &mut |_| {
        let destination = format!("/home/freshell/provider/.freshell/references/{next}");
        next += 1;
        Ok(destination)
    })
}

pub(super) fn resolve_file_references_allocated(
    raw: &str,
    origin: FileSourceOrigin<'_>,
    env: &dyn Fn(&str) -> Option<String>,
    recipe_ordinal: usize,
    allocate: &mut dyn FnMut(&Path) -> Result<String, &'static str>,
) -> Result<ResolvedFileReferencePlan, ReferenceError> {
    resolve_file_references_from_view(raw, None, origin, env, recipe_ordinal, allocate)
}

pub(super) fn resolve_file_references_from_view(
    raw: &str,
    source_view: Option<std::sync::Arc<String>>,
    origin: FileSourceOrigin<'_>,
    env: &dyn Fn(&str) -> Option<String>,
    recipe_ordinal: usize,
    allocate: &mut dyn FnMut(&Path) -> Result<String, &'static str>,
) -> Result<ResolvedFileReferencePlan, ReferenceError> {
    resolve_file_references_from_view_relocated(
        raw,
        source_view,
        origin,
        env,
        recipe_ordinal,
        allocate,
        ReferenceProjection {
            relocated_files: &std::collections::BTreeMap::new(),
            original_form: false,
        },
    )
}
pub(super) struct ReferenceProjection<'a> {
    pub relocated_files: &'a std::collections::BTreeMap<PathBuf, PathBuf>,
    pub original_form: bool,
}
pub(super) fn resolve_file_references_from_view_relocated(
    raw: &str,
    source_view: Option<std::sync::Arc<String>>,
    origin: FileSourceOrigin<'_>,
    env: &dyn Fn(&str) -> Option<String>,
    recipe_ordinal: usize,
    allocate: &mut dyn FnMut(&Path) -> Result<String, &'static str>,
    projection: ReferenceProjection<'_>,
) -> Result<ResolvedFileReferencePlan, ReferenceError> {
    use freshell_platform::opencode_config::{
        file_reference_path, transform_file_tokens, TokenTransformError,
    };
    let mut selections: Vec<FileReferenceSelection> = Vec::new();
    let mut rewritten = Vec::new();
    let mut native_alias_kinds = std::collections::BTreeMap::new();
    let mut occurrences = Vec::new();
    let mut path_variables = std::collections::BTreeSet::new();
    let mut generated = false;
    let mut planned_bytes = 0u64;
    let mut aliases = std::collections::BTreeSet::new();
    let variables = std::cell::RefCell::new(std::collections::BTreeSet::new());
    let substitution_events = std::cell::Cell::new(0usize);
    let input_error = std::cell::Cell::new(None);
    let fail = |ordinal, variables: Vec<String>, cause| ReferenceError {
        operation: "resolve",
        field: "OpenCode file",
        source_ordinal: ordinal,
        declaring_source: origin.declaring_config.into(),
        variables,
        cause,
    };
    let lookup = |name: &str| {
        let mut variables = variables.borrow_mut();
        if variables.len() >= 128 && !variables.contains(name) {
            input_error.set(Some("referenced variable count exceeds 128"));
            return None;
        }
        variables.insert(name.to_owned());
        substitution_events.set(substitution_events.get() + 1);
        env(name)
    };
    let transformed = transform_file_tokens(raw, &lookup, |token| {
        let names: Vec<String> = token
            .variables
            .iter()
            .map(|name| name.to_string())
            .collect();
        path_variables.extend(names.iter().cloned());
        substitution_events.set(substitution_events.get() + 1);
        if substitution_events.get() > 8192 {
            return Err(fail(
                token.ordinal,
                names,
                "source substitution event count exceeds 8192",
            ));
        }
        generated |= !token.direct_expression;
        let path = file_reference_path(
            token.path,
            origin.declaring_config,
            origin.cwd,
            origin.original_home,
        );
        let physical_source = projection.relocated_files.get(&path).unwrap_or(&path);
        let canonical = std::fs::canonicalize(physical_source).map_err(|_| {
            fail(
                token.ordinal,
                names.clone(),
                "referenced file is missing, inaccessible or cyclic",
            )
        })?;
        let metadata = std::fs::metadata(&canonical).map_err(|_| {
            fail(
                token.ordinal,
                names.clone(),
                "referenced file metadata unavailable",
            )
        })?;
        if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
            return Err(fail(
                token.ordinal,
                names,
                "referenced target must be a regular file at most 16 MiB",
            ));
        }
        std::fs::File::open(&canonical).map_err(|_| {
            fail(
                token.ordinal,
                names.clone(),
                "referenced file is unreadable",
            )
        })?;
        let destination =
            if let Some(selection) = selections.iter().find(|s| s.canonical_source == canonical) {
                selection.runtime_destination.clone()
            } else {
                if selections.len() >= 128 {
                    return Err(fail(
                        token.ordinal,
                        names,
                        "configuration reference count exceeds 128",
                    ));
                }
                planned_bytes = planned_bytes.checked_add(metadata.len()).ok_or_else(|| {
                    fail(
                        token.ordinal,
                        names.clone(),
                        "configuration reference size overflow",
                    )
                })?;
                if planned_bytes > 32 * 1024 * 1024 {
                    return Err(fail(
                        token.ordinal,
                        names,
                        "configuration references exceed 32 MiB",
                    ));
                }
                let destination = allocate(&canonical)
                    .map_err(|cause| fail(token.ordinal, names.clone(), cause))?;
                selections.push(FileReferenceSelection {
                    canonical_source: canonical,
                    runtime_destination: destination.clone(),
                    source_ordinal: token.ordinal,
                });
                destination
            };
        if aliases.insert(path.clone()) && aliases.len() > 256 {
            return Err(fail(
                token.ordinal,
                names,
                "configuration alias count exceeds 256",
            ));
        }
        occurrences.push(ApprovedFileOccurrence {
            ordinal: token.ordinal,
            approved_alias: path,
            runtime_destination: destination.clone(),
        });
        let replacement = format!("{{file:{destination}}}");
        let kind = if token.path.starts_with("~/") {
            NativeAliasKind::Home
        } else if Path::new(token.path).is_absolute() {
            NativeAliasKind::Absolute
        } else {
            NativeAliasKind::Relative
        };
        // Only literal source-independent paths can receive an identical edit
        // at a shared inode. Relative paths and loader-specific interpolation
        // retain native evaluation and their approved occurrence aliases.
        let selective = token.direct_expression
            && token.variables.is_empty()
            && !matches!(kind, NativeAliasKind::Relative);
        if !projection.original_form || selective {
            rewritten.push((token.original_span, replacement.clone()));
        } else {
            native_alias_kinds.insert(token.ordinal, kind);
        }
        Ok(replacement)
    })
    .map_err(|error| match error {
        TokenTransformError::Selection(error) => error,
        TokenTransformError::Bound(_) => fail(
            0,
            Vec::new(),
            "configuration source, expansion or event profile limit exceeded",
        ),
    })?;
    if let Some(cause) = input_error.get() {
        return Err(fail(0, Vec::new(), cause));
    }
    let transformed_length = transformed.len();
    drop(transformed);
    let (template, recipes) = if generated && !projection.original_form {
        let generated_name =
            freshell_platform::opencode_config::generated_config_reference_name(recipe_ordinal);
        if transformed_length > 64 * 1024 {
            return Err(fail(
                0,
                Vec::new(),
                "generated configuration exceeds 64 KiB child value limit",
            ));
        }
        if env(&generated_name).is_some() || raw.contains(&format!("{{env:{generated_name}}}")) {
            return Err(fail(
                0,
                vec![generated_name],
                "generated configuration name collides with an original child input",
            ));
        }
        (
            format!("{{env:{generated_name}}}"),
            vec![GeneratedFileRecipe {
                generated_name,
                unexpanded_source: raw.into(),
                declaring_config: origin.declaring_config.into(),
                cwd: origin.cwd.into(),
                original_home: origin.original_home.into(),
                occurrences: occurrences.clone(),
            }],
        )
    } else {
        let mut template = String::new();
        let mut cursor = 0;
        for (span, replacement) in rewritten {
            template.push_str(&raw[cursor..span.start]);
            template.push_str(&replacement);
            cursor = span.end;
        }
        template.push_str(&raw[cursor..]);
        (template, Vec::new())
    };
    let unexpanded_direct_source = (!generated || projection.original_form)
        .then(|| source_view.unwrap_or_else(|| std::sync::Arc::new(raw.to_owned())));
    let template = if template == raw {
        unexpanded_direct_source
            .as_ref()
            .cloned()
            .unwrap_or_else(|| std::sync::Arc::new(template))
    } else {
        std::sync::Arc::new(template)
    };
    Ok(ResolvedFileReferencePlan {
        template,
        unexpanded_direct_source,
        selections,
        referenced_variables: variables.into_inner().into_iter().collect(),
        path_variables: path_variables.into_iter().collect(),
        recipes,
        occurrences,
        substitution_events: substitution_events.get(),
        native_alias_kinds,
    })
}

pub fn evaluate_generated_recipe(
    recipe: &GeneratedFileRecipe,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<String, ReferenceError> {
    freshell_platform::opencode_recipe::evaluate(recipe, env).map_err(|cause| ReferenceError {
        operation: "prepare",
        field: "OpenCode generated configuration",
        source_ordinal: 0,
        declaring_source: recipe.declaring_config.clone(),
        variables: Vec::new(),
        cause,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    // Pinned resolver-equivalent consumer for OpenCode 1.18.21 variable.ts.
    // Receipt is a digest of values consumed by its native JSONC/file substitution.
    const CONSUMER: &str = r#"
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const source=process.argv[1],home=process.argv[2],env=JSON.parse(process.argv[3]);
let text=fs.readFileSync(source,'utf8').replace(/\{env:([^}]+)\}/g,(_,n)=>env[n]||'');
let out='',cursor=0;
for(const m of Array.from(text.matchAll(/\{file:[^}]+\}/g))) {
  out+=text.slice(cursor,m.index);
  if(text.slice(text.lastIndexOf('\n',m.index-1)+1,m.index).trimStart().startsWith('//')) out+=m[0];
  else {
    const target=m[0].slice(6,-1),prefix='/home/freshell/provider/';
    if(!target.startsWith(prefix)) process.exit(71);
    const bytes=fs.readFileSync(path.join(home,target.slice(prefix.length)),'utf8');
    out+=JSON.stringify(bytes.trim()).slice(1,-1);
  }
  cursor=m.index+m[0].length;
}
out+=text.slice(cursor);
const parsed=JSON.parse(out),receipts=Object.values(parsed).map(v=>crypto.createHash('sha256').update(v).digest('hex'));
process.stdout.write(JSON.stringify(receipts));
"#;

    fn digest(value: &str) -> String {
        format!("{:x}", Sha256::digest(value.as_bytes()))
    }
    fn consume(plan: &ResolvedFileReferencePlan, runtime: &Path) -> Vec<String> {
        consume_with_env(plan, runtime, &|_| None)
    }
    fn consume_with_env(
        plan: &ResolvedFileReferencePlan,
        runtime: &Path,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Vec<String> {
        std::fs::create_dir_all(runtime.join(".freshell/references")).unwrap();
        for selection in &plan.selections {
            let relative = selection
                .runtime_destination
                .strip_prefix("/home/freshell/provider/")
                .unwrap();
            std::fs::copy(&selection.canonical_source, runtime.join(relative)).unwrap();
        }
        let source = runtime.join("source.json");
        std::fs::write(&source, plan.template.as_bytes()).unwrap();
        let mut child = std::collections::BTreeMap::new();
        for recipe in &plan.recipes {
            child.insert(
                recipe.generated_name.clone(),
                evaluate_generated_recipe(recipe, env).unwrap(),
            );
        }
        let result = std::process::Command::new("node")
            .arg("-e")
            .arg(CONSUMER)
            .arg(&source)
            .arg(runtime)
            .arg(serde_json::to_string(&child).unwrap())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "pinned consumer failed with {:?}",
            result.status.code()
        );
        serde_json::from_slice(&result.stdout).unwrap()
    }

    #[test]
    fn managed_provider_references_child_consumes_original_absolute_relative_home_spaces_and_symlink(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("original-home");
        let declaring = temp.path().join("project/nested");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&declaring).unwrap();
        let payload = "  synthetic-nonce-quote\"slash\\\ntrim  ";
        for path in [
            home.join("home-ref"),
            declaring.join("relative-ref"),
            declaring.join("with spaces"),
            temp.path().join("external-ref"),
        ] {
            std::fs::write(path, payload).unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink("relative-ref", declaring.join("linked-ref")).unwrap();
        let targets = vec![
            temp.path().join("external-ref").display().to_string(),
            "relative-ref".into(),
            "~/home-ref".into(),
            "with spaces".into(),
            "linked-ref".into(),
        ];
        for target in targets {
            let raw = serde_json::json!({"instructions":format!("{{file:{target}}}")}).to_string();
            let original = declaring.join("opencode.json");
            std::fs::write(&original, &raw).unwrap();
            let plan = resolve_file_references(
                &raw,
                FileSourceOrigin {
                    declaring_config: &original,
                    cwd: &declaring,
                    original_home: &home,
                },
                &|_| None,
            )
            .unwrap();
            assert_eq!(
                consume(&plan, &temp.path().join("runtime")),
                vec![digest(payload.trim())]
            );
            assert_eq!(std::fs::read_to_string(&original).unwrap(), raw);
            assert!(!plan.template.contains("synthetic-nonce"));
        }
    }
    #[test]
    fn managed_provider_references_same_relative_spelling_keeps_each_declaring_origin() {
        let temp = tempfile::tempdir().unwrap();
        for (index, nonce) in ["first-origin-nonce", "second-origin-nonce"]
            .iter()
            .enumerate()
        {
            let origin = temp.path().join(format!("origin-{index}"));
            std::fs::create_dir_all(&origin).unwrap();
            std::fs::write(origin.join("rules"), nonce).unwrap();
            let config = origin.join("opencode.json");
            let raw = r#"{"instructions":"{file:rules}"}"#;
            let plan = resolve_file_references(
                raw,
                FileSourceOrigin {
                    declaring_config: &config,
                    cwd: temp.path(),
                    original_home: temp.path(),
                },
                &|_| None,
            )
            .unwrap();
            assert_eq!(
                consume(&plan, &temp.path().join(format!("runtime-{index}"))),
                vec![digest(nonce)]
            );
        }
    }
    #[test]
    fn managed_provider_references_nested_path_env_is_consumed_without_forwarding_value() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("private-path-ref");
        std::fs::write(&target, "nested-path-consumption-nonce").unwrap();
        let source = temp.path().join("opencode.json");
        let raw = r#"{"instructions":"{file:{env:NODE_EXTRA_CA_CERTS}}"}"#;
        let plan = resolve_file_references(
            raw,
            FileSourceOrigin {
                declaring_config: &source,
                cwd: temp.path(),
                original_home: temp.path(),
            },
            &|name| (name == "NODE_EXTRA_CA_CERTS").then(|| target.display().to_string()),
        )
        .unwrap();
        assert_eq!(
            consume(&plan, &temp.path().join("runtime")),
            vec![digest("nested-path-consumption-nonce")]
        );
        assert_eq!(plan.referenced_variables, vec!["NODE_EXTRA_CA_CERTS"]);
        assert!(!plan.template.contains("private-path-ref"));
    }
    #[test]
    fn managed_provider_references_missing_and_cyclic_targets_fail_without_echoing_candidate_values(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("opencode.json");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("cycle-b", temp.path().join("cycle-a")).unwrap();
            std::os::unix::fs::symlink("cycle-a", temp.path().join("cycle-b")).unwrap();
        }
        for target in ["private-missing-candidate", "cycle-a"] {
            let result = resolve_file_references(
                r#"{"x":"{file:{env:PATH_INPUT}}"}"#,
                FileSourceOrigin {
                    declaring_config: &source,
                    cwd: temp.path(),
                    original_home: temp.path(),
                },
                &|_| Some(temp.path().join(target).display().to_string()),
            );
            let err = result
                .err()
                .expect("missing or cyclic reference cannot launch");
            assert_eq!(err.source_ordinal, 0);
            assert_eq!(err.variables, vec!["PATH_INPUT"]);
            assert!(!format!("{err:?} {err}").contains(target));
        }
    }
    #[test]
    fn managed_provider_references_env_introduced_file_tokens_and_private_prefix_use_child_recipe()
    {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("reference");
        std::fs::write(&target, "  payload-nonce  ").unwrap();
        let source = temp.path().join("opencode.json");
        let raw = r#"{"instructions":"{env:OPENAI_API_KEY}"}"#;
        let lookup = |name: &str| {
            (name == "OPENAI_API_KEY").then(|| {
                format!(
                    "sentinel-private-prefix{{file:{}}}sentinel-private-suffix",
                    target.display()
                )
            })
        };
        let plan = resolve_file_references(
            raw,
            FileSourceOrigin {
                declaring_config: &source,
                cwd: temp.path(),
                original_home: temp.path(),
            },
            &lookup,
        )
        .unwrap();
        assert!(!plan.template.contains("sentinel-private"));
        assert_eq!(plan.recipes.len(), 1);
        assert!(!plan.recipes[0]
            .unexpanded_source
            .contains("sentinel-private"));
        assert_eq!(
            consume_with_env(&plan, &temp.path().join("runtime"), &lookup),
            vec![digest(
                "sentinel-private-prefixpayload-noncesentinel-private-suffix"
            )]
        );
    }

    #[test]
    fn managed_provider_references_changed_grant_selection_blocks_before_child_and_keeps_prior_projection(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        std::fs::write(&a, "prior-usable-nonce").unwrap();
        std::fs::write(&b, "unapproved-new-nonce").unwrap();
        let source = temp.path().join("opencode.json");
        let initial = |name: &str| {
            (name == "OPENAI_API_KEY").then(|| format!("prefix{{file:{}}}", a.display()))
        };
        let plan = resolve_file_references(
            r#"{"x":"{env:OPENAI_API_KEY}"}"#,
            FileSourceOrigin {
                declaring_config: &source,
                cwd: temp.path(),
                original_home: temp.path(),
            },
            &initial,
        )
        .unwrap();
        let previous = temp.path().join("runtime");
        assert_eq!(
            consume_with_env(&plan, &previous, &initial),
            vec![digest("prefixprior-usable-nonce")]
        );
        let changed = |name: &str| {
            (name == "OPENAI_API_KEY")
                .then(|| format!("sentinel-private-changed{{file:{}}}", b.display()))
        };
        let err = evaluate_generated_recipe(&plan.recipes[0], &changed)
            .err()
            .unwrap();
        assert!(err.cause.contains("selection changed"));
        assert!(!format!("{err:?} {err}").contains("sentinel-private"));
        assert_eq!(
            std::fs::read_to_string(previous.join(".freshell/references/0")).unwrap(),
            "prior-usable-nonce"
        );
        let same_selection = |name: &str| {
            (name == "OPENAI_API_KEY").then(|| format!("different-prefix{{file:{}}}", a.display()))
        };
        assert!(evaluate_generated_recipe(&plan.recipes[0], &same_selection)
            .unwrap()
            .contains("different-prefix"));
    }
    #[test]
    fn managed_provider_references_whole_document_native_wrapper_handles_outside_lexeme_expansion()
    {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("reference");
        std::fs::write(&target, "document-consumption-nonce").unwrap();
        let source = temp.path().join("opencode.json");
        let lookup = |name: &str| {
            (name == "OPENAI_API_KEY").then(|| {
                serde_json::json!({"instructions":format!("{{file:{}}}",target.display())})
                    .to_string()
            })
        };
        let plan = resolve_file_references(
            "{env:OPENAI_API_KEY}",
            FileSourceOrigin {
                declaring_config: &source,
                cwd: temp.path(),
                original_home: temp.path(),
            },
            &lookup,
        )
        .unwrap();
        assert_eq!(
            consume_with_env(&plan, &temp.path().join("runtime"), &lookup),
            vec![digest("document-consumption-nonce")]
        );
        assert_eq!(plan.recipes[0].unexpanded_source, "{env:OPENAI_API_KEY}");
    }
    #[test]
    fn managed_provider_references_virtual_inline_uses_instance_cwd() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("rules"), "inline-instance-nonce").unwrap();
        let plan = resolve_file_references(
            r#"{"x":"{file:rules}"}"#,
            FileSourceOrigin {
                declaring_config: Path::new("OPENCODE_CONFIG_CONTENT"),
                cwd: temp.path(),
                original_home: temp.path(),
            },
            &|_| None,
        )
        .unwrap();
        assert_eq!(
            consume(&plan, &temp.path().join("runtime")),
            vec![digest("inline-instance-nonce")]
        );
    }
    #[test]
    fn managed_provider_references_relative_parent_is_lexical_before_following_directory_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let logical = temp.path().join("logical");
        let actual = temp.path().join("actual/config");
        std::fs::create_dir_all(&logical).unwrap();
        std::fs::create_dir_all(&actual).unwrap();
        std::fs::write(logical.join("rules"), "native-lexical-origin-nonce").unwrap();
        std::fs::write(
            temp.path().join("actual/rules"),
            "wrong-physical-origin-nonce",
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&actual, logical.join("linked")).unwrap();
        let source = logical.join("linked/opencode.json");
        let plan = resolve_file_references(
            r#"{"x":"{file:../rules}"}"#,
            FileSourceOrigin {
                declaring_config: &source,
                cwd: temp.path(),
                original_home: temp.path(),
            },
            &|_| None,
        )
        .unwrap();
        assert_eq!(
            consume(&plan, &temp.path().join("runtime")),
            vec![digest("native-lexical-origin-nonce")]
        );
    }
}

pub(crate) struct PreparedManagedOpencode {
    pub context: freshell_runtime_protocol::ProviderLaunchContext,
    pub references: Vec<freshell_runtime_protocol::ProviderSecretReference>,
}

/// Terminal, fresh and scoped replacement callers share this one preparation.
/// The original lookup and decoded grants never enter the returned metadata.
pub(crate) struct OpencodePreparation<'a> {
    pub client: &'a freshell_runtime_client::RuntimeClient,
    pub soul: &'a freshell_runtime_protocol::SoulId,
    pub creation_seed: &'a str,
    pub home: &'a Path,
    pub cwd: &'a Path,
    pub workspace: &'a Path,
    pub original: &'a (dyn Fn(&str) -> Option<String> + Sync),
    pub references: Vec<freshell_runtime_protocol::ProviderSecretReference>,
    pub auth_authority: Option<&'a str>,
    pub selected_sources: Option<Vec<sources::SourceOccurrence>>,
    pub accepted_global_root: Option<PathBuf>,
    pub selected_resource_roots: Option<Vec<sources::DiscoveryRoot>>,
    pub native_source_flags: Option<Vec<freshell_platform::opencode_recipe::NativeSourceFlag>>,
    pub rebind_enabled: Option<bool>,
    pub inherited_inline: Option<String>,
    pub inline_edits: Option<freshell_platform::opencode_config::OwnedConfigEdits>,
}

pub(crate) async fn prepare_managed_opencode(
    request: OpencodePreparation<'_>,
) -> Result<PreparedManagedOpencode, String> {
    prepare_managed_opencode_with_publisher(
        request,
        crate::managed_mcp_capability::issue_prepared_opencode_context,
    )
    .await
}

pub(crate) async fn prepare_managed_opencode_with_publisher(
    request: OpencodePreparation<'_>,
    publish: impl FnOnce(
        &freshell_runtime_protocol::SoulId,
        &Path,
        &freshell_runtime_protocol::ProviderLaunchContext,
        crate::managed_mcp_capability::OpencodeEphemeralInput<'_>,
    ) -> Result<freshell_runtime_protocol::ProviderLaunchContext, String>,
) -> Result<PreparedManagedOpencode, String> {
    let OpencodePreparation {
        client,
        soul,
        creation_seed,
        home,
        cwd,
        workspace,
        original,
        mut references,
        auth_authority,
        selected_sources,
        accepted_global_root,
        selected_resource_roots,
        native_source_flags,
        rebind_enabled,
        inherited_inline,
        inline_edits,
    } = request;
    let rebind_enabled = rebind_enabled.unwrap_or_else(|| {
        !matches!(
            original("FRESHELL_OPENCODE_REBIND").as_deref(),
            Some("0" | "false")
        )
    });
    use sources::*;
    let inherited_inline = inherited_inline
        .or_else(|| original("OPENCODE_CONFIG_CONTENT"))
        .filter(|raw| !raw.is_empty());
    let mut inline_edits = inline_edits.unwrap_or_default();
    inline_edits.freshell_command = Some(vec!["node".into(), "/opt/freshell-mcp/server.js".into()]);
    if inline_edits.bash_permission.is_none() {
        inline_edits.bash_permission = original("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION")
            .filter(|value| matches!(value.as_str(), "allow" | "ask" | "deny"));
    }
    let config_root = if let Some(root) = accepted_global_root {
        if !root.is_absolute() || root.file_name() != Some(std::ffi::OsStr::new("opencode")) {
            return Err(
                "accepted global configuration root is invalid; retain prior inputs and reprepare"
                    .into(),
            );
        }
        root
    } else {
        let xdg = original("XDG_CONFIG_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        let xdg = if xdg.is_absolute() {
            xdg
        } else {
            cwd.join(xdg)
        };
        xdg.join("opencode")
    };
    let xdg = config_root
        .parent()
        .ok_or("global configuration root parent unavailable")?;
    let resource_roots = if let Some(roots) = selected_resource_roots {
        roots
    } else {
        sources::select_opencode_resource_roots(&OpencodeDiscovery {
            home,
            cwd,
            worktree: workspace,
            config_root: &config_root,
            env: original,
        })
        .map_err(str::to_string)?
    };
    let base = crate::managed_provider_bootstrap::provider_launch_context_from_home_at_with_xdg(
        "opencode",
        workspace,
        cwd,
        home,
        Some(xdg),
        None,
    )?
    .ok_or("OpenCode provider preparation unavailable")?;
    let selected = if let Some(sources) = selected_sources {
        sources
    } else {
        discover_opencode(OpencodeDiscovery {
            home,
            cwd,
            worktree: workspace,
            config_root: &config_root,
            env: original,
        })
        .map_err(str::to_string)?
    };
    let mut loaded = read_opencode_sources(selected).map_err(|error| error.to_string())?;
    if let Some(raw) = inherited_inline {
        if raw.len() > 16 * 1024 * 1024 {
            return Err("OpenCode inherited inline source exceeds 16 MiB".into());
        }
        let retained = sources::retained_source_view_bytes(&loaded)
            .map_err(str::to_string)?
            .checked_add(raw.len())
            .ok_or("source-view size overflow")?;
        let remaining = (64 * 1024 * 1024usize)
            .checked_sub(retained)
            .ok_or("simultaneous source views exceed 64 MiB")?;
        let user_owns_freshell_mcp = loaded
            .iter()
            .filter(|source| source.source.lane == SourceLane::Main)
            .try_fold(false, |owned, source| {
                freshell_platform::opencode_config::source_owns_freshell_mcp(
                    &source.view,
                    &source.source.logical_path,
                    cwd,
                )
                .map(|user_owns| owned || user_owns)
            })
            .map_err(|error| error.to_string())?;
        let view = freshell_platform::opencode_config::merge_owned_entries_bounded(
            Some(&raw),
            &freshell_platform::opencode_config::OpencodeConfigPlan {
                sources: vec![],
                user_owns_freshell_mcp,
                inline_prepared: false,
            },
            &inline_edits,
            remaining.min(64 * 1024),
        )
        .map_err(|error| error.to_string())?;
        let inline = LoadedSourceOccurrence {
            requires_config_bind: true,
            source: SourceOccurrence {
                logical_path: "OPENCODE_CONFIG_CONTENT".into(),
                canonical_source: "OPENCODE_CONFIG_CONTENT".into(),
                lane: SourceLane::Inline,
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            },
            view: std::sync::Arc::new(view),
        };
        let position = loaded
            .iter()
            .position(|source| source.source.lane == SourceLane::Tui)
            .unwrap_or(loaded.len());
        loaded.insert(position, inline);
    }
    let native_source_flags = if let Some(flags) = native_source_flags {
        flags
    } else {
        let mut flags = Vec::new();
        for (name, kind) in [
            (
                "OPENCODE_CONFIG",
                freshell_platform::opencode_recipe::NativeSourceFlagKind::Main,
            ),
            (
                "OPENCODE_TUI_CONFIG",
                freshell_platform::opencode_recipe::NativeSourceFlagKind::Tui,
            ),
        ] {
            if let Some(path) = original(name).filter(|path| !path.is_empty()) {
                let path = if Path::new(&path).is_absolute() {
                    PathBuf::from(path)
                } else {
                    cwd.join(path)
                };
                let source_ordinal = loaded
                    .iter()
                    .position(|source| source.source.logical_path == path && source.source.role == DiscoveryRole::Workspace && match kind {
                        freshell_platform::opencode_recipe::NativeSourceFlagKind::Main => source.source.lane == SourceLane::Main,
                        freshell_platform::opencode_recipe::NativeSourceFlagKind::Tui => source.source.lane == SourceLane::Tui,
                        freshell_platform::opencode_recipe::NativeSourceFlagKind::Directory => false,
                    }).ok_or_else(|| format!("selected {name} source is missing or unavailable; repair it before dispatch"))?;
                let destination = sources::runtime_config_destination(
                    home,
                    &config_root,
                    &path,
                    loaded[source_ordinal].source.role,
                );
                flags.push(freshell_platform::opencode_recipe::NativeSourceFlag {
                    kind,
                    source_ordinal: Some(
                        u16::try_from(source_ordinal)
                            .map_err(|_| "native source ordinal overflow")?,
                    ),
                    runtime_destination: destination
                        .to_str()
                        .ok_or("selected native source destination is not UTF-8")?
                        .into(),
                });
            }
        }
        if let Some(path) = original("OPENCODE_CONFIG_DIR").filter(|path| !path.is_empty()) {
            let path = if Path::new(&path).is_absolute() {
                PathBuf::from(path)
            } else {
                cwd.join(path)
            };
            if !resource_roots.iter().any(|root| root.logical_path == path) {
                return Err(
                    "selected OPENCODE_CONFIG_DIR root is unavailable before dispatch".into(),
                );
            }
            flags.push(freshell_platform::opencode_recipe::NativeSourceFlag {
                kind: freshell_platform::opencode_recipe::NativeSourceFlagKind::Directory,
                source_ordinal: None,
                runtime_destination: sources::runtime_directory_destination(
                    home,
                    &config_root,
                    &path,
                    DiscoveryRole::Workspace,
                )
                .to_str()
                .ok_or("selected directory is not UTF-8")?
                .into(),
            });
        }
        flags
    };
    let mut retained_views =
        sources::retained_source_view_bytes(&loaded).map_err(str::to_string)?;
    let mut edited = std::collections::BTreeSet::new();
    for ordinal in 0..loaded.len() {
        let source = &loaded[ordinal];
        if rebind_enabled
            && source.source.lane == SourceLane::Tui
            && native_source_flags.iter().any(|flag| {
                flag.kind == freshell_platform::opencode_recipe::NativeSourceFlagKind::Tui
                    && Path::new(&flag.runtime_destination)
                        == sources::runtime_config_destination(
                            home,
                            &config_root,
                            &source.source.logical_path,
                            source.source.role,
                        )
            })
        {
            let canonical = source.source.canonical_source.clone();
            if !edited.insert(canonical.clone()) {
                continue;
            }
            let shared = loaded
                .iter()
                .filter(|source| source.source.canonical_source == canonical)
                .count()
                > 1;
            let remaining = (64 * 1024 * 1024usize)
                .checked_sub(retained_views)
                .ok_or("simultaneous source views exceed 64 MiB")?;
            let runtime_home = Path::new("/home/freshell/provider");
            let plugin = if shared {
                freshell_platform::opencode_plugin::rebind_plugin_package_path(runtime_home)
            } else {
                freshell_platform::opencode_plugin::rebind_plugin_path(runtime_home)
            };
            let content = freshell_platform::opencode_plugin::selected_tui_content_bounded(
                &source.view,
                &plugin,
                remaining,
            )
            .map_err(|_| {
                format!(
                    "selected OpenCode TUI source {} has invalid JSONC/plugin list or exceeds the source-view profile",
                    source.source.logical_path.display()
                )
            })?;
            if content.len() > 16 * 1024 * 1024 {
                return Err("selected OpenCode effective TUI source exceeds 16 MiB".into());
            }
            retained_views = retained_views
                .checked_add(content.len())
                .ok_or("source-view byte count overflow")?;
            let view = std::sync::Arc::new(content);
            for (index, source) in loaded.iter_mut().enumerate() {
                if index == ordinal || shared && source.source.canonical_source == canonical {
                    source.view = view.clone();
                    source.requires_config_bind = true;
                }
            }
        }
    }
    let names = source_environment_names(&loaded).map_err(|error| error.to_string())?;
    let mut environment = environment::SourceEnvironment::read(names, &references, original)?;
    // Even a typed auth grant needs explicit ownership of a newly absent soul
    // volume before its descriptor-owned mountpoints can be constructed.
    let reservation = if auth_authority.is_none() {
        Some(
            client
                .reserve_provider_inputs(soul.clone(), "opencode".into(), creation_seed.into())
                .await
                .map_err(|error| error.to_string())?
                .reservation_id,
        )
    } else {
        None
    };
    if environment.needs_native_auth()
        && loaded
            .iter()
            .any(|source| source.source.lane == SourceLane::Main)
    {
        let authority = if let Some(authority) = auth_authority {
            authority.to_owned()
        } else {
            reservation
                .clone()
                .ok_or("initial provider input reservation unavailable")?
        };
        let values = client
            .native_auth_lookup(soul.clone(), authority, environment.names().to_vec())
            .await
            .map_err(|error| error.to_string())?;
        environment.set_native_auth(values.0)?;
    }
    let plan = environment
        .plan_sources(loaded, cwd, home)
        .map_err(|error| error.to_string())?;
    let frozen = environment.frozen_inputs(&plan)?;
    let frozen_names = frozen
        .iter()
        .map(|(name, _)| name.to_owned())
        .collect::<Vec<_>>();
    let mut files = std::collections::BTreeMap::new();
    for source in &plan {
        for selection in &source.references.selections {
            let id = selection
                .runtime_destination
                .strip_prefix("/home/freshell/provider/.freshell/references/")
                .and_then(|value| value.parse::<u16>().ok())
                .ok_or("invalid prepared source index")?;
            if files
                .insert(id, selection.canonical_source.clone())
                .is_some_and(|prior| prior != selection.canonical_source)
            {
                return Err("prepared source changes one selected index".into());
            }
        }
    }
    for (expected, (id, path)) in files.into_iter().enumerate() {
        if id as usize != expected {
            return Err("prepared source indexes are not contiguous".into());
        }
        references.push(freshell_runtime_protocol::ProviderSecretReference {
            source_path: path.to_str().ok_or("selected source is not UTF-8")?.into(),
            profile: freshell_runtime_protocol::ProviderSecretProfile::OpencodeConfigurationFile,
            provider_relative_path: Some(format!(".freshell/references/{id}")),
        });
    }
    freshell_runtime_protocol::validate_provider_secrets("opencode", &references)
        .map_err(|error| error.message)?;
    let context = publish(
        soul,
        home,
        &base,
        crate::managed_mcp_capability::OpencodeEphemeralInput {
            cwd: Some(cwd),
            workspace: Some(workspace),
            config_root: Some(&config_root),
            source_plan: Some(&plan),
            resource_roots: Some(&resource_roots),
            initial_auth_reservation: reservation.as_deref(),
            secret_references: Some(&references),
            frozen_inputs: Some(&frozen_names),
            native_source_flags: Some(&native_source_flags),
            rebind_enabled: Some(rebind_enabled),
            inline_edits: Some(&inline_edits),
            ..Default::default()
        },
    )?;
    let capability = context
        .mcp_capability
        .as_ref()
        .ok_or("prepared source capability unavailable")?;
    if !frozen.is_empty() {
        if let Err(error) = client
            .bind_provider_path_inputs(soul.clone(), capability.grant_id.clone(), frozen)
            .await
        {
            let _ = crate::managed_mcp_capability::revoke_mcp_capability(&capability.grant_id);
            return Err(error.to_string());
        }
    }
    context
        .prepared_inputs
        .as_ref()
        .ok_or("prepared source descriptors unavailable")?
        .validate_references(&references)
        .map_err(|error| error.message)?;
    Ok(PreparedManagedOpencode {
        context,
        references,
    })
}
