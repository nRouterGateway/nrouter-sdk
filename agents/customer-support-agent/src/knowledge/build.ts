// LANE L4 owns this file.
import type { BuildIndexOptions, KnowledgeIndex, KnowledgeChunk } from '../types.js';
import { chunkDocs } from './chunk.js';
import { validateIndex } from './validate.js';
import { SupportAgentError } from '../errors.js';
import { embed } from '../client.js';

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_EMBED_BATCH = 64;

export async function buildKnowledgeIndex(opts: BuildIndexOptions): Promise<KnowledgeIndex> {
  const embeddingModel = opts.embeddingModel || DEFAULT_EMBEDDING_MODEL;
  const dimensions = opts.dimensions || DEFAULT_EMBEDDING_DIMENSIONS;
  const batchSize = opts.batchSize || DEFAULT_EMBED_BATCH;

  if (opts.docs.length === 0) {
    const emptyIndex: KnowledgeIndex = {
      version: 1,
      embeddingModel,
      dimensions,
      createdAt: new Date().toISOString(),
      chunks: []
    };
    validateIndex(emptyIndex);
    return emptyIndex;
  }

  const baseChunks = chunkDocs(opts.docs);
  const chunks: KnowledgeChunk[] = [];

  for (let i = 0; i < baseChunks.length; i += batchSize) {
    if (opts.signal?.aborted) {
      throw new SupportAgentError('aborted', 'build aborted');
    }

    const batch = baseChunks.slice(i, i + batchSize);
    const input = batch.map(c => c.content);

    let vectors: number[][];
    try {
      vectors = await embed(opts.client, embeddingModel, input, dimensions, opts.signal);
    } catch (error: any) {
      if (error?.name === 'AbortError' || opts.signal?.aborted) {
        throw new SupportAgentError('aborted', 'build aborted');
      }
      throw error;
    }

    for (let j = 0; j < batch.length; j++) {
      const b = batch[j]!;
      chunks.push({
        id: b.id,
        title: b.title,
        url: b.url,
        content: b.content,
        audiences: b.audiences,
        embedding: vectors[j]!
      });
    }
  }

  const index: KnowledgeIndex = {
    version: 1,
    embeddingModel,
    dimensions,
    createdAt: new Date().toISOString(),
    chunks,
  };

  validateIndex(index);
  return index;
}
