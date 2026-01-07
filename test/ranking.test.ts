import { describe, expect, it } from 'vitest';
import { selectWinners } from '../src/domain/ranking.js';

describe('selectWinners', () => {
  it('selects top N by amount desc', () => {
    const bids = [
      { userId: 'u1', amount: 10, lastBidAt: new Date('2026-01-01T00:00:00Z') },
      { userId: 'u2', amount: 30, lastBidAt: new Date('2026-01-01T00:00:00Z') },
      { userId: 'u3', amount: 20, lastBidAt: new Date('2026-01-01T00:00:00Z') }
    ];
    const { winners, clearingPrice } = selectWinners(bids, 2);
    expect(winners.map((w) => w.userId)).toEqual(['u2', 'u3']);
    expect(clearingPrice).toBe(20);
  });

  it('breaks ties by earlier lastBidAt then userId', () => {
    const bids = [
      { userId: 'b', amount: 10, lastBidAt: new Date('2026-01-01T00:00:02Z') },
      { userId: 'a', amount: 10, lastBidAt: new Date('2026-01-01T00:00:02Z') },
      { userId: 'c', amount: 10, lastBidAt: new Date('2026-01-01T00:00:01Z') }
    ];
    const { winners } = selectWinners(bids, 3);
    expect(winners.map((w) => w.userId)).toEqual(['c', 'a', 'b']);
  });
});
