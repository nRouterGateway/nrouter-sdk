import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export default async function globalSetup() {
  if (!process.env.NROUTER_API_KEY || !process.env.NROUTER_API_KEY.trim()) {
    throw new Error('NROUTER_API_KEY is unset or empty: cannot run globalSetup build-kb');
  }

  const args = [
    'bin/support-agent.mjs',
    'build-kb',
    '--docs',
    'e2e/fixtures/docs',
    '--out',
    'e2e/.kb.json',
    '--base-docs-url',
    'https://docs.northwind.example',
  ];

  if (process.env.NROUTER_BASE_URL) {
    args.push('--base-url', process.env.NROUTER_BASE_URL);
  }

  console.log('[global-setup] Running CLI build-kb...');
  const res = spawnSync('node', args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (res.status !== 0) {
    throw new Error(`CLI build-kb failed with non-zero exit code: ${res.status}`);
  }

  const kbPath = path.resolve('e2e/.kb.json');
  if (!fs.existsSync(kbPath)) {
    throw new Error(`Knowledge base file was not written to: ${kbPath}`);
  }

  const content = fs.readFileSync(kbPath, 'utf-8');
  let index: any;
  try {
    index = JSON.parse(content);
  } catch (err: any) {
    throw new Error(`Failed to parse knowledge base JSON at ${kbPath}: ${err.message}`);
  }

  if (!Array.isArray(index.chunks)) {
    throw new Error(`Knowledge base index missing chunks array: ${kbPath}`);
  }

  if (index.chunks.length < 4) {
    throw new Error(`Knowledge base index must have >= 4 chunks, got ${index.chunks.length}`);
  }

  if (index.dimensions !== 768) {
    throw new Error(`Knowledge base index dimensions must be 768, got ${index.dimensions}`);
  }

  console.log(`[global-setup] Verified index: ${index.chunks.length} chunks, dimensions ${index.dimensions}`);
}
