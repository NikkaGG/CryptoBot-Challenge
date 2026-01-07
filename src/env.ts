import { z } from 'zod';

const EnvSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGO_URL: z
    .string()
    .default('mongodb://localhost:27017/auction?replicaSet=rs0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  ENGINE_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(500)
});

export type Env = z.infer<typeof EnvSchema>;

export function buildEnv(env: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  return parsed.data;
}
