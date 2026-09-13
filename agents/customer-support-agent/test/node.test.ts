import { describe, it, expect } from 'vitest';
import { readDocsDir, saveKnowledgeIndex } from '../src/node.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('readDocsDir', () => {
  it('parses frontmatter and builds correct urls', async () => {
    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'nrouter-test-'));
    try {
      await fs.writeFile(path.join(tmpdir, 'doc1.md'), `---\ntitle: Doc 1\naudiences: [internal, support]\n---\nBody text.`);
      await fs.writeFile(path.join(tmpdir, 'doc2.txt'), `No frontmatter here.`);
      
      const docs = await readDocsDir(tmpdir, 'https://docs.nrouter.ai');
      expect(docs).toHaveLength(2);
      
      const d1 = docs.find(d => d.url === 'https://docs.nrouter.ai/doc1');
      expect(d1).toBeDefined();
      expect(d1?.title).toBe('Doc 1');
      expect(d1?.audiences).toEqual(['internal', 'support']);
      expect(d1?.content).toBe('Body text.');

      const d2 = docs.find(d => d.url === 'https://docs.nrouter.ai/doc2');
      expect(d2).toBeDefined();
      expect(d2?.title).toBe('doc2.txt');
      expect(d2?.audiences).toBeUndefined();
      expect(d2?.content).toBe('No frontmatter here.');
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true });
    }
  });
});

describe('saveKnowledgeIndex', () => {
  it('saves atomically', async () => {
    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'nrouter-test-'));
    try {
      const outPath = path.join(tmpdir, 'idx.json');
      const fakeIndex: any = { version: 1, embeddingModel: 'test', dimensions: 10, createdAt: '2026-09-12T00:00:00Z', chunks: [] };
      await saveKnowledgeIndex(outPath, fakeIndex);
      
      const saved = JSON.parse(await fs.readFile(outPath, 'utf-8'));
      expect(saved.version).toBe(1);
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true });
    }
  });
});
