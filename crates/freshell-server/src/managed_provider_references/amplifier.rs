//! Ordinary Amplifier sources use the accepted initial creation authority.
use freshell_runtime_protocol::*;
use std::path::Path;

pub(crate) struct AmplifierPreparation<'a> {
    pub client: &'a freshell_runtime_client::RuntimeClient,
    pub soul: &'a SoulId,
    pub creation_seed: &'a str,
    pub home: &'a Path,
    pub cwd: &'a Path,
    pub workspace: &'a Path,
    pub references: &'a [ProviderSecretReference],
}
pub(crate) async fn prepare_managed(
    request: AmplifierPreparation<'_>,
) -> Result<ProviderLaunchContext, String> {
    let manifest = freshell_platform::amplifier_inputs::AmplifierInputManifest {
        version: 1,
        original_home: request.home.into(),
        cwd: request.cwd.into(),
        workspace: request.workspace.into(),
    };
    manifest.validate().map_err(str::to_string)?;
    let context = ProviderLaunchContext {
        preparation: ProviderPreparation::Amplifier {
            bundle: "default".into(),
            resume_args: vec![],
        },
        config: vec![],
        mcp_capability: None,
        prepared_inputs: None,
    };
    let reservation = request
        .client
        .reserve_provider_inputs(
            request.soul.clone(),
            "amplifier".into(),
            request.creation_seed.into(),
        )
        .await
        .map_err(|error| error.to_string())?;
    if reservation.provider != "amplifier"
        || &reservation.soul_id != request.soul
        || reservation.creation_seed_ref != request.creation_seed
    {
        return Err("Amplifier selected resource reservation does not match this creation".into());
    }
    crate::managed_mcp_capability::issue_prepared_provider_context(
        "amplifier",
        request.soul,
        request.home,
        &context,
        crate::managed_mcp_capability::OpencodeEphemeralInput {
            amplifier_manifest: Some(&manifest),
            cwd: Some(request.cwd),
            workspace: Some(request.workspace),
            secret_references: Some(request.references),
            initial_auth_reservation: Some(&reservation.reservation_id),
            ..Default::default()
        },
    )
}
