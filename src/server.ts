import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { join } from 'node:path';
import { buildEnv } from './env.js';
import { connectMongo } from './db/mongo.js';
import { registerRoutes } from './http/routes.js';
import { startAuctionEngine } from './services/auctionEngine.js';

async function main() {
  const env = buildEnv(process.env);

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL
    }
  });

  const mongo = await connectMongo(env);
  app.decorate('mongo', mongo);

  await app.register(staticPlugin, {
    root: join(process.cwd(), 'public'),
    prefix: '/',
    decorateReply: false
  });

  await app.register(registerRoutes);

  const engine = startAuctionEngine({ mongo, logger: app.log, pollIntervalMs: env.ENGINE_POLL_INTERVAL_MS });

  app.addHook('onClose', async () => {
    engine.stop();
    await mongo.client.close();
  });

  await app.listen({ port: env.PORT, host: env.HOST });
}

await main();
