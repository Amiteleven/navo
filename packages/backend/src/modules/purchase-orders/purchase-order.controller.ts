import { Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import {
  ApprovalStatus,
  DeliveryEventType,
  DiscrepancyResolution,
  DocumentCategory,
  InvoiceStatus,
  PaymentStatus,
  PurchaseOrderStatus,
  UserRole,
} from '@navo/shared';
import { AuthenticatedRequest } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AuthenticationError } from '../../utils/errors';
import { serializeMoney } from '../../utils/serialize.js';
import { ActorContext } from './po-access.js';
import {
  addDeliveryEvent,
  cancelPurchaseOrder,
  closePurchaseOrder,
  confirmOrderBySupplier,
  createPoFromDeal,
  CreatePoFromDealInput,
  decidePoApproval,
  getPurchaseOrder,
  issuePurchaseOrder,
  listPurchaseOrders,
  rejectOrderBySupplier,
  submitForApproval,
} from './purchase-order.service.js';
import { getGoodsReceiptTotals, listGoodsReceipts, recordGoodsReceipt } from './goods-receipt.service.js';
import { getInvoice, listInvoices, resolveDiscrepancy, submitInvoice, verifyInvoice } from './invoice.service.js';
import { listPayments, recordPayment } from './payment.service.js';
import { getDocumentContent, listDocuments, uploadDocument } from './document.service.js';
import { buildPoSummary, getPurchaseTimeline } from './timeline.service.js';
import {
  getSellerDashboard,
  getSellerOrderSummary,
  listSellerOrders,
} from './seller-dashboard.service.js';
import { explainPurchaseOrder } from './po-assistant.service.js';

/** Resolve the acting user into the ActorContext used by every service call. */
function actor(req: AuthenticatedRequest): ActorContext {
  if (!req.user) throw new AuthenticationError();
  return {
    userId: req.user.userId,
    tenantId: req.user.tenantId,
    role: req.user.role,
  };
}

// ── Validation schemas ───────────────────────────────────────────────────────

const moneySchema = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/, 'Must be a decimal number')]);

const createPoSchema = z.object({
  body: z.object({
    dealId: z.string().min(1, 'Deal ID is required'),
    deliveryAddress: z.string().min(1).optional(),
    expectedDeliveryDate: z.coerce.date().optional(),
    paymentTerms: z.string().optional(),
    warrantyMonths: z.coerce.number().int().nonnegative().optional(),
    notes: z.string().optional(),
    terms: z.string().optional(),
    overrides: z
      .object({
        quantity: z.coerce.number().int().positive().optional(),
        unitPrice: moneySchema.optional(),
        taxRate: moneySchema.optional(),
        freightAmount: moneySchema.optional(),
        installationAmount: moneySchema.optional(),
        otherCharges: moneySchema.optional(),
        otherChargesDetails: z.string().optional(),
      })
      .optional(),
  }),
});

const listPoSchema = z.object({
  query: z.object({
    status: z.nativeEnum(PurchaseOrderStatus).optional(),
    vendorId: z.string().min(1).optional(),
    buyerId: z.string().min(1).optional(),
    search: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

const poIdParam = z.object({ params: z.object({ poId: z.string().min(1, 'Purchase order ID is required') }) });
const invoiceIdParam = z.object({ params: z.object({ invoiceId: z.string().min(1, 'Invoice ID is required') }) });
const documentIdParam = z.object({ params: z.object({ documentId: z.string().min(1, 'Document ID is required') }) });

const approvalParam = z.object({
  params: z.object({
    poId: z.string().min(1),
    approvalId: z.string().min(1, 'Approval ID is required'),
  }),
});

const approvalDecisionSchema = z.object({
  body: z.object({
    status: z.enum([ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.CHANGES_REQUESTED]),
    comments: z.string().max(2000).optional(),
  }),
});

const cancelPoSchema = z.object({ body: z.object({ reason: z.string().min(1, 'A reason is required') }) });

const confirmOrderSchema = z.object({
  body: z.object({
    confirmedDeliveryDate: z.coerce.date().optional(),
    notes: z.string().max(2000).optional(),
  }),
});

const rejectOrderSchema = z.object({ body: z.object({ reason: z.string().min(1, 'A reason is required') }) });

const deliveryEventSchema = z.object({
  body: z.object({
    type: z.nativeEnum(DeliveryEventType),
    notes: z.string().max(2000).optional(),
    location: z.string().max(300).optional(),
    carrierName: z.string().max(200).optional(),
    trackingRef: z.string().max(200).optional(),
    estimatedDeliveryDate: z.coerce.date().optional(),
    documentIds: z.array(z.string().min(1)).optional(),
  }),
});

const receiptSchema = z.object({
  body: z.object({
    receivedQuantity: z.coerce.number().int().positive(),
    acceptedQuantity: z.coerce.number().int().nonnegative(),
    rejectedQuantity: z.coerce.number().int().nonnegative().optional(),
    receiptDate: z.coerce.date().optional(),
    conditionNotes: z.string().max(2000).optional(),
    discrepancies: z.array(z.record(z.unknown())).optional(),
    documentIds: z.array(z.string().min(1)).optional(),
  }),
});

const submitInvoiceSchema = z.object({
  body: z.object({
    poId: z.string().min(1, 'Purchase order ID is required'),
    invoiceNumber: z.string().min(1, 'Invoice number is required'),
    invoiceDate: z.coerce.date(),
    dueDate: z.coerce.date().optional(),
    quantity: z.coerce.number().int().positive().optional(),
    unitPrice: moneySchema.optional(),
    taxRate: moneySchema.optional(),
    taxAmount: moneySchema.optional(),
    freightAmount: moneySchema.optional(),
    otherCharges: moneySchema.optional(),
    otherChargesDetails: z.string().optional(),
    totalAmount: moneySchema.optional(),
    description: z.string().max(2000).optional(),
    extractedData: z.record(z.unknown()).optional(),
    extractionMethod: z.string().max(100).optional(),
    documentIds: z.array(z.string().min(1)).optional(),
  }),
});

const listInvoicesSchema = z.object({
  query: z.object({
    poId: z.string().min(1).optional(),
    status: z.nativeEnum(InvoiceStatus).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

const verifyInvoiceSchema = z.object({
  body: z.object({
    tolerance: moneySchema.optional(),
    notes: z.string().max(2000).optional(),
  }),
});

const resolveDiscrepancySchema = z.object({
  body: z.object({
    field: z.string().min(1, 'Field is required'),
    resolution: z.nativeEnum(DiscrepancyResolution).refine((r) => r !== DiscrepancyResolution.OPEN, {
      message: 'Choose a resolution other than OPEN',
    }),
    note: z.string().max(2000).optional(),
  }),
});

const paymentSchema = z.object({
  body: z.object({
    poId: z.string().min(1, 'Purchase order ID is required'),
    invoiceId: z.string().min(1).optional(),
    status: z.nativeEnum(PaymentStatus),
    amount: moneySchema.optional(),
    paidAmount: moneySchema.optional(),
    paidAt: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
    reference: z.string().max(200).optional(),
    paymentMethod: z.string().max(100).optional(),
    notes: z.string().max(2000).optional(),
  }),
});

const listPaymentsSchema = z.object({
  query: z.object({
    poId: z.string().min(1).optional(),
    status: z.nativeEnum(PaymentStatus).optional(),
  }),
});

const uploadDocumentSchema = z.object({
  body: z.object({
    poId: z.string().min(1).optional(),
    invoiceId: z.string().min(1).optional(),
    category: z.nativeEnum(DocumentCategory),
    fileName: z.string().min(1, 'File name is required'),
    mimeType: z.string().min(1, 'File type is required'),
    // Base64 payload; the decoded size is bounded in the service.
    content: z.string().min(1, 'File content is required'),
  }),
});

const listDocumentsSchema = z.object({
  query: z.object({
    poId: z.string().min(1).optional(),
    invoiceId: z.string().min(1).optional(),
    category: z.nativeEnum(DocumentCategory).optional(),
  }),
});

const listSellerOrdersSchema = z.object({
  query: z.object({
    status: z.nativeEnum(PurchaseOrderStatus).optional(),
    search: z.string().optional(),
  }),
});

const assistantSchema = z.object({
  body: z.object({
    question: z.string().min(1, 'A question is required').max(1000),
  }),
});

// ── Purchase order handlers ──────────────────────────────────────────────────

export const createPoHandler = [
  validate(createPoSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const po = await createPoFromDeal(req.body as CreatePoFromDealInput, actor(req));
    res.status(201).json({ success: true, data: serializeMoney(po) });
  },
];

export const listPurchaseOrdersHandler = [
  validate(listPoSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { status, vendorId, buyerId, search, page, limit } = req.query as Record<string, string | number>;
    const result = await listPurchaseOrders(actor(req), {
      status: status as PurchaseOrderStatus | undefined,
      vendorId: vendorId as string | undefined,
      buyerId: buyerId as string | undefined,
      search: search as string | undefined,
      page: Number(page),
      limit: Number(limit),
    });
    res.json({ success: true, ...serializeMoney(result) });
  },
];

export const getPurchaseOrderHandler = [
  validate(poIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const po = await getPurchaseOrder(req.params.poId, actor(req));
    res.json({ success: true, data: serializeMoney(po) });
  },
];

export const getPurchaseOrderSummaryHandler = [
  validate(poIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const summary = await buildPoSummary(req.params.poId, actor(req));
    if (!summary) {
      res.status(404).json({ success: false, message: 'Purchase order not found' });
      return;
    }
    res.json({ success: true, data: serializeMoney(summary) });
  },
];

export const getPurchaseTimelineHandler = [
  validate(poIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const entries = await getPurchaseTimeline(req.params.poId, actor(req));
    res.json({ success: true, data: serializeMoney(entries) });
  },
];

export const submitPoForApprovalHandler = [
  validate(poIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const po = await submitForApproval(req.params.poId, actor(req));
    res.json({ success: true, data: serializeMoney(po) });
  },
];

export const decidePoApprovalHandler = [
  validate(approvalParam),
  validate(approvalDecisionSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await decidePoApproval(req.params.poId, req.params.approvalId, actor(req), req.body);
    res.json({ success: true, data: serializeMoney(result) });
  },
];

export const issuePoHandler = [
  validate(poIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const po = await issuePurchaseOrder(req.params.poId, actor(req));
    res.json({ success: true, data: serializeMoney(po) });
  },
];

export const cancelPoHandler = [
  validate(poIdParam),
  validate(cancelPoSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const po = await cancelPurchaseOrder(req.params.poId, actor(req), req.body.reason);
    res.json({ success: true, data: serializeMoney(po) });
  },
];

export const closePoHandler = [
  validate(poIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const po = await closePurchaseOrder(req.params.poId, actor(req), req.body?.notes);
    res.json({ success: true, data: serializeMoney(po) });
  },
];

export const confirmOrderHandler = [
  validate(poIdParam),
  validate(confirmOrderSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const po = await confirmOrderBySupplier(req.params.poId, actor(req), {
      confirmedDeliveryDate: req.body.confirmedDeliveryDate?.toISOString(),
      notes: req.body.notes,
    });
    res.json({ success: true, data: serializeMoney(po) });
  },
];

export const rejectOrderHandler = [
  validate(poIdParam),
  validate(rejectOrderSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const po = await rejectOrderBySupplier(req.params.poId, actor(req), req.body.reason);
    res.json({ success: true, data: serializeMoney(po) });
  },
];

export const addDeliveryEventHandler = [
  validate(poIdParam),
  validate(deliveryEventSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const event = await addDeliveryEvent(req.params.poId, actor(req), {
      ...req.body,
      estimatedDeliveryDate: req.body.estimatedDeliveryDate?.toISOString(),
    });
    res.status(201).json({ success: true, data: serializeMoney(event) });
  },
];

// ── Goods receipt handlers ───────────────────────────────────────────────────

export const recordReceiptHandler = [
  validate(poIdParam),
  validate(receiptSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const receipt = await recordGoodsReceipt(req.params.poId, actor(req), {
      ...req.body,
      receiptDate: req.body.receiptDate?.toISOString(),
    });
    res.status(201).json({ success: true, data: serializeMoney(receipt) });
  },
];

export const listReceiptsHandler = [
  validate(poIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const receipts = await listGoodsReceipts(req.params.poId, actor(req));
    res.json({ success: true, data: serializeMoney(receipts) });
  },
];

export const getReceiptTotalsHandler = [
  validate(poIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const totals = await getGoodsReceiptTotals(req.params.poId, actor(req));
    res.json({ success: true, data: serializeMoney(totals) });
  },
];

// ── Invoice handlers ─────────────────────────────────────────────────────────

export const submitInvoiceHandler = [
  validate(submitInvoiceSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const invoice = await submitInvoice(actor(req), {
      ...req.body,
      invoiceDate: req.body.invoiceDate.toISOString(),
      dueDate: req.body.dueDate?.toISOString(),
    });
    res.status(201).json({ success: true, data: serializeMoney(invoice) });
  },
];

export const listInvoicesHandler = [
  validate(listInvoicesSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { poId, status, page, limit } = req.query as Record<string, string | number>;
    const result = await listInvoices(actor(req), {
      poId: poId as string | undefined,
      status: status as InvoiceStatus | undefined,
      page: Number(page),
      limit: Number(limit),
    });
    res.json({ success: true, ...serializeMoney(result) });
  },
];

export const getInvoiceHandler = [
  validate(invoiceIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const invoice = await getInvoice(req.params.invoiceId, actor(req));
    res.json({ success: true, data: serializeMoney(invoice) });
  },
];

export const verifyInvoiceHandler = [
  validate(invoiceIdParam),
  validate(verifyInvoiceSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tolerance = req.body.tolerance !== undefined ? new Prisma.Decimal(String(req.body.tolerance)) : undefined;
    const result = await verifyInvoice(req.params.invoiceId, actor(req), { tolerance, notes: req.body.notes });
    res.json({ success: true, data: serializeMoney(result) });
  },
];

export const resolveDiscrepancyHandler = [
  validate(invoiceIdParam),
  validate(resolveDiscrepancySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await resolveDiscrepancy(req.params.invoiceId, actor(req), req.body);
    res.json({ success: true, data: serializeMoney(result) });
  },
];

// ── Payment handlers ─────────────────────────────────────────────────────────

export const recordPaymentHandler = [
  validate(paymentSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const payment = await recordPayment(actor(req), {
      ...req.body,
      paidAt: req.body.paidAt?.toISOString(),
      dueDate: req.body.dueDate?.toISOString(),
    });
    res.status(201).json({ success: true, data: serializeMoney(payment) });
  },
];

export const listPaymentsHandler = [
  validate(listPaymentsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { poId, status } = req.query as Record<string, string>;
    const payments = await listPayments(actor(req), {
      poId: poId as string | undefined,
      status: status as PaymentStatus | undefined,
    });
    res.json({ success: true, data: serializeMoney(payments) });
  },
];

// ── Document handlers ────────────────────────────────────────────────────────

export const uploadDocumentHandler = [
  validate(uploadDocumentSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const document = await uploadDocument(actor(req), {
      poId: req.body.poId,
      invoiceId: req.body.invoiceId,
      category: req.body.category,
      fileName: req.body.fileName,
      mimeType: req.body.mimeType,
      content: Buffer.from(req.body.content, 'base64'),
    });
    res.status(201).json({ success: true, data: serializeMoney(document) });
  },
];

export const listDocumentsHandler = [
  validate(listDocumentsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { poId, invoiceId, category } = req.query as Record<string, string>;
    const documents = await listDocuments(actor(req), {
      poId: poId as string | undefined,
      invoiceId: invoiceId as string | undefined,
      category: category as DocumentCategory | undefined,
    });
    res.json({ success: true, data: serializeMoney(documents) });
  },
];

export const downloadDocumentHandler = [
  validate(documentIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const document = await getDocumentContent(req.params.documentId, actor(req));
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Length', String(document.size));
    // Quoted disposition with a sanitized name prevents header injection.
    res.setHeader('Content-Disposition', `attachment; filename="${document.fileName.replace(/"/g, '')}"`);
    res.send(document.content);
  },
];

// ── Seller handlers ──────────────────────────────────────────────────────────

export const getSellerDashboardHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const dashboard = await getSellerDashboard(actor(req));
  res.json({ success: true, data: serializeMoney(dashboard) });
};

export const listSellerOrdersHandler = [
  validate(listSellerOrdersSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { status, search } = req.query as Record<string, string>;
    const orders = await listSellerOrders(actor(req), {
      status: status as PurchaseOrderStatus | undefined,
      search,
    });
    res.json({ success: true, data: serializeMoney(orders) });
  },
];

export const getSellerOrderSummaryHandler = [
  validate(poIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const summary = await getSellerOrderSummary(req.params.poId, actor(req));
    res.json({ success: true, data: serializeMoney(summary) });
  },
];

// ── AI assistance ────────────────────────────────────────────────────────────

export const assistantHandler = [
  validate(assistantSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await explainPurchaseOrder(req.body.question, actor(req), req.query.poId as string | undefined);
    res.json({ success: true, data: serializeMoney(result) });
  },
];

export { UserRole };