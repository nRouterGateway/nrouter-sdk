# @nrouter_ai/image-prompt-generator

Turns a short description into a prompt for an image model, following the
nRouter image brand rules. It makes one `POST /v1/messages` call through
[`@nrouter_ai/sdk`](https://www.npmjs.com/package/@nrouter_ai/sdk) and returns
the generated prompt text.

## Install

```bash
npm install @nrouter_ai/image-prompt-generator
```

Requires Node.js >= 22.18 and an nRouter API key (`sk-nrouter-...`).

## Usage

```ts
import { generateImagePrompt } from '@nrouter_ai/image-prompt-generator';

// Reads NROUTER_API_KEY (and NROUTER_MODEL, if set) from the environment.
const prompt = await generateImagePrompt({
  query: 'a hero image about failover routing between model providers',
});
console.log(prompt);
```

Each call is a billed request to the nRouter gateway. A runnable example is in
[`examples/basic.ts`](examples/basic.ts).

## Options

`generateImagePrompt(options, deps?)` returns `Promise<string>`.

| Option | Type | Default | Notes |
|---|---|---|---|
| `query` | `string` | — (required) | Trimmed. Must be non-empty and at most `MAX_QUERY_LENGTH` (4000) characters. |
| `model` | `string` | `NROUTER_MODEL`, then `DEFAULT_MODEL` (`claude-haiku-4-5-20251001`) | A blank `NROUTER_MODEL` counts as unset. |
| `maxTokens` | `number` | `DEFAULT_MAX_TOKENS` (1024) | Must be a positive integer. Sent as `max_tokens`. |
| `apiKey` | `string` | `NROUTER_API_KEY` | Passed to the SDK client. |
| `baseUrl` | `string` | SDK default | Passed to the SDK client as `baseURL`. |

`deps.client` lets you supply your own client instead of the one built from
`apiKey`/`baseUrl` (which are then ignored). Any object with a
`nr.messages(body)` method returning `{ body, meta? }` works — an `nRouter`
instance from `@nrouter_ai/sdk` does, and so does a test double:

```ts
import { nRouter } from '@nrouter_ai/sdk';
const client = new nRouter({ apiKey: process.env.NROUTER_API_KEY });
await generateImagePrompt({ query: 'launch banner' }, { client });
```

## System prompt

The system prompt is `skills/instructions.md` followed by `skills/brand.md`,
read at call time from the `skills/` directory shipped in this package. Edit
those files to change the agent's behaviour; the brand rules (obsidian
`#0a0a0b` backgrounds, mint `#90FCA6` as an accent only, no text or logos,
nRouter shown as a gateway, never as an AI model) live in `brand.md`.

## Errors

Errors raised by this package extend `ImagePromptError`:

- `ImagePromptInputError` — invalid `query`, `model` or `maxTokens`. Thrown
  before any request is sent. `field` names the offending option.
- `ImagePromptResponseError` — the gateway replied but the response had no
  text content. Carries `stopReason` and `requestId` when the response had them.

Errors from the SDK or gateway — missing or malformed API key, invalid base
URL, authentication, credit, rate-limit, guardrail and transport failures —
are not wrapped. They propagate unchanged as `@nrouter_ai/sdk`'s
`nRouterError` subclasses (`nRouterConfigurationError`,
`nRouterAuthenticationError`, `nRouterRateLimitError`, ...).

```ts
import { nRouterError } from '@nrouter_ai/sdk';
import { ImagePromptError, generateImagePrompt } from '@nrouter_ai/image-prompt-generator';

try {
  console.log(await generateImagePrompt({ query: 'routing dashboard hero' }));
} catch (err) {
  if (err instanceof ImagePromptError) console.error(err.name, err.message);
  else if (err instanceof nRouterError) console.error(err.kind, err.status, err.message);
  else throw err;
}
```

## Development

```bash
npm ci
npm run typecheck
npm test        # offline: uses an injected fake client, no API key needed
npm run build
```

## License

MIT
