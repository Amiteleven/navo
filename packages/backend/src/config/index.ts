import dotenv from 'dotenv';

dotenv.config();

/**
 * Validate required secrets at startup.
 *
 * In production, silently falling back to a known-default secret is a
 * critical vulnerability — every instance would share the same key. We
 * surface this as an explicit, non-sensitive error so an operator knows
 * exactly what to fix.
 */
const isProduction = (process.env.NODE_ENV || 'development') === 'production';

function assertSecret(name: string, value: string | undefined): string {
  if (!value || value.length < 32) {
    if (isProduction) {
      throw new Error(
        `Configuration error: ${name} is not set or too short (minimum 32 characters). ` +
          'Set it in your environment before starting the server.'
      );
    }
    return '';
  }
  return value;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  jwt: {
    secret: isProduction
      ? assertSecret('JWT_SECRET', process.env.JWT_SECRET)
      : process.env.JWT_SECRET || 'dev-only-secret-key-not-for-production-use',
    refreshSecret: isProduction
      ? assertSecret('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET)
      : process.env.JWT_REFRESH_SECRET || 'dev-only-refresh-secret-not-for-production-use',
    accessTokenExpiry: '15m',
    refreshTokenExpiry: '7d',
  },
  
  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/navo?schema=public',
  },
  
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
  },
  
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  },
  
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    // Configurable because the end-to-end verification script drives ~90
    // requests through the limiter in a single run.
    maxRequests: Number(process.env.RATE_LIMIT_MAX || 100),
  },
  
  bcrypt: {
    saltRounds: 12,
  },

  /**
   * Email delivery. The provider is selected by configuration alone, so no
   * code change is needed to move between a real mailbox and the development
   * log recorder. `EMAIL_PROVIDER=log` (the default when nothing else is set)
   * keeps the notification pipeline runnable without a mailbox.
   */
  email: {
    provider: (process.env.EMAIL_PROVIDER || 'log') as 'log' | 'smtp' | 'http',
    from: process.env.EMAIL_FROM || 'NAVO <no-reply@navo.local>',
    // HTTP provider (SendGrid/Postmark/Resend shape)
    endpoint: process.env.EMAIL_HTTP_ENDPOINT || '',
    apiKey: process.env.EMAIL_API_KEY || '',
    // SMTP provider
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: Number(process.env.SMTP_PORT || 587),
    smtpSecure: process.env.SMTP_SECURE === 'true',
    smtpUser: process.env.SMTP_USER || '',
    smtpPassword: process.env.SMTP_PASSWORD || '',
  },

  /** Base URL used in notification deep links. */
  appUrl: process.env.APP_URL || 'http://localhost:5173',

  /**
   * Per-action limits for seller-initiated paths. Separate from the global
   * limiter because these protect a buyer from spam while leaving the buyer
   * unaffected.
   */
  sellerRateLimits: {
    connectionRequests: Number(process.env.SELLER_CONNECTION_LIMIT || 10),
    messages: Number(process.env.SELLER_MESSAGE_LIMIT || 30),
    quotations: Number(process.env.SELLER_QUOTE_LIMIT || 20),
    windowMs: Number(process.env.SELLER_RATE_WINDOW_MS || 60 * 60 * 1000),
  },
};