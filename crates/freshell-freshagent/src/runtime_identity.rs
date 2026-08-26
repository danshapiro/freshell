use std::sync::{Arc, OnceLock};

use freshell_protocol::RuntimeDescriptor;

/// Downstream-owned registry for fresh-agent runtime generations. The
/// fresh-agent crate invokes it synchronously at runtime creation, before the
/// first `freshAgent.created` broadcast can escape.
pub trait FreshRuntimeRegistry: Send + Sync {
    fn register_runtime(
        &self,
        provider: &str,
        durable_session_id: &str,
        live_runtime_id: &str,
    ) -> RuntimeDescriptor;
}

pub type SharedFreshRuntimeRegistry = Arc<dyn FreshRuntimeRegistry>;

#[derive(Clone, Default)]
pub struct FreshRuntimeIdentity {
    registry: Arc<OnceLock<SharedFreshRuntimeRegistry>>,
}

impl FreshRuntimeIdentity {
    pub fn set_registry(&self, registry: SharedFreshRuntimeRegistry) {
        let _ = self.registry.set(registry);
    }

    pub fn register(
        &self,
        provider: &str,
        durable_session_id: &str,
        live_runtime_id: &str,
    ) -> RuntimeDescriptor {
        self.registry.get().map_or_else(
            || RuntimeDescriptor {
                runtime_id: live_runtime_id.to_string(),
                generation: 1,
            },
            |registry| registry.register_runtime(provider, durable_session_id, live_runtime_id),
        )
    }

    pub fn mint_and_register(&self, provider: &str, durable_session_id: &str) -> RuntimeDescriptor {
        self.register(
            provider,
            durable_session_id,
            &format!("fresh-runtime-{}", uuid::Uuid::new_v4()),
        )
    }
}
