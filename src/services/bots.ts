import { ObjectId } from 'mongodb';
import type { MongoCtx } from '../db/mongo.js';
import { col } from '../db/collections.js';
import { createUser, topupUser } from './users.js';
import { placeBid } from './auctions.js';
import type { LogLike } from './auctionEngine.js';
import { appError } from '../errors.js';

type BotMode = 'normal' | 'aggressive' | 'sniper';

type BotState = {
  userId: ObjectId;
  mode: BotMode;
  currentBid: number;
  lastError?: string;
};

type BotGroup = {
  auctionId: ObjectId;
  startedAt: Date;
  controller: AbortController;
  bots: BotState[];
};

const groups = new Map<string, BotGroup>();

export async function startAuctionBots(opts: {
  mongo: MongoCtx;
  logger: LogLike;
  auctionId: ObjectId;
  count: number;
  topupAmount: number;
  maxBid: number;
}): Promise<{ auctionId: string; started: number }> {
  const { mongo, logger, auctionId, count, topupAmount, maxBid } = opts;

  const exists = await col.auctions(mongo.db)
    .find({ _id: auctionId })
    .project({ _id: 1 })
    .limit(1)
    .toArray();
  if (exists.length === 0) throw appError('NOT_FOUND', 'Auction not found', 404);

  if (!Number.isSafeInteger(count) || count <= 0 || count > 2000) {
    throw appError('INVALID_INPUT', 'count must be an integer between 1 and 2000', 400);
  }
  if (!Number.isSafeInteger(topupAmount) || topupAmount <= 0) {
    throw appError('INVALID_INPUT', 'topupAmount must be a positive integer', 400);
  }
  if (!Number.isSafeInteger(maxBid) || maxBid <= 0) {
    throw appError('INVALID_INPUT', 'maxBid must be a positive integer', 400);
  }

  stopAuctionBots({ auctionId, logger });

  const controller = new AbortController();
  const startedAt = new Date();
  const bots: BotState[] = [];

  for (let i = 0; i < count; i++) {
    const u = await createUser(mongo);
    await topupUser(mongo, u._id, topupAmount);
    const mode: BotMode = i % 10 === 0 ? 'sniper' : i % 3 === 0 ? 'aggressive' : 'normal';
    bots.push({ userId: u._id, mode, currentBid: 0 });
  }

  const group: BotGroup = { auctionId, startedAt, controller, bots };
  groups.set(auctionId.toHexString(), group);

  for (const b of bots) {
    void runBot({ mongo, logger, auctionId, bot: b, maxBid, signal: controller.signal });
  }

  logger.info({ auctionId: auctionId.toHexString(), bots: bots.length }, 'bots started');
  return { auctionId: auctionId.toHexString(), started: bots.length };
}

export function stopAuctionBots(opts: { auctionId: ObjectId; logger: LogLike }): { auctionId: string; stopped: number } {
  const key = opts.auctionId.toHexString();
  const group = groups.get(key);
  if (!group) return { auctionId: key, stopped: 0 };
  group.controller.abort();
  groups.delete(key);
  opts.logger.info({ auctionId: key, bots: group.bots.length }, 'bots stopped');
  return { auctionId: key, stopped: group.bots.length };
}

export function getBotsStatus(auctionId: ObjectId): {
  running: boolean;
  startedAt?: string;
  bots?: number;
  sample?: Array<{ userId: string; mode: BotMode; currentBid: number; lastError?: string }>;
} {
  const group = groups.get(auctionId.toHexString());
  if (!group) return { running: false };
  return {
    running: true,
    startedAt: group.startedAt.toISOString(),
    bots: group.bots.length,
    sample: group.bots.slice(0, 10).map((b) => ({
      userId: b.userId.toHexString(),
      mode: b.mode,
      currentBid: b.currentBid,
      ...(b.lastError ? { lastError: b.lastError } : {})
    }))
  };
}

async function runBot(opts: {
  mongo: MongoCtx;
  logger: LogLike;
  auctionId: ObjectId;
  bot: BotState;
  maxBid: number;
  signal: AbortSignal;
}) {
  const { mongo, logger, auctionId, bot, maxBid, signal } = opts;
  const auctions = col.auctions(mongo.db);
  const bids = col.bids(mongo.db);

  while (!signal.aborted) {
    const auction = await auctions.findOne({ _id: auctionId });
    if (!auction) return;
    if (auction.state !== 'running') return;
    if (auction.roundState !== 'open' || !auction.roundEndsAt) {
      await sleep(250);
      continue;
    }

    const now = Date.now();
    const remainingMs = Math.max(0, auction.roundEndsAt.getTime() - now);
    const remainingQty = Math.max(0, auction.totalQuantity - auction.awardedCount);
    const k = Math.min(remainingQty, auction.config.winnersPerRound);
    const est = k > 0 ? await estimateClearingPrice({ bids, auctionId, k }) : 0;

    let shouldBid = false;
    let next = bot.currentBid;

    if (bot.mode === 'sniper') {
      shouldBid = remainingMs > 0 && remainingMs < 1500;
      if (shouldBid) next = Math.min(maxBid, Math.max(bot.currentBid + 1, est + randInt(1, 50)));
    } else if (bot.mode === 'aggressive') {
      shouldBid = Math.random() < 0.5;
      if (shouldBid) next = Math.min(maxBid, Math.max(bot.currentBid + randInt(1, 200), est + randInt(1, 200)));
    } else {
      shouldBid = Math.random() < 0.2;
      if (shouldBid) next = Math.min(maxBid, Math.max(bot.currentBid + randInt(1, 50), est + randInt(1, 80)));
    }

    if (shouldBid && next > bot.currentBid) {
      try {
        await placeBid(mongo, auctionId, bot.userId, next);
        bot.currentBid = next;
        delete bot.lastError;
      } catch (e) {
        bot.lastError = e instanceof Error ? e.message : 'unknown error';
        // try to resync current bid
        const bidDoc = await bids.findOne({ auctionId, userId: bot.userId });
        if (bidDoc) bot.currentBid = bidDoc.amount;
      }
    }

    await sleep(bot.mode === 'sniper' ? 100 : randInt(80, 250));
  }

  logger.info({ auctionId: auctionId.toHexString(), userId: bot.userId.toHexString() }, 'bot stopped');
}

async function estimateClearingPrice(opts: {
  bids: ReturnType<typeof col.bids>;
  auctionId: ObjectId;
  k: number;
}): Promise<number> {
  if (opts.k <= 0) return 0;
  const winnerBids = await opts.bids
    .find({ auctionId: opts.auctionId, status: 'active' })
    .sort({ amount: -1, lastBidAt: 1, userId: 1 })
    .limit(opts.k)
    .project({ amount: 1 })
    .toArray();
  if (winnerBids.length < opts.k) return 0;
  return winnerBids[winnerBids.length - 1]!.amount;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
