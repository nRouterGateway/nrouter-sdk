import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retrieve } from '../src/retrieval.js';
import * as client from '../src/client.js';

vi.mock('../src/client.js', () => ({
  embed: vi.fn(),
}));

describe('retrieve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never embeds for empty/whitespace question and returns []', async () => {
    const cfg = {
      client: {},
      store: { search: vi.fn() }
    } as any;

    expect(await retrieve(cfg, '')).toEqual([]);
    expect(await retrieve(cfg, '   \n ')).toEqual([]);
    expect(client.embed).not.toHaveBeenCalled();
    expect(cfg.store.search).not.toHaveBeenCalled();
  });

  it('embeds question and calls store.search with topK and audiences', async () => {
    const mockStore = {
      embeddingModel: 'test-model',
      dimensions: 1536,
      search: vi.fn().mockResolvedValue([{ id: '1', similarity: 0.9 }])
    };
    const cfg = {
      client: {},
      store: mockStore,
      topK: 5
    } as any;
    
    vi.mocked(client.embed).mockResolvedValue([[0.1, 0.2]]);
    const signal = new AbortController().signal;

    const res = await retrieve(cfg, 'How do I test?', { audiences: ['dev'], signal });

    expect(client.embed).toHaveBeenCalledWith(
      cfg.client,
      'test-model',
      ['How do I test?'],
      1536,
      signal
    );
    expect(mockStore.search).toHaveBeenCalledWith([0.1, 0.2], {
      topK: 5,
      audiences: ['dev']
    });
    expect(res).toEqual([{ id: '1', similarity: 0.9 }]);
  });

  it('embeds the trimmed question, the same text it tested for emptiness', async () => {
    const cfg = {
      client: {},
      store: { embeddingModel: 'm', dimensions: 2, search: vi.fn().mockResolvedValue([]) },
      topK: 3,
    } as any;
    vi.mocked(client.embed).mockResolvedValue([[0.1, 0.2]]);

    await retrieve(cfg, '  padded question \n');

    expect(vi.mocked(client.embed).mock.calls[0]![2]).toEqual(['padded question']);
  });
});
