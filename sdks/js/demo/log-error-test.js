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
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) || undefined;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}

function requestIdOf(error) {
  return (
    error?.requestId ||
    error?.request_id ||
    error?.meta?.requestId ||
    error?.meta?.request_id ||
    headerValue(error?.headers, 'x-nr-request-id') ||
    headerValue(error?.response?.headers, 'x-nr-request-id') ||
    null
  );
}

function publicError(testId, error) {
  return {
    testId,
    name: error?.name || 'Error',
    status: error?.status ?? error?.response?.status ?? null,
    message: error?.message || String(error),
    requestId: requestIdOf(error),
    timestamp: new Date().toISOString(),
  };
}

async function runOne(client, testId, model, prompt, maxTokens) {
  try {
    await client.nr.chat({ model, prompt, maxTokens });
    return {
      testId,
      name: null,
      status: 200,
      message: 'request unexpectedly succeeded',
      requestId: null,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return publicError(testId, error);
  }
}

async function main() {
  loadRootEnv();
  const baseURL = process.env.NROUTER_BASE_URL || 'https://api.nrouter.ai/v1';
  const client = new nRouter({
    apiKey: process.env.NROUTER_API_KEY,
    baseURL,
    maxRetries: 0,
  });

  console.log(JSON.stringify({ baseURL }, null, 2));

  const results = [];
  results.push(
    await runOne(
      client,
      'LOG-ERROR-001',
      'definitely-invalid-model-log-test',
      'LOG-ERROR-001',
      8,
    ),
  );
  results.push(
    await runOne(client, 'LOG-ERROR-002', 'nrsmart', 'LOG-ERROR-002 Reply OK', 32),
  );

  for (const result of results) {
    console.log(JSON.stringify(result, null, 2));
  }

  console.log('');
  console.log('TEST | STATUS | ERROR | REQUEST ID');
  for (const result of results) {
    console.log(
      `${result.testId} | ${result.status ?? ''} | ${result.name || ''}: ${result.message} | ${
        result.requestId ?? ''
      }`,
    );
  }
}

main().catch((error) => {
  const result = publicError('SETUP', error);
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
});
