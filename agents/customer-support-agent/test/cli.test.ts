import { describe, it, expect, vi } from 'vitest';
import { runCliWith } from '../src/cli.js';

vi.mock('../src/node.js', () => ({
  readDocsDir: vi.fn().mockResolvedValue([]),
  saveKnowledgeIndex: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../src/knowledge/fetch.js', () => ({
  fetchSeedPages: vi.fn().mockResolvedValue([])
}));

vi.mock('../src/knowledge/build.js', () => ({
  buildKnowledgeIndex: vi.fn().mockResolvedValue({
    version: 1,
    embeddingModel: 'test',
    dimensions: 10,
    createdAt: '2026-09-12T00:00:00Z',
    chunks: []
  })
}));

describe('cli', () => {
  it('exits 2 on missing docs', async () => {
    const code = await runCliWith(['build-kb', '--out', 'out.json'], { NROUTER_API_KEY: 'sk-nrouter-test' }, {});
    expect(code).toBe(2);
  });

  it('exits 1 without printing key when NROUTER_API_KEY is missing', async () => {
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCliWith(['build-kb', '--docs', 'dir', '--out', 'out.json'], {}, {});
    expect(code).toBe(1);
    expect(spyErr).toHaveBeenCalledWith(expect.stringContaining('NROUTER_API_KEY'));
    spyErr.mockRestore();
  });

  it('runs successfully when properly invoked', async () => {
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runCliWith(
      ['build-kb', '--docs', 'dir', '--out', 'out.json'],
      { NROUTER_API_KEY: 'sk-nrouter-fake' },
      {}
    );
    expect(code).toBe(0);
    expect(spyLog).toHaveBeenCalledWith(expect.stringContaining('Built index:'));
    spyLog.mockRestore();
  });

  it('redacts sk-nrouter- keys from error messages', async () => {
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Force buildKnowledgeIndex to throw an error containing the key
    const buildModule = await import('../src/knowledge/build.js');
    (buildModule.buildKnowledgeIndex as any).mockRejectedValueOnce(new Error('Failed with key sk-nrouter-secretkey123 here'));

    const code = await runCliWith(
      ['build-kb', '--docs', 'dir', '--out', 'out.json'],
      { NROUTER_API_KEY: 'sk-nrouter-fake' },
      {}
    );
    
    expect(code).toBe(1);
    expect(spyErr).toHaveBeenCalledWith(expect.stringContaining('[redacted]'));
    expect(spyErr).not.toHaveBeenCalledWith(expect.stringContaining('sk-nrouter-secretkey123'));
    spyErr.mockRestore();
  });
});
