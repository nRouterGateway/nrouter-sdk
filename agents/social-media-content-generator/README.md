# @nrouter_ai/social-media-content-generator

Drafts technical social media posts (X and LinkedIn) about a topic, through the
nRouter gateway. One call to `generateSocialMediaContent` sends one
`POST /v1/messages` request via [`@nrouter_ai/sdk`](https://www.npmjs.com/package/@nrouter_ai/sdk)
and returns the generated text.

## Install

```bash
npm install @nrouter_ai/social-media-content-generator
```

Requires Node.js >= 22.18 and an nRouter API key (`sk-nrouter-...`).

## Usage

```ts
import { generateSocialMediaContent } from '@nrouter_ai/social-media-content-generator';

const post = await generateSocialMediaContent({
  topic: 'Why naive retries add seconds of latency during a provider outage',
  platform: 'linkedin',
  history: ['token budgets as an infrastructure default'],
});
console.log(post);
```

The API key comes from `options.apiKey`, or from `NROUTER_API_KEY` in the
environment (read by the SDK). See [`examples/basic.ts`](examples/basic.ts).

## Options

| Option | Type | Default | Rule |
|---|---|---|---|
| `topic` | `string` | required | 1 to 2000 characters after trimming (`MAX_TOPIC_LENGTH`). |
| `history` | `string[]` | `[]` | Topics of earlier posts, listed in the prompt as angles not to repeat. At most 20 entries (`MAX_HISTORY_ITEMS`), each 1 to 280 characters after trimming (`MAX_HISTORY_ITEM_LENGTH`). Over-long history is **rejected**, not truncated: pass the most recent entries. |
| `platform` | `'x' \| 'linkedin'` | none | One of `SUPPORTED_PLATFORMS`. When set, only that platform's variant is requested; when omitted, every variant in `skills/instructions.md` is. |
| `model` | `string` | `NROUTER_MODEL`, then `DEFAULT_MODEL` | Model id sent to the gateway. |
| `maxTokens` | `number` | `1024` (`DEFAULT_MAX_TOKENS`) | Positive integer, sent as `max_tokens`. |
| `apiKey` | `string` | `NROUTER_API_KEY` | Ignored when a client is injected. |

### Injecting a client

The optional second argument accepts any object with the `nr.messages(...)`
method of an `nRouter` client (`MessagesClient`). Use it to share one client or
to test offline:

```ts
import { nRouter } from '@nrouter_ai/sdk';

const client = new nRouter();
await generateSocialMediaContent({ topic: 'mTLS sidecars' }, { client });
```

## Errors

| Error | When | Billed? |
|---|---|---|
| `SocialMediaInputError` (`field`: `topic`, `history`, `platform`, `model`, `maxTokens`) | Options failed validation. Raised before any client is built or request sent. | No |
| `SocialMediaResponseError` (`stopReason`) | The gateway answered but the response had no non-empty `text` content block. | The request was sent |
| `nRouterError` and subclasses from `@nrouter_ai/sdk` | Missing or malformed API key, authentication, credit, rate limit, guardrail block, transport failure. Passed through unchanged. | Depends on the failure |

`SocialMediaInputError` and `SocialMediaResponseError` both extend
`SocialMediaAgentError`. No error raised by this package contains the API key.

## Skills

The system prompt is `skills/instructions.md` followed by `skills/brand.md`.
Both ship in the npm package and are read at call time from the package's own
`skills/` directory, so editing them changes the agent's behaviour without a
code change.

## Development

```bash
npm ci
npm run typecheck
npm test        # offline: every test uses an injected fake client
npm run build
```

## License

MIT
