/**
 * @nrouter_ai/sdk — one API key for models across six provider clouds.
 *
 *   import { nRouter } from "@nrouter_ai/sdk";
 *
 *   const client = new nRouter();              // reads NROUTER_API_KEY
 *   const res = await client.nr.chat({
 *     model: "claude-sonnet-4-5-20250929",
 *     prompt: "Hello!",
 *     cache: false,
 *   });
 *   console.log(client.nr.text(res));
 *   // Unpriced is NOT free — it is unknown. Never render null as 0.
 *   console.log(res.meta.cost ?? `unpriced (${res.meta.costStatus})`);
 *
 * Every OpenAI resource is inherited unchanged: `client.chat.completions`,
 * `client.embeddings`, `client.images` all work as they always did.
 */

export {
  nRouter,
  NRouterSurface,
  DEFAULT_BASE_URL,
  DEFAULT_BODY_IDLE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  ENV_KEY,
  KEY_PREFIX,
  validateGatewayBaseUrl,
  extractTraceHeaders,
  withTraceContext,
} from './client';

// The contract: metadata, options and the wire shapes.
export {
  HEADER_NAMES,
  type ResponseMeta,
  type HeaderName,
  type NRouterExtraBody,
  type NRouterFeatureOptions,
  type NRouterCallOptions,
  type NRouterResponse,
  type ChatMessage,
  type ChatContentPart,
  type ChatRole,
} from './types';

export {
  metaFromHeaders,
  metaFromLookup,
  isPriced,
  EMPTY_META,
  parseBudgetWarning,
  isCacheHit,
  isCacheMiss,
  type BudgetWarningInfo,
} from './meta';
export { jsonRequest } from './json';

// Typed errors. Catch `nRouterError` for all of them, a subclass for one.
export {
  nRouterError,
  nRouterRequestError,
  nRouterGuardrailBlockedError,
  nRouterAuthenticationError,
  nRouterCreditError,
  nRouterBudgetExceededError,
  nRouterNotFoundError,
  nRouterRateLimitError,
  nRouterServiceError,
  nRouterTransportError,
  nRouterConfigurationError,
  classifyError,
  classifyErrorClass,
  createError,
  configurationError,
  transportError,
  isRetryable,
  parseErrorBody,
  parseGatewayErrorEnvelope,
  type ParsedErrorEnvelope,
  type ParsedErrorBody,
  parseRetryAfter,
  MAX_RETRY_AFTER_SECONDS,
  computeJitteredBackoff,
  type BackoffOptions,
  safeJsonParse,
  formatNRouterError,
  withResponse,
  ERROR_CLASS_BY_CODE,
  ERROR_STATUS_BY_CODE,
  type nRouterErrorKind,
  type nRouterErrorOptions,
} from './errors';

// The sampling policy, exported because a caller building its own body needs
// the same Claude temperature-XOR-top_p rule the playground applies.
export {
  buildSamplingParams,
  isClaudeModel,
  type SamplingInput,
  type SamplingParams,
} from './sampling';

// Body construction, exported for the same reason.
export { buildChatBody, buildExtraBody, buildFeatureBody, buildMessages } from './options';

export { NRouterModels, type NRouterModel, type NRouterModelList, type RawRequester } from './models';

// The Anthropic Messages wire. Exported for the same reason `buildChatBody` is:
// a caller assembling its own request needs to know which wire a model is
// served on, because the gateway declares `chat_completions: None` for
// Anthropic and answers 404 there. `MESSAGES_PATH` and the refusal helper stay
// unexported — `stream.ts` reaches them internally and they are not a contract.
export {
  usesMessagesWire,
  toAnthropicMessagesRequest,
  toOpenAIChatCompletion,
  isAnthropicMessageResponse,
  createAnthropicSSETranslator,
  extractNRouterHeaders,
  toFinishReason,
  toOpenAIUsage,
  type OpenAIUsage,
  type AnthropicRequestResult,
} from './chat';

// Conversation memory. CLIENT-SIDE ONLY — the gateway stores nothing between
// requests, and `memory` appears nowhere in the wire spec. Every method is a
// Promise so an async store (Redis, a file) is a one-line swap rather than a
// change at every call site.
export {
  createMemory,
  createArrayStore,
  slidingWindow,
  type Memory,
  type MemoryStore,
  type MemoryOptions,
  type WindowOptions,
} from './memory';

// Prompt templates. Ergonomics over the two wire fields that DO exist and are
// consumed (`prompt_runtime.rs` removes each independently); no new field, and
// a test pins that this module's key set equals `buildExtraBody`'s so the
// omission rules cannot fork.
export {
  PROMPT_TEMPLATE_ID_FIELD,
  PROMPT_VARIABLES_FIELD,
  PROMPT_WIRE_FIELDS,
  SYSTEM_VARIABLE_NAMES,
  promptTemplate,
  promptVariables,
  withVariables,
  promptExtraBody,
  applyPrompt,
  systemVariableConflicts,
  renderPrompt,
  type PromptSelection,
  type SystemVariableName,
  type RenderPromptOptions,
} from './prompts';

// chatTextDiagnostic is re-exported here deliberately: index.ts uses an explicit named
// list, not export *, so an accessor added to chat.ts is unreachable to a package
// consumer until it appears on this line (DIPTESH-094).
export {
  chatText,
  chatTextDiagnostic,
  compareError,
  COMPARE_ERROR_KEY,
  type ChatRunner,
  type ChatRunnerResponse,
  type ChatTextDiagnostic,
  type ChatTextCondition,
} from './chat';

export {
  parseSSE,
  isAbortError,
  type StreamRunner,
  type StreamChunk,
  type StreamResult,
} from './stream';

export {
  Multimodal,
  dataUrlToPart,
  MULTIMODAL_ENDPOINTS,
  VALID_AUDIO_FORMATS,
  validateAudioFormat,
  // The pre-send bounds on the two BILLED media calls. Runtime values, so a
  // caller can validate a form against the SAME numbers the SDK enforces
  // instead of restating them and drifting.
  MAX_IMAGE_COUNT,
  VALID_IMAGE_SIZES,
  VALID_IMAGE_QUALITIES,
  VALID_IMAGE_RESPONSE_FORMATS,
  MAX_VIDEO_SECONDS,
  MIN_VIDEO_POLL_INTERVAL_MS,
  DEFAULT_VIDEO_POLL_INTERVAL_MS,
  DEFAULT_VIDEO_TIMEOUT_MS,
  validateImageParams,
  validateVideoParams,
  validateWaitForVideoOptions,
  type AudioFormat,
  type ImageSize,
  type ImageQuality,
  type ImageResponseFormat,
  type WaitForVideoOptions,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './multimodal';

// The shapes every `Multimodal` method takes and returns.
//
// Same reason `chatTextDiagnostic` is listed explicitly above (DIPTESH-094):
// this entry is a named list, not `export *`, so a type stays unreachable to a
// package consumer until it appears here. Withholding them shipped the class
// and the helpers while hiding every argument and result, which left a
// TypeScript caller writing a voice wrapper no option but to re-declare
// `SpeechParams` by hand — a copy that drifts from the real one silently,
// because nothing compiles the two against each other.
//
// TYPE EXPORTS ONLY. Interfaces and type aliases have no runtime value, so
// none of these adds a key to `dist/index.js` and none belongs in the
// hand-written runtime re-export list in `src/index.mjs`. `AudioFormat` and
// `WaitForVideoOptions` above are the precedent. `test/audio-exports.test.ts`
// compiles a fixture against `dist/index.d.ts` to prove each name is really
// reachable — Node strips types rather than checking them, so an `import type`
// in a test erases to nothing and proves nothing — and asserts none of them
// appears as a runtime export, which is what keeps
// `test/package-entry-parity.mjs` green.
//
// `JsonValue` and `AbortSignalLike` are here because they are the component
// types of two names on this list: `JsonObject` is `{ [k: string]: JsonValue }`
// and `CallOptions` is `{ signal?: AbortSignalLike }`. Exporting a container
// while withholding what goes inside it lets a caller declare the object and
// not name its parts, which is half an export.
export type {
  SpeechParams,
  SpeechResponseFormat,
  BinaryResult,
  TranscriptionParams,
  TranslationParams,
  TranscriptionFormat,
  TranscriptionResult,
  ImageParams,
  VideoParams,
  EmbeddingsParams,
  CallOptions,
  JsonObject,
  JsonValue,
  AbortSignalLike,
} from './multimodal';

export {
  diagnoseReasoningExhaustion,
  type ReasoningExhaustionReport,
} from './diagnostics';

export { nRouter as default } from './client';
