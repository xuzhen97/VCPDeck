use desktop_core::protocol::parse_signal_fixture;
use serde_json::json;

#[test]
fn strict_signal_parser_rejects_unknown_fields() {
    let value = json!({"kind": "offer", "sdp": "v=0\r\n", "actorId": "forged"});
    assert!(parse_signal_fixture(&value).is_err());
}

#[test]
fn strict_signal_parser_accepts_ice() {
    let value = json!({
        "kind": "ice",
        "candidate": "candidate:1",
        "sdpMid": "0",
        "sdpMLineIndex": 0
    });
    assert!(parse_signal_fixture(&value).is_ok());
}
