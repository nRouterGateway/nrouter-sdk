import fs from 'node:fs';
import { createSupportAgent } from '../dist/index.js';

async function main() {
  const kbPath = process.env.KB_PATH;
  const apiKey = process.env.NROUTER_API_KEY;

  if (!kbPath || !apiKey) {
    console.error("Missing KB_PATH or NROUTER_API_KEY environment variables.");
    process.exit(1);
  }

  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const dataset = JSON.parse(fs.readFileSync(new URL('dataset.json', import.meta.url), 'utf8'));

  const agent = createSupportAgent({
    apiKey,
    model: process.env.EVAL_MODEL || 'claude-haiku-4-5-20251001',
    knowledge: kb
  });

  console.log('Running evals...');
  for (const tc of dataset.cases) {
    console.log(`\nCase: ${tc.id} - ${tc.question}`);
    try {
      const stream = agent.chat({
        messages: [{ role: 'user', content: tc.question }]
      });
      let responseText = '';
      let confidenceLevel = null;
      let okError = false;

      for await (const event of stream) {
        if (event.type === 'token') {
          responseText += event.text;
        } else if (event.type === 'confidence') {
          confidenceLevel = event.level;
        } else if (event.type === 'error') {
          if (tc.expect.okErrors && tc.expect.okErrors.includes(event.code)) {
            okError = true;
          } else {
             throw new Error(`Unexpected agent error: ${event.code} - ${event.message}`);
          }
        }
      }

      if (okError) {
         console.log(`PASS - matched expected error`);
         continue;
      }
      
      let pass = true;
      if (tc.expect.confidenceIn && !tc.expect.confidenceIn.includes(confidenceLevel)) {
         console.log(`FAIL - confidence ${confidenceLevel} not in ${JSON.stringify(tc.expect.confidenceIn)}`);
         pass = false;
      }
      if (tc.expect.containsAny) {
         const hasAny = tc.expect.containsAny.some(word => responseText.toLowerCase().includes(word.toLowerCase()));
         if (!hasAny) {
            console.log(`FAIL - response did not contain any of ${JSON.stringify(tc.expect.containsAny)}`);
            pass = false;
         }
      }
      if (tc.expect.notContains) {
         const hasBanned = tc.expect.notContains.some(word => responseText.toLowerCase().includes(word.toLowerCase()));
         if (hasBanned) {
            console.log(`FAIL - response contained banned words ${JSON.stringify(tc.expect.notContains)}`);
            pass = false;
         }
      }

      if (pass) {
        console.log(`PASS`);
      }
    } catch (e) {
      console.log(`FAIL - Exception: ${e.message}`);
    }
  }
}

main().catch(console.error);
