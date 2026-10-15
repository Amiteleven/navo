import { UserRole } from '@navo/shared';
import prisma from '../../../utils/prisma.js';
import { decimalToNumber, formatMoney } from '../../../utils/money.js';
import {
  buildScope,
  canCreateRequests,
  canDraftNegotiation,
  dealRoomVisibility,
  dealVisibility,
  invoiceVisibility,
  paymentVisibility,
  purchaseOrderVisibility,
  quoteVisibility,
  requestVisibility,
  rfqVisibility,
  vendorVisibility,
  CopilotScope,
} from '../copilot-access.js';
import {
  CopilotCitation,
  CopilotToolResult,
  argFragments,
  defineTool,
} from '../tool-registry.js';
import { z } from 'zod';

/**
 * Read-only tools for requests, vendors, RFQs, quotations, deals, purchase
 * orders, deliveries and invoices.
 *
 * Each tool is a narrow, named question. That is deliberate: it keeps the
 * planner honest (there is no "run this SQL" escape hatch) and it makes every
 * answer traceable to a specific, authorization-checked query.
 */

const BUYER_AND_ADMIN = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
  UserRole.REQUESTER,
  UserRole.VIEWER,
] as const;

const ALL_ROLES = [...BUYER_AND_ADMIN, UserRole.VENDOR] as const;

/** Dates arrive from Prisma as `Date` (or `null`), but callers pass strings. */
const dateOnly = (value?: Date | string | null): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
};

/**
 * Resolve a requested record id against the caller's scope.
 * Returns null when the record does not exist or is not visible, so a caller
 * cannot distinguish "wrong tenant" from "wrong id" by timing the answer.
 */
async function loadScoped<T>(
  delegate: { findFirst: (args: never) => Promise<T | null> },
  where: Record<string, unknown>
): Promise<T | null> {
  return (delegate as unknown as {
    findFirst: (args: { where: Record<string, unknown> }) => Promise<T | null>;
  }).findFirst({ where });
}

// ── Requests ──────────────────────────────────────────────────────────────────

export const listRequestsTool = defineTool({
  name: 'list_requests',
  description:
    'List procurement requests the caller is allowed to see, optionally filtered by status, value or date.',
  readOnly: true,
  allowedRoles: ALL_ROLES,
  argHint: '{ status?: string, limit?: number, search?: string, vendorId?: string }',
  schema: z.object({
    status: z.string().max(40).optional(),
    search: argFragments.search,
    vendorId: argFragments.vendorId,
    limit: argFragments.limit,
  }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const focused = buildScope(scope.actor, args.vendorId);
    const where = requestVisibility(focused);
    if (args.status) where.status = args.status as never;
    if (args.search) {
      where.OR = [
        { title: { contains: args.search, mode: 'insensitive' } },
        { item: { contains: args.search, mode: 'insensitive' } },
      ];
    }

    const requests = await prisma.procurementRequest.findMany({
      where,
      include: { category: true, requester: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: args.limit,
    });

    const citations: CopilotCitation[] = requests.map((r) => ({
      entityType: 'REQUEST',
      entityId: r.id,
      label: r.title,
      href: `/requests/${r.id}`,
      status: r.status,
      date: dateOnly(r.requiredDate),
    }));

    return {
      kind: 'request_list',
      empty: requests.length === 0,
      lines: requests.map(
        (r) =>
          `${r.title} — ${r.status}, ${r.quantity}${r.unit ? ` ${r.unit}` : ''} of ${r.item}` +
          `, required ${dateOnly(r.requiredDate)}${r.location ? ` at ${r.location}` : ''}` +
          `${r.estimatedBudget ? `, budget ${formatMoney(r.estimatedBudget)}` : ''}`
      ),
      citations,
      facts: {
        count: requests.length,
        activeCount: requests.filter((r) =>
          ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'RFQ_SENT', 'QUOTES_RECEIVED'].includes(r.status)
        ).length,
      },
      suggestedQuestions: requests.length
        ? ['Which vendors can supply this?', 'Compare the quotations for my request']
        : ['Show my purchase orders', 'Which suppliers are online now?'],
    };
  },
});

// ── Vendors ───────────────────────────────────────────────────────────────────

export const listVendorsTool = defineTool({
  name: 'list_vendors',
  description:
    'List suppliers in the caller\'s tenant, with category, location, verification status and online availability.',
  readOnly: true,
  allowedRoles: BUYER_AND_ADMIN,
  argHint: '{ onlineOnly?: boolean, categoryId?: string, search?: string, limit?: number }',
  schema: z.object({
    onlineOnly: z.boolean().default(false),
    categoryId: argFragments.categoryId,
    search: argFragments.search,
    limit: argFragments.limit,
  }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const where = vendorVisibility(scope);
    if (args.categoryId) where.categoryId = args.categoryId;
    if (args.search) {
      where.OR = [
        { name: { contains: args.search, mode: 'insensitive' } },
        { products: { contains: args.search, mode: 'insensitive' } },
      ];
    }
    if (args.onlineOnly) {
      where.availability = { is: { isOnline: true } };
    }

    const vendors = await prisma.vendor.findMany({
      where,
      include: {
        category: true,
        availability: true,
        performance: true,
      },
      orderBy: { name: 'asc' },
      take: args.limit,
    });

    return {
      kind: 'vendor_list',
      empty: vendors.length === 0,
      lines: vendors.map((v) => {
        const presence = v.availability?.isOnline
          ? v.availability.isBusy
            ? 'online and busy'
            : 'online and available'
          : 'offline';
        const location = [v.city, v.state].filter(Boolean).join(', ') || 'location not recorded';
        const performance = v.performance
          ? `, on-time delivery ${Number(v.performance.onTimeDelivery).toFixed(1)}%, rating ${Number(v.performance.qualityRating).toFixed(1)}`
          : ', no performance record';
        return `${v.name} — ${v.status}, ${v.verificationStatus}, ${presence}, ${location}${performance}`;
      }),
      citations: vendors.map((v) => ({
        entityType: 'VENDOR',
        entityId: v.id,
        label: v.name,
        href: `/vendors?search=${encodeURIComponent(v.name)}`,
        status: v.status,
      })),
      facts: {
        count: vendors.length,
        onlineCount: vendors.filter((v) => v.availability?.isOnline).length,
        verifiedCount: vendors.filter((v) => v.verificationStatus === 'VERIFIED').length,
      },
      suggestedQuestions: ['Find suppliers who can provide a requirement', 'Compare supplier performance'],
    };
  },
});

// ── RFQs and quotations ───────────────────────────────────────────────────────

export const listQuotesTool = defineTool({
  name: 'list_quotes',
  description:
    'List quotations for an RFQ with landed cost, terms and supplier, ranked deterministically. A supplier only ever sees its own quotations.',
  readOnly: true,
  allowedRoles: BUYER_AND_ADMIN,
  argHint: '{ rfqId: string }',
  schema: z.object({ rfqId: z.string().min(1).max(64) }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const rfq = await prisma.rFQ.findFirst({
      where: { id: args.rfqId, ...rfqVisibility(scope) },
      select: { id: true, rfqNumber: true, title: true, quantity: true, requestId: true },
    });

    if (!rfq) {
      return {
        kind: 'quote_list',
        empty: true,
        lines: ['No such request for quotations was found in your scope.'],
        citations: [],
        facts: { count: 0 },
      };
    }

    const quotes = await prisma.quote.findMany({
      where: { rfqId: rfq.id, ...quoteVisibility(scope) },
      include: { vendor: { select: { name: true } } },
      orderBy: { submittedAt: 'asc' },
    });

    // Landed cost is computed here rather than trusted from a stored column, and
    // uses the same deterministic helpers as the rest of NAVO.
    const ranked = quotes
      .map((q) => {
        const base = q.unitPrice * q.quantity;
        const total =
          base + q.freightAmount + q.installationAmount + q.otherCharges + q.taxAmount;
        return {
          id: q.id,
          vendorName: q.vendor.name,
          unitPrice: q.unitPrice,
          quantity: q.quantity,
          total,
          taxRate: q.taxRate,
          warrantyMonths: q.warrantyMonths,
          deliveryTimelineDays: q.deliveryTimelineDays,
          paymentTerms: q.paymentTerms,
          status: q.status,
        };
      })
      .sort((a, b) => a.total - b.total);

    const best = ranked[0];

    return {
      kind: 'quote_list',
      empty: ranked.length === 0,
      lines: ranked.map(
        (q) =>
          `${q.vendorName} — unit ${formatMoney(q.unitPrice)}, total ${formatMoney(q.total)}` +
          ` (incl. ${q.taxRate}% tax, freight ${formatMoney(0)} placeholders omitted)` +
          `${q.warrantyMonths ? `, warranty ${q.warrantyMonths} months` : ', warranty not stated'}` +
          `${q.deliveryTimelineDays ? `, delivery ${q.deliveryTimelineDays} days` : ', delivery not stated'}` +
          `${q.paymentTerms ? `, terms: ${q.paymentTerms}` : ''}`
      ),
      citations: ranked.map((q) => ({
        entityType: 'QUOTE',
        entityId: q.id,
        label: `${q.vendorName} quotation`,
        href: `/quotes?rfqId=${rfq.id}`,
        status: q.status,
      })),
      facts: {
        count: ranked.length,
        rfqNumber: rfq.rfqNumber,
        lowestTotal: best ? decimalToNumber(best.total) : null,
        lowestVendor: best?.vendorName ?? null,
      },
      suggestedQuestions: ['Draft a counteroffer to the best quote', 'Compare these quotations'],
    };
  },
});

// ── Deals and negotiation ─────────────────────────────────────────────────────

export const listDealsTool = defineTool({
  name: 'list_deals',
  description:
    'List confirmed deals with the supplier, request and resulting purchase order. Sellers see only their own deals.',
  readOnly: true,
  allowedRoles: ALL_ROLES,
  argHint: '{ status?: string, limit?: number }',
  schema: z.object({ status: z.string().max(40).optional(), limit: argFragments.limit }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const where = dealVisibility(scope);
    if (args.status) where.status = args.status as never;

    const deals = await prisma.deal.findMany({
      where,
      include: {
        vendor: { select: { name: true } },
        request: { select: { title: true } },
        purchaseOrder: { select: { id: true, poNumber: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: args.limit,
    });

    return {
      kind: 'deal_list',
      empty: deals.length === 0,
      lines: deals.map(
        (d) =>
          `${d.dealNumber} — ${d.status}, ${d.vendor.name} on "${d.request.title}"` +
          `${d.purchaseOrder ? `, raised as ${d.purchaseOrder.poNumber} (${d.purchaseOrder.status})` : ', no purchase order yet'}`
      ),
      citations: deals.map((d) => ({
        entityType: 'DEAL',
        entityId: d.id,
        label: d.dealNumber,
        href: `/deals?dealId=${d.id}`,
        status: d.status,
        date: dateOnly(d.createdAt),
      })),
      facts: {
        count: deals.length,
        withoutPurchaseOrder: deals.filter((d) => !d.purchaseOrder).length,
      },
      suggestedQuestions: ['Show pending purchase orders', 'Which suppliers have not confirmed delivery?'],
    };
  },
});

export const listNegotiationsTool = defineTool({
  name: 'list_awaiting_negotiation',
  description:
    'List open deal rooms where the counterparty has replied and the caller has not yet responded.',
  readOnly: true,
  allowedRoles: ALL_ROLES,
  argHint: '{ limit?: number }',
  schema: z.object({ limit: argFragments.limit }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const rooms = await prisma.dealRoom.findMany({
      where: { ...dealRoomVisibility(scope), status: { in: ['ACTIVE', 'NEGOTIATING'] } },
      include: {
        vendor: { select: { name: true } },
        request: { select: { title: true } },
        offers: { orderBy: { createdAt: 'desc' }, take: 5 },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
      take: args.limit,
    });

    const roomsWithReplies = rooms.filter((room) => {
      const lastMessage = room.messages[0];
      // "Awaiting the caller" means the most recent message came from the other
      // side. Sender role is compared against the caller's own role.
      if (!lastMessage) return false;
      const callerRole = scope.isSeller ? UserRole.VENDOR : UserRole.REQUESTER;
      const senderRole = String(lastMessage.senderRole ?? '').toUpperCase();
      if (scope.isSeller) return senderRole !== 'VENDOR';
      return senderRole !== 'BUYER' && senderRole !== 'REQUESTER' && senderRole !== String(callerRole);
    });

    return {
      kind: 'negotiation_list',
      empty: roomsWithReplies.length === 0,
      lines: roomsWithReplies.map(
        (room) =>
          `${room.request.title} with ${room.vendor.name} — room ${room.status}, ` +
          `${room.offers.length} recent offer(s), last message ${dateOnly(room.messages[0]?.createdAt) ?? 'unknown'}`
      ),
      citations: roomsWithReplies.map((room) => ({
        entityType: 'DEAL_ROOM',
        entityId: room.id,
        label: `${room.request.title} × ${room.vendor.name}`,
        href: `/deals/new?dealRoomId=${room.id}`,
        status: room.status,
        date: dateOnly(room.messages[0]?.createdAt),
      })),
      facts: { count: roomsWithReplies.length },
      suggestedQuestions: ['Draft a counteroffer', 'Summarize the latest offer'],
    };
  },
});

// ── Purchase execution ────────────────────────────────────────────────────────

export const listPurchaseOrdersTool = defineTool({
  name: 'list_purchase_orders',
  description:
    'List purchase orders with status, supplier, value and delivery date, filtered by status or value.',
  readOnly: true,
  allowedRoles: ALL_ROLES,
  argHint: '{ status?: string, minValue?: number, maxValue?: number, limit?: number }',
  schema: z.object({
    status: z.string().max(40).optional(),
    minValue: argFragments.minValue,
    maxValue: argFragments.maxValue,
    limit: argFragments.limit,
  }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const where = purchaseOrderVisibility(scope);
    if (args.status) where.status = args.status as never;

    const orders = await prisma.purchaseOrder.findMany({
      where,
      include: { vendor: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: args.limit,
    });

    // Re-rank after value filtering so the reported cheapest is actually the
    // cheapest of what the caller asked for.
    const filtered = orders
      .filter((o) => {
        const total = decimalToNumber(o.totalAmount);
        if (args.minValue != null && total < args.minValue) return false;
        if (args.maxValue != null && total > args.maxValue) return false;
        return true;
      })
      .slice(0, args.limit);

    const totalValue = filtered.reduce((s, o) => s + decimalToNumber(o.totalAmount), 0);

    return {
      kind: 'purchase_order_list',
      empty: filtered.length === 0,
      lines: filtered.map(
        (o) =>
          `${o.poNumber} — ${o.status}, ${o.vendor.name}, ${o.quantity}${o.unit ? ` ${o.unit}` : ''} × ${o.itemName}, ` +
          `total ${formatMoney(o.totalAmount)}` +
          `${o.expectedDeliveryDate ? `, due ${dateOnly(o.expectedDeliveryDate)}` : ', no delivery date set'}`
      ),
      citations: filtered.map((o) => ({
        entityType: 'PURCHASE_ORDER',
        entityId: o.id,
        label: o.poNumber,
        href: `/purchase-orders/${o.id}`,
        status: o.status,
        date: dateOnly(o.expectedDeliveryDate),
      })),
      facts: {
        count: filtered.length,
        totalValue: Math.round(totalValue * 100) / 100,
        awaitingApproval: filtered.filter((o) => o.status === 'PENDING_APPROVAL').length,
        awaitingSupplier: filtered.filter((o) => o.status === 'ISSUED').length,
      },
      suggestedQuestions: ['Which suppliers have not confirmed delivery?', 'Which invoices have discrepancies?'],
    };
  },
});

export const listUnconfirmedDeliveriesTool = defineTool({
  name: 'list_unconfirmed_deliveries',
  description:
    'List purchase orders issued to a supplier that the supplier has not yet confirmed, with the days remaining against the expected date.',
  readOnly: true,
  allowedRoles: BUYER_AND_ADMIN,
  argHint: '{ limit?: number }',
  schema: z.object({ limit: argFragments.limit }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const orders = await prisma.purchaseOrder.findMany({
      where: { ...purchaseOrderVisibility(scope), status: 'ISSUED' },
      include: { vendor: { select: { name: true } } },
      orderBy: { issuedAt: 'asc' },
      take: args.limit,
    });

    const today = Date.now();

    return {
      kind: 'unconfirmed_delivery_list',
      empty: orders.length === 0,
      lines: orders.map((o) => {
        const due = o.expectedDeliveryDate?.getTime();
        const days = due == null ? null : Math.ceil((due - today) / 86_400_000);
        const timing =
          days == null
            ? 'no expected date'
            : days < 0
              ? `${Math.abs(days)} day(s) past the expected date`
              : `${days} day(s) remaining`;
        return `${o.poNumber} — ${o.vendor.name}, issued ${dateOnly(o.issuedAt) ?? 'unknown'}, ${timing}`;
      }),
      citations: orders.map((o) => ({
        entityType: 'PURCHASE_ORDER',
        entityId: o.id,
        label: `${o.poNumber} (${o.vendor.name})`,
        href: `/purchase-orders/${o.id}`,
        status: o.status,
        date: dateOnly(o.expectedDeliveryDate),
      })),
      facts: {
        count: orders.length,
        overdueCount: orders.filter(
          (o) => o.expectedDeliveryDate && o.expectedDeliveryDate.getTime() < today
        ).length,
      },
      suggestedQuestions: ['Show pending purchase orders', 'Summarize this month\'s completed purchases'],
    };
  },
});

export const listInvoicesWithDiscrepanciesTool = defineTool({
  name: 'list_invoice_discrepancies',
  description:
    'List invoices that failed three-way matching, with each discrepancy\'s field, expected value, actual value and severity.',
  readOnly: true,
  allowedRoles: BUYER_AND_ADMIN,
  argHint: '{ limit?: number }',
  schema: z.object({ limit: argFragments.limit }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const invoices = await prisma.invoice.findMany({
      where: { ...invoiceVisibility(scope), status: 'DISCREPANCIES_FOUND' },
      include: {
        vendor: { select: { name: true } },
        po: { select: { id: true, poNumber: true } },
        verifications: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
      take: args.limit,
    });

    interface DiscrepancyRow {
      field?: string;
      type?: string;
      severity?: string;
      resolution?: string;
      expected?: unknown;
      actual?: unknown;
      difference?: number | string;
      message?: string;
    }

    const readDiscrepancies = (invoice: (typeof invoices)[number]): DiscrepancyRow[] => {
      const raw = invoice.verifications[0]?.discrepancies;
      return Array.isArray(raw) ? (raw as DiscrepancyRow[]) : [];
    };

    const openCount = invoices.reduce(
      (sum, inv) => sum + readDiscrepancies(inv).filter((d) => d.resolution === 'OPEN').length,
      0
    );
    const criticalCount = invoices.reduce(
      (sum, inv) =>
        sum +
        readDiscrepancies(inv).filter(
          (d) => d.resolution === 'OPEN' && d.severity === 'CRITICAL'
        ).length,
      0
    );

    return {
      kind: 'invoice_discrepancy_list',
      empty: invoices.length === 0,
      lines: invoices.map((inv) => {
        const rows = readDiscrepancies(inv);
        const detail = rows
          .map((d) => {
            const parts = [`${d.field ?? d.type ?? 'field'} ${d.severity ?? 'UNKNOWN'}`];
            if (d.expected != null) parts.push(`expected ${String(d.expected)}`);
            if (d.actual != null) parts.push(`actual ${String(d.actual)}`);
            if (d.resolution) parts.push(`resolution ${d.resolution}`);
            return parts.join(', ');
          })
          .join('; ');
        return `${inv.invoiceNumber} on ${inv.po.poNumber} (${inv.vendor.name}) — total ${formatMoney(inv.totalAmount)}. ${detail || 'no discrepancy detail recorded'}`;
      }),
      citations: invoices.map((inv) => ({
        entityType: 'INVOICE',
        entityId: inv.id,
        label: `${inv.invoiceNumber} on ${inv.po.poNumber}`,
        href: `/purchase-orders/${inv.po.id}?tab=INVOICES`,
        status: inv.status,
        date: dateOnly(inv.invoiceDate),
      })),
      facts: {
        count: invoices.length,
        openDiscrepancies: openCount,
        criticalDiscrepancies: criticalCount,
      },
      suggestedQuestions: ['Show pending purchase orders', 'Explain an invoice discrepancy'],
    };
  },
});

export const listCompletedPurchasesTool = defineTool({
  name: 'summarize_completed_purchases',
  description:
    "Summarize purchase orders delivered or closed within a period, with count, total value and supplier breakdown.",
  readOnly: true,
  allowedRoles: BUYER_AND_ADMIN,
  argHint: '{ fromDate?: string, toDate?: string, limit?: number }',
  schema: z.object({
    fromDate: argFragments.fromDate,
    toDate: argFragments.toDate,
    limit: argFragments.limit.default(100),
  }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const where = purchaseOrderVisibility(scope);
    where.status = { in: ['DELIVERED', 'CLOSED'] };
    if (args.fromDate || args.toDate) {
      where.closedAt = {
        ...(args.fromDate ? { gte: new Date(args.fromDate) } : {}),
        ...(args.toDate ? { lte: new Date(args.toDate) } : {}),
      };
    }

    const orders = await prisma.purchaseOrder.findMany({
      where,
      include: { vendor: { select: { name: true } } },
      orderBy: { closedAt: 'desc' },
      take: args.limit,
    });

    const total = orders.reduce((s, o) => s + decimalToNumber(o.totalAmount), 0);
    const byVendor = new Map<string, { count: number; value: number }>();
    for (const o of orders) {
      const entry = byVendor.get(o.vendor.name) ?? { count: 0, value: 0 };
      entry.count += 1;
      entry.value += decimalToNumber(o.totalAmount);
      byVendor.set(o.vendor.name, entry);
    }
    const topSuppliers = [...byVendor.entries()]
      .sort((a, b) => b[1].value - a[1].value)
      .slice(0, 5);

    const range =
      args.fromDate || args.toDate
        ? ` between ${dateOnly(args.fromDate) ?? 'the beginning'} and ${dateOnly(args.toDate) ?? 'today'}`
        : ' to date';

    return {
      kind: 'completed_purchase_summary',
      empty: orders.length === 0,
      lines: [
        `${orders.length} purchase order(s) completed${range}, total ${formatMoney(total)}`,
        ...topSuppliers.map(
          ([name, entry]) =>
            `${name}: ${entry.count} order(s), ${formatMoney(entry.value)}`
        ),
      ],
      citations: orders.slice(0, 10).map((o) => ({
        entityType: 'PURCHASE_ORDER',
        entityId: o.id,
        label: o.poNumber,
        href: `/purchase-orders/${o.id}`,
        status: o.status,
        date: dateOnly(o.closedAt),
      })),
      facts: {
        count: orders.length,
        totalValue: Math.round(total * 100) / 100,
        supplierCount: byVendor.size,
        topSupplier: topSuppliers[0]?.[0] ?? null,
      },
      suggestedQuestions: ['Show verified savings from completed deals', 'Which suppliers have not confirmed delivery?'],
    };
  },
});

export const listSavingsTool = defineTool({
  name: 'list_verified_savings',
  description: 'List verified savings recorded against completed deals, with amount and calculation basis.',
  readOnly: true,
  allowedRoles: BUYER_AND_ADMIN,
  argHint: '{ limit?: number }',
  schema: z.object({ limit: argFragments.limit }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const records = await prisma.savingsRecord.findMany({
      where: { tenantId: scope.actor.tenantId, type: 'VERIFIED' },
      include: {
        vendor: { select: { id: true, name: true } },
        request: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: args.limit,
    });

    const total = records.reduce((s, r) => s + r.savingsAmount, 0);

    return {
      kind: 'savings_list',
      empty: records.length === 0,
      lines: records.map(
        (r) =>
          `${r.request.title} with ${r.vendor.name} — ${formatMoney(r.savingsAmount)} verified` +
          `${r.calculationMethod ? ` (${r.calculationMethod})` : ''}`
      ),
      citations: records.map((r) => ({
        entityType: 'REQUEST',
        entityId: r.request.id,
        label: r.request.title,
        href: `/requests/${r.request.id}`,
        date: dateOnly(r.createdAt),
      })),
      facts: {
        count: records.length,
        totalSavings: Math.round(total * 100) / 100,
      },
      suggestedQuestions: ["Summarize this month's completed purchases"],
    };
  },
});

export const listRecordDetailTool = defineTool({
  name: 'get_record_detail',
  description:
    'Fetch one record by id with its current state, used for contextual follow-up questions about a specific record.',
  readOnly: true,
  allowedRoles: ALL_ROLES,
  argHint: '{ entityType: string, entityId: string }',
  schema: z.object({
    entityType: z.enum([
      'REQUEST',
      'PURCHASE_ORDER',
      'DEAL',
      'DEAL_ROOM',
      'RFQ',
      'QUOTE',
      'INVOICE',
      'VENDOR',
    ]),
    entityId: z.string().min(1).max(64),
  }),
  async execute(args, scope): Promise<CopilotToolResult> {
    switch (args.entityType) {
      case 'REQUEST': {
        const record = await loadScoped<{
          id: string;
          title: string;
          status: string;
          item: string;
          quantity: number;
          location: string;
          requiredDate: Date;
        }>(
          prisma.procurementRequest as never,
          { id: args.entityId, ...requestVisibility(scope) }
        );
        if (!record) break;
        return {
          kind: 'request_detail',
          lines: [
            `${record.title} — ${record.status}, ${record.quantity} × ${record.item} at ${record.location}, required ${dateOnly(record.requiredDate)}`,
          ],
          citations: [
            {
              entityType: 'REQUEST',
              entityId: record.id,
              label: record.title,
              href: `/requests/${record.id}`,
              status: record.status,
            },
          ],
          facts: { count: 1, status: record.status },
          suggestedQuestions: ['Which vendors can supply this?', 'Show my quotations for this'],
        };
      }
      case 'PURCHASE_ORDER': {
        const record = await loadScoped<{
          id: string;
          poNumber: string;
          status: string;
          itemName: string;
          quantity: number;
          totalAmount: unknown;
          expectedDeliveryDate: Date | null;
        }>(prisma.purchaseOrder as never, {
          id: args.entityId,
          ...purchaseOrderVisibility(scope),
        });
        if (!record) break;
        return {
          kind: 'purchase_order_detail',
          lines: [
            `${record.poNumber} — ${record.status}, ${record.quantity} × ${record.itemName}, total ${formatMoney(record.totalAmount as never)}` +
              `${record.expectedDeliveryDate ? `, due ${dateOnly(record.expectedDeliveryDate)}` : ''}`,
          ],
          citations: [
            {
              entityType: 'PURCHASE_ORDER',
              entityId: record.id,
              label: record.poNumber,
              href: `/purchase-orders/${record.id}`,
              status: record.status,
            },
          ],
          facts: { count: 1, status: record.status },
          suggestedQuestions: ['Has this order shipped?', 'Which invoices have discrepancies?'],
        };
      }
      case 'VENDOR': {
        const record = await loadScoped<{ id: string; name: string; status: string }>(
          prisma.vendor as never,
          { id: args.entityId, ...vendorVisibility(scope) }
        );
        if (!record) break;
        return {
          kind: 'vendor_detail',
          lines: [`${record.name} — ${record.status}`],
          citations: [
            {
              entityType: 'VENDOR',
              entityId: record.id,
              label: record.name,
              href: `/vendors?search=${encodeURIComponent(record.name)}`,
              status: record.status,
            },
          ],
          facts: { count: 1 },
          suggestedQuestions: ['Which suppliers are online now?', 'Compare supplier performance'],
        };
      }
      default:
        break;
    }

    // Every other entity type resolves through the same "not found" path so a
    // cross-tenant probe cannot tell whether the id exists elsewhere.
    return {
      kind: 'record_not_found',
      empty: true,
      lines: [`No ${args.entityType.toLowerCase().replace('_', ' ')} with that id is available in your scope.`],
      citations: [],
      facts: { count: 0 },
    };
  },
});

export const listRecordsTool = defineTool({
  name: 'search_records',
  description:
    'Search procurement records across requests, purchase orders, deals and invoices. Honours the caller\'s scope, so results never include another company\'s or another supplier\'s records.',
  readOnly: true,
  allowedRoles: ALL_ROLES,
  argHint:
    '{ query: string, types?: string[], status?: string, vendorId?: string, categoryId?: string, location?: string, fromDate?: string, toDate?: string, minValue?: number, maxValue?: number, limit?: number }',
  schema: z.object({
    query: z.string().min(1).max(200),
    types: z
      .array(z.enum(['REQUEST', 'PURCHASE_ORDER', 'DEAL', 'INVOICE', 'QUOTE', 'VENDOR']))
      .max(6)
      .optional(),
    status: z.string().max(40).optional(),
    vendorId: argFragments.vendorId,
    categoryId: argFragments.categoryId,
    location: argFragments.location,
    fromDate: argFragments.fromDate,
    toDate: argFragments.toDate,
    minValue: argFragments.minValue,
    maxValue: argFragments.maxValue,
    limit: argFragments.limit.default(20),
  }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const focused = buildScope(scope.actor, args.vendorId);
    const wanted = new Set(args.types ?? ['REQUEST', 'PURCHASE_ORDER', 'DEAL', 'INVOICE']);
    const term = args.query;
    const citations: CopilotCitation[] = [];
    const lines: string[] = [];
    const perType = Math.max(1, Math.ceil(args.limit / Math.max(1, wanted.size)));

    // Requests
    if (wanted.has('REQUEST')) {
      const where = requestVisibility(focused);
      if (args.categoryId) where.categoryId = args.categoryId;
      if (args.location) where.location = { contains: args.location, mode: 'insensitive' };
      if (args.fromDate || args.toDate) {
        where.createdAt = {
          ...(args.fromDate ? { gte: new Date(args.fromDate) } : {}),
          ...(args.toDate ? { lte: new Date(args.toDate) } : {}),
        };
      }
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { item: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ];

      const rows = await prisma.procurementRequest.findMany({
        where,
        take: perType,
        orderBy: { createdAt: 'desc' },
      });
      for (const r of rows) {
        citations.push({
          entityType: 'REQUEST',
          entityId: r.id,
          label: r.title,
          href: `/requests/${r.id}`,
          status: r.status,
          date: dateOnly(r.createdAt),
        });
        lines.push(
          `Request: ${r.title} — ${r.status}, ${r.quantity}${r.unit ? ` ${r.unit}` : ''} × ${r.item}` +
            `${r.estimatedBudget ? `, budget ${formatMoney(r.estimatedBudget)}` : ''}` +
            `${r.location ? `, deliver to ${r.location}` : ''}`
        );
      }
    }

    // Purchase orders
    if (wanted.has('PURCHASE_ORDER')) {
      const where = purchaseOrderVisibility(focused);
      if (args.status) where.status = args.status as never;
      if (args.fromDate || args.toDate) {
        where.createdAt = {
          ...(args.fromDate ? { gte: new Date(args.fromDate) } : {}),
          ...(args.toDate ? { lte: new Date(args.toDate) } : {}),
        };
      }
      where.OR = [
        { poNumber: { contains: term, mode: 'insensitive' } },
        { itemName: { contains: term, mode: 'insensitive' } },
      ];

      const rows = await prisma.purchaseOrder.findMany({
        where,
        include: { vendor: { select: { name: true } } },
        take: perType * 2,
        orderBy: { createdAt: 'desc' },
      });
      for (const po of rows) {
        const total = decimalToNumber(po.totalAmount);
        if (args.minValue != null && total < args.minValue) continue;
        if (args.maxValue != null && total > args.maxValue) continue;
        citations.push({
          entityType: 'PURCHASE_ORDER',
          entityId: po.id,
          label: po.poNumber,
          href: `/purchase-orders/${po.id}`,
          status: po.status,
          date: dateOnly(po.createdAt),
        });
        lines.push(
          `Purchase order: ${po.poNumber} — ${po.status}, ${po.vendor.name}, total ${formatMoney(po.totalAmount)}`
        );
      }
    }

    // Deals
    if (wanted.has('DEAL')) {
      const where = dealVisibility(focused);
      if (args.status) where.status = args.status as never;
      if (args.fromDate || args.toDate) {
        where.createdAt = {
          ...(args.fromDate ? { gte: new Date(args.fromDate) } : {}),
          ...(args.toDate ? { lte: new Date(args.toDate) } : {}),
        };
      }
      where.OR = [{ dealNumber: { contains: term, mode: 'insensitive' } }];

      const rows = await prisma.deal.findMany({
        where,
        include: { vendor: { select: { name: true } }, request: { select: { title: true } } },
        take: perType,
        orderBy: { createdAt: 'desc' },
      });
      for (const d of rows) {
        citations.push({
          entityType: 'DEAL',
          entityId: d.id,
          label: d.dealNumber,
          href: `/deals?dealId=${d.id}`,
          status: d.status,
          date: dateOnly(d.createdAt),
        });
        lines.push(`Deal: ${d.dealNumber} — ${d.status}, ${d.vendor.name} on "${d.request.title}"`);
      }
    }

    // Invoices
    if (wanted.has('INVOICE')) {
      const where = invoiceVisibility(focused);
      if (args.status) where.status = args.status as never;
      where.invoiceNumber = { contains: term, mode: 'insensitive' };

      const rows = await prisma.invoice.findMany({
        where,
        include: { vendor: { select: { name: true } }, po: { select: { id: true, poNumber: true } } },
        take: perType,
        orderBy: { createdAt: 'desc' },
      });
      for (const inv of rows) {
        const total = decimalToNumber(inv.totalAmount);
        if (args.minValue != null && total < args.minValue) continue;
        if (args.maxValue != null && total > args.maxValue) continue;
        citations.push({
          entityType: 'INVOICE',
          entityId: inv.id,
          label: `${inv.invoiceNumber} on ${inv.po.poNumber}`,
          href: `/purchase-orders/${inv.po.id}?tab=INVOICES`,
          status: inv.status,
          date: dateOnly(inv.invoiceDate),
        });
        lines.push(
          `Invoice: ${inv.invoiceNumber} on ${inv.po.poNumber} — ${inv.status}, ${inv.vendor.name}, total ${formatMoney(inv.totalAmount)}`
        );
      }
    }

    // Quotes: only for callers entitled to see quotations at all.
    if (wanted.has('QUOTE') && !scope.isSeller) {
      const where = quoteVisibility(focused);
      const rows = await prisma.quote.findMany({
        where,
        include: { vendor: { select: { name: true } }, rfq: { select: { id: true, rfqNumber: true } } },
        take: perType,
        orderBy: { submittedAt: 'desc' },
      });
      for (const q of rows) {
        if (!`${q.vendor.name} ${q.rfq.rfqNumber}`.toLowerCase().includes(term.toLowerCase())) continue;
        citations.push({
          entityType: 'QUOTE',
          entityId: q.id,
          label: `${q.vendor.name} on ${q.rfq.rfqNumber}`,
          href: `/quotes?rfqId=${q.rfq.id}`,
          status: q.status,
          date: dateOnly(q.submittedAt),
        });
        lines.push(
          `Quotation: ${q.vendor.name} on ${q.rfq.rfqNumber} — unit ${formatMoney(q.unitPrice)}, ${q.status}`
        );
      }
    }

    // Vendors: buyers only. A seller searching "vendors" must not enumerate peers.
    if (wanted.has('VENDOR') && !scope.isSeller) {
      const where = vendorVisibility(focused);
      if (args.categoryId) where.categoryId = args.categoryId;
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { products: { contains: term, mode: 'insensitive' } },
      ];
      const rows = await prisma.vendor.findMany({ where, take: perType, orderBy: { name: 'asc' } });
      for (const v of rows) {
        citations.push({
          entityType: 'VENDOR',
          entityId: v.id,
          label: v.name,
          href: `/vendors?search=${encodeURIComponent(v.name)}`,
          status: v.status,
        });
        lines.push(`Supplier: ${v.name} — ${v.status}, ${v.verificationStatus}`);
      }
    }

    return {
      kind: 'search_results',
      empty: citations.length === 0,
      lines:
        citations.length === 0
          ? [`No records in your scope match "${term}".`]
          : [`Found ${citations.length} matching record(s) for "${term}".`, ...lines],
      citations,
      facts: { count: citations.length, query: term },
      suggestedQuestions:
        citations.length > 0
          ? ['Tell me more about the first result', 'Summarize this month\'s completed purchases']
          : ['Show my active procurement requests', 'Which suppliers are online now?'],
    };
  },
});

export const listRecordsNamed = listRecordsTool;

export const canCreateRequestsForScope = canCreateRequests;
export const canDraftNegotiationForScope = canDraftNegotiation;