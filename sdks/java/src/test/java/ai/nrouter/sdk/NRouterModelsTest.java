package ai.nrouter.sdk;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

@SuppressWarnings("deprecation")
class NRouterModelsTest {

    @Test
    void canonicalAndCompatConstantsMatchCatalogSnapshot() {
        assertEquals("gpt-5.4-mini", NRouterModels.MODEL_GPT_5_4_MINI);
        assertEquals("claude-sonnet-4-5-20250929", NRouterModels.MODEL_CLAUDE_SONNET_4_5);
        assertEquals("meta/llama-3.3-70b-instruct", NRouterModels.MODEL_META_LLAMA_3_3_70B_INSTRUCT);
        assertEquals("typesafe/jev", NRouterModels.MODEL_TYPESAFE_JEV);
        assertEquals("typesafe/jev", NRouterModels.MODEL_TYPESAFE_JEV_SYSTEM_ONE);
        assertEquals("google/gemini-2.0-flash", NRouterModels.MODEL_GOOGLE_GEMINI_2_0_FLASH);
        assertEquals("google/gemini-2.0-flash", NRouterModels.MODEL_GEMINI_2_0_FLASH);
    }

    @Test
    void modelsMapMatchesConstantsAndIsUnmodifiable() {
        assertEquals(NRouterModels.MODEL_GPT_5_4_MINI, NRouterModels.MODELS.get("GPT_5_4_MINI"));
        assertEquals(NRouterModels.MODEL_CLAUDE_SONNET_4_5, NRouterModels.MODELS.get("CLAUDE_SONNET_4_5"));
        assertEquals("typesafe/jev", NRouterModels.MODELS.get("TYPESAFE_JEV_SYSTEM_ONE"));
        assertEquals("google/gemini-2.0-flash", NRouterModels.MODELS.get("GEMINI_2_0_FLASH"));
        assertThrows(
                UnsupportedOperationException.class,
                () -> NRouterModels.MODELS.put("CUSTOM", "custom/model"));
    }
}
