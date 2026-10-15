import {
  ApprovalStatus,
  DiscrepancyResolution,
  DiscrepancySeverity,
  InvoiceMatchStatus,
  PaymentStatus,
  PurchaseOrderStatus,
  UserRole,
} from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { decimalToNumber } from '../../utils/money.js';
import { ActorContext, loadAccessiblePo, PO_ADMIN_ROLES, resolveSellerVendor } from './po-access.js';
import { buildPoSummary, getPurchaseTimeline } from './timeline.service.js';

/**
 * Purchase-order assistant.
 *
 * This is deliberately NOT an LLM. `OPENAI_API_KEY` in this deployment is a
 * placeholder, so a real model call would fail and fall back anyway. More
 * importantly, every answer here is a deterministic restatement of authoritative
 * database records, and each response carries `source: 'application_data'` plus
 * the rows it was derived from. A user can therefore verify any statement, and
 * the module cannot invent a figure, a status or a recommendation.
 */

export interface AssistantResponse {
  answer: string;
  /** Always 'application_data' - the answer came from stored records. */
  source: 'application_data';
  /** Labels identifying the records the answer was derived from. */
  evidence: string[];
  /** Follow-up questions the user can ask about the same records. */
  suggestedQuestions: string[];
  /** True when the question could not be answered from stored data. */
  notAnswerable?: boolean;
}

/*
 * Status sets as plain strings: values read back from the database are Prisma
 * enum members, which are nominally distinct from the shared enum.
 */
const CLOSED_STATUSES: string[] = [
  PurchaseOrderStatus.DELIVERED,
  PurchaseOrderStatus.CLOSED,
  PurchaseOrderStatus.CANCELLED,
];
const IN_FLIGHT_STATUSES: string[] = [
  PurchaseOrderStatus.ISSUED,
  PurchaseOrderStatus.SUPPLIER_CONFIRMED,
  PurchaseOrderStatus.IN_PROGRESS,
];

/** Topics the assistant recognises, matched against the user's question. */
type Topic =
  | 'status'
  | 'delivery'
  | 'payment'
  | 'invoice'
  | 'discrepancy'
  | 'history'
  | 'summary'
  | 'approval'
  | 'count'
  | 'unknown';

export function detectTopic(question: string): Topic {
  const q = question.toLowerCase();

  if (/\b(history|timeline|what happened|log|trail|sequence)\b/.test(q)) return 'history';
  if (/\b(overdue|late|delay|delayed|behind|shipping|shipped|dispatch|transit|arrive)\b/.test(q)) return 'delivery';
  if (/\b(pay|paid|payment|invoice|amount due|outstanding|settle|owe)\b/.test(q)) return 'payment';
  if (/\b(mismatch|discrepanc|discrepancies|error|problem|wrong|block)\b/.test(q)) return 'discrepancy';
  if (/\b(invoice|match|verify|verified|three-way)\b/.test(q)) return 'invoice';
  if (/\b(approv|sign-?off|signoff)\b/.test(q)) return 'approval';
  if (/\b(how many|list|count|orders|purchase orders)\b/.test(q)) return 'count';
  if (/\b(status|where is|what.*state|progress|summar|overview)\b/.test(q)) return 'status';
  // A question about a purchase order must mention something the assistant
  // actually tracks. Falling through to a summary for "what is the weather"
  // would answer something nobody asked.
  if (/\b(order|purchase order|po|supplier|vendor|invoice|payment|delivery|receipt|approval|document|status|amount|quantity|price|total)\b/.test(q)) {
    return 'summary';
  }
  return 'unknown';
}

export async function explainPurchaseOrder(
  question: string,
  actor: ActorContext,
  poId?: string,
): Promise<AssistantResponse> {
  const topic = detectTopic(question);

  // A question the assistant cannot ground in any stored record is refused
  // rather than answered with whatever topic happens to be closest.
  if (topic === 'unknown') {
    return {
      answer:
        'That is outside what I can answer. I can only report on recorded purchase order data: ' +
        'status, delivery progress, receipts, invoices and discrepancies, payments, approvals, ' +
        'documents and the transaction history.',
      source: 'application_data',
      evidence: [],
      suggestedQuestions: [
        'What is the current status of this order?',
        'How much has been paid so far?',
        'Are there any discrepancies?',
      ],
      notAnswerable: true,
    };
  }

  // Questions about a specific PO answer from that PO; portfolio questions
  // ("how many orders are delayed?") are answered across the actor's scope.
  if (poId) {
    return answerForPo(poId, topic, actor);
  }
  return answerAcrossScope(topic, actor, question);
}

async function answerForPo(poId: string, topic: Topic, actor: ActorContext): Promise<AssistantResponse> {
  // loadAccessiblePo enforces tenant and seller scoping; the summary and
  // timeline builders re-check access on every related record.
  const po = await loadAccessiblePo(poId, actor);
  const summary = await buildPoSummary(poId, actor);
  const evidence = [`Purchase order ${po.poNumber}`];

  if (!summary) {
    return {
      answer: 'No summary is available for this purchase order.',
      source: 'application_data',
      evidence,
      suggestedQuestions: [],
      notAnswerable: true,
    };
  }

  switch (topic) {
    case 'status':
    case 'summary': {
      evidence.push('PurchaseOrder', 'GoodsReceipt', 'Invoice', 'InvoiceVerification', 'Payment');
      return respond(summary.narrative, evidence, summary, [
        'What is the delivery status?',
        'What is outstanding on payment?',
        'Show the full transaction history',
      ]);
    }

    case 'delivery': {
      evidence.push('PurchaseOrder.expectedDeliveryDate', 'PurchaseOrder.supplierConfirmedDeliveryDate', 'DeliveryEvent');
      const events = await prisma.deliveryEvent.findMany({
        where: { poId },
        orderBy: { occurredAt: 'asc' },
        select: { type: true, occurredAt: true, notes: true, trackingRef: true },
      });

      const parts = [`Delivery status: ${summary.status.toLowerCase().replace(/_/g, ' ')}.`];
      parts.push(
        summary.expectedDeliveryDate
          ? `Committed delivery date is ${new Date(summary.expectedDeliveryDate).toISOString().slice(0, 10)}.`
          : 'No delivery date has been committed by the supplier.',
      );
      if (summary.daysDelayed) {
        parts.push(`This order is ${summary.daysDelayed} day(s) past its committed delivery date.`);
      }
      parts.push(
        `${summary.acceptedQuantity} of ${summary.orderedQuantity} units accepted` +
          (summary.rejectedQuantity > 0 ? `, ${summary.rejectedQuantity} rejected.` : '.'),
      );
      if (events.length > 0) {
        parts.push(
          `Recorded milestones: ${events.map((e) => `${e.type.replace(/_/g, ' ').toLowerCase()} on ${e.occurredAt.toISOString().slice(0, 10)}`).join(', ')}.`,
        );
      }

      return respond(parts.join(' '), evidence, summary, [
        'What is outstanding on payment?',
        'Show the full transaction history',
        'Are there any discrepancies?',
      ]);
    }

    case 'payment': {
      evidence.push('Payment', 'Invoice.totalAmount', 'PurchaseOrder.totalAmount');
      const payments = await prisma.payment.findMany({
        where: { poId },
        select: { status: true, amount: true, paidAmount: true, reference: true, paidAt: true },
      });

      const parts: string[] = [];
      if (payments.length === 0) {
        parts.push(
          `No payment has been recorded. The order value is ${summary.totalAmount.toFixed(2)} ${summary.currency}.`,
        );
      } else {
        parts.push(`Total order value ${summary.totalAmount.toFixed(2)} ${summary.currency}.`);
        parts.push(`Paid to date ${summary.paidAmount.toFixed(2)} ${summary.currency}.`);
        if (summary.outstandingAmount < 0) {
          // Paid beyond the order value. Reported as an overpayment rather than a
          // negative balance, which reads as a bug rather than an overpayment.
          parts.push(
            `Overpaid by ${Math.abs(summary.outstandingAmount).toFixed(2)} ${summary.currency} ` +
              'against the order value.',
          );
        } else {
          parts.push(`Outstanding ${summary.outstandingAmount.toFixed(2)} ${summary.currency}.`);
        }
        for (const p of payments) {
          parts.push(
            `Recorded payment: ${p.status.toLowerCase().replace(/_/g, ' ')}, ` +
              `${decimalToNumber(p.paidAmount).toFixed(2)} of ${decimalToNumber(p.amount).toFixed(2)}` +
              (p.reference ? ` (reference ${p.reference})` : '') +
              (p.paidAt ? ` on ${p.paidAt.toISOString().slice(0, 10)}` : '') +
              '.',
          );
        }
      }
      if (summary.openDiscrepancies > 0) {
        parts.push(
          `${summary.openDiscrepancies} unresolved discrepancy(s) are present; payments cannot be recorded while a critical discrepancy is open.`,
        );
      }

      return respond(parts.join(' '), evidence, summary, [
        'Are there any discrepancies?',
        'Show the full transaction history',
        'What is the delivery status?',
      ]);
    }

    case 'invoice':
    case 'discrepancy': {
      const invoices = await prisma.invoice.findMany({
        where: { poId },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          totalAmount: true,
          invoiceDate: true,
          verifications: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true, matched: true, discrepancies: true, toleranceAmount: true },
          },
        },
      });

      if (invoices.length === 0) {
        return respond(
          `No invoice has been raised against this purchase order yet. Order value is ${summary.totalAmount.toFixed(2)} ${summary.currency}.`,
          ['Invoice (none)'],
          summary,
          ['What is outstanding on payment?', 'What is the delivery status?'],
        );
      }

      evidence.push('Invoice', 'InvoiceVerification');

      const parts = [`${invoices.length} invoice(s) recorded, totalling ${summary.invoicedAmount.toFixed(2)} ${summary.currency}.`];
      for (const invoice of invoices) {
        const verification = invoice.verifications[0];
        parts.push(
          `Invoice ${invoice.invoiceNumber} for ${decimalToNumber(invoice.totalAmount).toFixed(2)} ${summary.currency} is ${invoice.status.toLowerCase().replace(/_/g, ' ')}.`,
        );

        if (!verification || verification.status === InvoiceMatchStatus.NOT_STARTED) {
          parts.push('It has not been verified yet.');
          continue;
        }

        const list = (verification.discrepancies as unknown as Array<Record<string, unknown>> | null) ?? [];
        if (verification.matched) {
          parts.push(
            `Three-way match passed within a tolerance of ${decimalToNumber(verification.toleranceAmount).toFixed(2)}.`,
          );
        } else {
          parts.push(`Three-way match found ${list.length} discrepancy(ies):`);
          for (const d of list) {
            const resolved = d.resolution && d.resolution !== DiscrepancyResolution.OPEN;
            parts.push(
              `- ${d.field} [${String(d.severity).toLowerCase()}]: expected ${d.expected ?? '-'}, actual ${d.actual ?? '-'}` +
                (d.difference ? ` (difference ${d.difference})` : '') +
                (resolved ? ` - ${String(d.resolution).toLowerCase()}` : ' - unresolved') +
                '.',
            );
          }
        }
      }

      if (summary.openDiscrepancies > 0) {
        parts.push(`${summary.openDiscrepancies} discrepancy(s) remain open and block payment.`);
      }

      return respond(parts.join(' '), evidence, summary, [
        'What is outstanding on payment?',
        'Show the full transaction history',
        'What is the delivery status?',
      ]);
    }

    case 'approval': {
      const approvals = await prisma.purchaseOrderApproval.findMany({
        where: { poId },
        orderBy: { level: 'asc' },
        select: { level: true, requiredRole: true, status: true, comments: true, decidedAt: true },
      });

      if (approvals.length === 0) {
        return respond('No approval levels are configured for this purchase order.', ['PurchaseOrderApproval (none)'], summary, [
          'What is the current status?',
        ]);
      }

      evidence.push('PurchaseOrderApproval');
      const pending = approvals.filter((a) => a.status === ApprovalStatus.PENDING);
      const parts = [
        `This purchase order requires ${approvals.length} approval level(s).`,
        ...approvals.map(
          (a) =>
            `- Level ${a.level} (${a.requiredRole.replace(/_/g, ' ').toLowerCase()}): ${a.status.toLowerCase()}` +
            (a.decidedAt ? ` on ${a.decidedAt.toISOString().slice(0, 10)}` : '') +
            (a.comments ? ` - ${a.comments}` : ''),
        ),
      ];
      if (pending.length > 0) {
        parts.push(
          `${pending.length} level(s) still pending, so the order cannot be issued until they are approved.`,
        );
      } else {
        parts.push('All approval levels are approved.');
      }

      return respond(parts.join(' '), evidence, summary, [
        'What is the current status?',
        'Show the full transaction history',
      ]);
    }

    case 'history': {
      evidence.push('AuditLog', 'DeliveryEvent', 'GoodsReceipt', 'InvoiceVerification', 'Payment');
      const entries = await getPurchaseTimeline(poId, actor);
      if (entries.length === 0) {
        return respond('No transaction history is recorded for this purchase order.', evidence, summary, [
          'What is the current status?',
        ]);
      }

      const lines = entries.map((entry) => {
        const when = new Date(entry.at).toISOString().slice(0, 10);
        const who = entry.actorName ?? (entry.actorId ? `user ${entry.actorId}` : 'system');
        return `- ${when} [${entry.stage}] ${entry.title}` +
          (entry.detail ? ` - ${entry.detail}` : '') +
          (entry.status ? ` (${entry.status})` : '') +
          ` [recorded by ${who}, source: ${entry.source}]`;
      });

      return respond(
        `Transaction history for ${summary.poNumber} (${entries.length} entries):\n${lines.join('\n')}`,
        evidence,
        summary,
        ['What is the current status?', 'Are there any discrepancies?', 'What is outstanding on payment?'],
      );
    }

    case 'count':
    default:
      return respond(summary.narrative, ['PurchaseOrder', 'GoodsReceipt', 'Invoice', 'Payment'], summary, [
        'Show the full transaction history',
        'What is the delivery status?',
      ]);
  }
}

async function answerAcrossScope(topic: Topic, actor: ActorContext, question: string): Promise<AssistantResponse> {
  const seller = await resolveSellerVendor(actor.userId);

  const where: Record<string, unknown> = { tenantId: actor.tenantId };
  if (actor.role === UserRole.VENDOR && seller) {
    where.vendorId = seller.vendorId;
  } else if (!PO_ADMIN_ROLES.includes(actor.role)) {
    // Non-admin buyers see only the orders they raised.
    where.buyerId = actor.userId;
  }

  const evidence = ['PurchaseOrder', 'GoodsReceipt', 'DeliveryEvent', 'InvoiceVerification'];

  if (topic === 'count' || topic === 'status' || topic === 'summary') {
    const [total, byStatus] = await Promise.all([
      prisma.purchaseOrder.count({ where }),
      prisma.purchaseOrder.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);

    const breakdown = byStatus.map((g) => `${g.status.toLowerCase().replace(/_/g, ' ')}: ${g._count._all}`).join(', ');
    return {
      answer: total === 0
        ? 'There are no purchase orders in your scope yet.'
        : `You have ${total} purchase order(s).` + (breakdown ? ` By status - ${breakdown}.` : ''),
      source: 'application_data',
      evidence,
      suggestedQuestions: ['Which orders are delayed?', 'What is outstanding on payment?', 'Are there any discrepancies?'],
    };
  }

  if (topic === 'delivery') {
    const orders = await prisma.purchaseOrder.findMany({
      where,
      select: {
        poNumber: true,
        status: true,
        expectedDeliveryDate: true,
        supplierConfirmedDeliveryDate: true,
        quantity: true,
        goodsReceipts: { select: { acceptedQuantity: true } },
      },
      orderBy: { expectedDeliveryDate: 'asc' },
    });

    const now = Date.now();
    const delayed = orders.filter((o) => {
      const committed = o.supplierConfirmedDeliveryDate ?? o.expectedDeliveryDate;
      return (
        committed &&
        new Date(committed).getTime() < now &&
        !CLOSED_STATUSES.includes(o.status)
      );
    });

    const inFlight = orders.filter((o) =>
      IN_FLIGHT_STATUSES.includes(o.status),
    );

    const parts = [
      `${orders.length} purchase order(s) in your scope; ${delayed.length} past their committed delivery date and ${inFlight.length} still in flight.`,
    ];

    if (delayed.length > 0) {
      parts.push('Past the committed delivery date:');
      for (const o of delayed.slice(0, 10)) {
        const committed = o.supplierConfirmedDeliveryDate ?? o.expectedDeliveryDate!;
        const days = Math.floor((now - new Date(committed).getTime()) / 86_400_000);
        const accepted = o.goodsReceipts.reduce((s, r) => s + r.acceptedQuantity, 0);
        parts.push(`- ${o.poNumber}: ${days} day(s) late, ${accepted} of ${o.quantity} units accepted.`);
      }
    }

    return {
      answer: parts.join(' '),
      source: 'application_data',
      evidence,
      suggestedQuestions: ['What is outstanding on payment?', 'Are there any discrepancies?'],
    };
  }

  if (topic === 'payment' || topic === 'invoice' || topic === 'discrepancy') {
    const orders = await prisma.purchaseOrder.findMany({
      where,
      select: {
        id: true,
        poNumber: true,
        totalAmount: true,
        currency: true,
        payments: { select: { paidAmount: true } },
        // A relation `select` cannot take orderBy/take, and Prisma rejects mixing
        // `include` with `select` on the same relation, so every verification is
        // fetched and the most recent is chosen below.
        invoices: {
          select: {
            id: true,
            invoiceNumber: true,
            verifications: {
              select: {
                discrepancies: true,
                matched: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });

    /** Newest verification per invoice; the schema stores at most one in practice. */
    const latestVerification = <T extends { createdAt: Date }>(
      invoice: { verifications: T[] }
    ) =>
      [...invoice.verifications].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
      )[0];

    if (topic === 'discrepancy') {
      const withOpen: string[] = [];
      let openCount = 0;
      for (const order of orders) {
        for (const invoice of order.invoices) {
          const list = (latestVerification(invoice)?.discrepancies as unknown as Array<Record<string, unknown>> | null) ?? [];
          const open = list.filter((d) => d.resolution === DiscrepancyResolution.OPEN);
          if (open.length > 0) {
            openCount += open.length;
            const critical = open.filter((d) => d.severity === DiscrepancySeverity.CRITICAL).length;
            withOpen.push(
              `- ${order.poNumber} / invoice ${invoice.invoiceNumber}: ${open.length} open (${critical} critical) - ` +
                open.map((d) => d.field).join(', '),
            );
          }
        }
      }

      return {
        answer:
          openCount === 0
            ? 'There are no unresolved invoice discrepancies in your scope.'
            : `${openCount} unresolved discrepancy(ies) across ${withOpen.length} invoice(s):\n${withOpen.join('\n')}`,
        source: 'application_data',
        evidence: ['Invoice', 'InvoiceVerification'],
        suggestedQuestions: ['What is outstanding on payment?', 'Which orders are delayed?'],
      };
    }

    let totalValue = 0;
    let totalPaid = 0;
    let totalOutstanding = 0;
    let invoiced = 0;
    for (const order of orders) {
      const value = decimalToNumber(order.totalAmount);
      const paid = order.payments.reduce((s, p) => s + decimalToNumber(p.paidAmount), 0);
      totalValue += value;
      totalPaid += paid;
      totalOutstanding += Math.max(0, value - paid);
      invoiced += order.invoices.length;
    }

    return {
      answer:
        `Across ${orders.length} purchase order(s): total value ${totalValue.toFixed(2)}, paid ${totalPaid.toFixed(2)}, ` +
        `outstanding ${totalOutstanding.toFixed(2)}. ${invoiced} invoice(s) recorded.`,
      source: 'application_data',
      evidence: ['PurchaseOrder.totalAmount', 'Payment.paidAmount', 'Invoice'],
      suggestedQuestions: ['Are there any discrepancies?', 'Which orders are delayed?'],
    };
  }

  if (topic === 'history') {
    return {
      answer:
        'To show a transaction history I need a specific purchase order. ' +
        'Open a purchase order and ask me again, or ask "Show the full transaction history" from its detail page.',
      source: 'application_data',
      evidence: ['PurchaseOrder'],
      suggestedQuestions: ['How many purchase orders do I have?', 'Which orders are delayed?'],
      notAnswerable: true,
    };
  }

  return {
    answer:
      'I can only answer from recorded purchase order data. I can report status, delivery progress, ' +
      'invoices and discrepancies, payment position, approvals and transaction history. ' +
      'Open a specific purchase order for a detailed answer.',
    source: 'application_data',
    evidence: ['PurchaseOrder'],
    suggestedQuestions: [
      'How many purchase orders do I have?',
      'Which orders are delayed?',
      'Are there any discrepancies?',
    ],
    notAnswerable: true,
  };
}

function respond(
  answer: string,
  evidence: string[],
  summary: { poNumber: string } | null,
  suggestedQuestions: string[],
): AssistantResponse {
  return {
    answer,
    source: 'application_data',
    evidence,
    suggestedQuestions,
  };
}

export { PaymentStatus };