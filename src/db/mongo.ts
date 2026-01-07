import { MongoClient } from 'mongodb';
import type { Env } from '../env.js';

export type MongoCtx = {
  client: MongoClient;
  db: ReturnType<MongoClient['db']>;
};

export async function connectMongo(env: Env): Promise<MongoCtx> {
  const client = new MongoClient(env.MONGO_URL);
  await client.connect();
  const db = client.db();

  await ensureIndexes(db);

  return { client, db };
}

async function ensureIndexes(db: MongoCtx['db']) {
  await Promise.all([
    db.collection('users').createIndex({ createdAt: 1 }),
    db
      .collection('auctions')
      .createIndex({ state: 1, roundState: 1, roundEndsAt: 1 }),
    db
      .collection('auctions')
      .createIndex({ state: 1, roundState: 1, endsAt: 1 }),
    db
      .collection('bids')
      .createIndex({ auctionId: 1, status: 1, amount: -1, lastBidAt: 1, userId: 1 }),
    db
      .collection('bids')
      .createIndex({ auctionId: 1, userId: 1 }, { unique: true }),
    db.collection('bids').createIndex(
      { auctionId: 1, 'settlement.giftSerial': 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'won', 'settlement.giftSerial': { $exists: true } }
      }
    ),
    db
      .collection('rounds')
      .createIndex({ auctionId: 1, roundNumber: 1 }, { unique: true }),
    db
      .collection('ledger')
      .createIndex({ userId: 1, createdAt: 1 }),
    db.collection('ledger').createIndex({ auctionId: 1, type: 1, createdAt: 1 }),
    db.collection('engineLocks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  ]);
}
