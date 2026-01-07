export type RankableBid = {
  userId: string;
  amount: number;
  lastBidAt: Date;
};

export function compareRankableBids(a: RankableBid, b: RankableBid): number {
  if (a.amount !== b.amount) return b.amount - a.amount;
  const at = a.lastBidAt.getTime();
  const bt = b.lastBidAt.getTime();
  if (at !== bt) return at - bt;
  if (a.userId < b.userId) return -1;
  if (a.userId > b.userId) return 1;
  return 0;
}

export function selectWinners<T extends RankableBid>(
  bids: readonly T[],
  winnersCount: number
): { winners: T[]; clearingPrice: number } {
  if (winnersCount <= 0) return { winners: [], clearingPrice: 0 };
  const sorted = [...bids].sort(compareRankableBids);
  const winners = sorted.slice(0, winnersCount);
  const clearingPrice = winners.length === 0 ? 0 : winners[winners.length - 1]!.amount;
  return { winners, clearingPrice };
}
