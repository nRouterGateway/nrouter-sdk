// Code generated from spec/model-catalog-snapshot.json (snapshot version: 2026-11-11, schema_version: 1, catalog_revision: 1); DO NOT EDIT.
// Run `node scripts/generate-model-constants.mjs` to regenerate.

package nrouter

const (
	MODEL_CLAUDE_3_7_SONNET = "claude-3-7-sonnet"
	MODEL_CLAUDE_OPUS_4_6   = "claude-opus-4-6"
	MODEL_CLAUDE_OPUS_4_8   = "claude-opus-4-8"
	// MODEL_CLAUDE_SONNET_4_5 is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_CLAUDE_SONNET_4_5_20250929 instead.
	MODEL_CLAUDE_SONNET_4_5          = "claude-sonnet-4-5-20250929"
	MODEL_CLAUDE_SONNET_4_5_20250929 = "claude-sonnet-4-5-20250929"
	// MODEL_GEMINI_1_5_FLASH_002 is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_1_5_FLASH_002 instead.
	MODEL_GEMINI_1_5_FLASH_002 = "google/gemini-1.5-flash-002"
	// MODEL_GEMINI_1_5_PRO_002 is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_1_5_PRO_002 instead.
	MODEL_GEMINI_1_5_PRO_002 = "google/gemini-1.5-pro-002"
	// MODEL_GEMINI_2_0_FLASH is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_2_0_FLASH instead.
	MODEL_GEMINI_2_0_FLASH = "google/gemini-2.0-flash"
	// MODEL_GEMINI_2_0_FLASH_LITE is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE instead.
	MODEL_GEMINI_2_0_FLASH_LITE = "google/gemini-2.0-flash-lite"
	// MODEL_GEMINI_2_5_FLASH is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_2_5_FLASH instead.
	MODEL_GEMINI_2_5_FLASH = "google/gemini-2.5-flash"
	// MODEL_GEMINI_2_5_PRO is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_2_5_PRO instead.
	MODEL_GEMINI_2_5_PRO = "google/gemini-2.5-pro"
	// MODEL_GEMINI_3_1_FLASH_LITE is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE instead.
	MODEL_GEMINI_3_1_FLASH_LITE = "google/gemini-3.1-flash-lite"
	// MODEL_GEMINI_3_1_PRO is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_3_1_PRO instead.
	MODEL_GEMINI_3_1_PRO = "google/gemini-3.1-pro"
	// MODEL_GEMINI_3_8_FLASH is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_GOOGLE_GEMINI_3_8_FLASH instead.
	MODEL_GEMINI_3_8_FLASH             = "google/gemini-3.8-flash"
	MODEL_GOOGLE_GEMINI_1_5_FLASH_002  = "google/gemini-1.5-flash-002"
	MODEL_GOOGLE_GEMINI_1_5_PRO_002    = "google/gemini-1.5-pro-002"
	MODEL_GOOGLE_GEMINI_2_0_FLASH      = "google/gemini-2.0-flash"
	MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE = "google/gemini-2.0-flash-lite"
	MODEL_GOOGLE_GEMINI_2_5_FLASH      = "google/gemini-2.5-flash"
	MODEL_GOOGLE_GEMINI_2_5_PRO        = "google/gemini-2.5-pro"
	MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE = "google/gemini-3.1-flash-lite"
	MODEL_GOOGLE_GEMINI_3_1_PRO        = "google/gemini-3.1-pro"
	MODEL_GOOGLE_GEMINI_3_8_FLASH      = "google/gemini-3.8-flash"
	MODEL_GPT_4O                       = "gpt-4o"
	MODEL_GPT_4O_MINI                  = "gpt-4o-mini"
	MODEL_GPT_5                        = "gpt-5"
	MODEL_GPT_5_4                      = "gpt-5.4"
	MODEL_GPT_5_4_MINI                 = "gpt-5.4-mini"
	MODEL_META_LLAMA_3_1_70B_INSTRUCT  = "meta/llama-3.1-70b-instruct"
	MODEL_META_LLAMA_3_1_8B_INSTRUCT   = "meta/llama-3.1-8b-instruct"
	// MODEL_META_LLAMA_3_2_11B_VISION is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT instead.
	MODEL_META_LLAMA_3_2_11B_VISION          = "meta/llama-3.2-11b-vision-instruct"
	MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT = "meta/llama-3.2-11b-vision-instruct"
	MODEL_META_LLAMA_3_2_1B_INSTRUCT         = "meta/llama-3.2-1b-instruct"
	MODEL_META_LLAMA_3_2_3B_INSTRUCT         = "meta/llama-3.2-3b-instruct"
	// MODEL_META_LLAMA_3_2_90B_VISION is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT instead.
	MODEL_META_LLAMA_3_2_90B_VISION          = "meta/llama-3.2-90b-vision-instruct"
	MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT = "meta/llama-3.2-90b-vision-instruct"
	MODEL_META_LLAMA_3_3_70B_INSTRUCT        = "meta/llama-3.3-70b-instruct"
	MODEL_O3_MINI                            = "o3-mini"
	MODEL_TYPESAFE_JEV                       = "typesafe/jev"
	// MODEL_TYPESAFE_JEV_SYSTEM_ONE is retained for compatibility.
	//
	// Deprecated: Compatibility alias; use MODEL_TYPESAFE_JEV instead.
	MODEL_TYPESAFE_JEV_SYSTEM_ONE = "typesafe/jev"
)

// MODELS maps each short constant key to its wire model identifier.
var MODELS = map[string]string{
	"CLAUDE_3_7_SONNET":                  "claude-3-7-sonnet",
	"CLAUDE_OPUS_4_6":                    "claude-opus-4-6",
	"CLAUDE_OPUS_4_8":                    "claude-opus-4-8",
	"CLAUDE_SONNET_4_5":                  "claude-sonnet-4-5-20250929",
	"CLAUDE_SONNET_4_5_20250929":         "claude-sonnet-4-5-20250929",
	"GEMINI_1_5_FLASH_002":               "google/gemini-1.5-flash-002",
	"GEMINI_1_5_PRO_002":                 "google/gemini-1.5-pro-002",
	"GEMINI_2_0_FLASH":                   "google/gemini-2.0-flash",
	"GEMINI_2_0_FLASH_LITE":              "google/gemini-2.0-flash-lite",
	"GEMINI_2_5_FLASH":                   "gemini-2.5-flash",
	"GEMINI_2_5_PRO":                     "gemini-2.5-pro",
	"GEMINI_3_1_FLASH_LITE":              "google/gemini-3.1-flash-lite",
	"GEMINI_3_1_PRO":                     "google/gemini-3.1-pro",
	"GEMINI_3_8_FLASH":                   "google/gemini-3.8-flash",
	"GOOGLE_GEMINI_1_5_FLASH_002":        "google/gemini-1.5-flash-002",
	"GOOGLE_GEMINI_1_5_PRO_002":          "google/gemini-1.5-pro-002",
	"GOOGLE_GEMINI_2_0_FLASH":            "google/gemini-2.0-flash",
	"GOOGLE_GEMINI_2_0_FLASH_LITE":       "google/gemini-2.0-flash-lite",
	"GOOGLE_GEMINI_2_5_FLASH":            "google/gemini-2.5-flash",
	"GOOGLE_GEMINI_2_5_PRO":              "google/gemini-2.5-pro",
	"GOOGLE_GEMINI_3_1_FLASH_LITE":       "google/gemini-3.1-flash-lite",
	"GOOGLE_GEMINI_3_1_PRO":              "google/gemini-3.1-pro",
	"GOOGLE_GEMINI_3_8_FLASH":            "google/gemini-3.8-flash",
	"GPT_4O":                             "gpt-4o",
	"GPT_4O_MINI":                        "gpt-4o-mini",
	"GPT_5":                              "gpt-5",
	"GPT_5_4":                            "gpt-5.4",
	"GPT_5_4_MINI":                       "gpt-5.4-mini",
	"META_LLAMA_3_1_70B_INSTRUCT":        "meta/llama-3.1-70b-instruct",
	"META_LLAMA_3_1_8B_INSTRUCT":         "meta/llama-3.1-8b-instruct",
	"META_LLAMA_3_2_11B_VISION":          "meta/llama-3.2-11b-vision-instruct",
	"META_LLAMA_3_2_11B_VISION_INSTRUCT": "meta/llama-3.2-11b-vision-instruct",
	"META_LLAMA_3_2_1B_INSTRUCT":         "meta/llama-3.2-1b-instruct",
	"META_LLAMA_3_2_3B_INSTRUCT":         "meta/llama-3.2-3b-instruct",
	"META_LLAMA_3_2_90B_VISION":          "meta/llama-3.2-90b-vision-instruct",
	"META_LLAMA_3_2_90B_VISION_INSTRUCT": "meta/llama-3.2-90b-vision-instruct",
	"META_LLAMA_3_3_70B_INSTRUCT":        "meta/llama-3.3-70b-instruct",
	"O3_MINI":                            "o3-mini",
	"TYPESAFE_JEV":                       "typesafe/jev",
	"TYPESAFE_JEV_SYSTEM_ONE":            "typesafe/jev",
}
