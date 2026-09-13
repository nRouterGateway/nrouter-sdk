import { describe, it, expect } from 'vitest';
import { scoreConfidence } from '../src/confidence.js';

describe('scoreConfidence', () => {
  it('returns low and 0 when no chunks are provided', () => {
    expect(scoreConfidence([], { high: 0.8, medium: 0.5 })).toEqual({
      level: 'low',
      score: 0
    });
  });

  it('clamps and rounds similarity properly to 3 decimals', () => {
    const res1 = scoreConfidence([{ similarity: 1.1 } as any], { high: 0.8, medium: 0.5 });
    expect(res1.score).toBe(1);

    const res2 = scoreConfidence([{ similarity: -0.5 } as any], { high: 0.8, medium: 0.5 });
    expect(res2.score).toBe(0);

    const res3 = scoreConfidence([{ similarity: 0.123456 } as any], { high: 0.8, medium: 0.5 });
    expect(res3.score).toBe(0.123);
  });

  it('assigns levels exactly at boundaries', () => {
    const thresholds = { high: 0.8, medium: 0.5 };
    
    expect(scoreConfidence([{ similarity: 0.8 } as any], thresholds).level).toBe('high');
    expect(scoreConfidence([{ similarity: 0.799 } as any], thresholds).level).toBe('medium');
    expect(scoreConfidence([{ similarity: 0.5 } as any], thresholds).level).toBe('medium');
    expect(scoreConfidence([{ similarity: 0.499 } as any], thresholds).level).toBe('low');
  });

  it('handles bad similarity values gracefully', () => {
    const res = scoreConfidence([{ similarity: NaN } as any], { high: 0.8, medium: 0.5 });
    expect(res.score).toBe(0);
    expect(res.level).toBe('low');

    const res2 = scoreConfidence([{ similarity: Infinity } as any], { high: 0.8, medium: 0.5 });
    expect(res2.score).toBe(0);
    
    const res3 = scoreConfidence([{ similarity: undefined } as any], { high: 0.8, medium: 0.5 });
    expect(res3.score).toBe(0);
  });
});
