import 'fastify';
import type { MongoCtx } from '../db/mongo.js';

declare module 'fastify' {
  interface FastifyInstance {
    mongo: MongoCtx;
  }
}
