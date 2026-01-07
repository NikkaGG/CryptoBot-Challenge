import { ObjectId } from 'mongodb';
import { col, type AuctionConfig, type AuctionDoc, type BidDoc } from '../db/collections.js';
import type { MongoCtx } from '../db/mongo.js';
import { withTxn } from '../db/transactions.js';
import { appError } from '../errors.js';

export type CreateAuctionInput = {
  title: string;
  totalQuantity: number;
  config?: Partial<AuctionConfig>;
};

export async function createAuction(mongo: MongoCtx, input: CreateAuctionInput): Promise<AuctionDoc> {
  if (!input.title.trim()) throw appError('INVALID_INPUT', 'Title is required', 400);
  if (!Number.isSafeInteger(input.totalQuantity) || input.totalQuantity <= 0) {
    throw appError('INVALID_INPUT', 'totalQuantity must be a positive integer', 400);
  }

  const cfg: AuctionConfig = {
    roundDurationMs: clampInt(input.config?.roundDurationMs ?? 60_000, 5_000, 60 * 60_000),
    winnersPerRound: clampInt(input.config?.winnersPerRound ?? 10, 1, input.totalQuantity),
    antiSnipeWindowMs: clampInt(input.config?.antiSnipeWindowMs ?? 10_000, 0, 60_000),
    antiSnipeExtendMs: clampInt(input.config?.antiSnipeExtendMs ?? 10_000, 0, 60_000),
    maxWinsPerUser: clampInt(input.config?.maxWinsPerUser ?? 1, 1, 1),
    maxDurationMs: clampInt(input.config?.maxDurationMs ?? 0, 0, 7 * 24 * 60 * 60_000),
    maxConsecutiveEmptyRounds: clampInt(input.config?.maxConsecutiveEmptyRounds ?? 3, 0, 10_000)
  };

  const now = new Date();
  const doc: AuctionDoc = {
    _id: new ObjectId(),
    createdAt: now,
    updatedAt: now,
    title: input.title,
    state: 'draft',
    totalQuantity: input.totalQuantity,
    awardedCount: 0,
    revenue: 0,
    currentRound: 0,
    consecutiveEmptyRounds: 0,
    version: 0,
    config: cfg
  };

  await col.auctions(mongo.db).insertOne(doc);
  return doc;
}

export async function listAuctions(mongo: MongoCtx): Promise<AuctionDoc[]> {
  return col.auctions(mongo.db).find({}).sort({ createdAt: -1 }).limit(50).toArray();
}

export async function getAuction(mongo: MongoCtx, auctionId: ObjectId): Promise<AuctionDoc | null> {
  return col.auctions(mongo.db).findOne({ _id: auctionId });
}

export async function startAuction(mongo: MongoCtx, auctionId: ObjectId): Promise<AuctionDoc> {
  return withTxn(mongo.client, async (session) => {
    const auctions = col.auctions(mongo.db);
    const now = new Date();

    const existing = await auctions.findOne({ _id: auctionId }, { session });
    if (!existing) throw appError('NOT_FOUND', 'Auction not found', 404);
    if (existing.state !== 'draft') throw appError('NOT_STARTABLE', 'Auction not startable', 409);

    const endsAt = new Date(now.getTime() + existing.config.roundDurationMs);
    const auctionEndsAt =
      existing.config.maxDurationMs > 0
        ? new Date(now.getTime() + existing.config.maxDurationMs)
        : undefined;

    const roundEndsAt =
      auctionEndsAt && auctionEndsAt.getTime() < endsAt.getTime() ? auctionEndsAt : endsAt;
    const res = await auctions.findOneAndUpdate(
      { _id: auctionId, state: 'draft' },
      {
        $set: {
          state: 'running',
          startedAt: now,
          ...(auctionEndsAt ? { endsAt: auctionEndsAt } : {}),
          currentRound: 1,
          roundState: 'open',
          roundEndsAt,
          consecutiveEmptyRounds: 0,
          updatedAt: now
        },
        $unset: { endedAt: '', endReason: '', ...(auctionEndsAt ? {} : { endsAt: '' }) },
        $inc: { version: 1 }
      },
      { session, returnDocument: 'after' }
    );
    const auction = res;
    if (!auction) throw appError('NOT_STARTABLE', 'Auction not startable', 409);
    return auction;
  });
}

export async function cancelAuction(mongo: MongoCtx, auctionId: ObjectId): Promise<AuctionDoc> {
  return withTxn(mongo.client, async (session) => {
    const auctions = col.auctions(mongo.db);
    const bids = col.bids(mongo.db);
    const users = col.users(mongo.db);
    const ledger = col.ledger(mongo.db);
    const now = new Date();

    const res = await auctions.findOneAndUpdate(
      { _id: auctionId, state: { $in: ['draft', 'running'] } },
      {
        $set: { state: 'cancelled', endedAt: now, endReason: 'cancelled', updatedAt: now },
        $unset: { roundState: '', roundEndsAt: '', closingToken: '', closingStartedAt: '' },
        $inc: { version: 1 }
      },
      { session, returnDocument: 'after' }
    );

    const auction = res;
    if (!auction) throw appError('NOT_CANCELLABLE', 'Auction not found or not cancellable', 409);

    const activeBids = await bids
      .find({ auctionId, status: 'active' }, { session })
      .project({ _id: 1, userId: 1, amount: 1 })
      .toArray();

    for (const b of activeBids) {
      const bidRes = await bids.updateOne(
        { _id: b._id, status: 'active' },
        { $set: { status: 'withdrawn', updatedAt: now } },
        { session }
      );
      if (bidRes.matchedCount !== 1) {
        throw appError('INVARIANT_VIOLATION', 'Invariant violation: active bid missing on cancel', 500);
      }

      const userRes = await users.updateOne(
        { _id: b.userId, 'balance.reserved': { $gte: b.amount } },
        { $inc: { 'balance.reserved': -b.amount, 'balance.available': b.amount } },
        { session }
      );
      if (userRes.matchedCount !== 1) {
        throw appError('INVARIANT_VIOLATION', 'Invariant violation: insufficient reserved on cancel', 500);
      }
      await ledger.insertOne(
        {
          _id: new ObjectId(),
          createdAt: now,
          userId: b.userId,
          type: 'unreserve',
          amount: b.amount,
          auctionId
        },
        { session }
      );
    }

    return auction;
  });
}

export async function placeBid(
  mongo: MongoCtx,
  auctionId: ObjectId,
  userId: ObjectId,
  newAmount: number
): Promise<{ auction: AuctionDoc; bid: BidDoc }>
{
  if (!Number.isSafeInteger(newAmount) || newAmount <= 0) {
    throw appError('INVALID_INPUT', 'Amount must be a positive integer', 400);
  }

  return withTxn(
    mongo.client,
    async (session) => {
      const auctions = col.auctions(mongo.db);
      const bids = col.bids(mongo.db);
      const users = col.users(mongo.db);
      const ledger = col.ledger(mongo.db);
      const now = new Date();

      const auction = await auctions.findOne({ _id: auctionId }, { session });
      if (!auction) throw appError('NOT_FOUND', 'Auction not found', 404);
      if (auction.state !== 'running' || auction.roundState !== 'open' || !auction.roundEndsAt) {
        throw appError('NOT_OPEN', 'Auction is not open for bids', 409);
      }

      if (now.getTime() >= auction.roundEndsAt.getTime()) {
        throw appError('ROUND_ENDED', 'Round already ended', 409);
      }

      const existing = await bids.findOne({ auctionId, userId }, { session });
      const existingActive = existing?.status === 'active';
      if (existing && !existingActive && existing.status !== 'withdrawn') {
        throw appError('BID_NOT_ACTIVE', 'Bid is not active', 409);
      }

      const oldAmount = existingActive ? existing.amount : 0;
      if (newAmount <= oldAmount) {
        throw appError('INVALID_INPUT', 'New amount must be greater than previous amount', 400);
      }

      const delta = newAmount - oldAmount;
      const userRes = await users.findOneAndUpdate(
        { _id: userId, 'balance.available': { $gte: delta } },
        {
          $inc: {
            'balance.available': -delta,
            'balance.reserved': delta
          }
        },
        { session, returnDocument: 'after' }
      );
      if (!userRes) {
        throw appError('INSUFFICIENT_FUNDS', 'Insufficient funds or user not found', 409);
      }

      let bid: BidDoc;
      if (existingActive) {
        const upd = await bids.findOneAndUpdate(
          { _id: existing._id, status: 'active' },
          { $set: { amount: newAmount, lastBidAt: now, updatedAt: now } },
          { session, returnDocument: 'after' }
        );
        if (!upd) throw appError('INVARIANT_VIOLATION', 'Invariant violation: failed to update bid', 500);
        bid = upd;
      } else if (existing) {
        const upd = await bids.findOneAndUpdate(
          { _id: existing._id, status: 'withdrawn' },
          { $set: { status: 'active', amount: newAmount, lastBidAt: now, updatedAt: now } },
          { session, returnDocument: 'after' }
        );
        if (!upd) throw appError('INVARIANT_VIOLATION', 'Invariant violation: failed to reactivate bid', 500);
        bid = upd;
      } else {
        bid = {
          _id: new ObjectId(),
          auctionId,
          userId,
          amount: newAmount,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          lastBidAt: now
        };
        await bids.insertOne(bid, { session });
      }

      await ledger.insertOne(
        {
          _id: new ObjectId(),
          createdAt: now,
          userId,
          type: 'reserve',
          amount: delta,
          auctionId,
          meta: { bidId: bid._id.toHexString() }
        },
        { session }
      );

      let newEndsAt = auction.roundEndsAt;
      if (auction.endsAt && newEndsAt.getTime() > auction.endsAt.getTime()) {
        newEndsAt = auction.endsAt;
      }
      const remainingMs = auction.roundEndsAt.getTime() - now.getTime();
      if (remainingMs <= auction.config.antiSnipeWindowMs) {
        let candidate = new Date(now.getTime() + auction.config.antiSnipeExtendMs);
        if (auction.endsAt && candidate.getTime() > auction.endsAt.getTime()) {
          candidate = auction.endsAt;
        }
        if (candidate.getTime() > newEndsAt.getTime()) newEndsAt = candidate;
      }

      const auRes = await auctions.findOneAndUpdate(
        { _id: auctionId, state: 'running', roundState: 'open' },
        {
          $set: { updatedAt: now },
          $max: { roundEndsAt: newEndsAt },
          $inc: { version: 1 }
        },
        { session, returnDocument: 'after' }
      );
      const updatedAuction = auRes;
      if (!updatedAuction) throw appError('NOT_OPEN', 'Auction is not open for bids', 409);

      return { auction: updatedAuction, bid };
    },
    { retryOnDuplicateKey: true }
  );
}

export async function withdrawBid(
  mongo: MongoCtx,
  auctionId: ObjectId,
  userId: ObjectId
): Promise<{ bid: BidDoc }>
{
  return withTxn(mongo.client, async (session) => {
    const bids = col.bids(mongo.db);
    const users = col.users(mongo.db);
    const auctions = col.auctions(mongo.db);
    const ledger = col.ledger(mongo.db);
    const now = new Date();

    const auction = await auctions.findOne({ _id: auctionId }, { session });
    if (!auction) throw appError('NOT_FOUND', 'Auction not found', 404);
    if (auction.state !== 'running' || auction.roundState !== 'open' || !auction.roundEndsAt) {
      throw appError('NOT_OPEN', 'Auction is not open for withdraw', 409);
    }
    if (now.getTime() >= auction.roundEndsAt.getTime()) {
      throw appError('ROUND_ENDED', 'Round already ended', 409);
    }

    const bid = await bids.findOne({ auctionId, userId, status: 'active' }, { session });
    if (!bid) throw appError('BID_NOT_ACTIVE', 'Active bid not found', 409);

    const bidRes = await bids.updateOne(
      { _id: bid._id, status: 'active' },
      { $set: { status: 'withdrawn', updatedAt: now } },
      { session }
    );
    if (bidRes.matchedCount !== 1) throw appError('BID_NOT_ACTIVE', 'Active bid not found', 409);

    const userRes = await users.findOneAndUpdate(
      { _id: userId, 'balance.reserved': { $gte: bid.amount } },
      { $inc: { 'balance.reserved': -bid.amount, 'balance.available': bid.amount } },
      { session, returnDocument: 'after' }
    );
    if (!userRes) throw appError('INVARIANT_VIOLATION', 'Invariant violation: user not found or inconsistent balance', 500);

    await ledger.insertOne(
      {
        _id: new ObjectId(),
        createdAt: now,
        userId,
        type: 'unreserve',
        amount: bid.amount,
        auctionId,
        meta: { bidId: bid._id.toHexString() }
      },
      { session }
    );

    const auRes = await auctions.updateOne(
      { _id: auctionId },
      { $set: { updatedAt: now }, $inc: { version: 1 } },
      { session }
    );
    if (auRes.matchedCount !== 1) throw appError('NOT_FOUND', 'Auction not found', 404);

    return { bid: { ...bid, status: 'withdrawn', updatedAt: now } };
  });
}

export async function getAuctionSnapshot(
  mongo: MongoCtx,
  auctionId: ObjectId,
  opts?: { userId?: ObjectId }
): Promise<{
  now: string;
  auction: AuctionDoc;
  timeRemainingMs: number | null;
  remainingQuantity: number;
  leaderboard: Array<{ userId: string; amount: number; lastBidAt: string }>;
  myBid: { status: string; amount: number; lastBidAt: string } | null;
  estimatedClearingPrice: number | null;
  recentRounds: Array<{ roundNumber: number; clearingPrice: number; endedAt: string; winners: Array<{ userId: string; amount: number; giftSerial: number }> }>;
}> {
  const auctions = col.auctions(mongo.db);
  const bids = col.bids(mongo.db);
  const rounds = col.rounds(mongo.db);

  const auction = await auctions.findOne({ _id: auctionId });
  if (!auction) throw appError('NOT_FOUND', 'Auction not found', 404);

  const now = new Date();
  const timeRemainingMs =
    auction.state === 'running' && auction.roundState === 'open' && auction.roundEndsAt
      ? Math.max(0, auction.roundEndsAt.getTime() - now.getTime())
      : null;

  const remainingQuantity = Math.max(0, auction.totalQuantity - auction.awardedCount);

  const k =
    auction.state === 'running'
      ? Math.min(remainingQuantity, auction.config.winnersPerRound)
      : 0;
  const leaderboardLimit = Math.max(20, Math.min(200, k));

  const activeBids = await bids
    .find({ auctionId, status: 'active' })
    .sort({ amount: -1, lastBidAt: 1, userId: 1 })
    .limit(leaderboardLimit)
    .project({ userId: 1, amount: 1, lastBidAt: 1 })
    .toArray();

  const leaderboard = activeBids.slice(0, 20).map((b) => ({
    userId: b.userId.toHexString(),
    amount: b.amount,
    lastBidAt: b.lastBidAt.toISOString()
  }));

  const myBidDoc = opts?.userId ? await bids.findOne({ auctionId, userId: opts.userId }) : null;
  const myBid = myBidDoc
    ? {
        status: myBidDoc.status,
        amount: myBidDoc.amount,
        lastBidAt: myBidDoc.lastBidAt.toISOString()
      }
    : null;

  const estimatedClearingPrice = k > 0 && activeBids.length >= k ? activeBids[k - 1]!.amount : null;

  const recentRounds = await rounds
    .find({ auctionId })
    .sort({ roundNumber: -1 })
    .limit(5)
    .toArray();

  return {
    now: now.toISOString(),
    auction,
    timeRemainingMs,
    remainingQuantity,
    leaderboard,
    myBid,
    estimatedClearingPrice,
    recentRounds: recentRounds
      .map((r) => ({
        roundNumber: r.roundNumber,
        clearingPrice: r.clearingPrice,
        endedAt: r.endedAt.toISOString(),
        winners: r.winners.map((w) => ({
          userId: w.userId.toHexString(),
          amount: w.amount,
          giftSerial: w.giftSerial
        }))
      }))
      .reverse()
  };
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  const iv = Math.trunc(v);
  if (iv < min) return min;
  if (iv > max) return max;
  return iv;
}
