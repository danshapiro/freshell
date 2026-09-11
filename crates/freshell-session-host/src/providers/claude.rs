use super::cli;
use freshell_agent_runtime::ProviderStoreProbe;
use freshell_runtime_protocol::ResumeSpec;

pub async fn probe(
    spec: &ResumeSpec,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<ProviderStoreProbe, String> {
    if !matches!(spec.provider_session.provider.as_str(), "claude" | "kilroy") {
        return Err("Claude recovery adapter received another provider".into());
    }
    cli::probe_as_provider(spec, run_as_uid, run_as_gid).await
}
