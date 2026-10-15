import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, QuoteStatus, RFQStatus } from '@navo/shared';
import { calculateComparison } from './quote.comparison';
import { Prisma } from '@prisma/client';

export interface SubmitQuoteInput {
  rfqId: string;
  vendorId: string;
  unitPrice: number;
  quantity: number;
  taxRate: number;
  freightAmount: number;
  installationAmount: number;
  warrantyMonths?: number;
  deliveryTimelineDays?: number;
  paymentTerms?: string;
  validityDays?: number;
  otherCharges: number;
  otherChargesDetails?: string;
  attachments: string[];
}

export interface UpdateQuoteInput {
  unitPrice?: number;
  quantity?: number;
  taxRate?: number;
  freightAmount?: number;
  installationAmount?: number;
  warrantyMonths?: number;
  deliveryTimelineDays?: number;
  paymentTerms?: string;
  validityDays?: number;
  otherCharges?: number;
  otherChargesDetails?: string;
  attachments?: string[];
}

export async function submitQuote(input: SubmitQuoteInput, userId: string, tenantId: string) {
  const rfq = await prisma.rFQ.findFirst({
    where: { id: input.rfqId, tenantId },
    include: { vendors: true },
  });
  
  if (!rfq) {
    throw new NotFoundError('RFQ');
  }
  
  if (rfq.status !== RFQStatus.SENT && rfq.status !== RFQStatus.RESPONSES_RECEIVED) {
    throw new ValidationError('RFQ is not accepting quotes');
  }
  
  const rfqVendor = rfq.vendors.find((v) => v.vendorId === input.vendorId);
  if (!rfqVendor) {
    throw new ValidationError('Vendor not invited to this RFQ');
  }
  
  // Check if vendor already submitted
  const existing = await prisma.quote.findFirst({
    where: { rfqId: input.rfqId, vendorId: input.vendorId },
  });
  
  if (existing) {
    throw new ValidationError('Vendor has already submitted a quote for this RFQ');
  }
  
  // Calculate tax amount
  const baseAmount = input.unitPrice * input.quantity;
  const taxAmount = baseAmount * (input.taxRate / 100);
  
  const quote = await prisma.quote.create({
    data: {
      rfqId: input.rfqId,
      vendorId: input.vendorId,
      unitPrice: input.unitPrice,
      quantity: input.quantity,
      taxRate: input.taxRate,
      taxAmount,
      freightAmount: input.freightAmount,
      installationAmount: input.installationAmount,
      warrantyMonths: input.warrantyMonths,
      deliveryTimelineDays: input.deliveryTimelineDays,
      paymentTerms: input.paymentTerms,
      validityDays: input.validityDays,
      otherCharges: input.otherCharges,
      otherChargesDetails: input.otherChargesDetails,
      attachments: input.attachments,
      status: QuoteStatus.SUBMITTED,
      tenantId,
    },
  });
  
  // Update RFQ vendor status
  await prisma.rFQVendor.update({
    where: { id: rfqVendor.id },
    data: { respondedAt: new Date(), status: 'RESPONDED' },
  });
  
  // Update RFQ status if first response
  if (rfq.status === RFQStatus.SENT) {
    await prisma.rFQ.update({
      where: { id: input.rfqId },
      data: { status: RFQStatus.RESPONSES_RECEIVED },
    });
  }
  
  await createAuditLog({
    userId,
    action: AuditAction.QUOTE_RECEIVED,
    entityType: 'Quote',
    entityId: quote.id,
    tenantId,
    metadata: { rfqId: input.rfqId, vendorId: input.vendorId, total: quote.unitPrice * quote.quantity },
  });
  
  return quote;
}

export async function getQuote(quoteId: string, tenantId: string) {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, tenantId },
    include: {
      rfq: { include: { request: true } },
      vendor: true,
      comparison: true,
    },
  });
  
  if (!quote) {
    throw new NotFoundError('Quote');
  }
  
  return quote;
}

export async function listQuotes(
  tenantId: string,
  filters: {
    rfqId?: string;
    vendorId?: string;
    status?: QuoteStatus;
    page?: number;
    limit?: number;
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };
  
  if (filters.rfqId) where.rfqId = filters.rfqId;
  if (filters.vendorId) where.vendorId = filters.vendorId;
  if (filters.status) where.status = filters.status;
  
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;
  
  const [quotes, total] = await Promise.all([
    prisma.quote.findMany({
      where,
      include: {
        rfq: { select: { id: true, rfqNumber: true, title: true } },
        vendor: { select: { id: true, name: true } },
        comparison: true,
      },
      orderBy: { submittedAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.quote.count({ where }),
  ]);
  
  return { data: quotes, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function updateQuote(quoteId: string, tenantId: string, input: UpdateQuoteInput, userId: string) {
  const existing = await prisma.quote.findFirst({
    where: { id: quoteId, tenantId },
  });
  
  if (!existing) {
    throw new NotFoundError('Quote');
  }
  
  if (existing.status !== QuoteStatus.SUBMITTED && existing.status !== QuoteStatus.UNDER_REVIEW) {
    throw new ValidationError('Cannot update quote in current status');
  }
  
  const baseAmount = (input.unitPrice ?? existing.unitPrice) * (input.quantity ?? existing.quantity);
  const taxRate = input.taxRate ?? existing.taxRate;
  const taxAmount = baseAmount * (taxRate / 100);
  
  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: {
      ...input,
      taxAmount,
    },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'Quote',
    entityId: quoteId,
    tenantId,
    metadata: input as unknown as Prisma.InputJsonValue,
  });
  
  return updated;
}

export async function reviewQuote(quoteId: string, tenantId: string, userId: string) {
  const existing = await prisma.quote.findFirst({
    where: { id: quoteId, tenantId },
  });
  
  if (!existing) {
    throw new NotFoundError('Quote');
  }
  
  const updated = await prisma.quote.update({
    where: { id: quoteId },
    data: {
      status: QuoteStatus.UNDER_REVIEW,
      reviewedAt: new Date(),
      reviewedBy: userId,
    },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'Quote',
    entityId: quoteId,
    tenantId,
    previousStatus: existing.status,
    newStatus: QuoteStatus.UNDER_REVIEW,
  });
  
  return updated;
}

export async function createComparison(quoteId: string, tenantId: string, userId: string) {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, tenantId },
    include: { comparison: true },
  });
  
  if (!quote) {
    throw new NotFoundError('Quote');
  }
  
  if (quote.comparison) {
    throw new ValidationError('Comparison already exists for this quote');
  }
  
  const comparisonData = calculateComparison(quote);
  
  const comparison = await prisma.quoteComparison.create({
    data: {
      quoteId,
      ...comparisonData,
    },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'QuoteComparison',
    entityId: comparison.id,
    tenantId,
    metadata: { quoteId },
  });
  
  return comparison;
}

export async function getComparison(quoteId: string, tenantId: string) {
  const comparison = await prisma.quoteComparison.findUnique({
    where: { quoteId },
  });
  
  if (!comparison) {
    throw new NotFoundError('Comparison');
  }
  
  return comparison;
}

export async function getRFQComparison(rfqId: string, tenantId: string) {
  const quotes = await prisma.quote.findMany({
    where: { rfqId, tenantId },
    include: {
      vendor: { select: { id: true, name: true, status: true } },
      comparison: true,
    },
    orderBy: { submittedAt: 'asc' },
  });
  
  // Calculate rankings for quotes with comparisons
  const withComparison = quotes.filter((q) => q.comparison);
  const sorted = [...withComparison].sort((a, b) => (a.comparison!.totalLandedCost - b.comparison!.totalLandedCost));
  
  // Assign ranks
  const ranked = sorted.map((q, i) => ({
    ...q,
    comparison: { ...q.comparison!, rank: i + 1 },
  }));
  
  // Update ranks in database
  for (const q of ranked) {
    await prisma.quoteComparison.update({
      where: { quoteId: q.id },
      data: { rank: q.comparison!.rank },
    });
  }
  
  return quotes.map((q) => {
    const rankedQuote = ranked.find((rq) => rq.id === q.id);
    return rankedQuote || q;
  });
}