//! Origin-aware managed provider configuration references.
//! Plans retain approved source metadata and unexpanded templates, never payload bytes.
use std::path::{Path, PathBuf};

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

pub struct ResolvedFileReferencePlan {
    pub template: String,
    pub selections: Vec<FileReferenceSelection>,
    pub referenced_variables: Vec<String>,
}

pub fn resolve_file_references(
    raw: &str,
    origin: FileSourceOrigin<'_>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<ResolvedFileReferencePlan, ReferenceError> {
    use freshell_platform::opencode_config::{transform_file_tokens, TokenTransformError};
    let mut selections: Vec<FileReferenceSelection> = Vec::new();
    let mut rewritten = Vec::new();
    let mut variables = std::collections::BTreeSet::new();
    let fail = |ordinal, variables: Vec<String>, cause| ReferenceError {
        operation: "resolve",
        field: "OpenCode file",
        source_ordinal: ordinal,
        declaring_source: origin.declaring_config.into(),
        variables,
        cause,
    };
    let transformed = transform_file_tokens(raw, env, |token| {
        let names: Vec<String> = token
            .variables
            .iter()
            .map(|name| name.to_string())
            .collect();
        variables.extend(names.iter().cloned());
        if !token.direct_expression {
            return Err(fail(
                token.ordinal,
                names,
                "generated document recipe required",
            ));
        }
        let path = if let Some(relative) = token.path.strip_prefix("~/") {
            origin.original_home.join(relative)
        } else {
            let path = Path::new(token.path);
            if path.is_absolute() {
                path.into()
            } else {
                origin
                    .declaring_config
                    .parent()
                    .unwrap_or(origin.cwd)
                    .join(path)
            }
        };
        let canonical = std::fs::canonicalize(&path).map_err(|_| {
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
                let bytes = selections
                    .iter()
                    .try_fold(metadata.len(), |bytes, selection| {
                        std::fs::metadata(&selection.canonical_source)
                            .ok()
                            .and_then(|m| bytes.checked_add(m.len()))
                    })
                    .ok_or_else(|| {
                        fail(
                            token.ordinal,
                            names.clone(),
                            "configuration reference accounting failed",
                        )
                    })?;
                if bytes > 32 * 1024 * 1024 {
                    return Err(fail(
                        token.ordinal,
                        names,
                        "configuration references exceed 32 MiB",
                    ));
                }
                let destination = format!(
                    "/home/freshell/provider/.freshell/references/{}",
                    selections.len()
                );
                selections.push(FileReferenceSelection {
                    canonical_source: canonical,
                    runtime_destination: destination.clone(),
                    source_ordinal: token.ordinal,
                });
                destination
            };
        let replacement = format!("{{file:{destination}}}");
        rewritten.push((token.original_span, replacement.clone()));
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
    drop(transformed); // Expanded env text is transient and never retained in the plan.
    let mut template = String::new();
    let mut cursor = 0;
    for (span, replacement) in rewritten {
        template.push_str(&raw[cursor..span.start]);
        template.push_str(&replacement);
        cursor = span.end;
    }
    template.push_str(&raw[cursor..]);
    Ok(ResolvedFileReferencePlan {
        template,
        selections,
        referenced_variables: variables.into_iter().collect(),
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
        std::fs::create_dir_all(runtime.join(".freshell/references")).unwrap();
        for selection in &plan.selections {
            let relative = selection
                .runtime_destination
                .strip_prefix("/home/freshell/provider/")
                .unwrap();
            std::fs::copy(&selection.canonical_source, runtime.join(relative)).unwrap();
        }
        let source = runtime.join("source.json");
        std::fs::write(&source, &plan.template).unwrap();
        let result = std::process::Command::new("node")
            .arg("-e")
            .arg(CONSUMER)
            .arg(&source)
            .arg(runtime)
            .arg("{}")
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
}
