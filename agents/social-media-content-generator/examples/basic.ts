// From this package directory: npm run build && node examples/basic.ts
// (Node >= 22.18 runs TypeScript directly.) Needs NROUTER_API_KEY in the
// environment. Each run is one billed request.
import { nRouterError } from '@nrouter_ai/sdk';
import { SocialMediaInputError, generateSocialMediaContent } from '@nrouter_ai/social-media-content-generator';

try {
  const post = await generateSocialMediaContent({
    topic: 'Why naive retries add seconds of latency during a provider outage',
    platform: 'linkedin',
    history: ['token budgets as an infrastructure default', 'PII redaction at the gateway'],
  });
  console.log(post);
} catch (err) {
  if (err instanceof SocialMediaInputError) {
    console.error(`Invalid option "${err.field}": ${err.message}`);
  } else if (err instanceof nRouterError) {
    console.error(`Gateway refused (${err.status ?? 'no status'}): ${err.message}`);
  } else {
    throw err;
  }
  process.exitCode = 1;
}
