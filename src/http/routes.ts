import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { appError, isAppError } from '../errors.js';
import { parseObjectId } from '../utils/objectId.js';
import { createUser, getUser, topupUser } from '../services/users.js';
import {
  cancelAuction,
  createAuction,
  getAuction,
  getAuctionSnapshot,
  listAuctions,
  placeBid,
  startAuction,
  withdrawBid
} from '../services/auctions.js';
import { auditAuction, auditGlobal } from '../services/audit.js';
import { getBotsStatus, startAuctionBots, stopAuctionBots } from '../services/bots.js';

type WrappedHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function wrap(handler: WrappedHandler): WrappedHandler {
  return async (req, reply) => {
    try {
      return await handler(req, reply);
    } catch (err) {
      return sendErr(reply, err);
    }
  };
}

export async function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/audit', wrap(async (_req, reply) => reply.send(await auditGlobal(app.mongo))));

  app.post(
    '/api/users',
    wrap(async (_req, reply) => {
      const user = await createUser(app.mongo);
      return reply.send({ id: user._id.toHexString(), balance: user.balance });
    })
  );

  app.get(
    '/api/users/:id',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = parseObjectId(id, 'userId');
      const user = await getUser(app.mongo, userId);
      if (!user) throw appError('NOT_FOUND', 'User not found', 404);
      return reply.send({
        id: user._id.toHexString(),
        balance: user.balance,
        totalTopups: user.totalTopups
      });
    })
  );

  app.post(
    '/api/users/:id/topup',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = parseObjectId(id, 'userId');
      const body = z.object({ amount: z.number().int().positive() }).parse(req.body);
      const user = await topupUser(app.mongo, userId, body.amount);
      return reply.send({ id: user._id.toHexString(), balance: user.balance });
    })
  );

  app.post(
    '/api/auctions',
    wrap(async (req, reply) => {
      const body = z
        .object({
          title: z.string().min(1),
          totalQuantity: z.number().int().positive(),
          config: z
            .object({
              roundDurationMs: z.number().int().positive().optional(),
              winnersPerRound: z.number().int().positive().optional(),
              antiSnipeWindowMs: z.number().int().min(0).optional(),
              antiSnipeExtendMs: z.number().int().min(0).optional(),
              maxDurationMs: z.number().int().min(0).optional(),
              maxConsecutiveEmptyRounds: z.number().int().min(0).optional()
            })
            .partial()
            .optional()
        })
        .parse(req.body);

      const config = body.config
        ? {
            ...(body.config.roundDurationMs !== undefined
              ? { roundDurationMs: body.config.roundDurationMs }
              : {}),
            ...(body.config.winnersPerRound !== undefined
              ? { winnersPerRound: body.config.winnersPerRound }
              : {}),
            ...(body.config.antiSnipeWindowMs !== undefined
              ? { antiSnipeWindowMs: body.config.antiSnipeWindowMs }
              : {}),
            ...(body.config.antiSnipeExtendMs !== undefined
              ? { antiSnipeExtendMs: body.config.antiSnipeExtendMs }
              : {}),
            ...(body.config.maxDurationMs !== undefined
              ? { maxDurationMs: body.config.maxDurationMs }
              : {}),
            ...(body.config.maxConsecutiveEmptyRounds !== undefined
              ? { maxConsecutiveEmptyRounds: body.config.maxConsecutiveEmptyRounds }
              : {})
          }
        : undefined;

      const auction = await createAuction(app.mongo, {
        title: body.title,
        totalQuantity: body.totalQuantity,
        ...(config ? { config } : {})
      });
      return reply.send({ id: auction._id.toHexString(), auction });
    })
  );

  app.get('/api/auctions', wrap(async (_req, reply) => reply.send({ auctions: await listAuctions(app.mongo) })));

  app.get(
    '/api/auctions/:id',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const auctionId = parseObjectId(id, 'auctionId');
      const auction = await getAuction(app.mongo, auctionId);
      if (!auction) throw appError('NOT_FOUND', 'Auction not found', 404);
      return reply.send({ auction });
    })
  );

  app.post(
    '/api/auctions/:id/start',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const auctionId = parseObjectId(id, 'auctionId');
      const auction = await startAuction(app.mongo, auctionId);
      return reply.send({ auction });
    })
  );

  app.post(
    '/api/auctions/:id/cancel',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const auctionId = parseObjectId(id, 'auctionId');
      const auction = await cancelAuction(app.mongo, auctionId);
      return reply.send({ auction });
    })
  );

  app.get(
    '/api/auctions/:id/snapshot',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const auctionId = parseObjectId(id, 'auctionId');
      const qs = req.query as { userId?: string };
      const userId = qs.userId ? parseObjectId(qs.userId, 'userId') : undefined;
      const snapshot = await getAuctionSnapshot(app.mongo, auctionId, userId ? { userId } : undefined);
      return reply.send(snapshot);
    })
  );

  app.get(
    '/api/auctions/:id/audit',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const auctionId = parseObjectId(id, 'auctionId');
      const audit = await auditAuction(app.mongo, auctionId);
      return reply.send(audit);
    })
  );

  app.get(
    '/api/auctions/:id/bots',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const auctionId = parseObjectId(id, 'auctionId');
      return reply.send(getBotsStatus(auctionId));
    })
  );

  app.post(
    '/api/auctions/:id/bots/start',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const auctionId = parseObjectId(id, 'auctionId');
      const body = z
        .object({
          count: z.number().int().positive().max(2000),
          topupAmount: z.number().int().positive().optional(),
          maxBid: z.number().int().positive().optional()
        })
        .parse(req.body);

      const topupAmount = body.topupAmount ?? 5_000;
      const maxBid = body.maxBid ?? topupAmount;
      const res = await startAuctionBots({
        mongo: app.mongo,
        logger: app.log,
        auctionId,
        count: body.count,
        topupAmount,
        maxBid
      });
      return reply.send(res);
    })
  );

  app.post(
    '/api/auctions/:id/bots/stop',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const auctionId = parseObjectId(id, 'auctionId');
      return reply.send(stopAuctionBots({ auctionId, logger: app.log }));
    })
  );

  app.post(
    '/api/auctions/:id/bids',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const auctionId = parseObjectId(id, 'auctionId');
      const body = z.object({ userId: z.string().min(1), amount: z.number().int().positive() }).parse(req.body);
      const userId = parseObjectId(body.userId, 'userId');
      const res = await placeBid(app.mongo, auctionId, userId, body.amount);
      return reply.send({
        auction: res.auction,
        bid: {
          ...res.bid,
          _id: res.bid._id.toHexString(),
          auctionId: res.bid.auctionId.toHexString(),
          userId: res.bid.userId.toHexString()
        }
      });
    })
  );

  app.post(
    '/api/auctions/:id/withdraw',
    wrap(async (req, reply) => {
      const { id } = req.params as { id: string };
      const auctionId = parseObjectId(id, 'auctionId');
      const body = z.object({ userId: z.string().min(1) }).parse(req.body);
      const userId = parseObjectId(body.userId, 'userId');
      const res = await withdrawBid(app.mongo, auctionId, userId);
      return reply.send({
        bid: {
          ...res.bid,
          _id: res.bid._id.toHexString(),
          auctionId: res.bid.auctionId.toHexString(),
          userId: res.bid.userId.toHexString()
        }
      });
    })
  );
}

function sendErr(reply: FastifyReply, err: unknown) {
  if (isAppError(err)) {
    return reply
      .code(err.status)
      .send({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }

  if (err instanceof ZodError) {
    return reply.code(400).send({ error: 'Validation error', code: 'INVALID_INPUT', details: err.issues });
  }

  const msg = err instanceof Error ? err.message : 'Unknown error';
  return reply.code(500).send({ error: msg });
}
