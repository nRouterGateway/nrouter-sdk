// ignore_for_file: constant_identifier_names
// Generated from spec/model-catalog-snapshot.json (snapshot version: 2026-11-11, schema_version: 1, catalog_revision: 1).
// Do not edit by hand; run `node scripts/generate-model-constants.mjs` to regenerate.

/// Generated well-known nRouter model constants.
class NRouterModels {
  const NRouterModels._();

  static const String MODEL_CLAUDE_3_7_SONNET = 'claude-3-7-sonnet';
  static const String MODEL_CLAUDE_OPUS_4_6 = 'claude-opus-4-6';
  static const String MODEL_CLAUDE_OPUS_4_8 = 'claude-opus-4-8';
  @Deprecated('Compatibility alias; use MODEL_CLAUDE_SONNET_4_5_20250929 instead.')
  static const String MODEL_CLAUDE_SONNET_4_5 = 'claude-sonnet-4-5-20250929';
  static const String MODEL_CLAUDE_SONNET_4_5_20250929 = 'claude-sonnet-4-5-20250929';
  @Deprecated('Compatibility alias; use MODEL_GOOGLE_GEMINI_1_5_FLASH_002 instead.')
  static const String MODEL_GEMINI_1_5_FLASH_002 = 'google/gemini-1.5-flash-002';
  @Deprecated('Compatibility alias; use MODEL_GOOGLE_GEMINI_1_5_PRO_002 instead.')
  static const String MODEL_GEMINI_1_5_PRO_002 = 'google/gemini-1.5-pro-002';
  @Deprecated('Compatibility alias; use MODEL_GOOGLE_GEMINI_2_0_FLASH instead.')
  static const String MODEL_GEMINI_2_0_FLASH = 'google/gemini-2.0-flash';
  @Deprecated('Compatibility alias; use MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE instead.')
  static const String MODEL_GEMINI_2_0_FLASH_LITE = 'google/gemini-2.0-flash-lite';
  @Deprecated('Compatibility alias; use MODEL_GOOGLE_GEMINI_2_5_FLASH instead.')
  static const String MODEL_GEMINI_2_5_FLASH = 'google/gemini-2.5-flash';
  @Deprecated('Compatibility alias; use MODEL_GOOGLE_GEMINI_2_5_PRO instead.')
  static const String MODEL_GEMINI_2_5_PRO = 'google/gemini-2.5-pro';
  @Deprecated('Compatibility alias; use MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE instead.')
  static const String MODEL_GEMINI_3_1_FLASH_LITE = 'google/gemini-3.1-flash-lite';
  @Deprecated('Compatibility alias; use MODEL_GOOGLE_GEMINI_3_1_PRO instead.')
  static const String MODEL_GEMINI_3_1_PRO = 'google/gemini-3.1-pro';
  @Deprecated('Compatibility alias; use MODEL_GOOGLE_GEMINI_3_8_FLASH instead.')
  static const String MODEL_GEMINI_3_8_FLASH = 'google/gemini-3.8-flash';
  static const String MODEL_GOOGLE_GEMINI_1_5_FLASH_002 = 'google/gemini-1.5-flash-002';
  static const String MODEL_GOOGLE_GEMINI_1_5_PRO_002 = 'google/gemini-1.5-pro-002';
  static const String MODEL_GOOGLE_GEMINI_2_0_FLASH = 'google/gemini-2.0-flash';
  static const String MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE = 'google/gemini-2.0-flash-lite';
  static const String MODEL_GOOGLE_GEMINI_2_5_FLASH = 'google/gemini-2.5-flash';
  static const String MODEL_GOOGLE_GEMINI_2_5_PRO = 'google/gemini-2.5-pro';
  static const String MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE = 'google/gemini-3.1-flash-lite';
  static const String MODEL_GOOGLE_GEMINI_3_1_PRO = 'google/gemini-3.1-pro';
  static const String MODEL_GOOGLE_GEMINI_3_8_FLASH = 'google/gemini-3.8-flash';
  static const String MODEL_GPT_4O = 'gpt-4o';
  static const String MODEL_GPT_4O_MINI = 'gpt-4o-mini';
  static const String MODEL_GPT_5 = 'gpt-5';
  static const String MODEL_GPT_5_4 = 'gpt-5.4';
  static const String MODEL_GPT_5_4_MINI = 'gpt-5.4-mini';
  static const String MODEL_META_LLAMA_3_1_70B_INSTRUCT = 'meta/llama-3.1-70b-instruct';
  static const String MODEL_META_LLAMA_3_1_8B_INSTRUCT = 'meta/llama-3.1-8b-instruct';
  @Deprecated('Compatibility alias; use MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT instead.')
  static const String MODEL_META_LLAMA_3_2_11B_VISION = 'meta/llama-3.2-11b-vision-instruct';
  static const String MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT = 'meta/llama-3.2-11b-vision-instruct';
  static const String MODEL_META_LLAMA_3_2_1B_INSTRUCT = 'meta/llama-3.2-1b-instruct';
  static const String MODEL_META_LLAMA_3_2_3B_INSTRUCT = 'meta/llama-3.2-3b-instruct';
  @Deprecated('Compatibility alias; use MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT instead.')
  static const String MODEL_META_LLAMA_3_2_90B_VISION = 'meta/llama-3.2-90b-vision-instruct';
  static const String MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT = 'meta/llama-3.2-90b-vision-instruct';
  static const String MODEL_META_LLAMA_3_3_70B_INSTRUCT = 'meta/llama-3.3-70b-instruct';
  static const String MODEL_O3_MINI = 'o3-mini';
  static const String MODEL_TYPESAFE_JEV = 'typesafe/jev';
  @Deprecated('Compatibility alias; use MODEL_TYPESAFE_JEV instead.')
  static const String MODEL_TYPESAFE_JEV_SYSTEM_ONE = 'typesafe/jev';

  /// Constant map of well-known model keys matching `MODELS` across all nRouter SDKs.
  static const Map<String, String> MODELS = <String, String>{
    'CLAUDE_3_7_SONNET': 'claude-3-7-sonnet',
    'CLAUDE_OPUS_4_6': 'claude-opus-4-6',
    'CLAUDE_OPUS_4_8': 'claude-opus-4-8',
    'CLAUDE_SONNET_4_5': 'claude-sonnet-4-5-20250929',
    'CLAUDE_SONNET_4_5_20250929': 'claude-sonnet-4-5-20250929',
    'GEMINI_1_5_FLASH_002': 'google/gemini-1.5-flash-002',
    'GEMINI_1_5_PRO_002': 'google/gemini-1.5-pro-002',
    'GEMINI_2_0_FLASH': 'google/gemini-2.0-flash',
    'GEMINI_2_0_FLASH_LITE': 'google/gemini-2.0-flash-lite',
    'GEMINI_2_5_FLASH': 'gemini-2.5-flash',
    'GEMINI_2_5_PRO': 'gemini-2.5-pro',
    'GEMINI_3_1_FLASH_LITE': 'google/gemini-3.1-flash-lite',
    'GEMINI_3_1_PRO': 'google/gemini-3.1-pro',
    'GEMINI_3_8_FLASH': 'google/gemini-3.8-flash',
    'GOOGLE_GEMINI_1_5_FLASH_002': 'google/gemini-1.5-flash-002',
    'GOOGLE_GEMINI_1_5_PRO_002': 'google/gemini-1.5-pro-002',
    'GOOGLE_GEMINI_2_0_FLASH': 'google/gemini-2.0-flash',
    'GOOGLE_GEMINI_2_0_FLASH_LITE': 'google/gemini-2.0-flash-lite',
    'GOOGLE_GEMINI_2_5_FLASH': 'google/gemini-2.5-flash',
    'GOOGLE_GEMINI_2_5_PRO': 'google/gemini-2.5-pro',
    'GOOGLE_GEMINI_3_1_FLASH_LITE': 'google/gemini-3.1-flash-lite',
    'GOOGLE_GEMINI_3_1_PRO': 'google/gemini-3.1-pro',
    'GOOGLE_GEMINI_3_8_FLASH': 'google/gemini-3.8-flash',
    'GPT_4O': 'gpt-4o',
    'GPT_4O_MINI': 'gpt-4o-mini',
    'GPT_5': 'gpt-5',
    'GPT_5_4': 'gpt-5.4',
    'GPT_5_4_MINI': 'gpt-5.4-mini',
    'META_LLAMA_3_1_70B_INSTRUCT': 'meta/llama-3.1-70b-instruct',
    'META_LLAMA_3_1_8B_INSTRUCT': 'meta/llama-3.1-8b-instruct',
    'META_LLAMA_3_2_11B_VISION': 'meta/llama-3.2-11b-vision-instruct',
    'META_LLAMA_3_2_11B_VISION_INSTRUCT': 'meta/llama-3.2-11b-vision-instruct',
    'META_LLAMA_3_2_1B_INSTRUCT': 'meta/llama-3.2-1b-instruct',
    'META_LLAMA_3_2_3B_INSTRUCT': 'meta/llama-3.2-3b-instruct',
    'META_LLAMA_3_2_90B_VISION': 'meta/llama-3.2-90b-vision-instruct',
    'META_LLAMA_3_2_90B_VISION_INSTRUCT': 'meta/llama-3.2-90b-vision-instruct',
    'META_LLAMA_3_3_70B_INSTRUCT': 'meta/llama-3.3-70b-instruct',
    'O3_MINI': 'o3-mini',
    'TYPESAFE_JEV': 'typesafe/jev',
    'TYPESAFE_JEV_SYSTEM_ONE': 'typesafe/jev',
  };
}
