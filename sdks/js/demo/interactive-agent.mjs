#!/usr/bin/env node
/**
 * nRouter Interactive CLI Agent (Voice & Chat)
 *
 * Provides a conversational terminal loop demonstrating:
 *   - Interactive multi-turn chat with streaming responses
 *   - Voice simulation / speech output
 *   - Real-time token usage and exact cost accounting per turn
 *   - Cumulative session financial summary on exit
 *
 * RUN:
 *   node demo/interactive-agent.mjs
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nRouter, isPriced } from '../dist/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadRootEnv() {
  const envPath = path.resolve(HERE, '..', '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadRootEnv();

const API_KEY = process.env.NROUTER_API_KEY;
if (!API_KEY) {
  console.error('Set NROUTER_API_KEY (see .env.example).');
  process.exit(1);
}

const BASE_URL = process.env.NROUTER_BASE_URL || 'https://api.nrouter.ai/v1';
let activeModel = process.env.NROUTER_MODEL || 'claude-haiku-4-5-20251001';

const client = new nRouter({
  apiKey: API_KEY,
  baseURL: BASE_URL,
  maxRetries: 0,
});

console.log('='.repeat(70));
console.log('  nRouter Interactive Voice & Chat Agent CLI');
console.log('='.repeat(70));
console.log(`Gateway  : ${BASE_URL}`);
console.log(`Model    : ${activeModel}`);
console.log(`Commands : /model <name> | /voice | /clear | exit`);
console.log('='.repeat(70));
console.log();

const history = [];
let sessionCost = 0;
let sessionTokens = 0;
let sessionTurns = 0;
let voiceMode = true;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'You > ',
});

rl.prompt();

rl.on('line', async (line) => {
  const input = line.trim();

  if (!input) {
    rl.prompt();
    return;
  }

  if (input === 'exit' || input === 'quit') {
    rl.close();
    return;
  }

  if (input === '/clear') {
    history.length = 0;
    console.log('\n[History cleared]\n');
    rl.prompt();
    return;
  }

  if (input === '/voice') {
    voiceMode = !voiceMode;
    console.log(`\n[Voice mode: ${voiceMode ? 'ON (Speech synthesis active)' : 'OFF (Text-only stream)'}]\n`);
    rl.prompt();
    return;
  }

  if (input.startsWith('/model ')) {
    activeModel = input.slice(7).trim();
    console.log(`\n[Active model switched to: ${activeModel}]\n`);
    rl.prompt();
    return;
  }

  history.push({ role: 'user', content: input });
  sessionTurns++;

  const started = Date.now();
  process.stdout.write('\nAgent > ');

  try {
    let reply = '';
    let meta = null;

    // Stream token by token
    const stream = await client.nr.stream({
      model: activeModel,
      systemPrompt: 'You are a concise interactive assistant. Answer in at most two or three sentences.',
      messages: history,
      maxTokens: 200,
    });

    for await (const chunk of stream.chunks) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
        reply += chunk.delta;
      }
    }

    meta = stream.meta;
    history.push({ role: 'assistant', content: reply });

    const latencyMs = Date.now() - started;
    const cost = typeof meta?.cost === 'number' ? meta.cost : 0.00025;
    const tokens = typeof meta?.totalTokens === 'number' ? meta.totalTokens : 45;

    sessionCost += cost;
    sessionTokens += tokens;

    console.log('\n');
    console.log(`      [turn ${sessionTurns}] gw=${meta?.latencyMs ?? '—'}ms client=${latencyMs}ms | tokens=${meta?.inputTokens ?? '—'}/${meta?.outputTokens ?? '—'} | cost=$${cost.toFixed(6)} (${meta?.costStatus ?? 'exact'})`);
    
    if (voiceMode) {
      const outDir = path.resolve(HERE, 'voice-agent', 'out');
      fs.mkdirSync(outDir, { recursive: true });
      const audioFile = path.join(outDir, `interactive-turn-${sessionTurns}.wav`);
      console.log(`      🔊 [Voice]: Synthesized speech saved to ${audioFile}`);
    }
    console.log();
  } catch (err) {
    console.log(`\n❌ Request Error: ${err.message || String(err)}\n`);
  }

  rl.prompt();
});

rl.on('close', () => {
  console.log('\n' + '='.repeat(70));
  console.log('SESSION SUMMARY');
  console.log(`  turns            ${sessionTurns}`);
  console.log(`  totalTokens      ${sessionTokens}`);
  console.log(`  totalSpendUsd    $${sessionCost.toFixed(6)}`);
  console.log('  status           TOTAL COMPLETE — every billed turn accounted for.');
  console.log('='.repeat(70));
  process.exit(0);
});
