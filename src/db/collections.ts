import type { Collection, Db, ObjectId } from 'mongodb';

export type UserDoc = {
  _id: ObjectId;
  createdAt: Date;
  balance: {
    available: number;
    reserved: number;
    spent: number;
  };
  totalTopups: number;
};

export type AuctionConfig = {
  roundDurationMs: number;
  winnersPerRound: number;
  antiSnipeWindowMs: number;
  antiSnipeExtendMs: number;
  maxWinsPerUser: number;
  maxDurationMs: number;
  maxConsecutiveEmptyRounds: number;
};

export type AuctionState = 'draft' | 'running' | 'ended' | 'cancelled';
export type AuctionRoundState = 'open' | 'closing';

export type AuctionDoc = {
  _id: ObjectId;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  state: AuctionState;
  startedAt?: Date;
  endsAt?: Date;
  endedAt?: Date;
  endReason?: 'soldOut' | 'maxDuration' | 'emptyRounds' | 'cancelled';
  totalQuantity: number;
  awardedCount: number;
  revenue: number;
  currentRound: number;
  consecutiveEmptyRounds: number;
  roundState?: AuctionRoundState;
  roundEndsAt?: Date;
  closingToken?: string;
  closingStartedAt?: Date;
  version: number;
  config: AuctionConfig;
};

export type BidStatus = 'active' | 'won' | 'lost' | 'withdrawn';

export type BidSettlement = {
  wonRound: number;
  giftSerial: number;
  clearingPrice: number;
  paid: number;
  refunded: number;
  settledAt: Date;
};

export type BidDoc = {
  _id: ObjectId;
  auctionId: ObjectId;
  userId: ObjectId;
  amount: number;
  status: BidStatus;
  createdAt: Date;
  updatedAt: Date;
  lastBidAt: Date;
  settlement?: BidSettlement;
};

export type RoundWinner = {
  userId: ObjectId;
  amount: number;
  giftSerial: number;
  paid: number;
  refunded: number;
};

export type RoundDoc = {
  _id: ObjectId;
  auctionId: ObjectId;
  roundNumber: number;
  endedAt: Date;
  clearingPrice: number;
  winners: RoundWinner[];
};

export type LedgerType = 'topup' | 'reserve' | 'unreserve' | 'spend' | 'refund';

export type LedgerDoc = {
  _id: ObjectId;
  createdAt: Date;
  userId: ObjectId;
  type: LedgerType;
  amount: number;
  auctionId?: ObjectId;
  meta?: Record<string, unknown>;
};

export const col = {
  users: (db: Db): Collection<UserDoc> => db.collection<UserDoc>('users'),
  auctions: (db: Db): Collection<AuctionDoc> => db.collection<AuctionDoc>('auctions'),
  bids: (db: Db): Collection<BidDoc> => db.collection<BidDoc>('bids'),
  rounds: (db: Db): Collection<RoundDoc> => db.collection<RoundDoc>('rounds'),
  ledger: (db: Db): Collection<LedgerDoc> => db.collection<LedgerDoc>('ledger')
};
