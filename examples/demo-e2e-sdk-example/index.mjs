/**
 * nRouter npm SDK — end-to-end example.
 *
 *   npm install && cp .env.example .env && npm start
 *
 * Sends one real request and prints what came back, including the two things a
 * production integration must branch on:
 *
 *   1. THE COST. `meta.cost` is the priced cost of THIS request and
 *      `meta.costStatus` says whether it is trustworthy. `exact` means priced;
 *      `unpriced` means nRouter could not price the model and the cost is
 *      ABSENT — never silently zero. Treating an absent cost as 0 is how spend
 *      dashboards under-report; branch on costStatus, not on `cost ?? 0`.
 *
 *   2. THE REFUSAL. Errors are typed, so a caller can tell "your key is fine but
 *      the account is suspended" from "your key is wrong". Retrying the first is
 *      pointless; the second needs a new key. `err.kind`, `err.status` and
 *      `err.authReason` are the fields that carry it.
 */
import 'dotenv/config';
import { nRouter } from '@nrouter_ai/sdk';

const { NROUTER_API_KEY, NROUTER_BASE_URL, NROUTER_MODEL } = process.env;

if (!NROUTER_API_KEY) {
  console.error('Set NROUTER_API_KEY (copy .env.example to .env).');
  process.exit(1);
}

const client = new nRouter({
  apiKey: NROUTER_API_KEY,
  ...(NROUTER_BASE_URL ? { baseURL: NROUTER_BASE_URL } : {}),
});

const model = NROUTER_MODEL || 'claude-fable-5';

console.log(`→ ${model} via ${NROUTER_BASE_URL || 'https://api.nrouter.ai/v1'}\n`);

try {
  const res = await client.nr.chat({
    model,
    prompt:
      process.env.NROUTER_PROMPT ||
      'In two sentences, why should an LLM gateway report an unknown price as "unpriced" rather than as zero?',
    maxTokens: Number(process.env.NROUTER_MAX_TOKENS || 200),
  });

  console.log(client.nr.text(res));
  console.log('\n--- request metadata ---');
  console.log({
    requestId: res.meta.requestId,
    model: res.meta.model,
    cost: res.meta.cost,
    costStatus: res.meta.costStatus,
    inputTokens: res.meta.inputTokens,
    outputTokens: res.meta.outputTokens,
    // A byte-identical repeat inside the TTL is served from a tenant-keyed
    // cache. It still costs: a cache hit skips the provider call but is still
    // authorized, rate-limited, guardrailed, metered and billed.
    responseCache: res.meta.responseCache,
    responseCacheAge: res.meta.responseCacheAge,
  });

  // `unpriced` is a real, expected state — not an error. It means the request
  // was served but nRouter could not price it, so no cost is reported at all.
  if (res.meta.costStatus !== 'exact') {
    console.log(`\n⚠ costStatus=${res.meta.costStatus}: served, but NOT priced. Do not record this as $0.`);
  }
} catch (err) {
  // Typed failure. The distinction that matters operationally is WHY.
  console.error('✗ request refused\n');
  console.error({
    kind: err.kind,             // 'authentication' | 'permission' | 'rate_limit' | ...
    status: err.status,         // HTTP status
    message: err.message,
    authReason: err.authReason, // e.g. key_blocked, account_hold, key_route_not_allowed
    limitSource: err.limitSource,
    requestId: err.meta?.requestId,
  });

  // Worth branching on: an account-level hold is not a bad key. Minting a new
  // key will not help, and retrying will not either — a human must lift it.
  const reason = err.authReason ?? '';
  if (reason.includes('hold') || reason.includes('blocked')) {
    console.error(
      '\n→ This key is not invalid: the ACCOUNT is suspended. A new key will not help ' +
        'and retrying will not either. Contact support to have the hold reviewed.',
    );
  }
  process.exitCode = 1;
}
