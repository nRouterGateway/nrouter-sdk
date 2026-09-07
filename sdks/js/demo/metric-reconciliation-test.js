#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { nRouter } = require('../dist/index.js');

function loadRootEnv() {
  const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
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

async function main() {
  loadRootEnv();

  const requestedModel = 'gpt-5';
  const client = new nRouter({
    apiKey: process.env.NROUTER_API_KEY,
    baseURL: process.env.NROUTER_BASE_URL || 'https://api.nrouter.ai/v1',
    maxRetries: 0,
  });

  const started = Date.now();
  const response = await client.nr.chat({
    model: requestedModel,
    systemPrompt: 'You are a concise SDK test agent.',
    prompt: 'Reply with exactly: METRIC TEST OK',
    maxTokens: 512,
  });
  const latencyMs = Date.now() - started;
  const text = client.nr.text(response);
  const resolvedModel =
    response.body && typeof response.body.model === 'string' ? response.body.model : null;

  const result = {
    timestamp: new Date().toISOString(),
    requestId: response.meta.requestId,
    modelRequested: requestedModel,
    modelReturned: resolvedModel,
    status: 200,
    inputTokens: response.meta.inputTokens,
    outputTokens: response.meta.outputTokens,
    totalTokens: response.meta.totalTokens,
    cost: response.meta.cost,
    costStatus: response.meta.costStatus,
    latencyMs,
    text,
  };

  console.log(JSON.stringify(result, null, 2));
  console.log('');
  console.log('REQUEST ID | MODEL | INPUT | OUTPUT | TOTAL | COST | COST STATUS | LATENCY | TEXT');
  console.log(
    `${result.requestId ?? ''} | ${result.modelReturned ?? result.modelRequested} | ${
      result.inputTokens ?? ''
    } | ${result.outputTokens ?? ''} | ${result.totalTokens ?? ''} | ${result.cost ?? ''} | ${
      result.costStatus ?? ''
    } | ${result.latencyMs}ms | ${result.text}`,
  );
}

main().catch((error) => {
  const result = {
    timestamp: new Date().toISOString(),
    requestId: error?.requestId ?? error?.meta?.requestId ?? null,
    modelRequested: 'gpt-5',
    modelReturned: null,
    status: error?.status ?? null,
    inputTokens: error?.meta?.inputTokens ?? null,
    outputTokens: error?.meta?.outputTokens ?? null,
    totalTokens: error?.meta?.totalTokens ?? null,
    cost: error?.meta?.cost ?? null,
    costStatus: error?.meta?.costStatus ?? null,
    latencyMs: null,
    text: '',
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error),
    },
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
});
