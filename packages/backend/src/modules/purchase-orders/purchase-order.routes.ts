import { Router } from '../../utils/router';
import { authenticate } from '../../middleware/auth';
import {
  addDeliveryEventHandler,
  assistantHandler,
  cancelPoHandler,
  closePoHandler,
  confirmOrderHandler,
  createPoHandler,
  decidePoApprovalHandler,
  downloadDocumentHandler,
  getInvoiceHandler,
  getPurchaseOrderHandler,
  getPurchaseOrderSummaryHandler,
  getPurchaseTimelineHandler,
  getReceiptTotalsHandler,
  getSellerDashboardHandler,
  getSellerOrderSummaryHandler,
  issuePoHandler,
  listDocumentsHandler,
  listInvoicesHandler,
  listPaymentsHandler,
  listPurchaseOrdersHandler,
  listReceiptsHandler,
  listSellerOrdersHandler,
  recordPaymentHandler,
  recordReceiptHandler,
  rejectOrderHandler,
  resolveDiscrepancyHandler,
  submitInvoiceHandler,
  submitPoForApprovalHandler,
  uploadDocumentHandler,
  verifyInvoiceHandler,
} from './purchase-order.controller';

const router = Router();

router.use(authenticate);

/*
 * Route order matters: Express matches in registration order, so every
 * module-level literal path must be declared before any `/:poId` route.
 * Registering `/:poId` first would swallow "/invoices", "/documents" and
 * "/payments", treating the literal as an id and returning 404.
 */

// ── Module-level literal routes ──────────────────────────────────────────────

// Seller surface
router.get('/seller/dashboard', getSellerDashboardHandler);
router.get('/seller/orders', listSellerOrdersHandler);
router.get('/seller/orders/:poId/summary', getSellerOrderSummaryHandler);

// Documents
router.get('/documents/:documentId/download', downloadDocumentHandler);
router.get('/documents', listDocumentsHandler);
router.post('/documents', uploadDocumentHandler);

// Invoices
router.get('/invoices/:invoiceId', getInvoiceHandler);
router.post('/invoices/:invoiceId/verify', verifyInvoiceHandler);
router.post('/invoices/:invoiceId/resolve-discrepancy', resolveDiscrepancyHandler);
router.get('/invoices', listInvoicesHandler);
router.post('/invoices', submitInvoiceHandler);

// Payments
router.get('/payments', listPaymentsHandler);
router.post('/payments', recordPaymentHandler);

// AI assistance
router.post('/assistant', assistantHandler);

// ── Purchase order collection ─────────────────────────────────────────────────
router.post('/', createPoHandler);
router.get('/', listPurchaseOrdersHandler);

// ── Purchase order scoped routes ─────────────────────────────────────────────
router.get('/:poId', getPurchaseOrderHandler);
router.get('/:poId/summary', getPurchaseOrderSummaryHandler);
router.get('/:poId/timeline', getPurchaseTimelineHandler);

router.post('/:poId/submit-approval', submitPoForApprovalHandler);
router.post('/:poId/approvals/:approvalId/decide', decidePoApprovalHandler);
router.post('/:poId/issue', issuePoHandler);
router.post('/:poId/cancel', cancelPoHandler);
router.post('/:poId/close', closePoHandler);

// Supplier order actions
router.post('/:poId/confirm', confirmOrderHandler);
router.post('/:poId/reject', rejectOrderHandler);
router.post('/:poId/delivery-events', addDeliveryEventHandler);

// Goods receipts
router.post('/:poId/receipts', recordReceiptHandler);
router.get('/:poId/receipts/totals', getReceiptTotalsHandler);
router.get('/:poId/receipts', listReceiptsHandler);

export default router;