import type { ClientSession, MongoClient, TransactionOptions } from 'mongodb';

export type TxnFn<T> = (session: ClientSession) => Promise<T>;

export async function withTxn<T>(
  client: MongoClient,
  fn: TxnFn<T>,
  opts?: TransactionOptions & { maxAttempts?: number; retryOnDuplicateKey?: boolean }
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const retryOnDuplicateKey = opts?.retryOnDuplicateKey ?? false;

  const txOpts: TransactionOptions = {
    readConcern: opts?.readConcern ?? { level: 'snapshot' },
    writeConcern: opts?.writeConcern ?? { w: 'majority' },
    ...(opts?.readPreference !== undefined ? { readPreference: opts.readPreference } : {}),
    ...(opts?.maxCommitTimeMS !== undefined ? { maxCommitTimeMS: opts.maxCommitTimeMS } : {})
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const session = client.startSession();
    try {
      // withTransaction handles commit retry for UnknownTransactionCommitResult.
      const res = await session.withTransaction(() => fn(session), txOpts);
      return res as T;
    } catch (err: unknown) {
      lastErr = err;
      if ((isTransientTxnError(err) || (retryOnDuplicateKey && isDuplicateKeyError(err))) && attempt < maxAttempts) {
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  throw lastErr;
}

function isTransientTxnError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { hasErrorLabel?: (label: string) => boolean };
  return typeof candidate.hasErrorLabel === 'function' && candidate.hasErrorLabel('TransientTransactionError');
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
