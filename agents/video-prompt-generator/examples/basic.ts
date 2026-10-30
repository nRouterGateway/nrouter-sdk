// Usage example.
//
// From this directory, build first so the package can import itself, then run
// it with Node's built-in TypeScript type stripping (Node >= 22.18). Running it
// sends ONE billed request through nRouter:
//   npm run build
//   NROUTER_API_KEY=sk-nrouter-... node examples/basic.ts
import { nRouterError } from '@nrouter_ai/sdk';
import {
  VideoPromptValidationError,
  generateVideoPrompt,
  listVideoModels,
} from '@nrouter_ai/video-prompt-generator';

console.log('Supported video models:', listVideoModels().map((m) => m.name).join(', '));

try {
  const brief = await generateVideoPrompt({
    query: 'A cinematic 10-second introduction of the nRouter dashboard',
    videoModel: 'Google Veo',
    maxTokens: 1500,
  });
  console.log(brief);
} catch (err) {
  if (err instanceof VideoPromptValidationError) {
    console.error(`Invalid ${err.field}: ${err.message}`);
  } else if (err instanceof nRouterError) {
    console.error(`nRouter error (${err.code ?? err.status ?? 'unknown'}): ${err.message}`);
  } else {
    throw err;
  }
  process.exitCode = 1;
}
