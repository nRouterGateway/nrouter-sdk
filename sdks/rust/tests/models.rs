#[allow(deprecated)]
use nrouter::models::{
    MODELS, MODEL_CLAUDE_SONNET_4_5, MODEL_GEMINI_2_0_FLASH, MODEL_GOOGLE_GEMINI_2_0_FLASH,
    MODEL_GPT_5_4_MINI, MODEL_META_LLAMA_3_3_70B_INSTRUCT, MODEL_TYPESAFE_JEV,
    MODEL_TYPESAFE_JEV_SYSTEM_ONE,
};

#[test]
#[allow(deprecated)]
fn canonical_and_compat_constants_match_catalog_snapshot() {
    assert_eq!(MODEL_GPT_5_4_MINI, "gpt-5.4-mini");
    assert_eq!(MODEL_CLAUDE_SONNET_4_5, "claude-sonnet-4-5-20250929");
    assert_eq!(MODEL_META_LLAMA_3_3_70B_INSTRUCT, "meta/llama-3.3-70b-instruct");
    assert_eq!(MODEL_TYPESAFE_JEV, "typesafe/jev");
    assert_eq!(MODEL_TYPESAFE_JEV_SYSTEM_ONE, "typesafe/jev");
    assert_eq!(MODEL_GOOGLE_GEMINI_2_0_FLASH, "google/gemini-2.0-flash");
    assert_eq!(MODEL_GEMINI_2_0_FLASH, "google/gemini-2.0-flash");
}

#[test]
#[allow(deprecated)]
fn models_slice_lookup_matches_constants() {
    let lookup = |key: &str| {
        MODELS
            .iter()
            .find_map(|(k, v)| (*k == key).then_some(*v))
    };
    assert_eq!(lookup("GPT_5_4_MINI"), Some(MODEL_GPT_5_4_MINI));
    assert_eq!(lookup("CLAUDE_SONNET_4_5"), Some(MODEL_CLAUDE_SONNET_4_5));
    assert_eq!(lookup("TYPESAFE_JEV"), Some(MODEL_TYPESAFE_JEV));
    assert_eq!(lookup("TYPESAFE_JEV_SYSTEM_ONE"), Some("typesafe/jev"));
    assert_eq!(lookup("GEMINI_2_0_FLASH"), Some("google/gemini-2.0-flash"));
}
