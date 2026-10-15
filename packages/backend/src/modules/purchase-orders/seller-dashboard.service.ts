import { Prisma, PurchaseOrderStatus as PrismaPOStatus, InvoiceStatus as PrismaInvoiceStatus } from '@prisma/client';
import {
  ApprovalStatus,
  DeliveryEventType,
  InvoiceMatchStatus,
  InvoiceStatus,
  PaymentStatus,
  PurchaseOrderStatus,
  UserRole,
} from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ForbiddenError } from '../../utils/errors.js';
import { decimalToNumber, roundMoney } from '../../utils/money.js';
import { ActorContext } from './po-access.js';
import { requireSeller } from './po-access.js';
import { buildPoSummary } from './timeline.service.js';

/**
 * Statuses meaning the order no longer needs a delivery date honoured.
 * Plain strings so Prisma enum members read from the database compare directly.
 */
const SETTLED_STATUSES: string[] = [
  PurchaseOrderStatus.DELIVERED,
  PurchaseOrderStatus.CLOSED,
  PurchaseOrderStatus.CANCELLED,
];

/**
 * Seller dashboard.
 *
 * The supplier view is derived strictly from their own purchase orders, so a
 * seller can never see another supplier's commercial data. `requireSeller`
 * resolves the vendor from the authenticated user, not from a request parameter.
 */
export async function getSellerDashboard(actor: ActorContext) {
  const seller = await requireSeller(actor.userId, actor.tenantId);

  const where: Prisma.PurchaseOrderWhereInput = {
    tenantId: actor.tenantId,
    vendorId: seller.vendorId,
  };

  const [vendor, totals, statusCounts, pendingOrders, recentOrders, openInvoices, earningsByMonth] =
    await Promise.all([
      prisma.vendor.findUnique({
        where: { id: seller.vendorId },
        select: {
          id: true,
          name: true,
          status: true,
          gstin: true,
          city: true,
          state: true,
          verificationStatus: true,
          performance: {
            select: {
              totalOrders: true,
              onTimeDelivery: true,
              qualityRating: true,
              responsiveness: true,
              lastOrderDate: true,
            },
          },
        },
      }),
      prisma.purchaseOrder.aggregate({
        where,
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.purchaseOrder.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.purchaseOrder.findMany({
        where: { ...where, status: PrismaPOStatus.ISSUED },
        select: {
          id: true,
          poNumber: true,
          itemName: true,
          quantity: true,
          totalAmount: true,
          currency: true,
          issuedAt: true,
          expectedDeliveryDate: true,
        },
        orderBy: { issuedAt: 'asc' },
      }),
      prisma.purchaseOrder.findMany({
        where,
        select: {
          id: true,
          poNumber: true,
          itemName: true,
          status: true,
          quantity: true,
          totalAmount: true,
          currency: true,
          expectedDeliveryDate: true,
          supplierConfirmedDeliveryDate: true,
          issuedAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
      prisma.invoice.findMany({
        where: {
          tenantId: actor.tenantId,
          vendorId: seller.vendorId,
          status: { in: [PrismaInvoiceStatus.DISCREPANCIES_FOUND, PrismaInvoiceStatus.SUBMITTED, PrismaInvoiceStatus.UNDER_REVIEW] },
        },
        select: {
          id: true,
          invoiceNumber: true,
          totalAmount: true,
          status: true,
          invoiceDate: true,
          po: { select: { id: true, poNumber: true } },
          verifications: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.purchaseOrder.findMany({
        where: { ...where, status: { notIn: [PrismaPOStatus.CANCELLED] } },
        select: { issuedAt: true, totalAmount: true },
      }),
    ]);

  // Monthly order value, computed in Decimal space and only over the last six
  // months so the chart has a stable window.
  const monthly = new Map<string, { orders: number; value: number }>();
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthly.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, { orders: 0, value: 0 });
  }
  for (const order of earningsByMonth) {
    if (!order.issuedAt) continue;
    const key = `${order.issuedAt.getFullYear()}-${String(order.issuedAt.getMonth() + 1).padStart(2, '0')}`;
    const bucket = monthly.get(key);
    if (bucket) {
      bucket.orders += 1;
      bucket.value = decimalToNumber(roundMoney(new Prisma.Decimal(bucket.value).plus(order.totalAmount)));
    }
  }

  const counts: Record<string, number> = {};
  for (const group of statusCounts) {
    counts[group.status] = group._count._all;
  }

  const now2 = new Date();
  // Only orders with a supplier-committed date in the past can be overdue; an
  // uncommitted estimate is not a breach of any commitment.
  const overdue = recentOrders.filter(
    (o) =>
      Boolean(o.supplierConfirmedDeliveryDate) &&
      new Date(o.supplierConfirmedDeliveryDate!).getTime() < now2.getTime() &&
      !SETTLED_STATUSES.includes(o.status),
  ).length;

  return {
    vendor,
    summary: {
      totalOrders: totals._count._all,
      totalOrderValue: decimalToNumber(totals._sum.totalAmount ?? new Prisma.Decimal(0)),
      pendingConfirmation: pendingOrders.length,
      overdueOrders: overdue,
      openInvoices: openInvoices.length,
      statusCounts: counts,
    },
    // Orders issued but not yet confirmed: the seller's immediate action list.
    pendingOrders,
    recentOrders,
    openInvoices: openInvoices.map((invoice) => ({
      ...invoice,
      discrepancyCount:
        (
          (invoice.verifications[0]?.discrepancies as unknown as unknown[] | null) ?? []
        ).length,
    })),
    monthlyPerformance: [...monthly.entries()].map(([month, value]) => ({ month, ...value })),
  };
}

/**
 * Order list for the supplier view, with the fields a seller needs and nothing
 * belonging to the buyer's internal process (no approvals, no internal notes).
 */
export async function listSellerOrders(
  actor: ActorContext,
  filters: { status?: PurchaseOrderStatus; search?: string } = {},
) {
  const seller = await requireSeller(actor.userId, actor.tenantId);

  const where: Prisma.PurchaseOrderWhereInput = {
    tenantId: actor.tenantId,
    vendorId: seller.vendorId,
  };
  if (filters.status) where.status = filters.status;
  if (filters.search?.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { poNumber: { contains: term, mode: 'insensitive' } },
      { itemName: { contains: term, mode: 'insensitive' } },
    ];
  }

  const orders = await prisma.purchaseOrder.findMany({
    where,
    select: {
      id: true,
      poNumber: true,
      status: true,
      itemName: true,
      description: true,
      quantity: true,
      unit: true,
      unitPrice: true,
      taxRate: true,
      taxAmount: true,
      freightAmount: true,
      installationAmount: true,
      otherCharges: true,
      otherChargesDetails: true,
      subtotal: true,
      totalAmount: true,
      currency: true,
      deliveryAddress: true,
      expectedDeliveryDate: true,
      supplierConfirmedDeliveryDate: true,
      paymentTerms: true,
      warrantyMonths: true,
      terms: true,
      issuedAt: true,
      rejectionReason: true,
      updatedAt: true,
      _count: { select: { deliveryEvents: true, invoices: true, documents: true } },
    },
    orderBy: { issuedAt: 'desc' },
  });

  return orders;
}

/** Per-PO summary for the seller, mirroring the buyer's derived summary. */
export async function getSellerOrderSummary(poId: string, actor: ActorContext) {
  const seller = await requireSeller(actor.userId, actor.tenantId);
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, tenantId: actor.tenantId, vendorId: seller.vendorId },
    select: { id: true },
  });
  if (!po) {
    throw new ForbiddenError('Purchase order not found for this supplier');
  }
  return buildPoSummary(poId, actor);
}

export { ApprovalStatus, DeliveryEventType, InvoiceMatchStatus, InvoiceStatus, PaymentStatus, UserRole };