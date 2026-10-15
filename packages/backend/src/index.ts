import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authenticate, enforceTenantIsolation } from './middleware/auth';
import { processPendingEmails } from './modules/notifications/notification.service';
import { ensureDbReady, checkDbHealth, prisma } from './utils/prisma';

// Import routes
import authRoutes from './modules/auth/auth.routes';
import tenantRoutes from './modules/tenants/tenant.routes';
import requestRoutes from './modules/requests/request.routes';
import vendorRoutes from './modules/vendors/vendor.routes';
import rfqRoutes from './modules/rfqs/rfq.routes';
import quoteRoutes from './modules/quotes/quote.routes';
import approvalRoutes from './modules/approvals/approval.routes';
import auditRoutes from './modules/audit/audit.routes';
import categoryRoutes from './modules/categories/category.routes';
import dealRoutes from './modules/deals/deal.routes';
import invitationRoutes from './modules/vendor-invitations/invitation.routes';
import quoteAnalysisRoutes from './modules/quote-analysis/quote-analysis.routes';
import negotiationRoutes from './modules/negotiation/negotiation.routes';
import savingsRoutes from './modules/savings/savings.routes';
import purchaseOrderRoutes from './modules/purchase-orders/purchase-order.routes';
import purchaseApprovalRoutes from './modules/purchase-approvals/purchase-approval.routes';
import requirementIntakeRoutes from './modules/requirement-intake/requirement-intake.routes';
import { requirementApprovalRoutes } from './modules/requirement-approval/requirement-approval.routes';
import copilotRoutes from './modules/copilot/copilot.routes';
import communicationRoutes from './modules/communication/communication.routes';
import notificationRoutes from './modules/notifications/notification.routes';
import navoRoutes from './modules/navo/navo.routes';
import { vendorIntelligenceRoutes } from './modules/vendor-intelligence';
import commercialOfferRoutes from './modules/commercial-offers/commercial-offer.controller';
import dealExecutionRoutes from './modules/deal-execution/deal-execution.routes.js';

const app = express();

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS
app.use(cors(config.cors));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check — application liveness
app.get('/health', (_req, res) => {
  res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() });
});

// Readiness probe — verifies database connectivity before reporting ready.
// Uses async checks so the HTTP status reflects actual DB availability.
let dbReady = false;
app.get('/ready', async (_req, res) => {
  if (dbReady) {
    return res.json({ success: true, status: 'ready', timestamp: new Date().toISOString() });
  }
  const health = await checkDbHealth();
  if (health.healthy) {
    dbReady = true;
    return res.json({ success: true, status: 'ready', latencyMs: health.latencyMs, timestamp: new Date().toISOString() });
  }
  return res.status(503).json({ success: false, status: 'not_ready', error: health.error, timestamp: new Date().toISOString() });
});

// API routes
const apiRouter = express.Router();

// Public routes (no auth required)
apiRouter.use('/auth', authRoutes);

// Protected routes (auth required)
apiRouter.use(authenticate);
apiRouter.use(enforceTenantIsolation);

apiRouter.use('/tenants', tenantRoutes);
apiRouter.use('/requests', requestRoutes);
apiRouter.use('/vendors', vendorRoutes);
apiRouter.use('/rfqs', rfqRoutes);
apiRouter.use('/quotes', quoteRoutes);
apiRouter.use('/approvals', approvalRoutes);
apiRouter.use('/audit', auditRoutes);
apiRouter.use('/categories', categoryRoutes);
apiRouter.use('/deals', dealRoutes);
apiRouter.use('/vendor-invitations', invitationRoutes);
apiRouter.use('/quote-analysis', quoteAnalysisRoutes);
apiRouter.use('/negotiation', negotiationRoutes);
apiRouter.use('/savings', savingsRoutes);
apiRouter.use('/purchase-orders', purchaseOrderRoutes);
apiRouter.use('/purchase-approvals', purchaseApprovalRoutes);
apiRouter.use('/requirement-intake', requirementIntakeRoutes);
apiRouter.use('/requirement-approval', requirementApprovalRoutes);
apiRouter.use('/copilot', copilotRoutes);
apiRouter.use('/communication', communicationRoutes);
apiRouter.use('/notifications', notificationRoutes);
  apiRouter.use('/navo', navoRoutes);
  apiRouter.use('/vendor-intelligence', vendorIntelligenceRoutes);
  apiRouter.use('/commercial-offers', commercialOfferRoutes);
  apiRouter.use('/deals/execution', dealExecutionRoutes);

// Drain the notification outbox on a timer. The same code path is exposed at
// `POST /api/notifications/process` so it can be driven deterministically in a
// test or by an external scheduler instead.
const NOTIFICATION_TICK_MS = Number(process.env.NOTIFICATION_TICK_MS || 60_000);
if (process.env.NODE_ENV !== 'test') {
  const timer = setInterval(() => {
    void processPendingEmails(25).catch((err) => {
      console.error('[notifications] batch failed:', err.message);
    });
  }, NOTIFICATION_TICK_MS);
  // Do not hold the process open purely for the notification timer.
  timer.unref();
}

app.use('/api', apiRouter);

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

// Start server — but only after the database is reachable.
// Bounded retries with exponential backoff prevent a crash loop on transient
// connection resets while still failing fast if the DB is genuinely down.
const DB_STARTUP_RETRIES = 5;
const DB_STARTUP_DELAY_MS = 3000;

async function startServer() {
  try {
    await ensureDbReady(DB_STARTUP_RETRIES, DB_STARTUP_DELAY_MS);
    dbReady = true;

    const server = app.listen(config.port, () => {
      console.log(`🚀 NAVO Backend running on port ${config.port}`);
      console.log(`📝 Environment: ${config.nodeEnv}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down gracefully');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down gracefully');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });

    // Refresh readiness flag on DB errors
    process.on('unhandledRejection', (err) => {
      if (err instanceof Error && err.message.includes('ECONN')) {
        dbReady = false;
        void ensureDbReady(1, 0).catch(() => { dbReady = false; });
      }
    });
  } catch (err) {
    console.error('[startup] Database not available after retries. Running in limited mode.');
    console.error((err as Error).message);

    // Start the server even without DB so /health and /ready probes work
    const server = app.listen(config.port, () => {
      console.log(`⚠️  NAVO Backend running in limited mode (no DB) on port ${config.port}`);
    });

    process.on('SIGTERM', () => {
      server.close(() => process.exit(0));
    });
    process.on('SIGINT', () => {
      server.close(() => process.exit(0));
    });
  }
}

void startServer();

export default app;