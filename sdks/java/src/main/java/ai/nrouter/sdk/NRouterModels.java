package ai.nrouter.sdk;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Model constants generated from {@code spec/model-catalog-snapshot.json} (snapshot version: 2026-11-11, schema_version: 1, catalog_revision: 1).
 *
 * <p>Do not edit by hand; run {@code node scripts/generate-model-constants.mjs} to regenerate.
 * Naming rule: {@code MODEL_} + uppercase model id with non-alphanumeric runs replaced by {@code _}.
 */
public final class NRouterModels {

    private NRouterModels() {
    }

    public static final String MODEL_CLAUDE_3_7_SONNET = "claude-3-7-sonnet";
    public static final String MODEL_CLAUDE_OPUS_4_6 = "claude-opus-4-6";
    public static final String MODEL_CLAUDE_OPUS_4_8 = "claude-opus-4-8";
    /** @deprecated Compatibility alias; use MODEL_CLAUDE_SONNET_4_5_20250929 instead. */
    @Deprecated
    public static final String MODEL_CLAUDE_SONNET_4_5 = "claude-sonnet-4-5-20250929";
    public static final String MODEL_CLAUDE_SONNET_4_5_20250929 = "claude-sonnet-4-5-20250929";
    /** @deprecated Compatibility alias; use MODEL_GOOGLE_GEMINI_1_5_FLASH_002 instead. */
    @Deprecated
    public static final String MODEL_GEMINI_1_5_FLASH_002 = "google/gemini-1.5-flash-002";
    /** @deprecated Compatibility alias; use MODEL_GOOGLE_GEMINI_1_5_PRO_002 instead. */
    @Deprecated
    public static final String MODEL_GEMINI_1_5_PRO_002 = "google/gemini-1.5-pro-002";
    /** @deprecated Compatibility alias; use MODEL_GOOGLE_GEMINI_2_0_FLASH instead. */
    @Deprecated
    public static final String MODEL_GEMINI_2_0_FLASH = "google/gemini-2.0-flash";
    /** @deprecated Compatibility alias; use MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE instead. */
    @Deprecated
    public static final String MODEL_GEMINI_2_0_FLASH_LITE = "google/gemini-2.0-flash-lite";
    /** @deprecated Compatibility alias; use MODEL_GOOGLE_GEMINI_2_5_FLASH instead. */
    @Deprecated
    public static final String MODEL_GEMINI_2_5_FLASH = "google/gemini-2.5-flash";
    /** @deprecated Compatibility alias; use MODEL_GOOGLE_GEMINI_2_5_PRO instead. */
    @Deprecated
    public static final String MODEL_GEMINI_2_5_PRO = "google/gemini-2.5-pro";
    /** @deprecated Compatibility alias; use MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE instead. */
    @Deprecated
    public static final String MODEL_GEMINI_3_1_FLASH_LITE = "google/gemini-3.1-flash-lite";
    /** @deprecated Compatibility alias; use MODEL_GOOGLE_GEMINI_3_1_PRO instead. */
    @Deprecated
    public static final String MODEL_GEMINI_3_1_PRO = "google/gemini-3.1-pro";
    /** @deprecated Compatibility alias; use MODEL_GOOGLE_GEMINI_3_8_FLASH instead. */
    @Deprecated
    public static final String MODEL_GEMINI_3_8_FLASH = "google/gemini-3.8-flash";
    public static final String MODEL_GOOGLE_GEMINI_1_5_FLASH_002 = "google/gemini-1.5-flash-002";
    public static final String MODEL_GOOGLE_GEMINI_1_5_PRO_002 = "google/gemini-1.5-pro-002";
    public static final String MODEL_GOOGLE_GEMINI_2_0_FLASH = "google/gemini-2.0-flash";
    public static final String MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE = "google/gemini-2.0-flash-lite";
    public static final String MODEL_GOOGLE_GEMINI_2_5_FLASH = "google/gemini-2.5-flash";
    public static final String MODEL_GOOGLE_GEMINI_2_5_PRO = "google/gemini-2.5-pro";
    public static final String MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE = "google/gemini-3.1-flash-lite";
    public static final String MODEL_GOOGLE_GEMINI_3_1_PRO = "google/gemini-3.1-pro";
    public static final String MODEL_GOOGLE_GEMINI_3_8_FLASH = "google/gemini-3.8-flash";
    public static final String MODEL_GPT_4O = "gpt-4o";
    public static final String MODEL_GPT_4O_MINI = "gpt-4o-mini";
    public static final String MODEL_GPT_5 = "gpt-5";
    public static final String MODEL_GPT_5_4 = "gpt-5.4";
    public static final String MODEL_GPT_5_4_MINI = "gpt-5.4-mini";
    public static final String MODEL_META_LLAMA_3_1_70B_INSTRUCT = "meta/llama-3.1-70b-instruct";
    public static final String MODEL_META_LLAMA_3_1_8B_INSTRUCT = "meta/llama-3.1-8b-instruct";
    /** @deprecated Compatibility alias; use MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT instead. */
    @Deprecated
    public static final String MODEL_META_LLAMA_3_2_11B_VISION = "meta/llama-3.2-11b-vision-instruct";
    public static final String MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT = "meta/llama-3.2-11b-vision-instruct";
    public static final String MODEL_META_LLAMA_3_2_1B_INSTRUCT = "meta/llama-3.2-1b-instruct";
    public static final String MODEL_META_LLAMA_3_2_3B_INSTRUCT = "meta/llama-3.2-3b-instruct";
    /** @deprecated Compatibility alias; use MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT instead. */
    @Deprecated
    public static final String MODEL_META_LLAMA_3_2_90B_VISION = "meta/llama-3.2-90b-vision-instruct";
    public static final String MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT = "meta/llama-3.2-90b-vision-instruct";
    public static final String MODEL_META_LLAMA_3_3_70B_INSTRUCT = "meta/llama-3.3-70b-instruct";
    public static final String MODEL_O3_MINI = "o3-mini";
    public static final String MODEL_TYPESAFE_JEV = "typesafe/jev";
    /** @deprecated Compatibility alias; use MODEL_TYPESAFE_JEV instead. */
    @Deprecated
    public static final String MODEL_TYPESAFE_JEV_SYSTEM_ONE = "typesafe/jev";

    /** Unmodifiable map of well-known model keys matching {@code MODELS} across all nRouter SDKs. */
    public static final Map<String, String> MODELS = buildModels();

    @SuppressWarnings("deprecation")
    private static Map<String, String> buildModels() {
        Map<String, String> map = new LinkedHashMap<>();
        map.put("CLAUDE_3_7_SONNET", MODEL_CLAUDE_3_7_SONNET);
        map.put("CLAUDE_OPUS_4_6", MODEL_CLAUDE_OPUS_4_6);
        map.put("CLAUDE_OPUS_4_8", MODEL_CLAUDE_OPUS_4_8);
        map.put("CLAUDE_SONNET_4_5", MODEL_CLAUDE_SONNET_4_5);
        map.put("CLAUDE_SONNET_4_5_20250929", MODEL_CLAUDE_SONNET_4_5_20250929);
        map.put("GEMINI_1_5_FLASH_002", MODEL_GEMINI_1_5_FLASH_002);
        map.put("GEMINI_1_5_PRO_002", MODEL_GEMINI_1_5_PRO_002);
        map.put("GEMINI_2_0_FLASH", MODEL_GEMINI_2_0_FLASH);
        map.put("GEMINI_2_0_FLASH_LITE", MODEL_GEMINI_2_0_FLASH_LITE);
        map.put("GEMINI_2_5_FLASH", "gemini-2.5-flash");
        map.put("GEMINI_2_5_PRO", "gemini-2.5-pro");
        map.put("GEMINI_3_1_FLASH_LITE", MODEL_GEMINI_3_1_FLASH_LITE);
        map.put("GEMINI_3_1_PRO", MODEL_GEMINI_3_1_PRO);
        map.put("GEMINI_3_8_FLASH", MODEL_GEMINI_3_8_FLASH);
        map.put("GOOGLE_GEMINI_1_5_FLASH_002", MODEL_GOOGLE_GEMINI_1_5_FLASH_002);
        map.put("GOOGLE_GEMINI_1_5_PRO_002", MODEL_GOOGLE_GEMINI_1_5_PRO_002);
        map.put("GOOGLE_GEMINI_2_0_FLASH", MODEL_GOOGLE_GEMINI_2_0_FLASH);
        map.put("GOOGLE_GEMINI_2_0_FLASH_LITE", MODEL_GOOGLE_GEMINI_2_0_FLASH_LITE);
        map.put("GOOGLE_GEMINI_2_5_FLASH", MODEL_GOOGLE_GEMINI_2_5_FLASH);
        map.put("GOOGLE_GEMINI_2_5_PRO", MODEL_GOOGLE_GEMINI_2_5_PRO);
        map.put("GOOGLE_GEMINI_3_1_FLASH_LITE", MODEL_GOOGLE_GEMINI_3_1_FLASH_LITE);
        map.put("GOOGLE_GEMINI_3_1_PRO", MODEL_GOOGLE_GEMINI_3_1_PRO);
        map.put("GOOGLE_GEMINI_3_8_FLASH", MODEL_GOOGLE_GEMINI_3_8_FLASH);
        map.put("GPT_4O", MODEL_GPT_4O);
        map.put("GPT_4O_MINI", MODEL_GPT_4O_MINI);
        map.put("GPT_5", MODEL_GPT_5);
        map.put("GPT_5_4", MODEL_GPT_5_4);
        map.put("GPT_5_4_MINI", MODEL_GPT_5_4_MINI);
        map.put("META_LLAMA_3_1_70B_INSTRUCT", MODEL_META_LLAMA_3_1_70B_INSTRUCT);
        map.put("META_LLAMA_3_1_8B_INSTRUCT", MODEL_META_LLAMA_3_1_8B_INSTRUCT);
        map.put("META_LLAMA_3_2_11B_VISION", MODEL_META_LLAMA_3_2_11B_VISION);
        map.put("META_LLAMA_3_2_11B_VISION_INSTRUCT", MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT);
        map.put("META_LLAMA_3_2_1B_INSTRUCT", MODEL_META_LLAMA_3_2_1B_INSTRUCT);
        map.put("META_LLAMA_3_2_3B_INSTRUCT", MODEL_META_LLAMA_3_2_3B_INSTRUCT);
        map.put("META_LLAMA_3_2_90B_VISION", MODEL_META_LLAMA_3_2_90B_VISION);
        map.put("META_LLAMA_3_2_90B_VISION_INSTRUCT", MODEL_META_LLAMA_3_2_90B_VISION_INSTRUCT);
        map.put("META_LLAMA_3_3_70B_INSTRUCT", MODEL_META_LLAMA_3_3_70B_INSTRUCT);
        map.put("O3_MINI", MODEL_O3_MINI);
        map.put("TYPESAFE_JEV", MODEL_TYPESAFE_JEV);
        map.put("TYPESAFE_JEV_SYSTEM_ONE", MODEL_TYPESAFE_JEV_SYSTEM_ONE);
        return Collections.unmodifiableMap(map);
    }
}
