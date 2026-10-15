import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
  config: vi.fn(),
}));

describe('Config: Secret Validation', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.JWT_REFRESH_SECRET;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.JWT_REFRESH_SECRET = originalRefreshSecret;
  });

  it('throws in production when JWT_SECRET is missing', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;

    await expect(import('../../config/index.js')).rejects.toThrow(
      /JWT_SECRET is not set or too short/
    );
  });

  it('throws in production when JWT_SECRET is too short', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'short';
    process.env.JWT_REFRESH_SECRET = 'a-very-long-enough-refresh-secret-key';

    await expect(import('../../config/index.js')).rejects.toThrow(
      /JWT_SECRET is not set or too short/
    );
  });

  it('throws in production when JWT_REFRESH_SECRET is too short', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-very-long-enough-jwt-secret-key-here';
    process.env.JWT_REFRESH_SECRET = 'short';

    await expect(import('../../config/index.js')).rejects.toThrow(
      /JWT_REFRESH_SECRET is not set or too short/
    );
  });

  it('accepts proper-length secrets in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-very-long-enough-jwt-secret-key-here';
    process.env.JWT_REFRESH_SECRET = 'a-very-long-enough-refresh-secret-key';

    const { config } = await import('../../config/index.js');
    expect(config.jwt.secret).toBe('a-very-long-enough-jwt-secret-key-here');
    expect(config.jwt.refreshSecret).toBe('a-very-long-enough-refresh-secret-key');
  });

  it('uses dev defaults in development when secret is missing', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;

    const { config } = await import('../../config/index.js');
    expect(config.jwt.secret).toBe('dev-only-secret-key-not-for-production-use');
    expect(config.jwt.refreshSecret).toBe('dev-only-refresh-secret-not-for-production-use');
  });
});
