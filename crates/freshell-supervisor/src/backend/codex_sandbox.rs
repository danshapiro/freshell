//! Codex's native sandbox needs only the declared namespace/mount delta.
//! Docker receives the policy itself, never a daemon-local file pathname.
use super::BackendError;
use freshell_runtime_protocol::{FreshAgentLaunchSpec, FreshProvider, TerminalLaunchSpec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const RESOURCE: &str = include_str!("../../../../docker/runtime/codex-native-sandbox.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Identity {
    pub id: String,
    pub profile_sha256: String,
    pub supported_native_version: String,
    pub declared_managed_version: String,
    pub helper_sha256: String,
    pub launch_wrapper: String,
}

struct Policy {
    identity: Identity,
    profile: Value,
    security_option: String,
}

pub(super) fn selected(
    terminal: Option<&TerminalLaunchSpec>,
    agent: Option<&FreshAgentLaunchSpec>,
) -> bool {
    terminal.is_some_and(|terminal| terminal.mode == "codex")
        || agent.is_some_and(|agent| {
            agent.provider == FreshProvider::Codex && agent.fixture_transport.is_none()
        })
}

fn parse(raw: &str) -> Result<Policy, String> {
    let resource: Value =
        serde_json::from_str(raw).map_err(|error| format!("invalid resource JSON: {error}"))?;
    if resource["schemaVersion"] != 1
        || resource["profile"]["defaultAction"] != "SCMP_ACT_ERRNO"
        || resource["profile"]["defaultErrnoRet"] != 1
        || !resource["profile"]["syscalls"].is_array()
    {
        return Err("unsupported resource schema or native default-deny policy".into());
    }
    let field = |pointer| {
        resource
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("missing native policy field {pointer}"))
    };
    let profile = resource["profile"].clone();
    let profile_json = serde_json::to_string(&profile).map_err(|error| error.to_string())?;
    let identity = Identity {
        id: field("/id")?,
        profile_sha256: format!("sha256:{:x}", Sha256::digest(profile_json.as_bytes())),
        supported_native_version: field("/native/version")?,
        declared_managed_version: freshell_agent_runtime::pinned_provider_version("codex")
            .ok_or("managed Codex version is undeclared")?
            .to_owned(),
        helper_sha256: field("/native/bwrapSha256")?,
        launch_wrapper: field("/native/launchWrapper")?,
    };
    Ok(Policy {
        identity,
        profile,
        security_option: format!("seccomp={profile_json}"),
    })
}

fn policy() -> Result<&'static Policy, BackendError> {
    static POLICY: OnceLock<Result<Policy, String>> = OnceLock::new();
    POLICY
        .get_or_init(|| parse(RESOURCE))
        .as_ref()
        .map_err(|error| BackendError::CodexIncompatible(error.clone()))
}

pub(super) fn identity(
    terminal: Option<&TerminalLaunchSpec>,
    agent: Option<&FreshAgentLaunchSpec>,
) -> Result<Option<Identity>, BackendError> {
    if selected(terminal, agent) {
        Ok(Some(policy()?.identity.clone()))
    } else {
        Ok(None)
    }
}

pub(super) fn security_options(
    terminal: Option<&TerminalLaunchSpec>,
    agent: Option<&FreshAgentLaunchSpec>,
) -> Result<Vec<String>, BackendError> {
    let mut options = vec!["no-new-privileges:true".to_owned()];
    if selected(terminal, agent) {
        options.push(policy()?.security_option.clone());
    }
    Ok(options)
}

pub(super) fn verify(host: &Value) -> Result<(), BackendError> {
    let expected = policy()?;
    let fail = || {
        BackendError::OwnershipMismatch(
            "Codex native sandbox policy or outer isolation changed".into(),
        )
    };
    if host["ReadonlyRootfs"] != true
        || host["CapDrop"].as_array().is_none_or(|caps| {
            caps.len() != 1 || !matches!(caps[0].as_str(), Some("ALL" | "CAP_ALL"))
        })
    {
        return Err(fail());
    }
    let options = host["SecurityOpt"].as_array().ok_or_else(fail)?;
    if options.len() != 2 {
        return Err(fail());
    }
    let mut no_new_privileges = false;
    let mut matched = false;
    for option in options {
        let option = option.as_str().ok_or_else(fail)?;
        if matches!(
            option,
            "no-new-privileges" | "no-new-privileges:true" | "no-new-privileges=true"
        ) && !no_new_privileges
        {
            no_new_privileges = true;
        } else if let Some(raw) = option.strip_prefix("seccomp=").filter(|_| !matched) {
            let actual: Value = serde_json::from_str(raw).map_err(|_| fail())?;
            if actual != expected.profile {
                return Err(fail());
            }
            matched = true;
        } else {
            return Err(fail());
        }
    }
    if !no_new_privileges || !matched {
        return Err(fail());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_invalid_policy_is_a_configuration_refusal() {
        assert!(parse("not JSON").is_err());
        assert!(parse("{}").is_err());
        let mut invalid: Value = serde_json::from_str(RESOURCE).unwrap();
        invalid["profile"]["defaultAction"] = Value::String("SCMP_ACT_ALLOW".into());
        assert!(parse(&invalid.to_string()).is_err());
    }

    #[test]
    fn codex_policy_rejects_mutated_profile_and_outer_isolation() {
        let policy = policy().unwrap();
        let valid = serde_json::json!({"ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges:true",policy.security_option]});
        assert!(verify(&valid).is_ok());
        let mut changed = valid.clone();
        changed["ReadonlyRootfs"] = Value::Bool(false);
        assert!(verify(&changed).is_err());
        changed = valid.clone();
        changed["CapDrop"] = serde_json::json!([]);
        assert!(verify(&changed).is_err());
        changed = valid.clone();
        changed["SecurityOpt"][1] = Value::String("seccomp=unconfined".into());
        assert!(verify(&changed).is_err());
        changed = valid;
        let mut profile = policy.profile.clone();
        profile["defaultErrnoRet"] = Value::from(0);
        changed["SecurityOpt"][1] = Value::String(format!("seccomp={profile}"));
        assert!(verify(&changed).is_err());
    }
}
