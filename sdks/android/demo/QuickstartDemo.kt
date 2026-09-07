package ai.nrouter.sdk.android.demo

import android.content.Context
import ai.nrouter.sdk.android.NRouterAndroid
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Demonstrates basic Android initialization and asynchronous chat completions
 * using [NRouterAndroid].
 */
class QuickstartDemo(private val context: Context) {

    private val scope = CoroutineScope(Dispatchers.Main)

    fun runDemo(apiKey: String? = null) {
        // Initialize client either using explicit key or AndroidManifest meta-data
        val client = if (apiKey != null) {
            NRouterAndroid.create(context, apiKey = apiKey)
        } else {
            NRouterAndroid.create(context)
        }

        scope.launch {
            try {
                val messages = JSONArray().apply {
                    put(JSONObject().apply {
                        put("role", "user")
                        put("content", "Hello nRouter from Android!")
                    })
                }

                val payload = JSONObject().apply {
                    put("model", "gpt-5.4-mini")
                    put("messages", messages)
                }

                val response = client.chatCompletions(payload)
                val text = response.optJSONArray("choices")
                    ?.optJSONObject(0)
                    ?.optJSONObject("message")
                    ?.optString("content")

                val requestId = client.lastResponseMeta?.requestId
                val costUsd = client.lastResponseMeta?.requestCost

                println("Response: $text")
                println("Request ID: $requestId | Cost: $$costUsd")
            } catch (e: Exception) {
                System.err.println("Android Demo Error: ${e.message}")
            }
        }
    }
}
