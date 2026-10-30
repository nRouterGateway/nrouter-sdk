#!/usr/bin/env node
// Opt-in live smoke for the agents in this folder.
//
// Makes ONE minimal, billed call per agent through the nRouter gateway, using
// each agent's built output (dist/). It refuses to run unless you opt in:
//
//   NROUTER_LIVE=1 NROUTER_API_KEY=sk-nrouter-... node agents/smoke-live.mjs
//
// Build each agent first: (cd agents/<name> && npm ci && npm run build)
// Optional: NROUTER_MODEL overrides the model each agent uses.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function refuse(message) {
  console.error(`smoke-live: refusing to run: ${message}`);
  process.exit(2);
}

if (process.env.NROUTER_LIVE !== '1') {
  refuse('this script makes live, billed gateway calls. Set NROUTER_LIVE=1 to opt in.');
}
if (!process.env.NROUTER_API_KEY || !process.env.NROUTER_API_KEY.trim()) {
  refuse('NROUTER_API_KEY is not set.');
}

const here = dirname(fileURLToPath(import.meta.url));

// One minimal call per agent. `call` receives the agent's dist/index.js module.
const AGENTS = [
  {
    name: 'image-prompt-generator',
    exportName: 'generateImagePrompt',
    call: (fn) => fn({ query: 'A one-line banner idea for a gateway release.' }),
  },
  {
    name: 'video-prompt-generator',
    exportName: 'generateVideoPrompt',
    call: (fn) => fn({ query: 'A five-second product teaser.', videoModel: 'Google Veo' }),
  },
  {
    name: 'social-media-content-generator',
    exportName: 'generateSocialMediaContent',
    call: (fn) => fn({ topic: 'Announcing model fallbacks.', history: [] }),
  },
];

let failures = 0;
for (const agent of AGENTS) {
  const entry = join(here, agent.name, 'dist', 'index.js');
  if (!existsSync(entry)) {
    console.error(`FAIL ${agent.name}: ${entry} not found; run npm ci && npm run build in agents/${agent.name}`);
    failures += 1;
    continue;
  }
  try {
    const mod = await import(pathToFileURL(entry).href);
    const fn = mod[agent.exportName];
    if (typeof fn !== 'function') {
      throw new Error(`dist/index.js does not export ${agent.exportName}()`);
    }
    const out = await agent.call(fn);
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    if (!text || !text.trim()) {
      throw new Error('empty response');
    }
    console.log(`PASS ${agent.name}: ${text.trim().slice(0, 80).replace(/\s+/g, ' ')}...`);
  } catch (err) {
    // Print the message only: never dump objects that could carry request headers.
    console.error(`FAIL ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
    failures += 1;
  }
}

process.exit(failures === 0 ? 0 : 1);
