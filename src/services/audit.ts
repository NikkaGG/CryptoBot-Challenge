import { ObjectId } from 'mongodb';
import type { MongoCtx } from '../db/mongo.js';
import { col } from '../db/collections.js';
import { appError } from '../errors.js';

export type GlobalAudit = {
  users: number;
  totals: {
    topups: number;
    available: number;
    reserved: number;
    spent: number;
  };
  activeBids: {
    count: number;
    sumAmount: number;
  };
  checks: {
    moneyConservationOk: boolean;
    reservedMatchesActiveBidsOk: boolean;
    negativeBalancesOk: boolean;
  };
  negativeUsers: number;
};

export type AuctionAudit = {
  auctionId: string;
  state: string;
  awardedCount: number;
  totalQuantity: number;
  revenue: number;
  bids: {
    won: number;
    active: number;
    lost: number;
    withdrawn: number;
  };
  activeBidsSum: number;
  ledger: {
    spendSum: number;
    refundSum: number;
    reserveSum: number;
    unreserveSum: number;
    expectedReserved: number;
  };
  checks: {
    revenueMatchesSpendLedgerOk: boolean;
    awardedMatchesWonBidsOk: boolean;
    giftSerialUniqueOk: boolean;
    giftSerialRangeOk: boolean;
    paidMatchesSpendLedgerOk: boolean;
    refundMatchesRefundLedgerOk: boolean;
    noActiveBidsWhenDoneOk: boolean;
    ledgerFlowMatchesActiveBidsOk: boolean;
  };
  duplicateGiftSerials: Array<{ giftSerial: number; count: number }>;
};

export async function auditGlobal(mongo: MongoCtx): Promise<GlobalAudit> {
  const usersCol = col.users(mongo.db);
  const bidsCol = col.bids(mongo.db);

  const [userAgg] = await usersCol
    .aggregate<{
      users: number;
      topups: number;
      available: number;
      reserved: number;
      spent: number;
    }>([
      {
        $group: {
          _id: null,
          users: { $sum: 1 },
          topups: { $sum: '$totalTopups' },
          available: { $sum: '$balance.available' },
          reserved: { $sum: '$balance.reserved' },
          spent: { $sum: '$balance.spent' }
        }
      }
    ])
    .toArray();

  const totals = {
    topups: userAgg?.topups ?? 0,
    available: userAgg?.available ?? 0,
    reserved: userAgg?.reserved ?? 0,
    spent: userAgg?.spent ?? 0
  };

  const [activeAgg] = await bidsCol
    .aggregate<{ count: number; sumAmount: number }>([
      { $match: { status: 'active' } },
      { $group: { _id: null, count: { $sum: 1 }, sumAmount: { $sum: '$amount' } } }
    ])
    .toArray();

  const negativeUsers = await usersCol.countDocuments({
    $or: [
      { 'balance.available': { $lt: 0 } },
      { 'balance.reserved': { $lt: 0 } },
      { 'balance.spent': { $lt: 0 } }
    ]
  });

  const moneyConservationOk = totals.topups === totals.available + totals.reserved + totals.spent;
  const reservedMatchesActiveBidsOk = totals.reserved === (activeAgg?.sumAmount ?? 0);
  const negativeBalancesOk = negativeUsers === 0;

  return {
    users: userAgg?.users ?? 0,
    totals,
    activeBids: {
      count: activeAgg?.count ?? 0,
      sumAmount: activeAgg?.sumAmount ?? 0
    },
    checks: {
      moneyConservationOk,
      reservedMatchesActiveBidsOk,
      negativeBalancesOk
    },
    negativeUsers
  };
}

export async function auditAuction(mongo: MongoCtx, auctionId: ObjectId): Promise<AuctionAudit> {
  const auction = await col.auctions(mongo.db).findOne({ _id: auctionId });
  if (!auction) throw appError('NOT_FOUND', 'Auction not found', 404);

  const bidsCol = col.bids(mongo.db);
  const ledgerCol = col.ledger(mongo.db);

  const bidCounts = await bidsCol
    .aggregate<{ _id: string; c: number }>([
      { $match: { auctionId } },
      {
        $group: {
          _id: '$status',
          c: { $sum: 1 }
        }
      }
    ])
    .toArray()
    .then((rows) => {
      const out = { won: 0, active: 0, lost: 0, withdrawn: 0 };
      for (const r of rows) {
        if (r._id === 'won') out.won = r.c;
        else if (r._id === 'active') out.active = r.c;
        else if (r._id === 'lost') out.lost = r.c;
        else if (r._id === 'withdrawn') out.withdrawn = r.c;
      }
      return out;
    });

  const [activeSumAgg] = await bidsCol
    .aggregate<{ sum: number }>([
      { $match: { auctionId, status: 'active' } },
      { $group: { _id: null, sum: { $sum: '$amount' } } }
    ])
    .toArray();
  const activeBidsSum = activeSumAgg?.sum ?? 0;

  const ledgerSums = { spendSum: 0, refundSum: 0, reserveSum: 0, unreserveSum: 0 };
  const ledgerRows = await ledgerCol
    .aggregate<{ _id: string; sum: number }>([
      { $match: { auctionId } },
      { $group: { _id: '$type', sum: { $sum: '$amount' } } }
    ])
    .toArray();
  for (const r of ledgerRows) {
    if (r._id === 'spend') ledgerSums.spendSum = r.sum;
    else if (r._id === 'refund') ledgerSums.refundSum = r.sum;
    else if (r._id === 'reserve') ledgerSums.reserveSum = r.sum;
    else if (r._id === 'unreserve') ledgerSums.unreserveSum = r.sum;
  }

  const expectedReserved =
    ledgerSums.reserveSum - ledgerSums.unreserveSum - ledgerSums.spendSum - ledgerSums.refundSum;

  const [wonAgg] = await bidsCol
    .aggregate<{
      won: number;
      sumPaid: number;
      sumRefunded: number;
      minSerial: number;
      maxSerial: number;
    }>([
      { $match: { auctionId, status: 'won' } },
      {
        $group: {
          _id: null,
          won: { $sum: 1 },
          sumPaid: { $sum: '$settlement.paid' },
          sumRefunded: { $sum: '$settlement.refunded' },
          minSerial: { $min: '$settlement.giftSerial' },
          maxSerial: { $max: '$settlement.giftSerial' }
        }
      }
    ])
    .toArray();

  const dupSerialRows = await bidsCol
    .aggregate<{ _id: number; count: number }>([
      { $match: { auctionId, status: 'won' } },
      { $group: { _id: '$settlement.giftSerial', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { _id: 1 } },
      { $limit: 50 }
    ])
    .toArray();

  const revenueMatchesSpendLedgerOk = auction.revenue === ledgerSums.spendSum;
  const awardedMatchesWonBidsOk = auction.awardedCount === bidCounts.won;
  const giftSerialUniqueOk = dupSerialRows.length === 0;
  const giftSerialRangeOk =
    bidCounts.won === 0
      ? true
      : (wonAgg?.minSerial ?? 0) === 1 && (wonAgg?.maxSerial ?? 0) === bidCounts.won;
  const paidMatchesSpendLedgerOk = (wonAgg?.sumPaid ?? 0) === ledgerSums.spendSum;
  const refundMatchesRefundLedgerOk = (wonAgg?.sumRefunded ?? 0) === ledgerSums.refundSum;
  const noActiveBidsWhenDoneOk =
    auction.state === 'ended' || auction.state === 'cancelled' ? bidCounts.active === 0 && activeBidsSum === 0 : true;
  const ledgerFlowMatchesActiveBidsOk = expectedReserved === activeBidsSum;

  return {
    auctionId: auction._id.toHexString(),
    state: auction.state,
    awardedCount: auction.awardedCount,
    totalQuantity: auction.totalQuantity,
    revenue: auction.revenue,
    bids: bidCounts,
    activeBidsSum,
    ledger: { ...ledgerSums, expectedReserved },
    checks: {
      revenueMatchesSpendLedgerOk,
      awardedMatchesWonBidsOk,
      giftSerialUniqueOk,
      giftSerialRangeOk,
      paidMatchesSpendLedgerOk,
      refundMatchesRefundLedgerOk,
      noActiveBidsWhenDoneOk,
      ledgerFlowMatchesActiveBidsOk
    },
    duplicateGiftSerials: dupSerialRows.map((r) => ({ giftSerial: r._id, count: r.count }))
  };
}
