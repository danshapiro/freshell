//! Client for the installation-scoped managed-runtime supervisor control socket.
//!
//! The web server uses this crate as a capability client. It never receives a
//! Docker socket or a process handle. All destructive authority stays behind the
//! supervisor's registry-backed `OwnedRuntimeHandle` boundary.

use freshell_runtime_protocol::{
    read_frame, write_frame, AdminCommand, AdminReply, AdminResult, ControlRole, Envelope,
    LaunchRequest, RequestId, RuntimeError, RuntimeErrorCode, RuntimeMetricsRequest, SoulId,
    StopRequest, TerminalInputRequest, TerminalReadOutputRequest, TerminalResizeRequest,
    CONTROL_PROTOCOL_VERSION,
};
use std::{path::PathBuf, sync::Arc};
use tokio::{net::UnixStream, sync::RwLock};

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("runtime supervisor I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("runtime supervisor protocol failed: {0}")]
    Protocol(String),
    #[error("runtime supervisor rejected request: {0:?}: {1}")]
    Runtime(RuntimeErrorCode, String),
    #[error("runtime supervisor returned an unexpected result")]
    UnexpectedResult,
}

impl ClientError {
    pub fn runtime_code(&self) -> Option<RuntimeErrorCode> {
        match self {
            Self::Runtime(code, _) => Some(*code),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct RuntimeClient {
    socket_path: Arc<PathBuf>,
    control_secret: Arc<String>,
    control_epoch: Arc<RwLock<Option<u64>>>,
}

impl RuntimeClient {
    pub async fn from_secret_file(
        socket_path: impl Into<PathBuf>,
        secret_file: impl Into<PathBuf>,
    ) -> Result<Self, ClientError> {
        let secret = tokio::fs::read_to_string(secret_file.into()).await?;
        let secret = secret.trim().to_string();
        if secret.len() < 16 {
            return Err(ClientError::Protocol(
                "runtime control secret is too short".into(),
            ));
        }
        Ok(Self::new(socket_path, secret))
    }

    pub fn new(socket_path: impl Into<PathBuf>, control_secret: impl Into<String>) -> Self {
        Self {
            socket_path: Arc::new(socket_path.into()),
            control_secret: Arc::new(control_secret.into()),
            control_epoch: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn health(&self) -> Result<(u64, String), ClientError> {
        match self.request(RequestId::new(), AdminCommand::Health).await? {
            AdminResult::Health {
                control_epoch,
                installation_id,
            } => {
                *self.control_epoch.write().await = Some(control_epoch);
                Ok((control_epoch, installation_id.to_string()))
            }
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn current_epoch(&self) -> Result<u64, ClientError> {
        if let Some(epoch) = *self.control_epoch.read().await {
            return Ok(epoch);
        }
        self.health().await.map(|(epoch, _)| epoch)
    }

    pub async fn inventory(
        &self,
    ) -> Result<Vec<freshell_runtime_protocol::RuntimeView>, ClientError> {
        match self
            .request(RequestId::new(), AdminCommand::Inventory)
            .await?
        {
            AdminResult::Inventory(views) => Ok(views),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn launch(
        &self,
        request_id: RequestId,
        mut request: LaunchRequest,
    ) -> Result<freshell_runtime_protocol::LaunchResult, ClientError> {
        let epoch = self.current_epoch().await?;
        request.expected_control_epoch = Some(epoch);
        let original = request.clone();
        match self
            .request(request_id.clone(), AdminCommand::Launch(request))
            .await
        {
            Ok(AdminResult::Launch(result)) => Ok(result),
            Err(error) if error.runtime_code() == Some(RuntimeErrorCode::StaleControlEpoch) => {
                let (epoch, _) = self.health().await?;
                let mut retry = original;
                retry.expected_control_epoch = Some(epoch);
                match self
                    .request(request_id, AdminCommand::Launch(retry))
                    .await?
                {
                    AdminResult::Launch(result) => Ok(result),
                    _ => Err(ClientError::UnexpectedResult),
                }
            }
            Ok(_) => Err(ClientError::UnexpectedResult),
            Err(error) => Err(error),
        }
    }

    pub async fn input(
        &self,
        request_id: RequestId,
        soul_id: SoulId,
        data: String,
    ) -> Result<freshell_runtime_protocol::CommandState, ClientError> {
        let epoch = self.current_epoch().await?;
        let request = TerminalInputRequest {
            soul_id,
            data,
            expected_control_epoch: Some(epoch),
        };
        match self
            .request(request_id, AdminCommand::TerminalInput(request))
            .await?
        {
            AdminResult::TerminalInput { state } => Ok(state),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn resize(&self, soul_id: SoulId, cols: u16, rows: u16) -> Result<(), ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::TerminalResize(TerminalResizeRequest {
                    soul_id,
                    cols,
                    rows,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::TerminalResize => Ok(()),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn read_output(
        &self,
        soul_id: SoulId,
        after_seq: u64,
        max_bytes: u64,
    ) -> Result<freshell_runtime_protocol::RuntimeOutputBatch, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::TerminalReadOutput(TerminalReadOutputRequest {
                    soul_id,
                    after_seq,
                    max_bytes,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::TerminalOutput(output) => Ok(output),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn metrics(
        &self,
        soul_id: SoulId,
    ) -> Result<freshell_runtime_protocol::RuntimeMetrics, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::RuntimeMetrics(RuntimeMetricsRequest {
                    soul_id,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::RuntimeMetrics(metrics) => Ok(metrics),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn stop(
        &self,
        soul_id: SoulId,
    ) -> Result<freshell_runtime_protocol::StopOutcome, ClientError> {
        let epoch = self.current_epoch().await?;
        match self
            .request(
                RequestId::new(),
                AdminCommand::Stop(StopRequest {
                    soul_id,
                    expected_control_epoch: Some(epoch),
                }),
            )
            .await?
        {
            AdminResult::Stop { outcome, .. } => Ok(outcome),
            _ => Err(ClientError::UnexpectedResult),
        }
    }

    pub async fn request(
        &self,
        request_id: RequestId,
        body: AdminCommand,
    ) -> Result<AdminResult, ClientError> {
        let mut stream = UnixStream::connect(self.socket_path.as_ref()).await?;
        let envelope = Envelope {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id,
            role: ControlRole::Web,
            auth: Some(self.control_secret.as_ref().clone()),
            body,
        };
        write_frame(&mut stream, &envelope)
            .await
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        let reply: AdminReply = read_frame(&mut stream)
            .await
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        reply.result.map_err(runtime_error)
    }
}

fn runtime_error(error: RuntimeError) -> ClientError {
    ClientError::Runtime(error.code, error.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::{write_frame, AdminReply, AdminResult, InstallationId};
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn health_authenticates_and_caches_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            assert_eq!(envelope.role, ControlRole::Web);
            assert_eq!(envelope.auth.as_deref(), Some("0123456789abcdef"));
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: envelope.request_id,
                    result: Ok(AdminResult::Health {
                        control_epoch: 41,
                        installation_id: InstallationId::new(),
                    }),
                },
            )
            .await
            .unwrap();
        });
        let client = RuntimeClient::new(&socket, "0123456789abcdef");
        assert_eq!(client.health().await.unwrap().0, 41);
        assert_eq!(client.current_epoch().await.unwrap(), 41);
        server.await.unwrap();
    }
}
