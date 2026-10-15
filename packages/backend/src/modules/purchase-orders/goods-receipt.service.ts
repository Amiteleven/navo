import { Prisma } from '@prisma/client';
import { AuditAction, DeliveryEventType, PurchaseOrderStatus, UserRole } from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { nextDocumentNumber } from '../../utils/documentNumber.js';
import { decimalToNumber, roundMoney } from '../../utils/money.js';
import { createAuditLog } from '../audit/audit.service.js';
import { ActorContext, loadAccessiblePo } from './po-access.js';
import { recordDeliveryEventInternal } from './purchase-order.service.js';

export interface RecordReceiptInput {
  receivedQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity?: number;
  receiptDate?: string;
  conditionNotes?: string;
  discrepancies?: Record<string, unknown>[];
  documentIds?: string[];
}

/**
 * Record a goods receipt against a PO.
 *
 * Quantity validation is entirely server-side and is the core correctness
 * guarantee of this module:
 *
 *  - received must equal accepted + rejected (nothing may go missing);
 *  - accepted must never exceed what was ordered;
 *  - the cumulative accepted quantity across all receipts may never exceed the
 *    ordered quantity, which makes over-receipt impossible even under
 *    concurrent submissions;
 *  - rejected quantities are tracked but do not advance the order, so a PO is
 *    only marked DELIVERED once the full ordered quantity has been accepted.
 *
 * All checks and the receipt write run in one serializable transaction with a
 * row lock on the PO, so two concurrent receipts cannot both pass the
 * cumulative check and together over-receive.
 */
export async function recordGoodsReceipt(poId: string, actor: ActorContext, input: RecordReceiptInput) {
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Goods receipts are recorded by the buyer, not the supplier');
  }

  const po = await loadAccessiblePo(poId, actor);

  // String-typed so Prisma enum members read from the database compare directly.
  const RECEIVABLE_STATUSES: string[] = [
    PurchaseOrderStatus.DRAFT,
    PurchaseOrderStatus.PENDING_APPROVAL,
    PurchaseOrderStatus.CANCELLED,
  ];

  if (RECEIVABLE_STATUSES.includes(po.status)) {
    throw new ConflictError(`Cannot receive goods against a purchase order in status ${po.status}`);
  }

  const received = Number(input.receivedQuantity);
  const accepted = Number(input.acceptedQuantity);
  const rejected = Number(input.rejectedQuantity ?? 0);

  if (!Number.isInteger(received) || received <= 0) {
    throw new ValidationError('receivedQuantity must be a positive whole number');
  }
  if (!Number.isInteger(accepted) || accepted < 0) {
    throw new ValidationError('acceptedQuantity must be zero or a positive whole number');
  }
  if (!Number.isInteger(rejected) || rejected < 0) {
    throw new ValidationError('rejectedQuantity must be zero or a positive whole number');
  }
  if (accepted > received) {
    throw new ValidationError('acceptedQuantity cannot exceed receivedQuantity');
  }
  if (accepted + rejected !== received) {
    throw new ValidationError(
      `acceptedQuantity (${accepted}) + rejectedQuantity (${rejected}) must equal receivedQuantity (${received})`,
    );
  }

  let receiptDate = new Date();
  if (input.receiptDate) {
    const parsed = new Date(input.receiptDate);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError('receiptDate is not a valid date');
    }
    receiptDate = parsed;
  }

  const receipt = await prisma.$transaction(
    async (tx) => {
      // Lock the PO row so cumulative accepted totals cannot interleave.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "PurchaseOrder" WHERE id = ${poId} FOR UPDATE
      `;
      if (locked.length === 0) throw new NotFoundError('Purchase Order');

      const existingReceipts = await tx.goodsReceipt.findMany({
        where: { poId },
        select: { acceptedQuantity: true, receivedQuantity: true },
      });
      const previouslyAccepted = existingReceipts.reduce((sum, r) => sum + r.acceptedQuantity, 0);
      const previouslyReceived = existingReceipts.reduce((sum, r) => sum + r.receivedQuantity, 0);

      if (accepted > po.quantity - previouslyAccepted) {
        throw new ConflictError(
          `Cannot accept ${accepted} unit(s): only ${po.quantity - previouslyAccepted} of ${po.quantity} remain to be accepted`,
        );
      }

      const receiptNumber = await nextDocumentNumber('GR', actor.tenantId, receiptDate);

      const created = await tx.goodsReceipt.create({
        data: {
          receiptNumber,
          poId,
          orderedQuantity: po.quantity,
          receivedQuantity: received,
          acceptedQuantity: accepted,
          rejectedQuantity: rejected,
          receiptDate,
          receivedById: actor.userId,
          conditionNotes: input.conditionNotes ?? null,
          discrepancies: (input.discrepancies ?? []) as Prisma.InputJsonValue,
          documentIds: input.documentIds ?? [],
          tenantId: actor.tenantId,
        },
      });

      const totalAccepted = previouslyAccepted + accepted;
      const totalReceived = previouslyReceived + received;

      // DELIVERED only when the entire ordered quantity is accepted. A part
      // receipt yields PARTIALLY_DELIVERED even if every unit sent was good.
      const nextStatus =
        totalAccepted >= po.quantity
          ? PurchaseOrderStatus.DELIVERED
          : PurchaseOrderStatus.PARTIALLY_DELIVERED;

      await tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          status: nextStatus,
          actualDeliveryDate: receiptDate,
        },
      });

      return { created, nextStatus, totalAccepted, totalReceived, remaining: po.quantity - totalAccepted };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  await recordDeliveryEventInternal({
    poId,
    type:
      receipt.nextStatus === PurchaseOrderStatus.DELIVERED
        ? DeliveryEventType.DELIVERED
        : DeliveryEventType.PARTIALLY_DELIVERED,
    actorId: actor.userId,
    tenantId: actor.tenantId,
    notes:
      input.conditionNotes ??
      `Received ${receipt.created.receivedQuantity} of ${po.quantity} units; ${receipt.created.acceptedQuantity} accepted.`,
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.GOODS_RECEIVED,
    entityType: 'GoodsReceipt',
    entityId: receipt.created.id,
    tenantId: actor.tenantId,
    metadata: {
      poId,
      poNumber: po.poNumber,
      receiptNumber: receipt.created.receiptNumber,
      orderedQuantity: po.quantity,
      receivedQuantity: received,
      acceptedQuantity: accepted,
      rejectedQuantity: rejected,
      cumulativeAccepted: receipt.totalAccepted,
      remainingQuantity: receipt.remaining,
      nextStatus: receipt.nextStatus,
    },
  });

  return {
    ...receipt.created,
    remainingQuantity: receipt.remaining,
    cumulativeAccepted: receipt.totalAccepted,
    poStatus: receipt.nextStatus,
  };
}

export async function listGoodsReceipts(poId: string, actor: ActorContext) {
  const po = await loadAccessiblePo(poId, actor);
  const receipts = await prisma.goodsReceipt.findMany({
    where: { poId: po.id },
    orderBy: { receiptDate: 'asc' },
    include: {
      receivedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });
  return receipts;
}

/**
 * Authorized wrapper for the receipt totals, used by the PO detail view.
 * Loads the PO first so the caller cannot read receipt aggregates for an order
 * they have no access to.
 */
export async function getGoodsReceiptTotals(poId: string, actor: ActorContext) {
  const po = await loadAccessiblePo(poId, actor);
  const totals = await getReceiptTotals(poId, po.quantity);
  return { ...totals, orderedQuantity: po.quantity };
}

/** Aggregate receipt totals used by the PO detail view and three-way match. */
export interface ReceiptTotals {
  receivedQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  remainingQuantity: number;
  fullyReceived: boolean;
}

export async function getReceiptTotals(
  poId: string,
  orderedQuantity: number,
): Promise<ReceiptTotals> {
  const receipts = await prisma.goodsReceipt.findMany({
    where: { poId },
    select: { receivedQuantity: true, acceptedQuantity: true, rejectedQuantity: true },
  });

  const receivedQuantity = receipts.reduce((s, r) => s + r.receivedQuantity, 0);
  const acceptedQuantity = receipts.reduce((s, r) => s + r.acceptedQuantity, 0);
  const rejectedQuantity = receipts.reduce((s, r) => s + r.rejectedQuantity, 0);

  return {
    receivedQuantity,
    acceptedQuantity,
    rejectedQuantity,
    remainingQuantity: Math.max(0, orderedQuantity - acceptedQuantity),
    fullyReceived: acceptedQuantity >= orderedQuantity,
  };
}

/**
 * Value actually accepted to date, used to scale invoice matching for
 * partial deliveries.
 */
export async function getAcceptedValue(poId: string): Promise<Prisma.Decimal> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: { quantity: true, unitPrice: true, taxRate: true, freightAmount: true, installationAmount: true, otherCharges: true },
  });
  if (!po) throw new NotFoundError('Purchase Order');

  const totals = await getReceiptTotals(poId, po.quantity);
  // Only the proportional goods value scales with partial receipt. Freight,
  // installation and other charges are not prorated: they are either incurred
  // in full on delivery or not at all, and prorating them would let an invoice
  // pass matching while under-claiming delivery-linked charges.
  const goodsValue = roundMoney(new Prisma.Decimal(po.unitPrice).times(totals.acceptedQuantity));
  const tax = roundMoney(goodsValue.times(po.taxRate).dividedBy(100));
  const nonGoods =
    totals.fullyReceived
      ? new Prisma.Decimal(po.freightAmount)
          .plus(po.installationAmount)
          .plus(po.otherCharges)
      : new Prisma.Decimal(0);

  return roundMoney(goodsValue.plus(tax).plus(nonGoods));
}

export function acceptedValueToNumber(value: Prisma.Decimal): number {
  return decimalToNumber(value);
}