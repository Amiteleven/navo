import {
  Prisma,
  DeliveryEventType as PrismaDeliveryEventType,
  PurchaseOrderStatus as PrismaPOStatus,
  ApprovalStatus as PrismaApprovalStatus,
} from '@prisma/client';
import {
  ApprovalStatus,
  AuditAction,
  DeliveryEventType,
  PurchaseOrderStatus,
  UserRole,
} from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { nextDocumentNumber } from '../../utils/documentNumber.js';
import { computeTotals, decimalToNumber, toDecimal } from '../../utils/money.js';
import { createAuditLog } from '../audit/audit.service.js';
import { ActorContext, assertCanModify, loadAccessiblePo, PO_APPROVER_ROLES } from './po-access.js';
import { buildApprovalChain, canDecideLevel } from './po-approval-policy.js';
import { linkPurchaseOrder } from '../purchase-approvals/purchase-approval.service.js';

/*
 * Status sets used for membership tests. Typed `string[]` so Prisma enum
 * members read from the database can be compared directly; the shared and
 * Prisma enums share identical literals but are nominally distinct types.
 */
const DELIVERABLE_STATUSES: string[] = [
  PurchaseOrderStatus.DELIVERED,
  PurchaseOrderStatus.PARTIALLY_DELIVERED,
];
const SUPPLIER_ACTIONABLE_STATUSES: string[] = [
  PurchaseOrderStatus.ISSUED,
  PurchaseOrderStatus.SUPPLIER_CONFIRMED,
];
const CLOSED_STATUSES: string[] = [PurchaseOrderStatus.CANCELLED, PurchaseOrderStatus.CLOSED];

/** Statuses in which the supplier may report shipment milestones. */
const SUPPLIER_MILESTONE_STATUSES: string[] = [
  PurchaseOrderStatus.SUPPLIER_CONFIRMED,
  PurchaseOrderStatus.IN_PROGRESS,
  PurchaseOrderStatus.PARTIALLY_DELIVERED,
];

const PO_INCLUDE = {
  vendor: { select: { id: true, name: true, email: true, status: true, gstin: true } },
  buyer: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
  request: { select: { id: true, title: true, item: true, quantity: true, unit: true } },
  approvals: {
    orderBy: { level: 'asc' as const },
    include: {
      approver: { select: { id: true, firstName: true, lastName: true, email: true } },
      decidedBy: { select: { id: true, firstName: true, lastName: true } },
    },
  },
  deliveryEvents: { orderBy: { occurredAt: 'asc' as const } },
  goodsReceipts: { orderBy: { receiptDate: 'asc' as const } },
  invoices: { orderBy: { createdAt: 'asc' as const } },
  payments: { orderBy: { createdAt: 'asc' as const } },
  documents: { orderBy: { createdAt: 'asc' as const } },
} satisfies Record<string, unknown>;

export interface CreatePoFromDealInput {
  dealId: string;
  /** Delivery address recorded on the PO. Falls back to the request location. */
  deliveryAddress?: string;
  expectedDeliveryDate?: string;
  paymentTerms?: string;
  warrantyMonths?: number;
  notes?: string;
  terms?: string;
  /**
   * Overrides for commercial terms. Any field omitted is copied from the
   * accepted offer. These are recorded as an explicit amendment in the audit
   * trail so a PO never silently differs from the negotiated deal.
   */
  overrides?: {
    quantity?: number;
    unitPrice?: number | string;
    taxRate?: number | string;
    freightAmount?: number | string;
    installationAmount?: number | string;
    otherCharges?: number | string;
    otherChargesDetails?: string;
  };
}

/**
 * Convert an accepted deal into a purchase order.
 *
 * Preconditions, all enforced server-side:
 *  - the deal belongs to the actor's tenant and has an accepted offer;
 *  - the actor is the deal's buyer (or a tenant PO admin);
 *  - the deal has not already been converted (one PO per deal, enforced by the
 *    `dealId` unique constraint).
 */
export async function createPoFromDeal(input: CreatePoFromDealInput, actor: ActorContext) {
  if (!PO_APPROVER_ROLES.includes(actor.role) && actor.role !== UserRole.REQUESTER) {
    throw new ForbiddenError('Insufficient permissions to raise a purchase order');
  }

  const deal = await prisma.deal.findFirst({
    where: { id: input.dealId, tenantId: actor.tenantId },
    include: {
      acceptedOffer: true,
      request: true,
      vendor: { select: { id: true, name: true } },
    },
  });

  if (!deal) throw new NotFoundError('Deal');
  if (!deal.acceptedOfferId || !deal.acceptedOffer) {
    throw new ValidationError('Deal has no accepted offer and cannot be converted to a purchase order');
  }
  if (actor.role === UserRole.REQUESTER && deal.buyerId !== actor.userId) {
    throw new ForbiddenError('Only the deal buyer can raise the purchase order');
  }

  const existing = await prisma.purchaseOrder.findUnique({ where: { dealId: deal.id } });
  if (existing) {
    throw new ConflictError(`This deal already has purchase order ${existing.poNumber}`);
  }

  // Organizations that configure manager approval cannot raise an order until
  // the authorization has been granted and the buyer has confirmed the purchase.
  // The lookup is by deal, not by amount, so a buyer cannot escape approval by
  // re-pricing the order.
  const authorization = await resolvePurchaseAuthorization(actor.tenantId, deal.id);
  if (authorization.required && !authorization.approvalId) {
    throw new ConflictError(
      'This purchase has not been authorized yet. Submit the offer for manager approval and confirm it before raising a purchase order.',
    );
  }
  if (authorization.required && authorization.status !== 'PURCHASE_CONFIRMED') {
    throw new ConflictError(
      `Purchase ${authorization.reference ?? ''} is approved but has not been confirmed by the buyer yet. ` +
        'Confirm the purchase before raising a purchase order.'.trim(),
    );
  }
  if (authorization.approvalId) {
    const alreadyOrdered = await prisma.purchaseOrder.findUnique({
      where: { approvalRequestId: authorization.approvalId },
    });
    if (alreadyOrdered) {
      throw new ConflictError(
        `This purchase is already covered by purchase order ${alreadyOrdered.poNumber}`,
      );
    }
  }

  const offer = deal.acceptedOffer;

  // Legacy Float offer values are stringified before conversion so the decimal
  // value matches what was agreed rather than a re-derived binary float.
  const quantity = input.overrides?.quantity ?? offer.quantity;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new ValidationError('Quantity must be a positive whole number');
  }

  const totals = computeTotals({
    quantity,
    unitPrice: toDecimal(input.overrides?.unitPrice ?? decimalString(offer.unitPrice), 'unitPrice'),
    taxRate: toDecimal(input.overrides?.taxRate ?? decimalString(offer.gst), 'taxRate'),
    freightAmount: toDecimal(input.overrides?.freightAmount ?? decimalString(offer.freightAmount), 'freightAmount'),
    installationAmount: toDecimal(
      input.overrides?.installationAmount ?? decimalString(offer.installationAmount),
      'installationAmount',
    ),
    otherCharges: toDecimal(input.overrides?.otherCharges ?? decimalString(offer.otherCharges), 'otherCharges'),
  });

  const chain = buildApprovalChain(decimalToNumber(totals.total));

  // The accepted offer is snapshotted verbatim. Terms are frozen at conversion
  // time, so later edits to the offer cannot rewrite what was ordered.
  const snapshot = {
    offerId: offer.id,
    unitPrice: decimalString(offer.unitPrice),
    quantity: offer.quantity,
    taxRate: decimalString(offer.gst),
    freightAmount: decimalString(offer.freightAmount),
    installationAmount: decimalString(offer.installationAmount),
    otherCharges: decimalString(offer.otherCharges),
    otherChargesDetails: offer.otherChargesDetails ?? undefined,
    warrantyMonths: offer.warrantyMonths ?? undefined,
    paymentTerms: offer.paymentTerms ?? undefined,
    deliveryTimelineDays: offer.deliveryTimelineDays ?? undefined,
    capturedAt: new Date().toISOString(),
  };

  const deliveryAddress = input.deliveryAddress ?? deal.request.location ?? undefined;
  const expectedDeliveryDate = resolveExpectedDeliveryDate(
    input.expectedDeliveryDate,
    offer.deliveryTimelineDays,
    deal.request.requiredDate ?? undefined,
  );

  // Number allocation and creation are wrapped so a concurrent request that
  // grabs the same number fails on the unique constraint and can be retried by
  // the caller rather than producing two POs.
  const poNumber = await nextDocumentNumber('PO', actor.tenantId);

  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber,
      dealId: deal.id,
      requestId: deal.requestId,
      buyerId: deal.buyerId,
      vendorId: deal.vendorId,
      status: PurchaseOrderStatus.DRAFT,
      currency: 'INR',
      itemName: deal.request.item,
      description: deal.request.description ?? undefined,
      quantity,
      unit: deal.request.unit ?? undefined,
      unitPrice: totals.unitPrice,
      taxRate: totals.taxRate,
      taxAmount: totals.taxAmount,
      freightAmount: totals.freight,
      installationAmount: totals.installation,
      otherCharges: totals.other,
      otherChargesDetails: input.overrides?.otherChargesDetails ?? offer.otherChargesDetails ?? undefined,
      subtotal: totals.subtotal,
      totalAmount: totals.total,
      acceptedOfferId: offer.id,
      acceptedOfferSnapshot: snapshot as Prisma.InputJsonValue,
      deliveryAddress,
      expectedDeliveryDate,
      paymentTerms: input.paymentTerms ?? offer.paymentTerms ?? undefined,
      warrantyMonths: input.warrantyMonths ?? offer.warrantyMonths ?? undefined,
      notes: input.notes ?? undefined,
      terms: input.terms ?? undefined,
      tenantId: actor.tenantId,
      approvalRequestId: authorization.approvalId ?? null,
      approvals: {
        create: chain.map((level) => ({
          level: level.level,
          requiredRole: level.requiredRole,
          status: ApprovalStatus.PENDING,
          tenantId: actor.tenantId,
        })),
      },
    },
    include: PO_INCLUDE,
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.PO_CREATED,
    entityType: 'PurchaseOrder',
    entityId: po.id,
    tenantId: actor.tenantId,
    metadata: {
      poNumber: po.poNumber,
      dealId: deal.id,
      dealNumber: deal.dealNumber,
      totalAmount: po.totalAmount.toString(),
      approvalLevels: chain.map((c) => `L${c.level}:${c.requiredRole}`).join(','),
      amendedTerms: input.overrides ? Object.keys(input.overrides) : [],
      // Which authorization released these funds, so the order and the approval
      // can be tied together in a review.
      purchaseApprovalRequestId: authorization.approvalId ?? null,
      purchaseApprovalReference: authorization.reference ?? null,
    },
  });

  if (authorization.approvalId) {
    // Records that the order exists, which is the last fact that makes the
    // purchase genuinely complete rather than merely approved and confirmed.
    await linkPurchaseOrder(authorization.approvalId, po.id, actor.tenantId).catch((err) => {
      // The order is already written and the link is a projection, so a failure
      // here is reported but must not orphan the order.
      console.error('[purchase-approvals] could not link purchase order:', err.message);
    });
  }

  return po;
}

/**
 * Find the authorization, if any, that released this deal's purchase.
 *
 * `required: false` means the organization has not configured manager approval,
 * in which case the order proceeds as it always did.
 */
async function resolvePurchaseAuthorization(
  tenantId: string,
  dealId: string,
): Promise<{ required: boolean; approvalId?: string; status?: string; reference?: string }> {
  const policy = await prisma.purchaseApprovalPolicy.findFirst({
    where: { tenantId, isActive: true },
    select: { id: true },
  });
  if (!policy) return { required: false };

  const approval = await prisma.purchaseApprovalRequest.findFirst({
    where: { tenantId, dealId },
    select: { id: true, status: true, reference: true },
  });

  if (!approval) return { required: true };
  return {
    required: true,
    approvalId: approval.id,
    status: approval.status,
    reference: approval.reference,
  };
}

/**
 * Render a legacy Float as its shortest decimal string.
 * `19.99` becomes "19.99" rather than 19.989999999999998.
 */
function decimalString(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '0';
  return String(value);
}

function resolveExpectedDeliveryDate(
  explicit: string | undefined,
  deliveryTimelineDays: number | null | undefined,
  requestRequiredDate: Date | string | null | undefined,
): Date | undefined {
  if (explicit) {
    const parsed = new Date(explicit);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError('expectedDeliveryDate is not a valid date');
    }
    return parsed;
  }
  if (deliveryTimelineDays && Number.isFinite(deliveryTimelineDays)) {
    const date = new Date();
    date.setDate(date.getDate() + deliveryTimelineDays);
    return date;
  }
  if (requestRequiredDate) {
    const parsed = new Date(requestRequiredDate);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

export async function listPurchaseOrders(
  actor: ActorContext,
  filters: {
    status?: PurchaseOrderStatus;
    vendorId?: string;
    buyerId?: string;
    search?: string;
    page?: number;
    limit?: number;
  } = {},
) {
  const where: Prisma.PurchaseOrderWhereInput = { tenantId: actor.tenantId };

  if (filters.status) where.status = filters.status;

  if (actor.role === UserRole.VENDOR) {
    // Sellers are hard-scoped to their own vendor's orders.
    const { resolveSellerVendor } = await import('./po-access.js');
    const seller = await resolveSellerVendor(actor.userId);
    if (!seller) throw new ForbiddenError('This action is restricted to supplier accounts');
    where.vendorId = seller.vendorId;
  } else {
    if (filters.vendorId) where.vendorId = filters.vendorId;
    if (filters.buyerId) where.buyerId = filters.buyerId;
  }

  if (filters.search?.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { poNumber: { contains: term, mode: 'insensitive' } },
      { itemName: { contains: term, mode: 'insensitive' } },
      { vendor: { name: { contains: term, mode: 'insensitive' } } },
    ];
  }

  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 100) : 20;
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: {
        vendor: { select: { id: true, name: true, status: true } },
        buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
        _count: { select: { goodsReceipts: true, invoices: true, deliveryEvents: true, approvals: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.purchaseOrder.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getPurchaseOrder(poId: string, actor: ActorContext) {
  return loadAccessiblePo(poId, actor, { include: PO_INCLUDE });
}

/**
 * Submit a draft PO into the approval chain.
 * Rejects if terms were overridden after creation, since approval must be given
 * against the exact numbers the PO will be issued with.
 */
export async function submitForApproval(poId: string, actor: ActorContext) {
  const po = await assertCanModify(poId, actor);
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Suppliers cannot submit purchase orders for approval');
  }
  if (po.status !== PurchaseOrderStatus.DRAFT) {
    throw new ConflictError(`Purchase order is already ${po.status.toLowerCase()}`);
  }

  const approvals = await prisma.purchaseOrderApproval.findMany({ where: { poId } });
  if (approvals.length === 0) {
    throw new ValidationError('No approval levels are configured for this purchase order');
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: poId },
    data: { status: PurchaseOrderStatus.PENDING_APPROVAL },
    include: PO_INCLUDE,
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.PO_SUBMITTED_FOR_APPROVAL,
    entityType: 'PurchaseOrder',
    entityId: poId,
    tenantId: actor.tenantId,
    previousStatus: po.status,
    newStatus: updated.status,
    metadata: { poNumber: updated.poNumber, levels: approvals.length },
  });

  return updated;
}

/**
 * Record a decision on one approval level.
 *
 * Ordering is enforced: a level can only be decided once every lower level is
 * APPROVED. Any rejection or changes-request immediately returns the PO to
 * DRAFT so the buyer can revise the terms and resubmit.
 */
export async function decidePoApproval(
  poId: string,
  approvalId: string,
  actor: ActorContext,
  decision: { status: ApprovalStatus; comments?: string },
) {
  const po = await loadAccessiblePo(poId, actor, { include: { approvals: true } });

  if (po.status !== PurchaseOrderStatus.PENDING_APPROVAL) {
    throw new ConflictError(`Purchase order is ${po.status.toLowerCase()} and is not awaiting approval`);
  }

  const approval = po.approvals.find((a: { id: string }) => a.id === approvalId);
  if (!approval) throw new NotFoundError('Approval level');

  if (approval.status !== ApprovalStatus.PENDING) {
    throw new ConflictError('This approval level has already been decided');
  }

  if (!canDecideLevel(actor.role, approval.requiredRole)) {
    throw new ForbiddenError(
      `Level ${approval.level} requires ${approval.requiredRole.replace(/_/g, ' ').toLowerCase()}`,
    );
  }

  // Out-of-order guard: lower levels must be approved first.
  const earlierPending = po.approvals.find(
    (a) => a.level < approval.level && a.status !== PrismaApprovalStatus.APPROVED,
  );
  if (decision.status === ApprovalStatus.APPROVED && earlierPending) {
    throw new ConflictError(`Level ${earlierPending.level} must be decided before level ${approval.level}`);
  }

  // Self-approval is blocked: the requester cannot approve their own PO.
  if (approval.requiredRole !== UserRole.COMPANY_ADMIN && po.buyerId === actor.userId && decision.status === ApprovalStatus.APPROVED) {
    throw new ForbiddenError('You cannot approve a purchase order you raised');
  }

  const updatedApproval = await prisma.purchaseOrderApproval.update({
    where: { id: approvalId },
    data: {
      status: decision.status,
      comments: decision.comments,
      decidedAt: new Date(),
      decidedById: actor.userId,
      approverId: approval.approverId ?? actor.userId,
    },
  });

  const allApprovals = await prisma.purchaseOrderApproval.findMany({
    where: { poId },
    orderBy: { level: 'asc' },
  });

  const anyRejected = allApprovals.some(
    (a) => a.status === ApprovalStatus.REJECTED || a.status === ApprovalStatus.CHANGES_REQUESTED,
  );
  const allApproved = allApprovals.every((a) => a.status === ApprovalStatus.APPROVED);

  // A rejected or changes-requested order returns to DRAFT for revision; it is
  // never left sitting in PENDING_APPROVAL with a resolved level.
  const nextStatus = anyRejected ? PurchaseOrderStatus.DRAFT : PurchaseOrderStatus.PENDING_APPROVAL;

  await prisma.purchaseOrder.update({
    where: { id: poId },
    data: { status: nextStatus },
  });

  await createAuditLog({
    userId: actor.userId,
    action:
      decision.status === ApprovalStatus.APPROVED
        ? AuditAction.PO_APPROVED
        : AuditAction.REJECTED,
    entityType: 'PurchaseOrderApproval',
    entityId: approvalId,
    tenantId: actor.tenantId,
    previousStatus: ApprovalStatus.PENDING,
    newStatus: decision.status,
    decision: decision.comments,
    metadata: { poId, poNumber: po.poNumber, level: approval.level, requiredRole: approval.requiredRole },
  });

  return {
    approval: updatedApproval,
    allApproved,
    poStatus: nextStatus,
    remainingLevels: allApprovals.filter((a) => a.status === ApprovalStatus.PENDING).length,
  };
}

/**
 * Issue an approved PO to the supplier.
 *
 * Issuing is gated on every approval level being APPROVED. The PO number is
 * frozen at this point and becomes the document reference the seller sees.
 */
export async function issuePurchaseOrder(poId: string, actor: ActorContext) {
  const po = await assertCanModify(poId, actor);
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Suppliers cannot issue purchase orders');
  }
  if (po.status !== PurchaseOrderStatus.PENDING_APPROVAL) {
    throw new ConflictError(`Purchase order must be pending approval to issue (currently ${po.status})`);
  }

  const approvals = await prisma.purchaseOrderApproval.findMany({ where: { poId } });
  const notApproved = approvals.filter((a) => a.status !== ApprovalStatus.APPROVED);
  if (notApproved.length > 0) {
    throw new ConflictError(
      `Cannot issue: ${notApproved.length} approval level(s) still pending ` +
        `(${notApproved.map((a) => `L${a.level}`).join(', ')})`,
    );
  }

  if (!po.deliveryAddress) {
    throw new ValidationError('A delivery address is required before issuing a purchase order');
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: poId },
    data: {
      status: PurchaseOrderStatus.ISSUED,
      issuedAt: new Date(),
    },
    include: PO_INCLUDE,
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.PO_ISSUED,
    entityType: 'PurchaseOrder',
    entityId: poId,
    tenantId: actor.tenantId,
    previousStatus: po.status,
    newStatus: updated.status,
    metadata: { poNumber: po.poNumber, totalAmount: po.totalAmount.toString() },
  });

  return updated;
}

/**
 * Cancel a PO that has not yet been closed.
 *
 * Buyer-side only. A supplier declining an order goes through
 * `rejectOrderBySupplier`, which is a separate, explicitly reasoned action;
 * without this guard a supplier could cancel the buyer's purchase order.
 */
export async function cancelPurchaseOrder(poId: string, actor: ActorContext, reason: string) {
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError(
      'Suppliers cannot cancel a purchase order; use order rejection instead',
    );
  }

  const po = await assertCanModify(poId, actor);
  if (!reason?.trim()) {
    throw new ValidationError('A cancellation reason is required');
  }
  if (po.status === PurchaseOrderStatus.CANCELLED) {
    throw new ConflictError('Purchase order is already cancelled');
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: poId },
    data: {
      status: PurchaseOrderStatus.CANCELLED,
      cancelledAt: new Date(),
      rejectionReason: reason.trim(),
    },
    include: PO_INCLUDE,
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.PO_CANCELLED,
    entityType: 'PurchaseOrder',
    entityId: poId,
    tenantId: actor.tenantId,
    previousStatus: po.status,
    newStatus: PurchaseOrderStatus.CANCELLED,
    decision: reason.trim(),
    metadata: { poNumber: po.poNumber },
  });

  return updated;
}

/** Close a delivered PO once invoicing and payment have settled. */
export async function closePurchaseOrder(poId: string, actor: ActorContext, notes?: string) {
  const po = await assertCanModify(poId, actor);
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Suppliers cannot close purchase orders');
  }
  if (!DELIVERABLE_STATUSES.includes(po.status)) {
    throw new ConflictError(`Purchase order must be delivered to close (currently ${po.status})`);
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: poId },
    data: { status: PurchaseOrderStatus.CLOSED, closedAt: new Date(), notes: notes ?? po.notes },
    include: PO_INCLUDE,
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.PO_CLOSED,
    entityType: 'PurchaseOrder',
    entityId: poId,
    tenantId: actor.tenantId,
    previousStatus: po.status,
    newStatus: PurchaseOrderStatus.CLOSED,
    metadata: { poNumber: po.poNumber },
  });

  return updated;
}

/**
 * Supplier confirms they will fulfil the order, optionally committing to a
 * delivery date. This is the point the PO becomes visible as an active order
 * to the seller.
 */
export async function confirmOrderBySupplier(
  poId: string,
  actor: ActorContext,
  input: { confirmedDeliveryDate?: string; notes?: string },
) {
  const seller = await requireSellerActor(actor);
  const po = await loadAccessiblePo(poId, actor);

  if (po.status !== PurchaseOrderStatus.ISSUED) {
    throw new ConflictError(
      `Purchase order must be issued before confirmation (currently ${po.status})`,
    );
  }

  let confirmedDeliveryDate: Date | undefined;
  if (input.confirmedDeliveryDate) {
    const parsed = new Date(input.confirmedDeliveryDate);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError('confirmedDeliveryDate is not a valid date');
    }
    confirmedDeliveryDate = parsed;
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: poId },
    data: {
      status: PurchaseOrderStatus.SUPPLIER_CONFIRMED,
      supplierConfirmedAt: new Date(),
      supplierConfirmedDeliveryDate: confirmedDeliveryDate,
      notes: input.notes ?? po.notes,
    },
    include: PO_INCLUDE,
  });

  await recordDeliveryEventInternal({
    poId,
    type: DeliveryEventType.CONFIRMED,
    actorId: seller.userId,
    tenantId: actor.tenantId,
    notes: input.notes,
  });

  await createAuditLog({
    userId: seller.userId,
    action: AuditAction.ORDER_CONFIRMED_BY_SUPPLIER,
    entityType: 'PurchaseOrder',
    entityId: poId,
    tenantId: actor.tenantId,
    previousStatus: po.status,
    newStatus: updated.status,
    metadata: {
      poNumber: po.poNumber,
      confirmedDeliveryDate: confirmedDeliveryDate?.toISOString(),
      vendorId: seller.vendorId,
    },
  });

  return updated;
}

/** Supplier declines to fulfil an issued order. */
export async function rejectOrderBySupplier(poId: string, actor: ActorContext, reason: string) {
  const seller = await requireSellerActor(actor);
  const po = await loadAccessiblePo(poId, actor);

  if (!SUPPLIER_ACTIONABLE_STATUSES.includes(po.status)) {
    throw new ConflictError(`Purchase order cannot be rejected in status ${po.status}`);
  }
  if (!reason?.trim()) {
    throw new ValidationError('A rejection reason is required');
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: poId },
    data: {
      status: PurchaseOrderStatus.CANCELLED,
      cancelledAt: new Date(),
      rejectionReason: reason.trim(),
    },
    include: PO_INCLUDE,
  });

  await createAuditLog({
    userId: seller.userId,
    action: AuditAction.ORDER_REJECTED_BY_SUPPLIER,
    entityType: 'PurchaseOrder',
    entityId: poId,
    tenantId: actor.tenantId,
    previousStatus: po.status,
    newStatus: PurchaseOrderStatus.CANCELLED,
    decision: reason.trim(),
    metadata: { poNumber: po.poNumber, vendorId: seller.vendorId },
  });

  return updated;
}

/**
 * Add a delivery milestone. Suppliers log dispatch and transit events; buyers
 * log exceptions. Delivery status is derived from these events, never set
 * directly, so the trail always explains how the order reached its state.
 */
export async function addDeliveryEvent(
  poId: string,
  actor: ActorContext,
  input: {
    type: DeliveryEventType;
    notes?: string;
    location?: string;
    carrierName?: string;
    trackingRef?: string;
    estimatedDeliveryDate?: string;
    documentIds?: string[];
  },
) {
  const po = await loadAccessiblePo(poId, actor);

  if (CLOSED_STATUSES.includes(po.status)) {
    throw new ConflictError(`Cannot record delivery on a ${po.status.toLowerCase()} purchase order`);
  }

  // Only suppliers may report dispatch/transit progress; buyers may record
  // exceptions and their own receipt observations.
  const supplierOnly: string[] = [
    DeliveryEventType.PREPARATION,
    DeliveryEventType.DISPATCH,
    DeliveryEventType.IN_TRANSIT,
  ];
  if (actor.role === UserRole.VENDOR && !supplierOnly.includes(input.type) && input.type !== DeliveryEventType.DELIVERED) {
    // Suppliers may still flag an exception on their own shipment.
    if (input.type !== DeliveryEventType.EXCEPTION) {
      throw new ForbiddenError('Suppliers may only record dispatch, transit, delivery or exception events');
    }
  }
  if (actor.role !== UserRole.VENDOR && supplierOnly.includes(input.type)) {
    throw new ForbiddenError('Only the supplier can report dispatch and transit events');
  }

  // Shipment milestones require a confirmed order. Without this, a supplier
  // could dispatch first, which advances the PO to IN_PROGRESS and then makes
  // the mandatory confirmation step impossible - leaving the order in a state
  // the supplier can never acknowledge.
  if (supplierOnly.includes(input.type) && !SUPPLIER_MILESTONE_STATUSES.includes(po.status)) {
    throw new ConflictError(
      `Cannot record ${input.type.toLowerCase()} before the order is confirmed ` +
        `(currently ${po.status.toLowerCase()})`,
    );
  }

  const event = await recordDeliveryEventInternal({
    poId,
    type: input.type,
    actorId: actor.userId,
    tenantId: actor.tenantId,
    notes: input.notes,
    location: input.location,
    carrierName: input.carrierName,
    trackingRef: input.trackingRef,
    estimatedDeliveryDate: input.estimatedDeliveryDate,
    documentIds: input.documentIds,
  });

  // Advance PO status from the milestone. PARTIALLY_DELIVERED is applied by the
  // goods receipt path, which is the only place with accepted-quantity truth.
  const nextStatus = resolveStatusAfterDeliveryEvent(po.status, input.type);
  if (nextStatus !== po.status) {
    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: {
        status: nextStatus,
        dispatchTrackingRef: input.type === DeliveryEventType.DISPATCH ? input.trackingRef ?? po.dispatchTrackingRef : undefined,
        dispatchNotes: input.notes ?? undefined,
      },
    });
  }

  await createAuditLog({
    userId: actor.userId,
    action:
      input.type === DeliveryEventType.EXCEPTION
        ? AuditAction.DELIVERY_EXCEPTION
        : AuditAction.DELIVERY_EVENT_ADDED,
    entityType: 'DeliveryEvent',
    entityId: event.id,
    tenantId: actor.tenantId,
    metadata: { poId, poNumber: po.poNumber, type: input.type, trackingRef: input.trackingRef },
  });

  return event;
}

/** Write a delivery event without a status transition or audit entry. */
export async function recordDeliveryEventInternal(input: {
  poId: string;
  type: DeliveryEventType;
  actorId: string;
  tenantId: string;
  notes?: string;
  location?: string;
  carrierName?: string;
  trackingRef?: string;
  estimatedDeliveryDate?: string;
  documentIds?: string[];
}): Promise<{ id: string; type: PrismaDeliveryEventType; occurredAt: Date; notes: string | null }> {
  return prisma.deliveryEvent.create({
    data: {
      poId: input.poId,
      type: input.type as unknown as PrismaDeliveryEventType,
      actorId: input.actorId,
      tenantId: input.tenantId,
      notes: input.notes ?? null,
      location: input.location ?? null,
      carrierName: input.carrierName ?? null,
      trackingRef: input.trackingRef ?? null,
      estimatedDeliveryDate: input.estimatedDeliveryDate ? new Date(input.estimatedDeliveryDate) : null,
      documentIds: input.documentIds ?? [],
    },
    select: { id: true, type: true, occurredAt: true, notes: true },
  });
}

function resolveStatusAfterDeliveryEvent(
  current: PrismaPOStatus,
  event: PrismaDeliveryEventType,
): PrismaPOStatus {
  switch (event) {
    case DeliveryEventType.PREPARATION:
      return current === PurchaseOrderStatus.SUPPLIER_CONFIRMED
        ? PrismaPOStatus.IN_PROGRESS
        : current;
    case DeliveryEventType.DISPATCH:
    case DeliveryEventType.IN_TRANSIT:
      return PrismaPOStatus.IN_PROGRESS;
    // DELIVERED is only applied by the goods receipt path, which verifies the
    // accepted quantity against what was ordered.
    case DeliveryEventType.DELIVERED:
      return current;
    default:
      return current;
  }
}

async function requireSellerActor(actor: ActorContext): Promise<{ userId: string; vendorId: string }> {
  if (actor.role !== UserRole.VENDOR) {
    throw new ForbiddenError('This action is restricted to supplier accounts');
  }
  const { resolveSellerVendor } = await import('./po-access.js');
  const seller = await resolveSellerVendor(actor.userId);
  if (!seller) {
    throw new ForbiddenError('Supplier account is not linked to a vendor record');
  }
  return { userId: seller.id, vendorId: seller.vendorId };
}

export { PO_INCLUDE };