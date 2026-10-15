import { Prisma } from '@prisma/client';
import { AuditAction, InvoiceStatus, PaymentStatus, PurchaseOrderStatus, UserRole } from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { amountsEqual, decimalToNumber, roundMoney, toDecimal } from '../../utils/money.js';
import { createAuditLog } from '../audit/audit.service.js';
import { ActorContext, loadAccessiblePo } from './po-access.js';
import { isClearedForPayment } from './invoice.service.js';

/**
 * Payment tracking.
 *
 * NAVO records the fact and status of payments made outside the system. It does
 * not initiate bank or gateway transfers, so every status here is an
 * assertion by an authorised user rather than a gateway confirmation. The UI
 * labels payment data accordingly.
 */

export interface RecordPaymentInput {
  poId: string;
  invoiceId?: string;
  status: PaymentStatus;
  amount?: number | string;
  paidAmount?: number | string;
  paidAt?: string;
  dueDate?: string;
  reference?: string;
  paymentMethod?: string;
  notes?: string;
}

/**
 * Create or update the payment record for a PO.
 *
 * A payment tied to an invoice is refused while that invoice carries
 * unresolved critical discrepancies - this is the gate that stops an
 * unreconciled invoice being marked paid.
 */
export async function recordPayment(actor: ActorContext, input: RecordPaymentInput) {
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Payment status is recorded by the buyer, not the supplier');
  }
  if (!PO_PAYMENT_ROLES.includes(actor.role)) {
    throw new ForbiddenError('Insufficient permissions to record payments');
  }

  const po = await loadAccessiblePo(input.poId, actor);

  if (po.status === PurchaseOrderStatus.CANCELLED) {
    throw new ConflictError('Cannot record payment against a cancelled purchase order');
  }

  let invoice: { id: string; invoiceNumber: string; totalAmount: Prisma.Decimal; status: string } | null = null;
  if (input.invoiceId) {
    invoice = await prisma.invoice.findFirst({
      where: { id: input.invoiceId, tenantId: actor.tenantId },
      select: { id: true, invoiceNumber: true, totalAmount: true, status: true },
    });
    if (!invoice) throw new NotFoundError('Invoice');

    if (!(await invoiceBelongsToPo(input.invoiceId, input.poId))) {
      throw new ValidationError('Invoice does not belong to this purchase order');
    }
  }

  const dueAmount = invoice ? invoice.totalAmount : po.totalAmount;
  const amount = roundMoney(toDecimal(input.amount ?? dueAmount, 'amount'));
  const paidAmount = roundMoney(toDecimal(input.paidAmount ?? 0, 'paidAmount'));

  if (paidAmount.gt(amount)) {
    throw new ValidationError(
      `paidAmount (${paidAmount.toFixed(2)}) cannot exceed the amount due (${amount.toFixed(2)})`,
    );
  }

  // Payment gate: critical unresolved discrepancies block any amount that
  // settles the invoice.
  if (invoice) {
    const cleared = await isClearedForPayment(invoice.id);
    if (!cleared && paidAmount.gt(0)) {
      throw new ConflictError(
        `Invoice ${invoice.invoiceNumber} has unresolved critical discrepancies. Resolve them before recording payment.`,
      );
    }
  }

  // Derive a consistent status rather than trusting the caller's label, so the
  // stored status can never contradict the recorded amounts.
  // Reject an overstated PAID before deriving anything. Checking after
  // derivation would be dead code, because derivePaymentStatus downgrades an
  // underpaid PAID to PARTIALLY_PAID - the caller would silently get a
  // different status than the one they asked for and record.
  if (input.status === PaymentStatus.PAID && !amountsEqual(paidAmount, amount, 0.01)) {
    throw new ValidationError(
      `Cannot mark as PAID: ${paidAmount.toFixed(2)} of ${amount.toFixed(2)} recorded`,
    );
  }

  const status = derivePaymentStatus(input.status, paidAmount, amount);

  const paidAt = input.paidAt ? new Date(input.paidAt) : status === PaymentStatus.PAID ? new Date() : null;
  if (paidAt && Number.isNaN(paidAt.getTime())) {
    throw new ValidationError('paidAt is not a valid date');
  }
  const dueDate = input.dueDate ? new Date(input.dueDate) : null;
  if (dueDate && Number.isNaN(dueDate.getTime())) {
    throw new ValidationError('dueDate is not a valid date');
  }

  const existing = await prisma.payment.findFirst({
    where: { poId: input.poId, invoiceId: input.invoiceId ?? null },
    orderBy: { createdAt: 'desc' },
  });

  const data = {
    poId: input.poId,
    invoiceId: input.invoiceId ?? null,
    status,
    amount,
    paidAmount,
    currency: po.currency,
    reference: input.reference ?? null,
    paymentMethod: input.paymentMethod ?? null,
    paidAt,
    dueDate,
    notes: input.notes ?? null,
    recordedById: actor.userId,
    tenantId: actor.tenantId,
  };

  const payment = existing
    ? await prisma.payment.update({ where: { id: existing.id }, data })
    : await prisma.payment.create({ data });

  if (invoice && status === PaymentStatus.PAID) {
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: InvoiceStatus.VERIFIED } });
  }

  await createAuditLog({
    userId: actor.userId,
    action:
      existing && existing.status !== status
        ? AuditAction.PAYMENT_STATUS_UPDATED
        : AuditAction.PAYMENT_RECORDED,
    entityType: 'Payment',
    entityId: payment.id,
    tenantId: actor.tenantId,
    previousStatus: existing?.status,
    newStatus: status,
    metadata: {
      poId: input.poId,
      poNumber: po.poNumber,
      invoiceNumber: invoice?.invoiceNumber,
      amount: amount.toString(),
      paidAmount: paidAmount.toString(),
      reference: input.reference,
      method: input.paymentMethod,
    },
  });

  return payment;
}

const PO_PAYMENT_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.FINANCE_APPROVER,
  UserRole.PROCUREMENT_MANAGER,
];

/**
 * Reconcile the caller's intended status with the recorded amounts.
 * NOT_DUE/ON_HOLD/DISPUTED are explicit user assertions and pass through;
 * otherwise the status is derived so it cannot contradict the money.
 */
function derivePaymentStatus(
  requested: PaymentStatus,
  paidAmount: Prisma.Decimal,
  amount: Prisma.Decimal,
): PaymentStatus {
  switch (requested) {
    case PaymentStatus.ON_HOLD:
    case PaymentStatus.DISPUTED:
      return requested;
    case PaymentStatus.PAID:
      return amountsEqual(paidAmount, amount, 0.01) ? PaymentStatus.PAID : PaymentStatus.PARTIALLY_PAID;
    case PaymentStatus.PARTIALLY_PAID:
      return amountsEqual(paidAmount, amount, 0.01) ? PaymentStatus.PAID : PaymentStatus.PARTIALLY_PAID;
    case PaymentStatus.DUE:
    case PaymentStatus.NOT_DUE:
    default:
      return requested;
  }
}

export async function listPayments(actor: ActorContext, filters: { poId?: string; status?: PaymentStatus } = {}) {
  const where: Prisma.PaymentWhereInput = { tenantId: actor.tenantId };

  if (actor.role === UserRole.VENDOR) {
    // Sellers may view payment progress on their own orders, but never the
    // recorded bank reference or internal notes.
    const { requireSeller } = await import('./po-access.js');
    const seller = await requireSeller(actor.userId, actor.tenantId);
    where.po = { vendorId: seller.vendorId };
  }
  if (filters.poId) where.poId = filters.poId;
  if (filters.status) where.status = filters.status;

  return prisma.payment.findMany({
    where,
    include: {
      recordedBy: { select: { id: true, firstName: true, lastName: true } },
      invoice: { select: { id: true, invoiceNumber: true, totalAmount: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function invoiceBelongsToPo(invoiceId: string, poId: string): Promise<boolean> {
  const match = await prisma.invoice.findFirst({
    where: { id: invoiceId, poId },
    select: { id: true },
  });
  return Boolean(match);
}

/** Aggregate payment totals for the PO detail view and dashboards. */
export async function getPaymentSummary(poId: string): Promise<{
  totalDue: number;
  totalPaid: number;
  outstanding: number;
  status: PaymentStatus;
}> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: { totalAmount: true },
  });
  if (!po) throw new NotFoundError('Purchase Order');

  const payments = await prisma.payment.findMany({ where: { poId } });
  const totalPaid = payments.reduce((sum, p) => sum.add(p.paidAmount), new Prisma.Decimal(0));
  const totalDue = po.totalAmount;
  const outstanding = roundMoney(totalDue.minus(totalPaid).abs());

  let status = PaymentStatus.NOT_DUE;
  if (payments.some((p) => p.status === PaymentStatus.DISPUTED)) status = PaymentStatus.DISPUTED;
  else if (payments.some((p) => p.status === PaymentStatus.ON_HOLD)) status = PaymentStatus.ON_HOLD;
  else if (totalPaid.gte(totalDue)) status = PaymentStatus.PAID;
  else if (totalPaid.gt(0)) status = PaymentStatus.PARTIALLY_PAID;
  else if (payments.some((p) => p.status === PaymentStatus.DUE)) status = PaymentStatus.DUE;

  return {
    totalDue: decimalToNumber(totalDue),
    totalPaid: decimalToNumber(totalPaid),
    outstanding: decimalToNumber(outstanding),
    status,
  };
}