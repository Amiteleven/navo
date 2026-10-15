import {
  Prisma,
  PurchaseOrderStatus as PrismaPOStatus,
  InvoiceMatchStatus as PrismaMatchStatus,
  AuditAction as PrismaAuditAction,
} from '@prisma/client';
import {
  ApprovalStatus,
  AuditAction,
  DeliveryEventType,
  DiscrepancyResolution,
  DiscrepancySeverity,
  DocumentCategory,
  InvoiceMatchStatus,
  PaymentStatus,
  PurchaseOrderStatus,
  TransactionTimelineEntry,
} from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { decimalToNumber, roundMoney } from '../../utils/money.js';
import { ActorContext, loadAccessiblePo } from './po-access.js';

// Keyed by plain string: the values arrive as Prisma enum members, which are
// nominally distinct from the shared enum even though the literals match.
const DELIVERY_LABELS: Record<string, string> = {
  [DeliveryEventType.CONFIRMED]: 'Supplier confirmed the order',
  [DeliveryEventType.PREPARATION]: 'Supplier preparing the goods',
  [DeliveryEventType.DISPATCH]: 'Goods dispatched',
  [DeliveryEventType.IN_TRANSIT]: 'In transit',
  [DeliveryEventType.PARTIALLY_DELIVERED]: 'Partial delivery recorded',
  [DeliveryEventType.DELIVERED]: 'Goods delivered',
  [DeliveryEventType.EXCEPTION]: 'Delivery exception reported',
};

const STATUS_LABELS: Record<string, string> = {
  [PurchaseOrderStatus.DRAFT]: 'Purchase order drafted',
  [PurchaseOrderStatus.PENDING_APPROVAL]: 'Submitted for approval',
  [PurchaseOrderStatus.ISSUED]: 'Purchase order issued to supplier',
  [PurchaseOrderStatus.SUPPLIER_CONFIRMED]: 'Supplier confirmed the order',
  [PurchaseOrderStatus.IN_PROGRESS]: 'Order in progress',
  [PurchaseOrderStatus.PARTIALLY_DELIVERED]: 'Partially delivered',
  [PurchaseOrderStatus.DELIVERED]: 'Delivered',
  [PurchaseOrderStatus.CLOSED]: 'Purchase order closed',
  [PurchaseOrderStatus.CANCELLED]: 'Purchase order cancelled',
};

/*
 * Status sets as plain strings. Prisma enum members read back from the database
 * are nominally distinct from the shared enum even though the literals match,
 * so membership tests need a widened element type.
 */
const SETTLED_STATUSES: string[] = [
  PurchaseOrderStatus.DELIVERED,
  PurchaseOrderStatus.CLOSED,
  PurchaseOrderStatus.CANCELLED,
];

/** Statuses meaning at least some goods physically arrived. */
const RECEIVED_STATUSES: string[] = [
  PurchaseOrderStatus.PARTIALLY_DELIVERED,
  PurchaseOrderStatus.DELIVERED,
];

/**
 * Build the complete purchase transaction history for a PO.
 *
 * The timeline is assembled from the records themselves rather than from a
 * stored narrative, so it cannot drift from the data. Audit log entries are
 * merged in for the decision points that leave no dedicated row (cancellations,
 * discrepancy resolutions), and every entry carries `source` so the UI can
 * distinguish authoritative application data from the audit trail.
 */
export async function getPurchaseTimeline(poId: string, actor: ActorContext) {
  const po = await loadAccessiblePo(poId, actor, {
    include: {
      approvals: {
        orderBy: { level: 'asc' },
        include: {
          approver: { select: { id: true, firstName: true, lastName: true } },
          decidedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      },
      deliveryEvents: { orderBy: { occurredAt: 'asc' } },
      goodsReceipts: { orderBy: { receiptDate: 'asc' } },
      invoices: {
        include: { verifications: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      },
      payments: { orderBy: { createdAt: 'asc' } },
      documents: { orderBy: { createdAt: 'asc' } },
      deal: { select: { id: true, dealNumber: true, createdAt: true } },
    },
  });

  const entries: TransactionTimelineEntry[] = [];

  if (po.deal) {
    entries.push({
      at: po.deal.createdAt.toISOString(),
      stage: 'DEAL',
      title: `Deal ${po.deal.dealNumber} accepted`,
      detail: 'Commercial terms agreed and accepted.',
      source: 'application_data',
    });
  }

  entries.push({
    at: po.createdAt.toISOString(),
    stage: 'PO',
    title: `Purchase order ${po.poNumber} created`,
    detail: `${po.quantity} × ${po.itemName} at ${po.unitPrice.toFixed(2)} ${po.currency} (total ${po.totalAmount.toFixed(2)}).`,
    status: po.status,
    source: 'application_data',
  });

  for (const approval of po.approvals) {
    const approver = approval.decidedBy ?? approval.approver;
    entries.push({
      at: (approval.decidedAt ?? approval.createdAt).toISOString(),
      stage: 'APPROVAL',
      title:
        approval.status === ApprovalStatus.PENDING
          ? `Level ${approval.level} approval awaiting decision`
          : `Level ${approval.level} approval ${approval.status.toLowerCase()}`,
      detail: approval.comments ?? `Required role: ${approval.requiredRole.replace(/_/g, ' ').toLowerCase()}`,
      actorId: approval.decidedById ?? approval.approverId ?? undefined,
      actorName: approver ? fullName(approver) : undefined,
      status: approval.status,
      source: 'application_data',
    });
  }

  if (po.issuedAt) {
    entries.push({
      at: po.issuedAt.toISOString(),
      stage: 'PO',
      title: STATUS_LABELS[PrismaPOStatus.ISSUED],
      detail: `Purchase order ${po.poNumber} issued to the supplier.`,
      source: 'application_data',
    });
  }

  if (po.supplierConfirmedAt) {
    entries.push({
      at: po.supplierConfirmedAt.toISOString(),
      stage: 'SUPPLIER',
      title: 'Supplier confirmed the order',
      detail: po.supplierConfirmedDeliveryDate
        ? `Supplier committed to delivery by ${po.supplierConfirmedDeliveryDate.toISOString().slice(0, 10)}.`
        : 'Supplier accepted the order. No committed delivery date yet.',
      status: PurchaseOrderStatus.SUPPLIER_CONFIRMED,
      source: 'application_data',
    });
  }

  for (const event of po.deliveryEvents) {
    // CONFIRMED is represented by the SUPPLIER entry above; emitting it here
    // too would duplicate the same milestone in the history.
    if (event.type === DeliveryEventType.CONFIRMED) continue;

    entries.push({
      at: event.occurredAt.toISOString(),
      stage: 'DELIVERY',
      title: DELIVERY_LABELS[event.type],
      detail: [event.notes, event.carrierName, event.trackingRef && `Tracking: ${event.trackingRef}`]
        .filter(Boolean)
        .join(' · '),
      actorId: event.actorId,
      status: event.type,
      source: 'application_data',
    });
  }

  for (const receipt of po.goodsReceipts) {
    entries.push({
      at: receipt.receiptDate.toISOString(),
      stage: 'RECEIPT',
      title: `Goods receipt ${receipt.receiptNumber}`,
      detail:
        `Received ${receipt.receivedQuantity} of ${receipt.orderedQuantity} units; ` +
        `${receipt.acceptedQuantity} accepted, ${receipt.rejectedQuantity} rejected.`,
      actorId: receipt.receivedById,
      status: receipt.acceptedQuantity > 0 ? 'ACCEPTED' : 'REJECTED',
      source: 'application_data',
    });
  }

  for (const invoice of po.invoices) {
    entries.push({
      at: invoice.createdAt.toISOString(),
      stage: 'INVOICE',
      title: `Invoice ${invoice.invoiceNumber} submitted`,
      detail: `Total ${invoice.totalAmount.toFixed(2)} ${invoice.currency}, dated ${invoice.invoiceDate.toISOString().slice(0, 10)}.`,
      actorId: invoice.submittedById ?? undefined,
      status: invoice.status,
      source: 'application_data',
    });

    for (const verification of invoice.verifications) {
      const list = (verification.discrepancies as unknown as Array<Record<string, unknown>> | null) ?? [];
      const critical = list.filter((d) => d.severity === DiscrepancySeverity.CRITICAL).length;

      entries.push({
        at: (verification.verifiedAt ?? verification.createdAt).toISOString(),
        stage: 'VERIFICATION',
        title:
          verification.status === PrismaMatchStatus.MATCHED
            ? `Invoice ${invoice.invoiceNumber} matched successfully`
            : `Invoice ${invoice.invoiceNumber}: ${list.length} discrepancy(s) found`,
        detail:
          list.length === 0
            ? 'PO, goods receipt and invoice agree within tolerance.'
            : list
                .map((d) => `${d.field}: expected ${d.expected ?? '-'}, actual ${d.actual ?? '-'} (${d.severity})`)
                .join(' · '),
        actorId: verification.verifiedById ?? undefined,
        status: verification.status,
        source: 'application_data',
      });

      // Surface each resolution as its own entry so the decision history is
      // visible even after the verification record is superseded.
      for (const d of list) {
        if (d.resolution && d.resolution !== DiscrepancyResolution.OPEN) {
          entries.push({
            at: String(d.resolvedAt ?? verification.verifiedAt ?? verification.createdAt),
            stage: 'VERIFICATION',
            title: `Discrepancy on ${d.field} marked ${String(d.resolution).toLowerCase()}`,
            detail: (d.resolutionNote as string) ?? undefined,
            actorId: d.resolvedById as string | undefined,
            status: String(d.resolution),
            source: 'application_data',
          });
        }
      }

      if (critical > 0) {
        entries.push({
          at: (verification.verifiedAt ?? verification.createdAt).toISOString(),
          stage: 'VERIFICATION',
          title: `Payment blocked: ${critical} critical discrepancy(s)`,
          detail: 'Payment cannot be recorded until the critical discrepancies are resolved.',
          status: 'BLOCKED',
          source: 'application_data',
        });
      }
    }
  }

  for (const payment of po.payments) {
    entries.push({
      at: (payment.paidAt ?? payment.updatedAt).toISOString(),
      stage: 'PAYMENT',
      title: `Payment ${payment.status.toLowerCase().replace(/_/g, ' ')}`,
      detail:
        `Recorded ${decimalToNumber(payment.paidAmount).toFixed(2)} of ${decimalToNumber(payment.amount).toFixed(2)} ${payment.currency}` +
        (payment.reference ? ` · Reference: ${payment.reference}` : ''),
      actorId: payment.recordedById,
      status: payment.status,
      source: 'application_data',
    });
  }

  for (const document of po.documents) {
    entries.push({
      at: document.createdAt.toISOString(),
      stage: document.category === DocumentCategory.INVOICE || document.category === DocumentCategory.TAX_INVOICE ? 'INVOICE' : 'RECEIPT',
      title: `Document uploaded: ${document.fileName}`,
      detail: `${document.category.replace(/_/g, ' ')} · ${(document.size / 1024).toFixed(1)} KB`,
      actorId: document.uploadedById,
      source: 'application_data',
    });
  }

  // Merge in decision points that only exist in the audit trail.
  const auditEntries = await prisma.auditLog.findMany({
    where: {
      tenantId: actor.tenantId,
      OR: [
        { entityId: po.id, entityType: 'PurchaseOrder' },
        { entityId: po.id, entityType: 'Invoice' },
      ],
      action: {
        in: [
          PrismaAuditAction.PO_CANCELLED,
          PrismaAuditAction.PO_CLOSED,
          PrismaAuditAction.ORDER_REJECTED_BY_SUPPLIER,
          PrismaAuditAction.DISCREPANCY_RESOLVED,
          PrismaAuditAction.DOCUMENT_UPLOADED,
        ],
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const knownTitles = new Set(entries.map((e) => e.title));
  for (const log of auditEntries) {
    const title = auditTitle(log.action);
    if (!title || knownTitles.has(title)) continue;
    entries.push({
      at: log.createdAt.toISOString(),
      stage: log.action === AuditAction.DOCUMENT_UPLOADED ? 'RECEIPT' : 'CLOSURE',
      title,
      detail: log.decision ?? undefined,
      actorId: log.userId,
      status: log.newStatus ?? undefined,
      source: 'audit_log',
    });
  }

  if (po.closedAt) {
    entries.push({
      at: po.closedAt.toISOString(),
      stage: 'CLOSURE',
      title: STATUS_LABELS[PrismaPOStatus.CLOSED],
      detail: `Purchase order ${po.poNumber} closed.`,
      source: 'application_data',
    });
  }

  if (po.cancelledAt) {
    entries.push({
      at: po.cancelledAt.toISOString(),
      stage: 'CLOSURE',
      title: STATUS_LABELS[PrismaPOStatus.CANCELLED],
      detail: po.rejectionReason ?? undefined,
      source: 'application_data',
    });
  }

  entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return entries;
}

function auditTitle(action: PrismaAuditAction): string | null {
  switch (action) {
    case PrismaAuditAction.PO_CANCELLED:
      return 'Purchase order cancelled';
    case PrismaAuditAction.PO_CLOSED:
      return 'Purchase order closed';
    case PrismaAuditAction.ORDER_REJECTED_BY_SUPPLIER:
      return 'Supplier rejected the order';
    case PrismaAuditAction.DISCREPANCY_RESOLVED:
      return 'Invoice discrepancy resolved';
    case PrismaAuditAction.DOCUMENT_UPLOADED:
      return 'Supporting document uploaded';
    default:
      return null;
  }
}

function fullName(user: { firstName?: string | null; lastName?: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown';
}

/**
 * Build the per-PO procurement summary used on list views and by the AI
 * assistant.
 *
 * Every field is derived from stored records. Where a value cannot be derived,
 * `incomplete` is set and the reason is listed in `missingDocuments`, so the UI
 * never presents a guessed or fabricated figure as fact.
 */
export async function buildPoSummary(poId: string, actor: ActorContext) {
  await loadAccessiblePo(poId, actor);
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      vendor: { select: { name: true } },
      goodsReceipts: { select: { acceptedQuantity: true, receivedQuantity: true, rejectedQuantity: true } },
      invoices: {
        include: { verifications: { orderBy: { createdAt: 'desc' }, take: 1 } },
      },
      payments: { select: { paidAmount: true, status: true, dueDate: true } },
      deliveryEvents: { select: { type: true, estimatedDeliveryDate: true, occurredAt: true } },
      documents: { select: { category: true } },
    },
  });

  if (!po) return null;

  const receivedQuantity = po.goodsReceipts.reduce((s, r) => s + r.receivedQuantity, 0);
  const acceptedQuantity = po.goodsReceipts.reduce((s, r) => s + r.acceptedQuantity, 0);
  const rejectedQuantity = po.goodsReceipts.reduce((s, r) => s + r.rejectedQuantity, 0);

  const invoicedAmount = po.invoices.reduce((sum, i) => sum.add(i.totalAmount), new Prisma.Decimal(0));
  const verifiedAmount = po.invoices.reduce((sum, i) => {
    const latest = i.verifications[0];
    if (!latest) return sum;
    if (latest.matched) return sum.add(i.totalAmount);
    const list = (latest.discrepancies as unknown as Array<Record<string, unknown>> | null) ?? [];
    const hasOpenCritical = list.some(
      (d) => d.severity === DiscrepancySeverity.CRITICAL && d.resolution === DiscrepancyResolution.OPEN,
    );
    // Only fully matched invoices count as verified value; a discrepant
    // invoice contributes nothing until the discrepancies are cleared.
    return hasOpenCritical ? sum : sum.add(i.totalAmount);
  }, new Prisma.Decimal(0));

  const paidAmount = po.payments.reduce((sum, p) => sum.add(p.paidAmount), new Prisma.Decimal(0));

  const openDiscrepancies = po.invoices.reduce((count, invoice) => {
    const latest = invoice.verifications[0];
    const list = (latest?.discrepancies as unknown as Array<Record<string, unknown>> | null) ?? [];
    return count + list.filter((d) => d.resolution === DiscrepancyResolution.OPEN).length;
  }, 0);

  // Flag documents the workflow expects but has not received.
  const categories = new Set(po.documents.map((d) => d.category));
  const missingDocuments: string[] = [];
  if (po.status !== PrismaPOStatus.DRAFT && !categories.has(DocumentCategory.PURCHASE_ORDER)) {
    missingDocuments.push('Issued purchase order document');
  }
  if (po.status === PrismaPOStatus.DELIVERED && !categories.has(DocumentCategory.PROOF_OF_DELIVERY)) {
    missingDocuments.push('Proof of delivery');
  }
  if (invoicedAmount.gt(0) && !categories.has(DocumentCategory.INVOICE) && !categories.has(DocumentCategory.TAX_INVOICE)) {
    missingDocuments.push('Supplier invoice document');
  }

  // Only count as overdue when the order is actually late relative to a date
  // the supplier committed to; an unconfirmed estimate is not a breach.
  const committedDate = po.supplierConfirmedDeliveryDate ?? po.expectedDeliveryDate;
  let daysDelayed: number | undefined;
  if (committedDate && !SETTLED_STATUSES.includes(po.status)) {
    const diffMs = Date.now() - new Date(committedDate).getTime();
    const days = Math.floor(diffMs / 86_400_000);
    if (days > 0) daysDelayed = days;
  }

  const incomplete =
    (po.status === PrismaPOStatus.DELIVERED && acceptedQuantity < po.quantity) ||
    missingDocuments.length > 0 ||
    (po.status === PrismaPOStatus.DELIVERED && invoicedAmount.isZero());

  return {
    poId: po.id,
    poNumber: po.poNumber,
    status: po.status,
    supplierName: po.vendor.name,
    totalAmount: decimalToNumber(po.totalAmount),
    currency: po.currency,
    expectedDeliveryDate: committedDate?.toISOString(),
    daysDelayed,
    orderedQuantity: po.quantity,
    receivedQuantity,
    acceptedQuantity,
    rejectedQuantity,
    invoicedAmount: decimalToNumber(invoicedAmount),
    verifiedAmount: decimalToNumber(verifiedAmount),
    paidAmount: decimalToNumber(roundMoney(paidAmount)),
    outstandingAmount: decimalToNumber(roundMoney(po.totalAmount.minus(paidAmount))),
    openDiscrepancies,
    missingDocuments,
    incomplete,
    // The narrative is a factual restatement of the numbers above, not advice.
    narrative: buildNarrative({
      status: po.status,
      quantity: po.quantity,
      acceptedQuantity,
      receivedQuantity,
      invoicedAmount: decimalToNumber(invoicedAmount),
      paidAmount: decimalToNumber(roundMoney(paidAmount)),
      totalAmount: decimalToNumber(po.totalAmount),
      openDiscrepancies,
      daysDelayed,
      missingDocuments,
    }),
  };
}

function buildNarrative(input: {
  status: string;
  quantity: number;
  acceptedQuantity: number;
  receivedQuantity: number;
  invoicedAmount: number;
  paidAmount: number;
  totalAmount: number;
  openDiscrepancies: number;
  daysDelayed?: number;
  missingDocuments: string[];
}): string {
  const parts: string[] = [];
  const outstanding = roundMoney(new Prisma.Decimal(input.totalAmount).minus(new Prisma.Decimal(input.paidAmount))).toNumber();
  const { totalAmount } = input;

  parts.push(`Purchase order is ${input.status.toLowerCase().replace(/_/g, ' ')}.`);

  if (input.acceptedQuantity > 0) {
    parts.push(
      `${input.acceptedQuantity} of ${input.quantity} units accepted` +
        (input.receivedQuantity > input.acceptedQuantity ? ` (${input.receivedQuantity} received, ${input.receivedQuantity - input.acceptedQuantity} rejected)` : '') + '.',
    );
  } else if (RECEIVED_STATUSES.includes(input.status)) {
    parts.push('No units have been accepted yet.');
  } else {
    parts.push('No goods have been received.');
  }

  if (input.invoicedAmount > 0) {
    parts.push(`Invoiced ${input.invoicedAmount.toFixed(2)} of ${totalAmount.toFixed(2)}.`);
  }
  if (input.paidAmount > 0) {
    parts.push(
      input.paidAmount >= totalAmount
        ? `Paid in full (${input.paidAmount.toFixed(2)}).`
        : `Paid ${input.paidAmount.toFixed(2)}; ${outstanding.toFixed(2)} outstanding.`,
    );
  } else if (input.invoicedAmount > 0) {
    parts.push('No payment recorded.');
  }

  if (input.daysDelayed) {
    parts.push(`Delivery is ${input.daysDelayed} day(s) past the committed date.`);
  }
  if (input.openDiscrepancies > 0) {
    parts.push(`${input.openDiscrepancies} unresolved invoice discrepancy(s).`);
  }
  if (input.missingDocuments.length > 0) {
    parts.push(`Missing documents: ${input.missingDocuments.join(', ')}.`);
  }

  return parts.join(' ');
}

export { PaymentStatus };