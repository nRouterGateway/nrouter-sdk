# nRouter agents

Small, self-contained agent packages built on the nRouter JavaScript SDK
([`@nrouter_ai/sdk`](../sdks/js)). Each folder is its own npm package with its
own `package.json`, lockfile, tests and README.

| Agent | What it does |
|---|---|
| [`image-prompt-generator`](./image-prompt-generator) | An image prompt generator agent adhering to nRouter brand standards. |
| [`video-prompt-generator`](./video-prompt-generator) | A video prompt generator agent for AI video models. |
| [`social-media-content-generator`](./social-media-content-generator) | A viral social media content generator agent. |

The public, zero-database customer support agent (`@nrouter_ai/support-agent`)
is not here: it lives in its own repository,
[nRouterGateway/customer-support-agent](https://github.com/nRouterGateway/customer-support-agent).

## SDK version

Every agent pins an **exact, published** `@nrouter_ai/sdk` version in its
`package.json` (no `^`/`~` ranges, no local `file:` links), so an agent builds
the same way from a clean checkout as it does from npm. Read the pinned
version from each agent's `package.json`.

## Test one agent (offline)

No API key and no network calls to the gateway are needed:

```bash
cd agents/<name>
npm ci
npm run typecheck
npm test
npm run build
```

## Live smoke (opt-in, billed)

[`smoke-live.mjs`](./smoke-live.mjs) makes one minimal call per agent through
the gateway using each agent's built `dist/`. It spends credits, so it refuses
to run unless you opt in explicitly:

```bash
# build each agent first (see above), then:
NROUTER_LIVE=1 NROUTER_API_KEY=<your key> node agents/smoke-live.mjs
```

`NROUTER_MODEL` optionally overrides the model the agents use. The script
exits `0` only when every agent returns a non-empty response.
