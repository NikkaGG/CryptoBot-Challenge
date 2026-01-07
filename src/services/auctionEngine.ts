import { ObjectId } from 'mongodb';
import { col } from '../db/collections.js';
import type { MongoCtx } from '../db/mongo.js';
import { withTxn } from '../db/transactions.js';

export type LogLike = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export function startAuctionEngine(opts: {
  mongo: MongoCtx;
  logger: LogLike;
  pollIntervalMs: number;
}) {
  const { mongo, logger, pollIntervalMs } = opts;
  const closeGraceMs = 250;
  const engineOwnerId = new ObjectId().toHexString();
  const lockTtlMs = Math.max(2_000, pollIntervalMs * 10);
  let leader = false;

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const now = new Date();

      const isLeader = await tryAcquireEngineLock(mongo, engineOwnerId, lockTtlMs, now);
      if (!isLeader) {
        if (leader) logger.info({ engineOwnerId }, 'auctionEngine lost leadership');
        leader = false;
        return;
      }
      if (!leader) logger.info({ engineOwnerId }, 'auctionEngine became leader');
      leader = true;

      const auctions = col.auctions(mongo.db);

      // 1) Recover / continue closings (e.g. after restart)
      const closing = await auctions
        .find({ state: 'running', roundState: 'closing', closingToken: { $exists: true } })
        .limit(5)
        .project({ _id: 1, closingToken: 1 })
        .toArray();
      for (const a of closing) {
        if (!a.closingToken) continue;
        await settleClosingAuction(mongo, a._id, a.closingToken, logger);
      }

      // 2) Lock and close due rounds
      const threshold = new Date(now.getTime() - closeGraceMs);
      const due = await auctions
        .find({
          state: 'running',
          roundState: 'open',
          $or: [{ roundEndsAt: { $lte: threshold } }, { endsAt: { $lte: threshold } }]
        })
        .limit(5)
        .project({ _id: 1 })
        .toArray();

      for (const a of due) {
        const token = new ObjectId().toHexString();
        const lock = await auctions.findOneAndUpdate(
          {
            _id: a._id,
            state: 'running',
            roundState: 'open',
            $or: [{ roundEndsAt: { $lte: threshold } }, { endsAt: { $lte: threshold } }]
          },
          {
            $set: {
              roundState: 'closing',
              closingToken: token,
              closingStartedAt: now,
              updatedAt: now
            },
            $inc: { version: 1 }
          },
          { returnDocument: 'after' }
        );
        if (!lock) continue;
        await settleClosingAuction(mongo, lock._id, token, logger);
      }
    } catch (err) {
      logger.error({ err }, 'auctionEngine tick failed');
    } finally {
      inFlight = false;
    }
  }

  timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

async function settleClosingAuction(
  mongo: MongoCtx,
  auctionId: ObjectId,
  closingToken: string,
  logger: LogLike
): Promise<void> {
  await withTxn(mongo.client, async (session) => {
    const auctions = col.auctions(mongo.db);
    const bids = col.bids(mongo.db);
    const users = col.users(mongo.db);
    const rounds = col.rounds(mongo.db);
    const ledger = col.ledger(mongo.db);

    const now = new Date();
    const auction = await auctions.findOne(
      { _id: auctionId, state: 'running', roundState: 'closing', closingToken },
      { session }
    );
    if (!auction) return;

    const remainingQty = Math.max(0, auction.totalQuantity - auction.awardedCount);
    const winnersCount = Math.min(auction.config.winnersPerRound, remainingQty);

    const winnerBids =
      winnersCount > 0
        ? await bids
            .find({ auctionId, status: 'active' }, { session })
            .sort({ amount: -1, lastBidAt: 1, userId: 1 })
            .limit(winnersCount)
            .toArray()
        : [];

    const clearingPrice = winnerBids.length === 0 ? 0 : winnerBids[winnerBids.length - 1]!.amount;

    const winners = winnerBids.map((b, idx) => {
      const giftSerial = auction.awardedCount + idx + 1;
      const refunded = b.amount - clearingPrice;
      return {
        bidId: b._id,
        userId: b.userId,
        amount: b.amount,
        giftSerial,
        paid: clearingPrice,
        refunded
      };
    });

    // Persist round result first (unique index prevents double-settlement).
    await rounds.insertOne(
      {
        _id: new ObjectId(),
        auctionId,
        roundNumber: auction.currentRound,
        endedAt: now,
        clearingPrice,
        winners: winners.map((w) => ({
          userId: w.userId,
          amount: w.amount,
          giftSerial: w.giftSerial,
          paid: w.paid,
          refunded: w.refunded
        }))
      },
      { session }
    );

    // Apply settlements for winners.
    for (const w of winners) {
      const bidRes = await bids.updateOne(
        { _id: w.bidId, status: 'active' },
        {
          $set: {
            status: 'won',
            updatedAt: now,
            settlement: {
              wonRound: auction.currentRound,
              giftSerial: w.giftSerial,
              clearingPrice,
              paid: w.paid,
              refunded: w.refunded,
              settledAt: now
            }
          }
        },
        { session }
      );
      if (bidRes.matchedCount !== 1) throw new Error('Invariant violation: winner bid not active');

      const userRes = await users.updateOne(
        { _id: w.userId, 'balance.reserved': { $gte: w.amount } },
        {
          $inc: {
            'balance.reserved': -w.amount,
            'balance.spent': w.paid,
            'balance.available': w.refunded
          }
        },
        { session }
      );
      if (userRes.matchedCount !== 1) throw new Error('Invariant violation: insufficient reserved balance');

      await ledger.insertMany(
        [
          {
            _id: new ObjectId(),
            createdAt: now,
            userId: w.userId,
            type: 'spend' as const,
            amount: w.paid,
            auctionId,
            meta: { round: auction.currentRound, giftSerial: w.giftSerial }
          },
          ...(w.refunded > 0
            ? [
                {
                  _id: new ObjectId(),
                  createdAt: now,
                  userId: w.userId,
                  type: 'refund' as const,
                  amount: w.refunded,
                  auctionId,
                  meta: { round: auction.currentRound, giftSerial: w.giftSerial }
                }
              ]
            : [])
        ],
        { session }
      );
    }

    const newAwardedCount = auction.awardedCount + winners.length;
    const soldOut = newAwardedCount >= auction.totalQuantity;

    const forcedByDuration = !!auction.endsAt && now.getTime() >= auction.endsAt.getTime();
    const emptyRound = remainingQty > 0 && winnerBids.length === 0;
    const newConsecutiveEmptyRounds = emptyRound ? auction.consecutiveEmptyRounds + 1 : 0;
    const forcedByEmptyRounds =
      emptyRound &&
      auction.config.maxConsecutiveEmptyRounds > 0 &&
      newConsecutiveEmptyRounds >= auction.config.maxConsecutiveEmptyRounds;

    const shouldEnd = soldOut || forcedByDuration || forcedByEmptyRounds;
    const endReason = soldOut
      ? ('soldOut' as const)
      : forcedByDuration
        ? ('maxDuration' as const)
        : ('emptyRounds' as const);

    if (shouldEnd) {
      // Refund all remaining active bids.
      const active = await bids
        .find({ auctionId, status: 'active' }, { session })
        .project({ _id: 1, userId: 1, amount: 1 })
        .toArray();

      for (const b of active) {
        const bidRes = await bids.updateOne(
          { _id: b._id, status: 'active' },
          { $set: { status: 'lost', updatedAt: now } },
          { session }
        );
        if (bidRes.matchedCount !== 1) throw new Error('Invariant violation: active bid missing on refund');

        const userRes = await users.updateOne(
          { _id: b.userId, 'balance.reserved': { $gte: b.amount } },
          { $inc: { 'balance.reserved': -b.amount, 'balance.available': b.amount } },
          { session }
        );
        if (userRes.matchedCount !== 1) throw new Error('Invariant violation: insufficient reserved on refund');
        await ledger.insertOne(
          {
            _id: new ObjectId(),
            createdAt: now,
            userId: b.userId,
            type: 'unreserve' as const,
            amount: b.amount,
            auctionId,
            meta: { reason: 'auctionEnded' }
          },
          { session }
        );
      }

      const auRes = await auctions.updateOne(
        { _id: auctionId, state: 'running', closingToken },
        {
          $set: {
            state: 'ended',
            endedAt: now,
            endReason,
            awardedCount: newAwardedCount,
            consecutiveEmptyRounds: newConsecutiveEmptyRounds,
            revenue: auction.revenue + clearingPrice * winners.length,
            updatedAt: now
          },
          $unset: { roundState: '', roundEndsAt: '', closingToken: '', closingStartedAt: '' },
          $inc: { version: 1 }
        },
        { session }
      );
      if (auRes.matchedCount !== 1) throw new Error('Invariant violation: auction not updated on end');
      logger.info({ auctionId: auctionId.toHexString(), endReason }, 'auction ended');
      return;
    }

    let nextEndsAt = new Date(now.getTime() + auction.config.roundDurationMs);
    if (auction.endsAt && auction.endsAt.getTime() < nextEndsAt.getTime()) nextEndsAt = auction.endsAt;
    const auRes = await auctions.updateOne(
      { _id: auctionId, state: 'running', closingToken },
      {
        $set: {
          awardedCount: newAwardedCount,
          revenue: auction.revenue + clearingPrice * winners.length,
          currentRound: auction.currentRound + 1,
          consecutiveEmptyRounds: newConsecutiveEmptyRounds,
          roundState: 'open',
          roundEndsAt: nextEndsAt,
          updatedAt: now
        },
        $unset: { closingToken: '', closingStartedAt: '' },
        $inc: { version: 1 }
      },
      { session }
    );
    if (auRes.matchedCount !== 1) throw new Error('Invariant violation: auction not updated for next round');
  }).catch((err) => {
    if (isDuplicateRoundSettlement(err)) {
      logger.info({ auctionId: auctionId.toHexString() }, 'round already settled');
      return;
    }
    logger.error({ err, auctionId: auctionId.toHexString() }, 'settleClosingAuction failed');
  });
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

function isDuplicateRoundSettlement(err: unknown): boolean {
  if (!isDuplicateKeyError(err)) return false;
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { keyPattern?: Record<string, unknown>; message?: unknown };
  const kp = candidate.keyPattern;
  if (kp && typeof kp === 'object') {
    return Object.prototype.hasOwnProperty.call(kp, 'auctionId') && Object.prototype.hasOwnProperty.call(kp, 'roundNumber');
  }
  return typeof candidate.message === 'string' && candidate.message.includes('roundNumber');
}

type EngineLockDoc = {
  _id: string;
  ownerId: string;
  expiresAt: Date;
  updatedAt: Date;
};

async function tryAcquireEngineLock(
  mongo: MongoCtx,
  ownerId: string,
  ttlMs: number,
  now: Date
): Promise<boolean> {
  const locks = mongo.db.collection<EngineLockDoc>('engineLocks');
  const expiresAt = new Date(now.getTime() + ttlMs);
  try {
    const doc = await locks.findOneAndUpdate(
      {
        _id: 'auctionEngine',
        $or: [{ ownerId }, { expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }]
      },
      { $set: { ownerId, expiresAt, updatedAt: now } },
      { upsert: true, returnDocument: 'after' }
    );
    return !!doc && doc.ownerId === ownerId;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}
