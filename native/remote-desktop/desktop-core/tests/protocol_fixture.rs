use desktop_core::protocol::parse_fixture;
use serde::Deserialize;
use serde_json::Value;
use std::fs;

#[derive(Debug, Deserialize)]
struct Fixture {
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    name: String,
    kind: String,
    valid: bool,
    payload: Value,
}

#[test]
fn shared_fixture_has_identical_rust_results() {
    let path = format!(
        "{}/../../../packages/shared/protocol-fixtures/remote-desktop-v1.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Fixture = serde_json::from_str(&fs::read_to_string(path).expect("fixture"))
        .expect("valid fixture JSON");
    assert_eq!(fixture.protocol_version, 1);

    for case in fixture.cases {
        assert_eq!(
            parse_fixture(&case.kind, &case.payload).is_ok(),
            case.valid,
            "{}",
            case.name
        );
    }
}
