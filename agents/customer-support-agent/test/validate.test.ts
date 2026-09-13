import { describe, it, expect } from 'vitest';
import { validateIndex } from '../src/knowledge/validate.js';
import { SupportAgentError } from '../src/errors.js';

describe('validateIndex', () => {
  const getValid = () => ({
    version: 1,
    embeddingModel: 'model-a',
    dimensions: 2,
    createdAt: new Date().toISOString(),
    chunks: [
      {
        id: 'chunk1',
        title: 'Title 1',
        url: 'https://example.com/1',
        content: 'Content 1',
        embedding: [0.1, 0.2]
      }
    ]
  });

  it('should accept a valid index', () => {
    const valid = getValid();
    expect(validateIndex(valid)).toEqual(valid);
  });

  const expectError = (obj: any, expectedMessage: string) => {
    try {
      validateIndex(obj);
      expect.fail('should throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(SupportAgentError);
      expect(e.code).toBe('invalid_index');
      expect(e.message).toContain(expectedMessage);
    }
  };

  it('rejects non-objects', () => {
    expectError(null, 'index must be an object');
    expectError('string', 'index must be an object');
  });

  it('rejects invalid version', () => {
    expectError({ ...getValid(), version: 2 }, 'version must be 1');
  });

  it('rejects invalid embeddingModel', () => {
    expectError({ ...getValid(), embeddingModel: 123 }, 'embeddingModel must be a non-empty string');
    expectError({ ...getValid(), embeddingModel: '   ' }, 'embeddingModel must be a non-empty string');
  });

  it('rejects invalid dimensions', () => {
    expectError({ ...getValid(), dimensions: '12' }, 'dimensions must be an integer between 1 and 8192');
    expectError({ ...getValid(), dimensions: 0 }, 'dimensions must be an integer between 1 and 8192');
    expectError({ ...getValid(), dimensions: 8193 }, 'dimensions must be an integer between 1 and 8192');
    expectError({ ...getValid(), dimensions: 2.5 }, 'dimensions must be an integer between 1 and 8192');
  });

  it('rejects invalid createdAt', () => {
    expectError({ ...getValid(), createdAt: 123 }, 'createdAt must be a parseable date string');
    expectError({ ...getValid(), createdAt: 'not-a-date' }, 'createdAt must be a parseable date string');
  });

  it('rejects invalid chunks array', () => {
    expectError({ ...getValid(), chunks: {} }, 'chunks must be an array');
  });

  it('rejects invalid chunk object', () => {
    const valid = getValid();
    valid.chunks.push(null as any);
    expectError(valid, 'chunks[1] must be an object');
  });

  it('rejects invalid chunk id', () => {
    const valid = getValid();
    (valid.chunks[0] as any).id = 123;
    expectError(valid, 'chunks[0].id must be a string');
  });

  it('rejects duplicate chunk ids', () => {
    const valid = getValid();
    valid.chunks.push({ ...valid.chunks[0]! });
    expectError(valid, "chunks[1].id 'chunk1' is a duplicate");
  });

  it('rejects invalid chunk title', () => {
    const valid = getValid();
    (valid.chunks[0] as any).title = null;
    expectError(valid, 'chunks[0].title must be a string');
  });

  it('rejects invalid chunk url', () => {
    const valid = getValid();
    (valid.chunks[0] as any).url = 123;
    expectError(valid, 'chunks[0].url must be a string');
  });

  it('rejects invalid chunk content', () => {
    const valid = getValid();
    (valid.chunks[0] as any).content = '';
    expectError(valid, 'chunks[0].content must be a non-empty string');
  });

  it('rejects invalid chunk audiences', () => {
    const valid = getValid();
    (valid.chunks[0] as any).audiences = 'public';
    expectError(valid, 'chunks[0].audiences must be an array of strings');
    
    (valid.chunks[0] as any).audiences = ['public', 123];
    expectError(valid, 'chunks[0].audiences[1] must be a string');
  });

  it('rejects invalid chunk embedding array', () => {
    const valid = getValid();
    (valid.chunks[0] as any).embedding = '0.1,0.2';
    expectError(valid, 'chunks[0].embedding must be an array');
  });

  it('rejects invalid chunk embedding length', () => {
    const valid = getValid();
    valid.chunks[0]!.embedding = [0.1];
    expectError(valid, 'chunks[0].embedding length 1 != dimensions 2');
  });

  it('rejects invalid chunk embedding values', () => {
    const valid = getValid();
    (valid.chunks[0]!.embedding as any) = [0.1, '0.2'];
    expectError(valid, 'chunks[0].embedding[1] must be a finite number');

    (valid.chunks[0]!.embedding as any) = [0.1, NaN];
    expectError(valid, 'chunks[0].embedding[1] must be a finite number');
  });
});
