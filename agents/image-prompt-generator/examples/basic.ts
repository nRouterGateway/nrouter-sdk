// Usage example. With NROUTER_API_KEY set, from this package's directory:
//   npm run build && node examples/basic.ts "a hero image about failover routing"
// (Node >= 22.18 runs .ts files directly.) This makes one billed request.
import { nRouterError } from '@nrouter_ai/sdk';
import { ImagePromptError, generateImagePrompt } from '@nrouter_ai/image-prompt-generator';

const query = process.argv.slice(2).join(' ') || 'a hero image about secure LLM routing';

try {
  const prompt = await generateImagePrompt({ query, maxTokens: 512 });
  console.log(prompt);
} catch (err) {
  if (err instanceof ImagePromptError) {
    console.error(`${err.name}: ${err.message}`);
  } else if (err instanceof nRouterError) {
    console.error(`nRouter ${err.kind} error (status ${err.status ?? 'n/a'}): ${err.message}`);
  } else {
    throw err;
  }
  process.exitCode = 1;
}
