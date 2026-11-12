//! Model constants generated from `spec/model-catalog-snapshot.json` (snapshot version: 2026-11-11, schema_version: 1, catalog_revision: 1).
//!
//! Do not edit by hand; run `node scripts/generate-model-constants.mjs` to regenerate.
//! Naming rule: `MODEL_` + uppercase model id with non-alphanumeric runs replaced by `_`.

/// Canonical identifier `claude-3-7-sonnet`.
pub const MODEL_CLAUDE_3_7_SONNET: &str = "claude-3-7-sonnet";
/// Canonical identifier `claude-opus-4-6`.
pub const MODEL_CLAUDE_OPUS_4_6: &str = "claude-opus-4-6";
/// Canonical identifier `claude-opus-4-8`.
pub const MODEL_CLAUDE_OPUS_4_8: &str = "claude-opus-4-8";
/// Deprecated: Compatibility alias; use MODEL_CLAUDE_SONNET_4_5_20250929 instead.
#[deprecated(note = "Compatibility alias; use MODEL_CLAUDE_SONNET_4_5_20250929 instead.")]
pub const MODEL_CLAUDE_SONNET_4_5: &str = "claude-sonnet-4-5-20250929";
/// Canonical identifier `claude-sonnet-4-5-20250929`.
pub const MODEL_CLAUDE_SONNET_4_5_20250929: &str = "claude-sonnet-4-5-20250929";
/// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_1_5_FLASH_002 instead.
#[deprecated(note = "Compatibility alias; use MODEL_GOOGLE_GEMINI_1_5_FLASH_002 instead.")]
pub const MODEL_GEMINI_1_5_FLASH_002: &str = "google/gemini-1.5-flash-002";
/// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_1_5_PRO_002 instead.
#[deprecated(note = "Compatibility alias; use MODEL_GOOGLE_GEMINI_1_5_PRO_002 instead.")]
pub const MODEL_GEMINI_1_5_PRO_002: &str = "google/gemini-1.5-pro-002";
/// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_2_0_FLASH instead.
#[deprecated(note = "Compatibility alias; use MODEL_GOOGLE_GEMINI_2_0_FLASH instead.")]
pub const MODEL_GEMINI_2_0_FLASH: &str = "google/gemini-2.0-flash";
/// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE instead.
#[deprecated(note = "Compatibility alias; use MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE instead.")]
pub const MODEL_GEMINI_2_0_FLASH_LITE: &str = "google/gemini-2.0-flash-lite";
/// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_2_5_FLASH instead.
#[deprecated(note = "Compatibility alias; use MODEL_GOOGLE_GEMINI_2_5_FLASH instead.")]
pub const MODEL_GEMINI_2_5_FLASH: &str = "google/gemini-2.5-flash";
/// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_2_5_PRO instead.
#[deprecated(note = "Compatibility alias; use MODEL_GOOGLE_GEMINI_2_5_PRO instead.")]
pub const MODEL_GEMINI_2_5_PRO: &str = "google/gemini-2.5-pro";
/// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE instead.
#[deprecated(note = "Compatibility alias; use MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE instead.")]
pub const MODEL_GEMINI_3_1_FLASH_LITE: &str = "google/gemini-3.1-flash-lite";
/// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_3_1_PRO instead.
#[deprecated(note = "Compatibility alias; use MODEL_GOOGLE_GEMINI_3_1_PRO instead.")]
pub const MODEL_GEMINI_3_1_PRO: &str = "google/gemini-3.1-pro";
/// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_3_8_FLASH instead.
#[deprecated(note = "Compatibility alias; use MODEL_GOOGLE_GEMINI_3_8_FLASH instead.")]
pub const MODEL_GEMINI_3_8_FLASH: &str = "google/gemini-3.8-flash";
/// Canonical identifier `google/gemini-1.5-flash-002`.
pub const MODEL_GOOGLE_GEMINI_1_5_FLASH_002: &str = "google/gemini-1.5-flash-002";
/// Canonical identifier `google/gemini-1.5-pro-002`.
pub const MODEL_GOOGLE_GEMINI_1_5_PRO_002: &str = "google/gemini-1.5-pro-002";
/// Canonical identifier `google/gemini-2.0-flash`.
pub const MODEL_GOOGLE_GEMINI_2_0_FLASH: &str = "google/gemini-2.0-flash";
/// Canonical identifier `google/gemini-2.0-flash-lite`.
pub const MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE: &str = "google/gemini-2.0-flash-lite";
/// Canonical identifier `google/gemini-2.5-flash`.
pub const MODEL_GOOGLE_GEMINI_2_5_FLASH: &str = "google/gemini-2.5-flash";
/// Canonical identifier `google/gemini-2.5-pro`.
pub const MODEL_GOOGLE_GEMINI_2_5_PRO: &str = "google/gemini-2.5-pro";
/// Canonical identifier `google/gemini-3.1-flash-lite`.
pub const MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE: &str = "google/gemini-3.1-flash-lite";
/// Canonical identifier `google/gemini-3.1-pro`.
pub const MODEL_GOOGLE_GEMINI_3_1_PRO: &str = "google/gemini-3.1-pro";
/// Canonical identifier `google/gemini-3.8-flash`.
pub const MODEL_GOOGLE_GEMINI_3_8_FLASH: &str = "google/gemini-3.8-flash";
/// Canonical identifier `gpt-4o`.
pub const MODEL_GPT_4O: &str = "gpt-4o";
/// Canonical identifier `gpt-4o-mini`.
pub const MODEL_GPT_4O_MINI: &str = "gpt-4o-mini";
/// Canonical identifier `gpt-5`.
pub const MODEL_GPT_5: &str = "gpt-5";
/// Canonical identifier `gpt-5.4`.
pub const MODEL_GPT_5_4: &str = "gpt-5.4";
/// Canonical identifier `gpt-5.4-mini`.
pub const MODEL_GPT_5_4_MINI: &str = "gpt-5.4-mini";
/// Canonical identifier `meta/llama-3.1-70b-instruct`.
pub const MODEL_META_LLAMA_3_1_70B_INSTRUCT: &str = "meta/llama-3.1-70b-instruct";
/// Canonical identifier `meta/llama-3.1-8b-instruct`.
pub const MODEL_META_LLAMA_3_1_8B_INSTRUCT: &str = "meta/llama-3.1-8b-instruct";
/// Deprecated: Compatibility alias; use MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT instead.
#[deprecated(note = "Compatibility alias; use MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT instead.")]
pub const MODEL_META_LLAMA_3_2_11B_VISION: &str = "meta/llama-3.2-11b-vision-instruct";
/// Canonical identifier `meta/llama-3.2-11b-vision-instruct`.
pub const MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT: &str = "meta/llama-3.2-11b-vision-instruct";
/// Canonical identifier `meta/llama-3.2-1b-instruct`.
pub const MODEL_META_LLAMA_3_2_1B_INSTRUCT: &str = "meta/llama-3.2-1b-instruct";
/// Canonical identifier `meta/llama-3.2-3b-instruct`.
pub const MODEL_META_LLAMA_3_2_3B_INSTRUCT: &str = "meta/llama-3.2-3b-instruct";
/// Deprecated: Compatibility alias; use MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT instead.
#[deprecated(note = "Compatibility alias; use MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT instead.")]
pub const MODEL_META_LLAMA_3_2_90B_VISION: &str = "meta/llama-3.2-90b-vision-instruct";
/// Canonical identifier `meta/llama-3.2-90b-vision-instruct`.
pub const MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT: &str = "meta/llama-3.2-90b-vision-instruct";
/// Canonical identifier `meta/llama-3.3-70b-instruct`.
pub const MODEL_META_LLAMA_3_3_70B_INSTRUCT: &str = "meta/llama-3.3-70b-instruct";
/// Canonical identifier `o3-mini`.
pub const MODEL_O3_MINI: &str = "o3-mini";
/// Canonical identifier `typesafe/jev`.
pub const MODEL_TYPESAFE_JEV: &str = "typesafe/jev";
/// Deprecated: Compatibility alias; use MODEL_TYPESAFE_JEV instead.
#[deprecated(note = "Compatibility alias; use MODEL_TYPESAFE_JEV instead.")]
pub const MODEL_TYPESAFE_JEV_SYSTEM_ONE: &str = "typesafe/jev";

/// Sorted `(key, model_id)` directory matching `MODELS` across every nRouter SDK.
#[allow(deprecated)]
pub const MODELS: &[(&str, &str)] = &[
    ("CLAUDE_3_7_SONNET", MODEL_CLAUDE_3_7_SONNET),
    ("CLAUDE_OPUS_4_6", MODEL_CLAUDE_OPUS_4_6),
    ("CLAUDE_OPUS_4_8", MODEL_CLAUDE_OPUS_4_8),
    ("CLAUDE_SONNET_4_5", MODEL_CLAUDE_SONNET_4_5),
    ("CLAUDE_SONNET_4_5_20250929", MODEL_CLAUDE_SONNET_4_5_20250929),
    ("GEMINI_1_5_FLASH_002", MODEL_GEMINI_1_5_FLASH_002),
    ("GEMINI_1_5_PRO_002", MODEL_GEMINI_1_5_PRO_002),
    ("GEMINI_2_0_FLASH", MODEL_GEMINI_2_0_FLASH),
    ("GEMINI_2_0_FLASH_LITE", MODEL_GEMINI_2_0_FLASH_LITE),
    ("GEMINI_2_5_FLASH", "gemini-2.5-flash"),
    ("GEMINI_2_5_PRO", "gemini-2.5-pro"),
    ("GEMINI_3_1_FLASH_LITE", MODEL_GEMINI_3_1_FLASH_LITE),
    ("GEMINI_3_1_PRO", MODEL_GEMINI_3_1_PRO),
    ("GEMINI_3_8_FLASH", MODEL_GEMINI_3_8_FLASH),
    ("GOOGLE_GEMINI_1_5_FLASH_002", MODEL_GOOGLE_GEMINI_1_5_FLASH_002),
    ("GOOGLE_GEMINI_1_5_PRO_002", MODEL_GOOGLE_GEMINI_1_5_PRO_002),
    ("GOOGLE_GEMINI_2_0_FLASH", MODEL_GOOGLE_GEMINI_2_0_FLASH),
    ("GOOGLE_GEMINI_2_0_FLASH_LITE", MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE),
    ("GOOGLE_GEMINI_2_5_FLASH", MODEL_GOOGLE_GEMINI_2_5_FLASH),
    ("GOOGLE_GEMINI_2_5_PRO", MODEL_GOOGLE_GEMINI_2_5_PRO),
    ("GOOGLE_GEMINI_3_1_FLASH_LITE", MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE),
    ("GOOGLE_GEMINI_3_1_PRO", MODEL_GOOGLE_GEMINI_3_1_PRO),
    ("GOOGLE_GEMINI_3_8_FLASH", MODEL_GOOGLE_GEMINI_3_8_FLASH),
    ("GPT_4O", MODEL_GPT_4O),
    ("GPT_4O_MINI", MODEL_GPT_4O_MINI),
    ("GPT_5", MODEL_GPT_5),
    ("GPT_5_4", MODEL_GPT_5_4),
    ("GPT_5_4_MINI", MODEL_GPT_5_4_MINI),
    ("META_LLAMA_3_1_70B_INSTRUCT", MODEL_META_LLAMA_3_1_70B_INSTRUCT),
    ("META_LLAMA_3_1_8B_INSTRUCT", MODEL_META_LLAMA_3_1_8B_INSTRUCT),
    ("META_LLAMA_3_2_11B_VISION", MODEL_META_LLAMA_3_2_11B_VISION),
    ("META_LLAMA_3_2_11B_VISION_INSTRUCT", MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT),
    ("META_LLAMA_3_2_1B_INSTRUCT", MODEL_META_LLAMA_3_2_1B_INSTRUCT),
    ("META_LLAMA_3_2_3B_INSTRUCT", MODEL_META_LLAMA_3_2_3B_INSTRUCT),
    ("META_LLAMA_3_2_90B_VISION", MODEL_META_LLAMA_3_2_90B_VISION),
    ("META_LLAMA_3_2_90B_VISION_INSTRUCT", MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT),
    ("META_LLAMA_3_3_70B_INSTRUCT", MODEL_META_LLAMA_3_3_70B_INSTRUCT),
    ("O3_MINI", MODEL_O3_MINI),
    ("TYPESAFE_JEV", MODEL_TYPESAFE_JEV),
    ("TYPESAFE_JEV_SYSTEM_ONE", MODEL_TYPESAFE_JEV_SYSTEM_ONE),
];

/// Look up a model identifier in [`MODELS`] by short key (for example `"GPT_5_4_MINI"`).
pub fn model_id(key: &str) -> Option<&'static str> {
    MODELS
        .binary_search_by_key(&key, |(k, _)| *k)
        .ok()
        .map(|idx| MODELS[idx].1)
}
