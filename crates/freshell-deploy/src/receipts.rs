use serde::{Deserialize, Serialize};

use crate::error::{DeployError, Result};
use crate::process_identity::ProcessIdentity;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveReceipt {
    pub schema_version: String,
    pub selected_generation_id: String,
    pub running_server_generation_id: Option<String>,
    pub legacy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_identity: Option<ProcessIdentity>,
}

impl LiveReceipt {
    pub fn new(
        selected_generation_id: String,
        running_server_generation_id: Option<String>,
        legacy: bool,
        process_identity: Option<ProcessIdentity>,
    ) -> Self {
        Self {
            schema_version: "1".to_string(),
            selected_generation_id,
            running_server_generation_id,
            legacy,
            process_identity,
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if self.schema_version != "1" {
            return Err(DeployError::InvalidReceipt(
                "schemaVersion must be \"1\"".to_string(),
            ));
        }
        validate_generation_id(&self.selected_generation_id)?;
        if let Some(id) = &self.running_server_generation_id {
            validate_generation_id(id)?;
        }
        if let Some(process) = &self.process_identity {
            process.validate().map_err(|error| {
                DeployError::InvalidReceipt(format!("live process identity is invalid: {error}"))
            })?;
            if self.running_server_generation_id.is_none() {
                return Err(DeployError::InvalidReceipt(
                    "processIdentity requires runningServerGenerationId".to_string(),
                ));
            }
        }
        if self.running_server_generation_id.is_some() && self.process_identity.is_none() {
            return Err(DeployError::InvalidReceipt(
                "runningServerGenerationId requires processIdentity".to_string(),
            ));
        }
        if self.legacy
            && (self.running_server_generation_id.is_none() || self.process_identity.is_none())
        {
            return Err(DeployError::InvalidReceipt(
                "legacy live receipt requires a running generation and process identity"
                    .to_string(),
            ));
        }
        Ok(())
    }

    pub(crate) fn from_json(bytes: &[u8]) -> Result<Self> {
        let receipt: Self = serde_json::from_slice(bytes)
            .map_err(|error| DeployError::InvalidReceipt(error.to_string()))?;
        receipt.validate()?;
        Ok(receipt)
    }

    pub(crate) fn to_json(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut bytes = serde_json::to_vec(self)
            .map_err(|error| DeployError::InvalidReceipt(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

pub(crate) fn validate_generation_id(id: &str) -> Result<()> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(DeployError::InvalidReceipt(format!(
            "invalid generation id {id:?}"
        )));
    }
    Ok(())
}
