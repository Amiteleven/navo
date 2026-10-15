import { PrismaClient, Prisma } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  dbReady: boolean | undefined;
};

const logLevel = process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'];

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: logLevel as Prisma.LogLevel[],
  // Neon uses pooled connections with a 60s idle timeout. Set a connection
  // timeout so Prisma does not hang indefinitely when the pooler drops a
  // connection between requests.
  datasources: {
    db: {
      url: process.env.DATABASE_URL
        ? `${process.env.DATABASE_URL}${process.env.DATABASE_URL.includes('connection_timeout') ? '' : (process.env.DATABASE_URL.includes('?') ? '&' : '?')}connection_timeout=10`
        : undefined,
    },
  },
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

let dbReadyPromise: Promise<void> | null = globalForPrisma.dbReady ? Promise.resolve() : null;

export async function ensureDbReady(retries = 3, delayMs = 2000): Promise<void> {
  if (dbReadyPromise) return dbReadyPromise;

  dbReadyPromise = new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = async () => {
      try {
        await prisma.$queryRawUnsafe('SELECT 1');
        globalForPrisma.dbReady = true;
        resolve();
      } catch (err) {
        attempts++;
        if (attempts >= retries) {
          console.error('[db] Connection failed after', retries, 'attempts:', (err as Error).message);
          reject(err);
        } else {
          console.warn(`[db] Connection attempt ${attempts}/${retries} failed, retrying in ${delayMs}ms...`);
          setTimeout(attempt, delayMs);
        }
      }
    };
    attempt();
  });

  return dbReadyPromise;
}

export async function checkDbHealth(): Promise<{ healthy: boolean; error?: string; latencyMs?: number }> {
  try {
    const start = Date.now();
    await prisma.$queryRawUnsafe('SELECT 1');
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { healthy: false, error: (err as Error).message };
  }
}

export default prisma;
