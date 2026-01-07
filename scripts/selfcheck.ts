const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

const ROUND_MS = intEnv('ROUND_MS', 5_000);
const ANTI_WINDOW_MS = intEnv('ANTI_WINDOW_MS', 2_000);
const ANTI_EXTEND_MS = intEnv('ANTI_EXTEND_MS', 3_000);
const TOPUP = intEnv('TOPUP', 1_000);
const TIMEOUT_MS = intEnv('TIMEOUT_MS', 60_000);

type AuctionSnapshot = {
  auction: {
    _id: string;
    state: string;
    currentRound?: number;
    roundEndsAt?: string;
    revenue: number;
    awardedCount: number;
    totalQuantity: number;
  };
  timeRemainingMs: number | null;
  estimatedClearingPrice: number | null;
};

async function main() {
  console.log({ BASE_URL, ROUND_MS, ANTI_WINDOW_MS, ANTI_EXTEND_MS, TOPUP });

  const users: string[] = [];
  for (let i = 0; i < 3; i++) {
    const u = await api<{ id: string }>('/api/users', { method: 'POST', body: '{}' });
    await api(`/api/users/${u.id}/topup`, {
      method: 'POST',
      body: JSON.stringify({ amount: TOPUP })
    });
    users.push(u.id);
  }

  const auctionRes = await api<{ id: string }>('/api/auctions', {
    method: 'POST',
    body: JSON.stringify({
      title: `Selfcheck ${new Date().toISOString()}`,
      totalQuantity: 3,
      config: {
        roundDurationMs: ROUND_MS,
        winnersPerRound: 1,
        antiSnipeWindowMs: ANTI_WINDOW_MS,
        antiSnipeExtendMs: ANTI_EXTEND_MS,
        maxConsecutiveEmptyRounds: 10
      }
    })
  });
  const auctionId = auctionRes.id;
  console.log('auction:', auctionId);

  await api(`/api/auctions/${auctionId}/start`, { method: 'POST', body: '{}' });

  await api(`/api/auctions/${auctionId}/bids`, {
    method: 'POST',
    body: JSON.stringify({ userId: users[0], amount: 100 })
  });
  await api(`/api/auctions/${auctionId}/bids`, {
    method: 'POST',
    body: JSON.stringify({ userId: users[1], amount: 90 })
  });
  await api(`/api/auctions/${auctionId}/bids`, {
    method: 'POST',
    body: JSON.stringify({ userId: users[2], amount: 80 })
  });

  // Anti-snipe sanity: bid inside the window and verify roundEndsAt extends.
  const s0 = await waitSnapshot(auctionId, (s) => (s.timeRemainingMs ?? 0) > 0);
  const round0 = s0.auction.currentRound ?? 0;

  const before = await waitSnapshot(auctionId, (s) => {
    if ((s.timeRemainingMs ?? 0) <= 0) return false;
    if ((s.auction.currentRound ?? 0) !== round0) return false;
    return (s.timeRemainingMs ?? 0) < Math.floor(ANTI_WINDOW_MS / 2);
  });
  const beforeEnds = Date.parse(before.auction.roundEndsAt ?? '');
  if (!Number.isFinite(beforeEnds)) throw new Error('missing auction.roundEndsAt');

  await api(`/api/auctions/${auctionId}/bids`, {
    method: 'POST',
    body: JSON.stringify({ userId: users[0], amount: 130 })
  });
  const after = await api<AuctionSnapshot>(`/api/auctions/${auctionId}/snapshot`);
  const afterEnds = Date.parse(after.auction.roundEndsAt ?? '');
  if (!Number.isFinite(afterEnds)) throw new Error('missing auction.roundEndsAt (after)');
  if ((after.auction.currentRound ?? 0) === round0 && afterEnds <= beforeEnds) {
    throw new Error('anti-snipe check failed: roundEndsAt did not extend');
  }

  // Wait completion and verify invariants via audit endpoints.
  await waitSnapshot(auctionId, (s) => s.auction.state !== 'running');

  const auctionAudit = await api<{ checks: Record<string, boolean> }>(`/api/auctions/${auctionId}/audit`);
  const globalAudit = await api<{ checks: Record<string, boolean> }>('/api/audit');

  for (const [k, v] of Object.entries(globalAudit.checks)) {
    if (!v) throw new Error(`global audit failed: ${k}`);
  }
  for (const [k, v] of Object.entries(auctionAudit.checks)) {
    if (!v) throw new Error(`auction audit failed: ${k}`);
  }

  console.log('OK: selfcheck passed');
}

async function waitSnapshot(auctionId: string, pred: (s: AuctionSnapshot) => boolean): Promise<AuctionSnapshot> {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const s = await api<AuctionSnapshot>(`/api/auctions/${auctionId}/snapshot`);
    if (pred(s)) return s;
    await sleep(200);
  }
  throw new Error('timeout waiting for condition');
}

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

function intEnv(key: string, def: number) {
  const v = process.env[key];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

await main();
