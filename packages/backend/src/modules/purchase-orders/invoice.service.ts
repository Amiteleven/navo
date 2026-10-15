import { Prisma } from '@prisma/client';
import {
  AuditAction,
  DiscrepancyResolution,
  DiscrepancySeverity,
  DiscrepancyType,
  InvoiceMatchStatus,
  InvoiceStatus,
  PurchaseOrderStatus,
  UserRole,
} from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { amountsEqual, computeTotals, decimalToNumber, difference, roundMoney, toDecimal } from '../../utils/money.js';
import { createAuditLog } from '../audit/audit.service.js';
import { ActorContext, loadAccessiblePo, requireSeller } from './po-access.js';
import { getAcceptedValue, getReceiptTotals } from './goods-receipt.service.js';

/**
 * Default tolerance for three-way matching, in currency units.
 *
 * Suppliers commonly invoice rounded freight or apply a minor tax-rounding
 * adjustment. A small absolute tolerance prevents a 0.01 difference from
 * blocking payment, while anything material still surfaces as a discrepancy.
 */
export const DEFAULT_TOLERANCE = new Prisma.Decimal('1.00');

const DUPLICATE_WINDOW_DAYS = 365;

/** Statuses in which an invoice may still be raised. */
const INVOICABLE_STATUSES: string[] = [
  PurchaseOrderStatus.DRAFT,
  PurchaseOrderStatus.PENDING_APPROVAL,
  PurchaseOrderStatus.CANCELLED,
];

export interface SubmitInvoiceInput {
  poId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  quantity?: number;
  unitPrice?: number | string;
  taxRate?: number | string;
  taxAmount?: number | string;
  freightAmount?: number | string;
  otherCharges?: number | string;
  otherChargesDetails?: string;
  totalAmount?: number | string;
  description?: string;
  extractedData?: Record<string, unknown>;
  extractionMethod?: string;
  documentIds?: string[];
}

export async function submitInvoice(actor: ActorContext, input: SubmitInvoiceInput) {
  // Invoices may be raised by the supplier or entered on their behalf by finance.
  const po = await loadAccessiblePo(input.poId, actor);

  let vendorId = po.vendorId;
  if (actor.role === UserRole.VENDOR) {
    const seller = await requireSeller(actor.userId, actor.tenantId);
    vendorId = seller.vendorId;
  }

  if (INVOICABLE_STATUSES.includes(po.status)) {
    throw new ConflictError(`Cannot invoice against a purchase order in status ${po.status}`);
  }
  if (!input.invoiceNumber?.trim()) {
    throw new ValidationError('invoiceNumber is required');
  }

  const invoiceDate = parseDate(input.invoiceDate, 'invoiceDate');

  // Duplicate detection: the same vendor may not re-submit the same invoice
  // number twice, and the unique constraint on (vendorId, invoiceNumber) is the
  // backstop. Caught here so the user gets a useful message.
  const duplicate = await prisma.invoice.findFirst({
    where: { vendorId, invoiceNumber: input.invoiceNumber.trim() },
    select: { id: true, poId: true, totalAmount: true, status: true },
  });
  if (duplicate) {
    throw new ConflictError(
      `Invoice ${input.invoiceNumber} has already been recorded for this supplier` +
        (duplicate.poId === input.poId ? ' against this purchase order' : ' against another purchase order'),
    );
  }

  // When the supplier does not itemise, fall back to the PO terms so the match
  // has real values to compare rather than silently passing on zeroes.
  const quantity = input.quantity ?? po.quantity;
  const totals = computeTotals({
    quantity,
    unitPrice: toDecimal(input.unitPrice ?? decimalToNumber(po.unitPrice), 'unitPrice'),
    taxRate: toDecimal(input.taxRate ?? decimalToNumber(po.taxRate), 'taxRate'),
    freightAmount: toDecimal(input.freightAmount ?? decimalToNumber(po.freightAmount), 'freightAmount'),
    otherCharges: toDecimal(input.otherCharges ?? decimalToNumber(po.otherCharges), 'otherCharges'),
  });

  const taxAmount =
    input.taxAmount !== undefined
      ? roundMoney(toDecimal(input.taxAmount, 'taxAmount'))
      : totals.taxAmount;

  const totalAmount =
    input.totalAmount !== undefined
      ? roundMoney(toDecimal(input.totalAmount, 'totalAmount'))
      : roundMoney(totals.subtotal.plus(taxAmount).plus(totals.freight).plus(totals.other));

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: input.invoiceNumber.trim(),
      poId: input.poId,
      vendorId,
      status: InvoiceStatus.SUBMITTED,
      currency: po.currency,
      invoiceDate,
      dueDate: input.dueDate ? parseDate(input.dueDate, 'dueDate') : null,
      subtotal: totals.subtotal,
      taxRate: totals.taxRate,
      taxAmount,
      freightAmount: totals.freight,
      otherCharges: totals.other,
      otherChargesDetails: input.otherChargesDetails ?? null,
      totalAmount,
      description: input.description ?? null,
      // Extracted data is stored separately from verified amounts and is always
      // labelled as unverified in the UI.
      extractedData: input.extractedData ? (input.extractedData as Prisma.InputJsonValue) : Prisma.JsonNull,
      extractionMethod: input.extractionMethod ?? null,
      extractedAt: input.extractedData ? new Date() : null,
      documentIds: input.documentIds ?? [],
      submittedById: actor.userId,
      tenantId: actor.tenantId,
      verifications: {
        create: {
          poId: input.poId,
          status: InvoiceMatchStatus.NOT_STARTED,
          tenantId: actor.tenantId,
        },
      },
    },
    include: { verifications: true },
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.INVOICE_SUBMITTED,
    entityType: 'Invoice',
    entityId: invoice.id,
    tenantId: actor.tenantId,
    metadata: {
      poId: input.poId,
      poNumber: po.poNumber,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: invoice.totalAmount.toString(),
      hadExtractedData: Boolean(input.extractedData),
    },
  });

  return invoice;
}

export async function listInvoices(
  actor: ActorContext,
  filters: { poId?: string; status?: InvoiceStatus; page?: number; limit?: number } = {},
) {
  const where: Prisma.InvoiceWhereInput = { tenantId: actor.tenantId };

  if (actor.role === UserRole.VENDOR) {
    const seller = await requireSeller(actor.userId, actor.tenantId);
    where.vendorId = seller.vendorId;
  }
  if (filters.poId) where.poId = filters.poId;
  if (filters.status) where.status = filters.status;

  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 100) : 20;

  const [data, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        po: { select: { id: true, poNumber: true, itemName: true, status: true, totalAmount: true } },
        verifications: { orderBy: { createdAt: 'desc' }, take: 1 },
        payments: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.invoice.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getInvoice(invoiceId: string, actor: ActorContext) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: actor.tenantId },
    include: {
      po: {
        include: {
          vendor: { select: { id: true, name: true, gstin: true } },
          buyer: { select: { id: true, firstName: true, lastName: true } },
          goodsReceipts: true,
          approvals: true,
        },
      },
      verifications: { orderBy: { createdAt: 'desc' } },
      payments: { orderBy: { createdAt: 'desc' } },
      documents: true,
    },
  });

  if (!invoice) throw new NotFoundError('Invoice');

  if (actor.role === UserRole.VENDOR) {
    const seller = await requireSeller(actor.userId, actor.tenantId);
    if (seller.vendorId !== invoice.vendorId) {
      throw new ForbiddenError('Access denied: invoice belongs to another supplier');
    }
  }

  return invoice;
}

interface DiscrepancyInput {
  type: DiscrepancyType;
  severity: DiscrepancySeverity;
  field: string;
  message: string;
  expected?: string;
  actual?: string;
  difference?: string;
  /** Defaults to OPEN; set when a reviewer resolves or waives the item. */
  resolution?: DiscrepancyResolution;
  resolutionNote?: string | null;
  resolvedById?: string;
  resolvedAt?: string;
}

/**
 * Run the deterministic three-way match between PO, goods receipts and invoice.
 *
 * This is intentionally rule-based rather than AI-driven: the output feeds a
 * payment gate, so it must be reproducible and explainable. Each check returns a
 * typed discrepancy recording expected vs actual values and the delta, and no
 * check silently passes - an unmatchable field produces a discrepancy.
 */
export async function verifyInvoice(
  invoiceId: string,
  actor: ActorContext,
  options: { tolerance?: Prisma.Decimal; notes?: string } = {},
) {
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Invoices are verified by the buyer, not the supplier');
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: actor.tenantId },
    include: {
      po: { include: { goodsReceipts: true, vendor: { select: { id: true, name: true, gstin: true } } } },
    },
  });
  if (!invoice) throw new NotFoundError('Invoice');

  const TERMINAL_INVOICE_STATUSES: string[] = [InvoiceStatus.VERIFIED, InvoiceStatus.REJECTED];

  if (TERMINAL_INVOICE_STATUSES.includes(invoice.status)) {
    throw new ConflictError(`Invoice is already ${invoice.status.toLowerCase()} and cannot be re-verified`);
  }

  const po = invoice.po;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const discrepancies: DiscrepancyInput[] = [];
  const checkedFields: Record<string, unknown> = {};

  // ── Duplicate invoice check ────────────────────────────────────────────────
  // The unique index already blocks an exact repeat of an invoice number. This
  // check catches a resubmission under a *different* number.
  //
  // Severity depends on whether it points at the same purchase order:
  //   - same PO  -> almost certainly a double submission, so CRITICAL;
  //   - other PO  -> two distinct orders for the same amount on the same day is
  //     entirely normal for a supplier, so this is only a WARNING. Treating it
  //     as critical would block payment on a legitimate invoice.
  const windowStart = new Date(invoice.invoiceDate);
  windowStart.setDate(windowStart.getDate() - DUPLICATE_WINDOW_DAYS);
  const possibleDuplicate = await prisma.invoice.findFirst({
    where: {
      id: { not: invoice.id },
      tenantId: actor.tenantId,
      vendorId: invoice.vendorId,
      totalAmount: invoice.totalAmount,
      invoiceDate: { gte: windowStart, lte: invoice.invoiceDate },
    },
    select: { id: true, invoiceNumber: true, poId: true },
  });
  checkedFields.duplicateCheck = {
    lookedBackDays: DUPLICATE_WINDOW_DAYS,
    duplicateFound: Boolean(possibleDuplicate),
    duplicateOfSamePo: possibleDuplicate?.poId === po.id,
  };

  if (possibleDuplicate) {
    const samePo = possibleDuplicate.poId === po.id;
    discrepancies.push({
      type: DiscrepancyType.DUPLICATE_INVOICE,
      severity: samePo ? DiscrepancySeverity.CRITICAL : DiscrepancySeverity.WARNING,
      field: 'invoiceNumber',
      message: samePo
        ? `Invoice ${possibleDuplicate.invoiceNumber} already exists for this purchase order at the same amount; this looks like a duplicate submission`
        : `A separate invoice ${possibleDuplicate.invoiceNumber} exists for this supplier at the same amount within ${DUPLICATE_WINDOW_DAYS} days. Confirm these are distinct orders.`,
      expected: 'no matching prior invoice for this purchase order',
      actual: `${possibleDuplicate.invoiceNumber} against PO ${possibleDuplicate.poId}`,
    });
  }

  // ── Goods receipt check ────────────────────────────────────────────────────
  const totals = await getReceiptTotals(po.id, po.quantity);
  checkedFields.goodsReceipt = totals;

  if (po.goodsReceipts.length === 0) {
    discrepancies.push({
      type: DiscrepancyType.MISSING_GOODS_RECEIPT,
      severity: DiscrepancySeverity.CRITICAL,
      field: 'goodsReceipt',
      message: 'Invoice submitted with no goods receipt recorded against this purchase order',
      expected: 'at least one goods receipt',
      actual: 'none',
    });
  }

  // ── Quantity check ─────────────────────────────────────────────────────────
  // Compared against the quantity actually accepted, not the quantity ordered,
  // so an invoice that arrives ahead of the rest of a part delivery is flagged
  // rather than paid in full.
  const invoicedQuantity = deriveInvoicedQuantity(invoice, po);
  checkedFields.quantity = { invoiced: invoicedQuantity, accepted: totals.acceptedQuantity, ordered: po.quantity };
  if (invoicedQuantity > totals.acceptedQuantity) {
    discrepancies.push({
      type: DiscrepancyType.QUANTITY_MISMATCH,
      severity:
        invoicedQuantity > po.quantity ? DiscrepancySeverity.CRITICAL : DiscrepancySeverity.WARNING,
      field: 'quantity',
      message: `Invoice covers ${invoicedQuantity} unit(s) but only ${totals.acceptedQuantity} of ${po.quantity} have been accepted`,
      expected: String(totals.acceptedQuantity),
      actual: String(invoicedQuantity),
      difference: String(invoicedQuantity - totals.acceptedQuantity),
    });
  }

  // ── Unit price check ──────────────────────────────────────────────────────
  // Only verifiable when the supplier's claimed unit price was captured in
  // extractedData; an absent value is not treated as a zero-price invoice.
  const extractedData =
    typeof invoice.extractedData === 'object' && invoice.extractedData !== null && !Array.isArray(invoice.extractedData)
      ? (invoice.extractedData as Record<string, unknown>)
      : null;
  const claimedUnitPrice = extractedData?.unitPrice;

  if (claimedUnitPrice !== undefined && claimedUnitPrice !== null) {
    const expectedPrice = roundMoney(po.unitPrice);
    const actualPrice = roundMoney(toDecimal(claimedUnitPrice, 'unitPrice'));
    const delta = difference(actualPrice, expectedPrice);
    checkedFields.unitPrice = { expected: expectedPrice.toString(), actual: actualPrice.toString() };
    if (!amountsEqual(actualPrice, expectedPrice, tolerance)) {
      const deltaPct = expectedPrice.isZero()
        ? '100'
        : delta.div(expectedPrice).times(100).toFixed(2);
      discrepancies.push({
        type: DiscrepancyType.UNIT_PRICE_VARIATION,
        // A price movement is critical only when it moves against the buyer.
        severity:
          delta.gt(0) ? DiscrepancySeverity.CRITICAL : DiscrepancySeverity.WARNING,
        field: 'unitPrice',
        message: `Invoice unit price ${actualPrice.toFixed(2)} differs from the agreed ${expectedPrice.toFixed(2)} (${deltaPct}%)`,
        expected: expectedPrice.toFixed(2),
        actual: actualPrice.toFixed(2),
        difference: delta.toFixed(2),
      });
    }
  }

  // ── Total check against accepted value ─────────────────────────────────────
  // The expected invoice value is derived from what was actually accepted, with
  // delivery-linked charges included only on a fully received order.
  const acceptedValue = await getAcceptedValue(po.id);
  checkedFields.amounts = {
    invoiceTotal: invoice.totalAmount.toString(),
    expectedFromAcceptedValue: acceptedValue.toString(),
    poTotal: po.totalAmount.toString(),
    tolerance: tolerance.toString(),
  };

  const totalDelta = difference(invoice.totalAmount, acceptedValue);
  if (!amountsEqual(invoice.totalAmount, acceptedValue, tolerance)) {
    discrepancies.push({
      type: DiscrepancyType.TOTAL_MISMATCH,
      severity:
        totalDelta.gt(tolerance) ? DiscrepancySeverity.CRITICAL : DiscrepancySeverity.WARNING,
      field: 'totalAmount',
      message:
        `Invoice total ${invoice.totalAmount.toFixed(2)} does not match the accepted value ${acceptedValue.toFixed(2)}`,
      expected: acceptedValue.toFixed(2),
      actual: invoice.totalAmount.toFixed(2),
      difference: totalDelta.toFixed(2),
    });
  }

  // ── Tax check ──────────────────────────────────────────────────────────────
  const expectedTax = roundMoney(po.taxAmount);
  checkedFields.tax = {
    expected: expectedTax.toString(),
    actual: invoice.taxAmount.toString(),
    poTaxRate: decimalToNumber(po.taxRate),
    invoiceTaxRate: invoice.taxRate ? decimalToNumber(invoice.taxRate) : null,
  };
  if (!amountsEqual(invoice.taxAmount, expectedTax, tolerance)) {
    discrepancies.push({
      type: DiscrepancyType.TAX_MISMATCH,
      severity: invoice.taxAmount.gt(expectedTax) ? DiscrepancySeverity.CRITICAL : DiscrepancySeverity.WARNING,
      field: 'taxAmount',
      message: `Invoice tax ${invoice.taxAmount.toFixed(2)} does not match the agreed tax ${expectedTax.toFixed(2)}`,
      expected: expectedTax.toFixed(2),
      actual: invoice.taxAmount.toFixed(2),
      difference: difference(invoice.taxAmount, expectedTax).toFixed(2),
    });
  }

  // ── Unexpected charges check ───────────────────────────────────────────────
  // Charges the PO never authorised cannot pass matching silently.
  const authorisedExtra = roundMoney(po.freightAmount).plus(po.installationAmount).plus(po.otherCharges);
  const invoicedExtra = roundMoney(invoice.freightAmount).plus(invoice.otherCharges);
  if (invoicedExtra.gt(authorisedExtra.plus(tolerance))) {
    discrepancies.push({
      type: DiscrepancyType.UNEXPECTED_CHARGE,
      severity: DiscrepancySeverity.CRITICAL,
      field: 'additionalCharges',
      message: `Invoice includes ${invoicedExtra.minus(authorisedExtra).toFixed(2)} in charges that were not authorised on the purchase order`,
      expected: authorisedExtra.toFixed(2),
      actual: invoicedExtra.toFixed(2),
      difference: invoicedExtra.minus(authorisedExtra).toFixed(2),
    });
  }

  // ── Vendor tax details check ───────────────────────────────────────────────
  // Missing GSTIN is reported as a warning, not a hard block: the supplier may
  // be unregistered or registered elsewhere.
  if (!po.vendor.gstin) {
    checkedFields.vendorTaxDetails = { gstin: null };
    discrepancies.push({
      type: DiscrepancyType.UNVERIFIED_TAX_DETAILS,
      severity: DiscrepancySeverity.WARNING,
      field: 'vendor.gstin',
      message: `Supplier ${po.vendor.name} has no GSTIN on record; tax details could not be verified`,
      expected: 'GSTIN on supplier record',
      actual: 'not provided',
    });
  }

  const hasCritical = discrepancies.some((d) => d.severity === DiscrepancySeverity.CRITICAL);
  const matched = discrepancies.length === 0;
  const status = matched ? InvoiceMatchStatus.MATCHED : InvoiceMatchStatus.DISCREPANCIES;

  const typedDiscrepancies = discrepancies.map((d) => ({
    ...d,
    resolution: DiscrepancyResolution.OPEN as DiscrepancyResolution,
  }));

  const verification = await prisma.invoiceVerification.create({
    data: {
      invoiceId: invoice.id,
      poId: po.id,
      status,
      matched,
      discrepancies: typedDiscrepancies as unknown as Prisma.InputJsonValue,
      checkedFields: checkedFields as Prisma.InputJsonValue,
      toleranceAmount: tolerance,
      verifiedById: actor.userId,
      verifiedAt: new Date(),
      notes: options.notes ?? null,
      tenantId: actor.tenantId,
    },
  });

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: matched ? InvoiceStatus.VERIFIED : InvoiceStatus.DISCREPANCIES_FOUND,
    },
  });

  await createAuditLog({
    userId: actor.userId,
    action: matched ? AuditAction.INVOICE_VERIFIED : AuditAction.INVOICE_DISCREPANCY_FOUND,
    entityType: 'InvoiceVerification',
    entityId: verification.id,
    tenantId: actor.tenantId,
    metadata: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      poId: po.id,
      poNumber: po.poNumber,
      matched,
      discrepancyCount: discrepancies.length,
      criticalCount: discrepancies.filter((d) => d.severity === DiscrepancySeverity.CRITICAL).length,
      checkedFields: checkedFields as Prisma.InputJsonValue,
    },
  });

  return {
    verification,
    matched,
    hasCritical,
    discrepancies: typedDiscrepancies,
    checkedFields,
    invoiceStatus: matched ? InvoiceStatus.VERIFIED : InvoiceStatus.DISCREPANCIES_FOUND,
  };
}

/**
 * Resolve or waive a discrepancy.
 *
 * Critical discrepancies block payment until explicitly resolved. Waiving a
 * critical discrepancy is permitted but recorded with the acting user and
 * rationale so the decision is always attributable.
 */
export async function resolveDiscrepancy(
  invoiceId: string,
  actor: ActorContext,
  input: {
    field: string;
    resolution: DiscrepancyResolution;
    note?: string;
  },
) {
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Discrepancies are resolved by the buyer, not the supplier');
  }
  if (input.resolution === DiscrepancyResolution.OPEN) {
    throw new ValidationError('Choose a resolution other than leaving the discrepancy open');
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: actor.tenantId },
    include: { verifications: { orderBy: { createdAt: 'desc' }, take: 1 }, po: true },
  });
  if (!invoice) throw new NotFoundError('Invoice');

  const verification = invoice.verifications[0];
  if (!verification) throw new NotFoundError('Invoice verification');
  if (verification.status === InvoiceMatchStatus.NOT_STARTED) {
    throw new ConflictError('Verify the invoice before resolving discrepancies');
  }

  const current = (verification.discrepancies as unknown as DiscrepancyInput[] | null) ?? [];
  const target = current.find((d) => d.field === input.field);
  if (!target) {
    throw new NotFoundError(`Discrepancy on field '${input.field}'`);
  }
  if (target.resolution !== DiscrepancyResolution.OPEN) {
    throw new ConflictError('This discrepancy has already been resolved');
  }
  if (target.severity === DiscrepancySeverity.CRITICAL && !input.note?.trim()) {
    throw new ValidationError('A rationale is required when resolving a critical discrepancy');
  }

  const updatedDiscrepancies = current.map((d) =>
    d.field === input.field
      ? {
          ...d,
          resolution: input.resolution,
          resolutionNote: input.note ?? null,
          resolvedById: actor.userId,
          resolvedAt: new Date().toISOString(),
        }
      : d,
  );

  // Critical items stay blocking regardless of a waive: only an ACCEPTED
  // resolution (supplier agreed the corrected value) clears the gate.
  const outstandingCritical = updatedDiscrepancies.some(
    (d) =>
      d.severity === DiscrepancySeverity.CRITICAL &&
      d.resolution !== DiscrepancyResolution.ACCEPTED &&
      d.resolution !== DiscrepancyResolution.REJECTED,
  );

  await prisma.invoiceVerification.update({
    where: { id: verification.id },
    data: {
      discrepancies: updatedDiscrepancies as unknown as Prisma.InputJsonValue,
      // matched stays false: the numbers did not agree, even if the buyer chose
      // to proceed. Only `outstandingCritical` governs the payment gate.
      matched: updatedDiscrepancies.length === 0,
    },
  });

  const nextInvoiceStatus =
    outstandingCritical || updatedDiscrepancies.length > 0
      ? InvoiceStatus.DISCREPANCIES_FOUND
      : InvoiceStatus.VERIFIED;

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: nextInvoiceStatus },
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.DISCREPANCY_RESOLVED,
    entityType: 'InvoiceVerification',
    entityId: verification.id,
    tenantId: actor.tenantId,
    decision: input.note,
    metadata: {
      invoiceId: invoice.id,
      poId: invoice.poId,
      poNumber: invoice.po?.poNumber ?? undefined,
      field: input.field,
      severity: target.severity,
      resolution: input.resolution,
      outstandingCritical,
    },
  });

  return {
    discrepancies: updatedDiscrepancies,
    outstandingCritical,
    invoiceStatus: nextInvoiceStatus,
  };
}

/** True when an invoice is free of unresolved critical discrepancies. */
export async function isClearedForPayment(invoiceId: string): Promise<boolean> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { verifications: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!invoice) return false;

  const verification = invoice.verifications[0];
  if (!verification) return false;

  if (verification.matched) return true;

  const list = (verification.discrepancies as unknown as DiscrepancyInput[] | null) ?? [];
  return !list.some(
    (d) => d.severity === DiscrepancySeverity.CRITICAL && d.resolution === DiscrepancyResolution.OPEN,
  );
}

/**
 * Derive the invoiced quantity.
 * Prefers the value recorded in extractedData (what the supplier actually
 * claimed), falling back to the implied quantity from the subtotal.
 */
function deriveInvoicedQuantity(
  invoice: { subtotal: Prisma.Decimal; extractedData: unknown },
  po: { quantity: number; unitPrice: Prisma.Decimal },
): number {
  // Prisma returns Json fields as a JsonValue union; narrow to an object before
  // reading keys off it.
  const extracted =
    typeof invoice.extractedData === 'object' && invoice.extractedData !== null && !Array.isArray(invoice.extractedData)
      ? (invoice.extractedData as Record<string, unknown>)
      : null;

  if (extracted && extracted.quantity !== undefined && extracted.quantity !== null) {
    const q = Number(extracted.quantity);
    if (Number.isFinite(q) && q > 0) return Math.round(q);
  }

  // Fall back to subtotal / PO unit price, rounded to the nearest whole unit.
  // The Invoice table has no unitPrice column, so the agreed PO price is the
  // only reliable divisor for the implied quantity.
  if (!po.unitPrice.isZero()) {
    const implied = invoice.subtotal.dividedBy(po.unitPrice);
    if (implied.gt(0)) return Math.round(implied.toNumber());
  }
  return po.quantity;
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${field} is not a valid date`);
  }
  return parsed;
}