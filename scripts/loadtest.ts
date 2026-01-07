import { MongoClient, ObjectId } from 'mongodb';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/auction?replicaSet=rs0';

const USERS = intEnv('USERS', 200);
const TOPUP = intEnv('TOPUP', 50_000);
const QUANTITY = intEnv('QUANTITY', 100);
const WINNERS_PER_ROUND = intEnv('WINNERS_PER_ROUND', 20);
const ROUND_MS = intEnv('ROUND_MS', 15_000);
const RUNTIME_LIMIT_MS = intEnv('RUNTIME_LIMIT_MS', 5 * 60_000);
const WITHDRAW_PROB = numEnv('WITHDRAW_PROB', 0.01);

async function main() {
  console.log({ BASE_URL, USERS, TOPUP, QUANTITY, WINNERS_PER_ROUND, ROUND_MS });

  const userIds: string[] = [];
  for (let i = 0; i < USERS; i++) {
    const u = await api<{ id: string }>('/api/users', { method: 'POST', body: '{}' });
    await api(`/api/users/${u.id}/topup`, {
      method: 'POST',
      body: JSON.stringify({ amount: TOPUP })
    });
    userIds.push(u.id);
  }
  console.log('users created:', userIds.length);

  const auctionRes = await api<{ id: string }>('/api/auctions', {
    method: 'POST',
    body: JSON.stringify({
      title: `Loadtest ${new Date().toISOString()}`,
      totalQuantity: QUANTITY,
      config: {
        roundDurationMs: ROUND_MS,
        winnersPerRound: WINNERS_PER_ROUND,
        antiSnipeWindowMs: 5_000,
        antiSnipeExtendMs: 5_000,
        maxConsecutiveEmptyRounds: 1000
      }
    })
  });
  const auctionId: string = auctionRes.id;
  console.log('auction created:', auctionId);

  await api(`/api/auctions/${auctionId}/start`, { method: 'POST', body: '{}' });
  console.log('auction started');

  const start = Date.now();
  const bots = userIds.map((id, idx) => botLoop({
    auctionId,
    userId: id,
    mode: idx % 10 === 0 ? 'sniper' : idx % 3 === 0 ? 'aggressive' : 'normal',
    startMs: start
  }));

  await Promise.race([
    Promise.all(bots),
    (async () => {
      while (Date.now() - start < RUNTIME_LIMIT_MS) {
        const snap = await api<AuctionSnapshot>(`/api/auctions/${auctionId}/snapshot`);
        if (snap.auction.state !== 'running') return;
        await sleep(1000);
      }
      throw new Error('Runtime limit exceeded');
    })()
  ]);

  console.log('waiting final snapshot...');
  const finalSnap = await api<AuctionSnapshot>(`/api/auctions/${auctionId}/snapshot`);
  console.log('final:', {
    state: finalSnap.auction.state,
    revenue: finalSnap.auction.revenue,
    awarded: finalSnap.auction.awardedCount
  });

  await verifyInvariants(new ObjectId(auctionId));
}

async function botLoop(opts: {
  auctionId: string;
  userId: string;
  mode: 'normal' | 'aggressive' | 'sniper';
  startMs: number;
}) {
  const maxBid = TOPUP;
  let current = 0;

  while (Date.now() - opts.startMs < RUNTIME_LIMIT_MS) {
    const snap = await api<AuctionSnapshot>(
      `/api/auctions/${opts.auctionId}/snapshot?userId=${opts.userId}`
    );
    if (snap.auction.state !== 'running') return;

    if (current > 0 && Math.random() < WITHDRAW_PROB) {
      try {
        await api(`/api/auctions/${opts.auctionId}/withdraw`, {
          method: 'POST',
          body: JSON.stringify({ userId: opts.userId })
        });
        current = 0;
      } catch {
        // ignore conflicts
      }
      await sleep(randInt(80, 250));
      continue;
    }

    const remaining = snap.timeRemainingMs ?? 0;
    const est = snap.estimatedClearingPrice ?? 0;

    let shouldBid = false;
    let next = current;

    if (opts.mode === 'sniper') {
      shouldBid = remaining > 0 && remaining < 1500;
      if (shouldBid) next = Math.min(maxBid, Math.max(current + 1, est + randInt(1, 50)));
    } else if (opts.mode === 'aggressive') {
      shouldBid = Math.random() < 0.5;
      if (shouldBid) next = Math.min(maxBid, Math.max(current + randInt(1, 200), est + randInt(1, 200)));
    } else {
      shouldBid = Math.random() < 0.2;
      if (shouldBid) next = Math.min(maxBid, Math.max(current + randInt(1, 50), est + randInt(1, 80)));
    }

    if (shouldBid && next > current) {
      try {
        await api(`/api/auctions/${opts.auctionId}/bids`, {
          method: 'POST',
          body: JSON.stringify({ userId: opts.userId, amount: next })
        });
        current = next;
      } catch {
        // ignore conflicts/insufficient funds/ended rounds
      }
    }

    await sleep(opts.mode === 'sniper' ? 100 : randInt(80, 250));
  }
}

async function verifyInvariants(auctionId: ObjectId) {
  console.log('verifying invariants via Mongo...', MONGO_URL);
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db();

  type UserDocLike = {
    totalTopups?: number;
    balance?: { available?: number; reserved?: number; spent?: number };
  };
  const users = await db.collection<UserDocLike>('users').find({}).toArray();
  const totalTopups = users.reduce((acc, u) => acc + (u.totalTopups ?? 0), 0);
  const totalBalance = users.reduce(
    (acc, u) =>
      acc +
      (u.balance?.available ?? 0) +
      (u.balance?.reserved ?? 0) +
      (u.balance?.spent ?? 0),
    0
  );

  if (totalTopups !== totalBalance) {
    throw new Error(`Invariant failed: Σbalances=${totalBalance} != Σtopups=${totalTopups}`);
  }

  const auction = await db.collection<{ revenue?: number; totalQuantity?: number }>('auctions').findOne({ _id: auctionId });
  if (!auction) throw new Error('Auction not found in DB');

  const [spendAgg] = await db
    .collection<{ auctionId?: ObjectId; type?: string; amount?: number }>('ledger')
    .aggregate<{ sum: number }>([
      { $match: { auctionId, type: 'spend' } },
      { $group: { _id: null, sum: { $sum: '$amount' } } }
    ])
    .toArray();
  const spendSum = spendAgg?.sum ?? 0;
  if ((auction.revenue ?? 0) !== spendSum) {
    throw new Error(`Invariant failed: auction.revenue=${auction.revenue} != Σspend(ledger)=${spendSum}`);
  }

  type WinnerBidLike = { settlement?: { giftSerial?: number } };
  const winners = await db
    .collection<WinnerBidLike>('bids')
    .find({ auctionId, status: 'won' })
    .project({ settlement: 1 })
    .toArray();

  const serials = winners.map((w) => w.settlement?.giftSerial).filter((x) => Number.isInteger(x));
  const uniq = new Set(serials);
  if (uniq.size !== serials.length) throw new Error('Invariant failed: duplicate giftSerial');
  if (uniq.size !== (auction.totalQuantity ?? 0)) {
    throw new Error(`Invariant failed: winners=${uniq.size} != totalQuantity=${auction.totalQuantity}`);
  }

  console.log('OK: invariants passed');
  await client.close();
}

type AuctionSnapshot = {
  auction: { state: string; revenue: number; awardedCount: number; totalQuantity: number };
  timeRemainingMs: number | null;
  estimatedClearingPrice: number | null;
};

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    throw new Error(getErrorMessage(data) || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

function getErrorMessage(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const rec = data as Record<string, unknown>;
  return typeof rec.error === 'string' ? rec.error : null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function numEnv(key: string, def: number) {
  const v = process.env[key];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function intEnv(key: string, def: number) {
  const v = process.env[key];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

await main();
