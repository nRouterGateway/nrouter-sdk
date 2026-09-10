package ai.nrouter.sdk

import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeout
import java.util.Locale

/** Supported audio formats for speech generation. */
public val VALID_AUDIO_FORMATS: List<String> = listOf("mp3", "opus", "aac", "flac", "wav", "pcm")

/** Default poll interval for video generation jobs (5 seconds). */
public const val DEFAULT_VIDEO_POLL_INTERVAL_MILLIS: Long = 5000L

/** Default overall timeout for video generation jobs (10 minutes). */
public const val DEFAULT_VIDEO_TIMEOUT_MILLIS: Long = 600_000L

/** Floor on `waitForVideo`'s poll interval (1 second). */
public const val MIN_VIDEO_POLL_INTERVAL_MILLIS: Long = 1000L

/**
 * Validates an audio format string against the supported speech formats.
 *
 * @throws NRouterError.Configuration if null or unsupported.
 */
public fun validateAudioFormat(format: String) {
    val clean = format.trim().lowercase(Locale.ROOT)
    if (!VALID_AUDIO_FORMATS.contains(clean)) {
        throw NRouterError.Configuration(
            "Invalid audio format '$format'; must be one of: ${VALID_AUDIO_FORMATS.joinToString(", ")}"
        )
    }
}

/**
 * Polls a video generation job until completion, terminal failure, or timeout.
 *
 * Defaults to a 5-second polling interval and a 10-minute timeout.
 * Rejects intervals below 1 second and timeouts shorter than one interval.
 * Applies modest backoff and jitter across repeated non-terminal status checks,
 * and caps each individual status request to the remaining overall timeout.
 *
 * @throws NRouterError.Configuration if videoID is empty, poll interval < 1000ms, or timeout < poll interval.
 * @throws NRouterError.Service if the job reaches a terminal failure status ("failed" or "cancelled").
 * @throws NRouterError.Transport on overall timeout or network error.
 */
public suspend fun NRouter.waitForVideo(
    videoID: String,
    pollIntervalMillis: Long = DEFAULT_VIDEO_POLL_INTERVAL_MILLIS,
    timeoutMillis: Long = DEFAULT_VIDEO_TIMEOUT_MILLIS,
): NRouter.Response {
    val cleanId = videoID.trim()
    if (cleanId.isEmpty()) {
        throw NRouterError.Configuration("videoID must not be empty")
    }
    if (pollIntervalMillis < MIN_VIDEO_POLL_INTERVAL_MILLIS) {
        throw NRouterError.Configuration(
            "waitForVideo() pollIntervalMillis must be at least $MIN_VIDEO_POLL_INTERVAL_MILLIS ms; received $pollIntervalMillis"
        )
    }
    if (timeoutMillis < pollIntervalMillis) {
        throw NRouterError.Configuration(
            "waitForVideo() timeoutMillis must be at least pollIntervalMillis ($pollIntervalMillis ms); received $timeoutMillis"
        )
    }

    val start = System.currentTimeMillis()
    val deadline = start + timeoutMillis
    var nonTerminalCount = 0

    while (true) {
        currentCoroutineContext().ensureActive()
        val now = System.currentTimeMillis()
        val remaining = deadline - now
        if (remaining <= 0) {
            throw NRouterError.Transport("Timeout waiting for video job $cleanId")
        }

        // Cap each status request to the remaining overall timeout
        val resp = try {
            withTimeout(remaining) {
                retrieveVideo(cleanId)
            }
        } catch (e: TimeoutCancellationException) {
            throw NRouterError.Transport("Timeout waiting for video job $cleanId")
        }

        val status = resp.body.optString("status")?.trim()?.lowercase(Locale.ROOT)
        if (status == "completed" || status == "succeeded") {
            return resp
        } else if (status == "failed" || status == "cancelled") {
            throw NRouterError.Service(
                NRouterErrorBody(
                    message = "Video job $cleanId ended with status: $status",
                    code = "video_failed",
                    status = 500
                )
            )
        }

        nonTerminalCount++
        // Modest backoff: up to 2.5x base interval, plus +/- 15% jitter
        val backoffFactor = Math.min(2.5, Math.pow(1.2, (nonTerminalCount - 1).toDouble()))
        val baseDelay = (pollIntervalMillis * backoffFactor).toLong()
        val jitter = (Math.random() * 0.3 - 0.15) * baseDelay
        val delayMillis = Math.max(MIN_VIDEO_POLL_INTERVAL_MILLIS, (baseDelay + jitter).toLong())

        val postReqRemaining = deadline - System.currentTimeMillis()
        if (postReqRemaining <= 0) {
            throw NRouterError.Transport("Timeout waiting for video job $cleanId")
        }
        delay(Math.min(delayMillis, postReqRemaining))
    }
}

