use freshell_codex::{new_channel_transport, CodexAppServerClient};
use serde_json::json;

#[tokio::test]
async fn task5_native_initialization_advertises_both_observed_openai_form_routes() {
    let (transport, peer) = new_channel_transport();
    let (client, _) = CodexAppServerClient::connect(transport);
    let initialize = tokio::spawn(async move { client.initialize().await.unwrap() });
    let (id, method, params) = peer.expect_request().await;
    assert_eq!(method, "initialize");
    assert_eq!(
        params["capabilities"]["extensions"],
        json!({"openai/form":{},"openai/elicitation":{"form":{}},"openai/standard-form-input":{}})
    );
    peer.respond(&id, json!({}));
    peer.expect_notification().await;
    initialize.await.unwrap();
}
