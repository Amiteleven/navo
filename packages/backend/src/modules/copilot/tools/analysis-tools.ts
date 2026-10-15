import { UserRole } from '@navo/shared';
import prisma from '../../../utils/prisma.js';
import { formatMoney, toDecimal } from '../../../utils/money.js';
import {
  CopilotScope,
  canCreateRequests,
  canDraftNegotiation,
  dealRoomVisibility,
  purchaseOrderVisibility,
  quoteVisibility,
  requestVisibility,
  rfqVisibility,
  vendorVisibility,
} from '../copilot-access.js';
import { CopilotCitation, CopilotToolResult, argFragments, defineTool } from '../tool-registry.js';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '../../../utils/errors.js';

/**
 * Tools that explain *why* a record looks the way it does, plus vendor matching.
 *
 * These are still read-only. Anything that writes lives in `action-tools.ts`
 * and is gated behind explicit user confirmation.
 */

const BUYER_AND_ADMIN = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
  UserRole.REQUESTER,
  UserRole.VIEWER,
] as const;

const dateOnly = (value?: Date | string | null): string | undefined =>
  value ? new Date(value).toISOString().slice(0, 10) : undefined;

// ── Vendor matching ───────────────────────────────────────────────────────────

/**
 * Score suppliers against a requirement.
 *
 * Matching is deterministic and explainable: each signal states the field it
 * came from, so the copilot can say *why* a supplier matched rather than
 * asserting suitability. Score is a ranking aid only, never a commitment.
 */
export const findSuppliersTool = defineTool({
  name: 'find_suppliers',
  description:
    'Match suppliers to a requirement using category, product keywords, location and online availability, explaining each match signal.',
  readOnly: true,
  allowedRoles: BUYER_AND_ADMIN,
  argHint: '{ item?: string, categoryId?: string, location?: string, onlineOnly?: boolean, limit?: number }',
  schema: z.object({
    item: z.string().min(1).max(200).optional(),
    categoryId: argFragments.categoryId,
    location: argFragments.location,
    onlineOnly: z.boolean().default(false),
    limit: argFragments.limit.default(10),
  }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const where = vendorVisibility(scope);
    // Only suppliers the buyer is actually allowed to engage are candidates.
    where.status = { in: ['ACTIVE', 'PENDING_APPROVAL'] };
    if (args.categoryId) where.categoryId = args.categoryId;
    if (args.onlineOnly) where.availability = { is: { isOnline: true } };

    const vendors = await prisma.vendor.findMany({
      where,
      include: { category: true, availability: true, performance: true },
      take: 50,
    });

    const term = (args.item ?? '').toLowerCase();
    const terms = term.split(/[^a-z0-9]+/).filter((t) => t.length > 2);

    interface Scored {
      vendor: (typeof vendors)[number];
      score: number;
      signals: string[];
      matched: boolean;
    }

    const scored: Scored[] = vendors.map((vendor) => {
      const signals: string[] = [];
      let score = 0;
      const products = (vendor.products ?? '').toLowerCase();

      if (args.categoryId && vendor.categoryId === args.categoryId) {
        score += 40;
        signals.push(`category matches ${vendor.category?.name ?? 'the requested category'}`);
      }
      if (terms.length > 0) {
        const hits = terms.filter((t) => products.includes(t));
        if (hits.length > 0) {
          score += Math.min(40, hits.length * 12);
          signals.push(`products list mentions ${hits.join(', ')}`);
        }
      }
      if (args.location) {
        const loc = [vendor.city, vendor.state].filter(Boolean).join(' ').toLowerCase();
        const wanted = args.location.toLowerCase();
        if (loc && (loc.includes(wanted) || wanted.includes(vendor.city?.toLowerCase() ?? ''))) {
          score += 10;
          signals.push(`based in ${[vendor.city, vendor.state].filter(Boolean).join(', ')}`);
        }
      }
      if (vendor.availability?.isOnline) {
        score += 10;
        signals.push('online now');
      }
      if (vendor.verificationStatus === 'VERIFIED') {
        score += 15;
        signals.push('GSTIN verified');
      }
      if (vendor.performance) {
        const onTime = Number(vendor.performance.onTimeDelivery);
        if (onTime > 0) {
          score += Math.min(15, Math.round(onTime / 10));
          signals.push(`${onTime.toFixed(1)}% on-time delivery across ${vendor.performance.totalOrders} order(s)`);
        }
      }

      // With no explicit requirement, every candidate is a weak match; without
      // signals we say so rather than implying suitability.
      const matched = signals.length > 0;
      return { vendor, score, signals, matched };
    });

    const ranked = scored
      .filter((s) => s.matched)
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit);

    return {
      kind: 'supplier_match',
      empty: ranked.length === 0,
      lines: ranked.length
        ? ranked.map(
            (s) =>
              `${s.vendor.name} (${s.vendor.status}, ${s.vendor.verificationStatus}) — ${s.signals.join('; ')}`
          )
        : [
            'No supplier in your tenant matched that requirement on category, product keywords, location or availability. Widen the search or add a supplier first.',
          ],
      citations: ranked.map((s) => ({
        entityType: 'VENDOR',
        entityId: s.vendor.id,
        label: s.vendor.name,
        href: `/vendors?search=${encodeURIComponent(s.vendor.name)}`,
        status: s.vendor.status,
      })),
      facts: {
        count: ranked.length,
        onlineNow: ranked.filter((s) => s.vendor.availability?.isOnline).length,
        topSupplier: ranked[0]?.vendor.name ?? null,
      },
      suggestedQuestions: ranked.length
        ? ['Compare supplier performance', 'Create a procurement request for this']
        : ['Show my vendors', 'Which suppliers are online now?'],
    };
  },
});

/** Suppliers that have already supplied a given category to this tenant. */
export const listCategorySuppliersTool = defineTool({
  name: 'list_category_suppliers',
  description:
    'List suppliers that have previously delivered a given category, with their order count and recorded performance.',
  readOnly: true,
  allowedRoles: BUYER_AND_ADMIN,
  argHint: '{ categoryId: string }',
  schema: z.object({ categoryId: z.string().min(1).max(64) }),
  async execute(args, scope): Promise<CopilotToolResult> {
    // Scoped through the purchase orders the caller may see, so "previously
    // supplied" can only ever be answered from their own records.
    const vendors = await prisma.vendor.findMany({
      where: {
        ...vendorVisibility(scope),
        categoryId: args.categoryId,
        purchaseOrders: { some: purchaseOrderVisibility(scope) },
      },
      include: {
        performance: true,
        category: true,
      },
      take: 20,
    });

    const orderCounts = await Promise.all(
      vendors.map(async (v) => ({
        id: v.id,
        count: await prisma.purchaseOrder.count({
          where: { vendorId: v.id, ...purchaseOrderVisibility(scope) },
        }),
      }))
    );
    const countFor = (id: string) => orderCounts.find((c) => c.id === id)?.count ?? 0;

    return {
      kind: 'category_suppliers',
      empty: vendors.length === 0,
      lines: vendors.map((v) => {
        const p = v.performance;
        return (
          `${v.name} — ${countFor(v.id)} order(s) with this tenant` +
          (p
            ? `, on-time delivery ${Number(p.onTimeDelivery).toFixed(1)}%, quality rating ${Number(p.qualityRating).toFixed(1)}`
            : ', no performance record yet')
        );
      }),
      citations: vendors.map((v) => ({
        entityType: 'VENDOR',
        entityId: v.id,
        label: v.name,
        href: `/vendors?search=${encodeURIComponent(v.name)}`,
        status: v.status,
      })),
      facts: { count: vendors.length },
      suggestedQuestions: ['Find suppliers who can provide this', 'Compare supplier performance'],
    };
  },
});

// ── Quotation analysis ────────────────────────────────────────────────────────

/**
 * Compare quotations on one RFQ deterministically.
 *
 * Differences are computed here with the shared money helpers. Every missing
 * field is reported as missing rather than defaulted, and quotations whose
 * quantities differ are flagged as not directly comparable - presenting them as
 * equivalent would be a false statement about cost.
 */
export const compareQuotesTool = defineTool({
  name: 'compare_quotes',
  description:
    'Compare quotations on an RFQ across unit price, total landed cost, tax, delivery, warranty and payment terms, flagging missing data and non-comparable specifications.',
  readOnly: true,
  allowedRoles: BUYER_AND_ADMIN,
  argHint: '{ rfqId: string }',
  schema: z.object({ rfqId: z.string().min(1).max(64) }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const rfq = await prisma.rFQ.findFirst({
      where: { id: args.rfqId, ...rfqVisibility(scope) },
      select: { id: true, rfqNumber: true, title: true, quantity: true },
    });
    if (!rfq) {
      return {
        kind: 'quote_comparison',
        empty: true,
        lines: ['That request for quotations is not available in your scope.'],
        citations: [],
        facts: { count: 0 },
      };
    }

    const quotes = await prisma.quote.findMany({
      where: { rfqId: rfq.id, ...quoteVisibility(scope) },
      include: { vendor: { select: { name: true } } },
    });

    if (quotes.length === 0) {
      return {
        kind: 'quote_comparison',
        empty: true,
        lines: [
          `No quotations have been submitted for ${rfq.rfqNumber} yet. Nothing can be compared until at least one supplier quotes.`,
        ],
        citations: [
          {
            entityType: 'RFQ',
            entityId: rfq.id,
            label: rfq.rfqNumber,
            href: `/rfqs`,
          },
        ],
        facts: { count: 0, rfqNumber: rfq.rfqNumber },
        suggestedQuestions: ['Which suppliers are online now?', 'Show my pending requests'],
      };
    }

    const rows = quotes
      .map((q) => {
        const base = toDecimal(q.unitPrice).times(q.quantity);
        const tax = toDecimal(q.taxAmount);
        const freight = toDecimal(q.freightAmount);
        const installation = toDecimal(q.installationAmount);
        const other = toDecimal(q.otherCharges);
        const landed = base.plus(tax).plus(freight).plus(installation).plus(other);
        return {
          id: q.id,
          vendorName: q.vendor.name,
          unitPrice: q.unitPrice,
          quantity: q.quantity,
          base,
          taxAmount: tax,
          freightAmount: freight,
          installationAmount: installation,
          otherCharges: other,
          landed,
          taxRate: q.taxRate,
          warrantyMonths: q.warrantyMonths,
          deliveryTimelineDays: q.deliveryTimelineDays,
          paymentTerms: q.paymentTerms,
          status: q.status,
          missing: [
            q.warrantyMonths == null ? 'warranty' : null,
            q.deliveryTimelineDays == null ? 'delivery timeline' : null,
            q.paymentTerms == null || q.paymentTerms === '' ? 'payment terms' : null,
          ].filter((v): v is string => v != null),
        };
      })
      .sort((a, b) => Number(a.landed.minus(b.landed)));

    const quantitiesDiffer = new Set(rows.map((r) => r.quantity)).size > 1;
    const cheapest = rows[0];
    const dearest = rows[rows.length - 1];
    const spread =
      cheapest && dearest ? Number(dearest.landed.minus(cheapest.landed)) : 0;

    const lines: string[] = [
      `${rows.length} quotation(s) on ${rfq.rfqNumber} for ${rfq.quantity} unit(s).`,
    ];

    if (quantitiesDiffer) {
      lines.push(
        'Warning: the quotations quote different quantities, so the totals below are not directly comparable without normalising to a single quantity.'
      );
    }

    for (const r of rows) {
      const freight = toDecimal(r.freightAmount);
      const installation = toDecimal(r.installationAmount);
      const other = toDecimal(r.otherCharges);
      lines.push(
        `${r.vendorName}: unit ${formatMoney(r.unitPrice)}, landed ${formatMoney(r.landed)}` +
          ` (base ${formatMoney(r.base)}, tax ${r.taxRate}% = ${formatMoney(r.taxAmount)}` +
          `${freight.gt(0) ? `, freight ${formatMoney(freight)}` : ''}` +
          `${installation.gt(0) ? `, installation ${formatMoney(installation)}` : ''}` +
          `${other.gt(0) ? `, other ${formatMoney(other)}` : ''}` +
          `)` +
          `${r.warrantyMonths != null ? `, warranty ${r.warrantyMonths} months` : ''}` +
          `${r.deliveryTimelineDays != null ? `, delivery ${r.deliveryTimelineDays} days` : ''}` +
          `${r.paymentTerms ? `, terms ${r.paymentTerms}` : ''}` +
          `${r.missing.length ? ` — not stated: ${r.missing.join(', ')}` : ''}`
      );
    }

    if (cheapest && dearest && rows.length > 1) {
      lines.push(
        `Cheapest landed cost: ${cheapest.vendorName} at ${formatMoney(cheapest.landed)}. ` +
          `Spread to the highest is ${formatMoney(spread)}.`
      );
    }

    return {
      kind: 'quote_comparison',
      empty: false,
      lines,
      citations: rows.map((r) => ({
        entityType: 'QUOTE',
        entityId: r.id,
        label: `${r.vendorName} on ${rfq.rfqNumber}`,
        href: `/quotes?rfqId=${rfq.id}`,
        status: r.status,
      })),
      facts: {
        count: rows.length,
        rfqNumber: rfq.rfqNumber,
        lowestLandedCost: cheapest ? Number(cheapest.landed) : null,
        lowestVendor: cheapest?.vendorName ?? null,
        priceSpread: Math.round(spread * 100) / 100,
        comparableQuantities: !quantitiesDiffer,
        suppliersMissingTerms: rows.filter((r) => r.missing.length > 0).length,
      },
      suggestedQuestions: ['Draft a counteroffer to the lowest quote', 'Which suppliers have not quoted?'],
    };
  },
});

// ── Negotiation drafting ──────────────────────────────────────────────────────

/**
 * Draft a negotiation message from actual quote history.
 *
 * The draft is deterministic: it is assembled from the real offers on the room
 * and the real landed-cost arithmetic, then handed back as a *proposal*. Nothing
 * is sent until the user confirms, and one supplier's pricing is never mixed
 * into a message addressed to another.
 */
export const draftNegotiationTool = defineTool({
  name: 'draft_negotiation',
  description:
    'Draft a counteroffer or negotiation message for a deal room using the offers actually recorded there. Returns a draft for review; it is never sent automatically.',
  readOnly: true,
  allowedRoles: BUYER_AND_ADMIN,
  argHint: '{ dealRoomId: string, targetUnitPrice?: number, note?: string }',
  schema: z.object({
    dealRoomId: z.string().min(1).max(64),
    targetUnitPrice: z.number().min(0).optional(),
    note: z.string().max(1000).optional(),
  }),
  async execute(args, scope): Promise<CopilotToolResult> {
    if (!canDraftNegotiation(scope)) {
      throw new ForbiddenError('Only buyer accounts can draft negotiation messages');
    }

    const room = await prisma.dealRoom.findFirst({
      where: { id: args.dealRoomId, ...dealRoomVisibility(scope) },
      include: {
        vendor: { select: { name: true } },
        request: { select: { title: true, quantity: true } },
        offers: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!room) {
      throw new NotFoundError('Deal room');
    }
    if (['CLOSED', 'EXPIRED'].includes(room.status)) {
      return {
        kind: 'negotiation_draft',
        empty: true,
        lines: [`The deal room with ${room.vendor.name} is ${room.status.toLowerCase()} and cannot receive new messages.`],
        citations: [],
        facts: { count: 0 },
      };
    }

    const latestByParty = new Map<string, (typeof room.offers)[number]>();
    for (const offer of room.offers) {
      if (!latestByParty.has(offer.submittedByRole)) {
        latestByParty.set(offer.submittedByRole, offer);
      }
    }

    const quantity = room.request.quantity;
    const supplierOffer = [...latestByParty.values()].find(
      (o) => o.submittedByRole !== 'BUYER' && o.submittedByRole !== 'REQUESTER'
    );

    const landedFor = (offer: (typeof room.offers)[number]) =>
      toDecimal(offer.unitPrice)
        .times(offer.quantity)
        .plus(toDecimal(offer.freightAmount))
        .plus(toDecimal(offer.installationAmount))
        .plus(toDecimal(offer.otherCharges));

    const target = args.targetUnitPrice;
    const draftLines: string[] = [];

    draftLines.push(
      `Regarding "${room.request.title}" — thank you for the revised terms.`
    );

    if (supplierOffer && target != null) {
      const supplierLanded = landedFor(supplierOffer);
      const targetLanded = toDecimal(target)
        .times(quantity)
        .plus(toDecimal(supplierOffer.freightAmount))
        .plus(toDecimal(supplierOffer.installationAmount))
        .plus(toDecimal(supplierOffer.otherCharges));
      const delta = supplierLanded.minus(targetLanded);

      draftLines.push(
        `Your latest offer is ${formatMoney(supplierOffer.unitPrice)} per unit, a landed total of ${formatMoney(supplierLanded)} for ${quantity} unit(s).`
      );
      draftLines.push(
        `We can confirm the order at ${formatMoney(target)} per unit if you can hold that price` +
          `${supplierOffer.warrantyMonths ? ` and maintain the ${supplierOffer.warrantyMonths}-month warranty` : ''}` +
          `${supplierOffer.deliveryTimelineDays ? ` and the ${supplierOffer.deliveryTimelineDays}-day delivery timeline` : ''}.` +
          (delta.gt(0)
            ? ` That is ${formatMoney(delta)} below your quoted landed cost.`
            : ' That is above your quoted landed cost.')
      );
    } else if (supplierOffer) {
      draftLines.push(
        `Your latest offer is ${formatMoney(supplierOffer.unitPrice)} per unit, a landed total of ${formatMoney(landedFor(supplierOffer))} for ${quantity} unit(s).`
      );
      draftLines.push(
        'Please confirm whether you can improve on unit price, and on freight and installation charges if those were quoted separately.'
      );
    } else {
      draftLines.push('Please share your best unit price, landed cost and delivery timeline.');
    }

    if (args.note) draftLines.push(args.note);

    return {
      kind: 'negotiation_draft',
      empty: false,
      lines: draftLines,
      citations: [
        {
          entityType: 'DEAL_ROOM',
          entityId: room.id,
          label: `${room.request.title} × ${room.vendor.name}`,
          href: `/deals/new?dealRoomId=${room.id}`,
          status: room.status,
        },
      ],
      facts: {
        count: 1,
        dealRoomId: room.id,
        offerCount: room.offers.length,
        hasSupplierOffer: Boolean(supplierOffer),
        targetUnitPrice: target ?? null,
      },
      suggestedQuestions: ['Open the deal room', 'Summarize the latest offer'],
    };
  },
});

// ── Order and invoice explanation ─────────────────────────────────────────────

/**
 * Explain a purchase order's delivery state, grounded in recorded delivery
 * events and receipts. It never asserts that an order shipped unless a
 * DISPATCH event exists.
 */
export const explainOrderTool = defineTool({
  name: 'explain_order',
  description:
    'Explain a purchase order\'s delivery and receipt state from its recorded events, and state plainly what has not happened yet.',
  readOnly: true,
  allowedRoles: [
    ...BUYER_AND_ADMIN,
    UserRole.VENDOR,
  ],
  argHint: '{ purchaseOrderId: string }',
  schema: z.object({ purchaseOrderId: z.string().min(1).max(64) }),
  async execute(args, scope): Promise<CopilotToolResult> {
    const po = await prisma.purchaseOrder.findFirst({
      where: { id: args.purchaseOrderId, ...purchaseOrderVisibility(scope) },
      include: {
        vendor: { select: { name: true } },
        deliveryEvents: { orderBy: { occurredAt: 'asc' } },
        goodsReceipts: { orderBy: { createdAt: 'asc' } },
        invoices: {
          include: { verifications: { orderBy: { createdAt: 'desc' }, take: 1 } },
        },
        payments: { orderBy: { paidAt: 'asc' } },
      },
    });
    if (!po) {
      throw new NotFoundError('Purchase order');
    }

    const shipped = po.deliveryEvents.some((e) => e.type === 'DISPATCH');
    const delivered = po.deliveryEvents.some((e) => e.type === 'DELIVERED');
    const acceptedQuantity = po.goodsReceipts.reduce((s, r) => s + Number(r.acceptedQuantity), 0);
    const rejectedQuantity = po.goodsReceipts.reduce((s, r) => s + Number(r.rejectedQuantity), 0);
    const paidAmount = po.payments.reduce((s, p) => s + Number(p.paidAmount), 0);
    const orderTotal = Number(po.totalAmount);

    const lines = [
      `${po.poNumber} is ${po.status} with ${po.vendor.name}: ${po.quantity} × ${po.itemName}, total ${formatMoney(po.totalAmount)}.`,
    ];

    lines.push(
      shipped
        ? `Dispatch is recorded (${po.dispatchTrackingRef ?? 'no tracking reference supplied'}).`
        : 'Dispatch has not been recorded for this order.'
    );
    lines.push(
      delivered
        ? 'Delivery is recorded.'
        : po.status === 'DELIVERED' || po.status === 'CLOSED'
          ? 'The order is marked delivered.'
          : 'Delivery is not recorded yet.'
    );
    lines.push(
      `Goods received: ${acceptedQuantity} accepted, ${rejectedQuantity} rejected, of ${po.quantity} ordered.`
    );

    const discrepancies = po.invoices.flatMap((inv) => {
      const list = inv.verifications[0]?.discrepancies;
      return Array.isArray(list)
        ? (list as Array<{ field?: string; severity?: string; resolution?: string; expected?: unknown; actual?: unknown }>).map((d) => ({ ...d, invoiceNumber: inv.invoiceNumber }))
        : [];
    });
    const openDiscrepancies = discrepancies.filter((d) => d.resolution === 'OPEN');

    lines.push(
      openDiscrepancies.length === 0
        ? 'No unresolved invoice discrepancies.'
        : `${openDiscrepancies.length} unresolved invoice discrepancy(ies): ` +
          openDiscrepancies
            .map(
              (d) =>
                `${d.invoiceNumber} ${d.field ?? 'field'} (${d.severity ?? 'UNKNOWN'}), expected ${String(d.expected)}, actual ${String(d.actual)}`
            )
            .join('; ')
    );

    lines.push(
      paidAmount === 0
        ? `No payment has been recorded. Order value ${formatMoney(orderTotal)}.`
        : orderTotal - paidAmount > 0
          ? `Paid ${formatMoney(paidAmount)} of ${formatMoney(orderTotal)}; outstanding ${formatMoney(orderTotal - paidAmount)}.`
          : `Paid in full (${formatMoney(paidAmount)}).`
    );

    return {
      kind: 'order_explanation',
      empty: false,
      lines,
      citations: [
        {
          entityType: 'PURCHASE_ORDER',
          entityId: po.id,
          label: po.poNumber,
          href: `/purchase-orders/${po.id}`,
          status: po.status,
          date: dateOnly(po.expectedDeliveryDate),
        },
      ],
      facts: {
        count: 1,
        status: po.status,
        shipped,
        delivered,
        acceptedQuantity,
        rejectedQuantity,
        openDiscrepancies: openDiscrepancies.length,
        paidAmount,
        outstanding: Math.round((orderTotal - paidAmount) * 100) / 100,
      },
      suggestedQuestions: ['Which invoices have discrepancies?', 'Show pending purchase orders'],
    };
  },
});