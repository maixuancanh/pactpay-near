use near_sdk::{
    env,
    serde_json::{json, Value},
};

pub(crate) fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({
            "standard": "pactpay",
            "version": "2.0.0",
            "event": event,
            "data": [data],
        })
    ));
}
