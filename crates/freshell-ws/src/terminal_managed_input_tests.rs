use super::pane_reconcile_gate_tests::{loopback_sink_and_client, next_text_frame, state};
use super::*;
use freshell_terminal::registry::{
    ManagedOutputRead, ManagedTerminalController, ManagedTerminalDescriptor, ManagedTerminalFuture,
};
use std::sync::atomic::{AtomicBool, Ordering};

struct ReadinessController {
    ready: AtomicBool,
    refusal: ManagedTerminalInputError,
    dispatched: StdMutex<Vec<String>>,
}

impl ManagedTerminalController for ReadinessController {
    fn lookup_terminal<'a>(
        &'a self,
        _: &'a str,
        _: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        Box::pin(async { panic!("input must not look up or replace a terminal") })
    }

    fn launch<'a>(
        &'a self,
        _: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<
        'a,
        Result<ManagedTerminalDescriptor, freshell_terminal::registry::ManagedTerminalLaunchError>,
    > {
        Box::pin(async { panic!("input must not launch a provider") })
    }

    fn input<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        data: String,
    ) -> ManagedTerminalFuture<'a, Result<(), ManagedTerminalInputError>> {
        Box::pin(async move {
            if !self.ready.load(Ordering::SeqCst) {
                return Err(self.refusal.clone());
            }
            self.dispatched.lock().unwrap().push(data);
            Ok(())
        })
    }

    fn resize<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: u16,
        _: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { panic!("input must not resize") })
    }

    fn stop<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { panic!("input must not stop") })
    }

    fn read_output<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: i64,
        _: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        Box::pin(async { panic!("input refusal must not read provider output") })
    }
}

#[tokio::test]
async fn managed_readiness_refusal_is_terminal_scoped_and_retries_only_after_new_input() {
    for (refusal, reason) in [
        (
            ManagedTerminalInputError::RecoveryBlocked,
            "managed_recovery_blocked",
        ),
        (
            ManagedTerminalInputError::RecoveryPending,
            "managed_recovery_pending",
        ),
    ] {
        let state = state();
        let controller = Arc::new(ReadinessController {
            ready: AtomicBool::new(false),
            refusal,
            dispatched: StdMutex::new(Vec::new()),
        });
        state
            .registry
            .set_managed_controller(Some(controller.clone()));
        state.registry.register_managed(
            ManagedTerminalDescriptor {
                soul_id: "input-soul".into(),
                incarnation_id: "input-incarnation".into(),
                terminal_id: "input-terminal".into(),
                stream_id: "input-stream".into(),
                mode: "opencode".into(),
                cwd: "/workspace".into(),
                resume_session_id: Some("ses_input".into()),
                create_request_id: None,
            },
            "OpenCode".into(),
        );
        let (mut sink, mut client) = loopback_sink_and_client().await;
        let conn_sink: FrameSink = Arc::new(|_| {});
        let (create_tx, _create_rx) = mpsc::channel(1);
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let mut refresh = None;
        let mut identity = ConnectionIdentity::default();
        let mut paced = Default::default();
        let input = r#"{"type":"terminal.input","terminalId":"input-terminal","data":"synthetic-keybytes\r"}"#;
        for _ in 0..2 {
            assert!(
                handle_client_text(
                    input,
                    &mut sink,
                    &state,
                    1,
                    &conn_sink,
                    false,
                    false,
                    false,
                    false,
                    &create_tx,
                    &cancel_rx,
                    &mut refresh,
                    &mut identity,
                    &mut paced,
                    &None
                )
                .await
            );
            let frame = next_text_frame(&mut client).await;
            assert_eq!(
                frame,
                serde_json::json!({
                    "type":"terminal.input.blocked", "terminalId":"input-terminal",
                    "reason":reason,
                })
            );
            assert!(controller.dispatched.lock().unwrap().is_empty());
        }
        controller.ready.store(true, Ordering::SeqCst);
        // Readiness becoming healthy cannot replay either rejected input.
        assert!(controller.dispatched.lock().unwrap().is_empty());
        assert!(
            handle_client_text(
                input,
                &mut sink,
                &state,
                1,
                &conn_sink,
                false,
                false,
                false,
                false,
                &create_tx,
                &cancel_rx,
                &mut refresh,
                &mut identity,
                &mut paced,
                &None
            )
            .await
        );
        assert!(
            handle_client_text(
                r#"{"type":"ping"}"#,
                &mut sink,
                &state,
                1,
                &conn_sink,
                false,
                false,
                false,
                false,
                &create_tx,
                &cancel_rx,
                &mut refresh,
                &mut identity,
                &mut paced,
                &None
            )
            .await
        );
        assert_eq!(next_text_frame(&mut client).await["type"], "pong");
        assert_eq!(
            controller.dispatched.lock().unwrap().as_slice(),
            ["synthetic-keybytes\r"]
        );
    }
}
