#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { nRouter } = require('../../../sdks/js/dist/index.js');

function loadRootEnv() {
  const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function requestIdFrom(value) {
  const headers = value?.headers;
  if (!headers) return value?.requestId ?? value?.request_id ?? value?.meta?.requestId ?? null;
  const get = typeof headers.get === 'function'
    ? (name) => headers.get(name)
    : (name) => headers[name] ?? headers[name.toLowerCase()];
  return value?.requestId ?? value?.request_id ?? value?.meta?.requestId
    ?? get('x-nr-request-id') ?? get('x-request-id') ?? null;
}

function percentile(values, percentileRank) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentileRank;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function main() {
  loadRootEnv();
  const baseURL = process.env.NROUTER_BASE_URL || 'https://api.nrouter.ai/v1';
  const client = new nRouter({
    apiKey: process.env.NROUTER_API_KEY,
    baseURL,
    maxRetries: 0,
  });
  const model = 'gpt-4o-mini';
  const successes = [];
  const failures = [];

  console.log(`BASE URL | ${baseURL}`);
  console.log('TEST ID | REQUEST ID | STATUS | LATENCY MS | INPUT | OUTPUT | COST');

  for (let index = 1; index <= 10; index += 1) {
    const testId = `PERF-${String(index).padStart(3, '0')}`;
    const started = Date.now();
    try {
      const response = await client.nr.chat({
        model,
        prompt: `${testId} Reply exactly OK`,
        maxTokens: 16,
      });
      const latencyMs = Date.now() - started;
      const row = {
        testId,
        requestId: requestIdFrom(response),
        status: 200,
        latencyMs,
        inputTokens: numberOrNull(response?.meta?.inputTokens),
        outputTokens: numberOrNull(response?.meta?.outputTokens),
        cost: numberOrNull(response?.meta?.cost),
      };
      successes.push(row);
      console.log(`${row.testId} | ${row.requestId ?? ''} | ${row.status} | ${row.latencyMs} | ${row.inputTokens ?? ''} | ${row.outputTokens ?? ''} | ${row.cost ?? ''}`);
    } catch (error) {
      throw new Error(`${testId} unexpectedly failed: ${error?.message || String(error)}`);
    }
  }

  for (const [testId, modelName, prompt] of [
    ['PERF-ERR-001', 'definitely-invalid-model-perf-test', 'PERF-ERR-001'],
    ['PERF-ERR-002', 'nrsmart', 'PERF-ERR-002 Reply exactly OK'],
  ]) {
    const started = Date.now();
    try {
      await client.nr.chat({ model: modelName, prompt, maxTokens: 16 });
      throw new Error('request unexpectedly succeeded');
    } catch (error) {
      const row = {
        testId,
        requestId: requestIdFrom(error),
        status: error?.status ?? error?.statusCode ?? null,
        errorClass: error?.name || 'Error',
        latencyMs: Date.now() - started,
      };
      failures.push(row);
      console.log(`${row.testId} | ${row.requestId ?? ''} | ${row.status ?? ''} | ${row.errorClass} | ${row.latencyMs}`);
    }
  }

  const latencies = successes.map((row) => row.latencyMs);
  const totalInput = successes.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  const totalOutput = successes.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0);
  const exactCosts = successes.map((row) => row.cost).filter((cost) => cost !== null);
  const totalCost = exactCosts.length === successes.length
    ? exactCosts.reduce((sum, cost) => sum + cost, 0)
    : null;

  console.log('');
  console.log('FAILURE TEST ID | REQUEST ID | HTTP STATUS | ERROR CLASS | LATENCY MS');
  for (const row of failures) {
    console.log(`${row.testId} | ${row.requestId ?? ''} | ${row.status ?? ''} | ${row.errorClass} | ${row.latencyMs}`);
  }
  console.log('');
  console.log('SUMMARY');
  console.log(`count: ${successes.length}`);
  console.log(`min latency: ${Math.min(...latencies)} ms`);
  console.log(`average latency: ${(latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2)} ms`);
  console.log(`P50: ${percentile(latencies, 0.50).toFixed(2)} ms`);
  console.log(`P75: ${percentile(latencies, 0.75).toFixed(2)} ms`);
  console.log(`P90: ${percentile(latencies, 0.90).toFixed(2)} ms`);
  console.log(`P95: ${percentile(latencies, 0.95).toFixed(2)} ms`);
  console.log(`max latency: ${Math.max(...latencies)} ms`);
  console.log(`total input tokens: ${totalInput}`);
  console.log(`total output tokens: ${totalOutput}`);
  console.log(`total exact cost: ${totalCost === null ? 'unavailable' : totalCost.toFixed(10)}`);
  console.log(`attempted requests: ${successes.length + failures.length}`);
  console.log(`successes: ${successes.length}`);
  console.log(`failures: ${failures.length}`);
  console.log(`observed failure rate: ${(failures.length / (successes.length + failures.length) * 100).toFixed(2)}%`);
  console.log(`both failures returned x-nr-request-id: ${failures.every((row) => Boolean(row.requestId)) ? 'yes' : 'no'}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
