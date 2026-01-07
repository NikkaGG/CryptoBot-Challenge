import { ObjectId } from 'mongodb';
import { col, type UserDoc } from '../db/collections.js';
import type { MongoCtx } from '../db/mongo.js';
import { withTxn } from '../db/transactions.js';
import { appError } from '../errors.js';

export async function createUser(mongo: MongoCtx): Promise<UserDoc> {
  const now = new Date();
  const doc: UserDoc = {
    _id: new ObjectId(),
    createdAt: now,
    balance: { available: 0, reserved: 0, spent: 0 },
    totalTopups: 0
  };
  await col.users(mongo.db).insertOne(doc);
  return doc;
}

export async function getUser(mongo: MongoCtx, userId: ObjectId): Promise<UserDoc | null> {
  return col.users(mongo.db).findOne({ _id: userId });
}

export async function topupUser(
  mongo: MongoCtx,
  userId: ObjectId,
  amount: number
): Promise<UserDoc> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw appError('INVALID_INPUT', 'Amount must be a positive integer', 400);
  }

  return withTxn(mongo.client, async (session) => {
    const users = col.users(mongo.db);
    const ledger = col.ledger(mongo.db);
    const now = new Date();

    const res = await users.findOneAndUpdate(
      { _id: userId },
      {
        $inc: {
          'balance.available': amount,
          totalTopups: amount
        }
      },
      { session, returnDocument: 'after' }
    );
    const user = res;
    if (!user) throw appError('NOT_FOUND', 'User not found', 404);

    await ledger.insertOne(
      {
        _id: new ObjectId(),
        createdAt: now,
        userId,
        type: 'topup',
        amount
      },
      { session }
    );

    return user;
  });
}
