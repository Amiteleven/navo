import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, QuoteAnalysisType } from '@navo/shared';
import { analyzeQuote, QuoteAnalysisInput } from '../../modules/ai/ai.service';
import { calculateComparison, normalizeQuotes, ComparisonData } from '../quotes/quote.comparison';
import { QuoteAnalysis } from '@prisma/client';

export interface AnalyzeQuoteInput {
  quoteId: string;
}

export async function analyzeQuoteService(
  quoteId: string,
  tenantId: string,
  userId: string
): Promise<QuoteAnalysis> {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, tenantId },
    include: {
      rfq: { include: { request: true } },
      vendor: true,
    },
  });

  if (!quote) {
    throw new NotFoundError('Quote');
  }

  // Get historical quotes for same item/category
  const historicalQuotes = await prisma.quote.findMany({
    where: {
      tenantId,
      rfq: {
        request: {
          item: quote.rfq.request.item,
        },
      },
      status: { in: ['ACCEPTED', 'UNDER_REVIEW'] },
      id: { not: quoteId },
    },
    include: {
      rfq: { include: { request: true } },
      vendor: { select: { name: true } },
    },
    orderBy: { submittedAt: 'desc' },
    take: 20,
  });

  // Get price benchmark data
  const category = quote.rfq.request.categoryId
    ? await prisma.category.findUnique({ where: { id: quote.rfq.request.categoryId } })
    : null;

  const benchmarkData = category
    ? await prisma.priceBenchmark.findFirst({
        where: {
          tenantId,
          categoryId: category.id,
          item: quote.rfq.request.item,
          periodEnd: { gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { periodEnd: 'desc' },
      })
    : null;

  const input: QuoteAnalysisInput = {
    quote: {
      id: quote.id,
      vendor: { name: quote.vendor.name, status: quote.vendor.status, verificationStatus: quote.vendor.verificationStatus },
      unitPrice: quote.unitPrice,
      quantity: quote.quantity,
      taxRate: quote.taxRate,
      taxAmount: quote.taxAmount,
      freightAmount: quote.freightAmount,
      installationAmount: quote.installationAmount,
      warrantyMonths: quote.warrantyMonths || undefined,
      deliveryTimelineDays: quote.deliveryTimelineDays || undefined,
      paymentTerms: quote.paymentTerms || undefined,
      validityDays: quote.validityDays || undefined,
      otherCharges: quote.otherCharges,
      otherChargesDetails: quote.otherChargesDetails || undefined,
      specifications: quote.rfq.specifications || undefined,
    },
    request: {
      item: quote.rfq.request.item,
      quantity: quote.rfq.quantity,
      location: quote.rfq.deliveryLocation,
      requiredDate: quote.rfq.requiredDeliveryDate,
      specifications: quote.rfq.request.specifications || undefined,
      estimatedBudget: quote.rfq.request.estimatedBudget || undefined,
    },
    historicalQuotes: historicalQuotes.map(hq => ({
      vendor: hq.vendor.name,
      unitPrice: hq.unitPrice,
      quantity: hq.quantity,
      totalLandedCost: hq.unitPrice * hq.quantity + hq.taxAmount + hq.freightAmount + hq.installationAmount + hq.otherCharges,
      date: hq.submittedAt,
      specifications: hq.rfq.specifications || undefined,
    })),
    benchmarkData: benchmarkData ? {
      minPrice: benchmarkData.minPrice,
      avgPrice: benchmarkData.avgPrice,
      maxPrice: benchmarkData.maxPrice,
      sampleSize: benchmarkData.sampleSize,
      dataSource: benchmarkData.dataSource,
      periodStart: benchmarkData.periodStart,
      periodEnd: benchmarkData.periodEnd,
    } : undefined,
  };

  const analysis = await analyzeQuote(input);

  // Store analysis
  const stored = await prisma.quoteAnalysis.create({
    data: {
      quoteId,
      type: QuoteAnalysisType.COMMERCIAL_SUMMARY,
      content: analysis as any,
      confidence: analysis.priceBenchmark.confidence,
      evidence: {
        historicalQuotes: input.historicalQuotes?.length || 0,
        benchmarkSource: input.benchmarkData?.dataSource || 'none',
        sampleSize: input.benchmarkData?.sampleSize || 0,
      } as any,
      generatedBy: 'ai',
      tenantId,
    },
  });

  await createAuditLog({
    userId,
    action: AuditAction.QUOTE_ANALYZED,
    entityType: 'QuoteAnalysis',
    entityId: stored.id,
    tenantId,
    metadata: { quoteId, type: 'COMMERCIAL_SUMMARY' },
  });

  return stored;
}

export async function getQuoteAnalysis(quoteId: string, tenantId: string) {
  const analysis = await prisma.quoteAnalysis.findFirst({
    where: { quoteId, tenantId },
    orderBy: { createdAt: 'desc' },
  });

  if (!analysis) {
    throw new NotFoundError('Quote Analysis');
  }

  return analysis;
}

export async function getQuoteAnalyses(quoteId: string, tenantId: string) {
  return prisma.quoteAnalysis.findMany({
    where: { quoteId, tenantId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function compareQuotes(
  rfqId: string,
  tenantId: string,
  userId: string
) {
  const rfq = await prisma.rFQ.findFirst({
    where: { id: rfqId, tenantId },
    include: {
      request: true,
      quotes: {
        include: {
          vendor: true,
          comparison: true,
        },
        orderBy: { submittedAt: 'asc' },
      },
    },
  });

  if (!rfq) {
    throw new NotFoundError('RFQ');
  }

  const quotesWithComparison = rfq.quotes.map(quote => {
    const stored = quote.comparison;
    const comparison: ComparisonData = stored
      ? {
          id: stored.id,
          basePrice: stored.basePrice,
          taxAmount: stored.taxAmount,
          freightAmount: stored.freightAmount,
          installationAmount: stored.installationAmount,
          otherCharges: stored.otherCharges,
          totalLandedCost: stored.totalLandedCost,
          deliveryDays: stored.deliveryDays ?? undefined,
          paymentTerms: stored.paymentTerms ?? undefined,
          warrantyMonths: stored.warrantyMonths ?? undefined,
          validityDays: stored.validityDays ?? undefined,
          score: stored.score ?? undefined,
          rank: stored.rank ?? undefined,
          notes: stored.notes ?? undefined,
        }
      : calculateComparison(quote);

    return { ...quote, comparison };
  });

  // Derive a weighted normalized score, then rank on that overall score.
  const scored = normalizeQuotes(quotesWithComparison);

  scored.forEach(q => {
    q.comparison.score = q.normalizedScore;
  });

  const ranked = scored.sort((a, b) => (b.comparison.score ?? 0) - (a.comparison.score ?? 0));

  ranked.forEach((q, i) => {
    q.comparison.rank = i + 1;
  });

  await Promise.all(
    ranked
      .filter(q => q.comparison.id)
      .map(q =>
        prisma.quoteComparison
          .update({
            where: { id: q.comparison.id as string },
            data: { rank: q.comparison.rank, score: q.comparison.score },
          })
          .catch(() => {})
      )
  );

  // Analyze each quote
  const analyses = await Promise.all(
    ranked.map(q => analyzeQuoteService(q.id, tenantId, userId).catch(() => null))
  );

  const lowestLandedCost = Math.min(...ranked.map(q => q.comparison.totalLandedCost));

  const result = ranked.map((quote, index) => ({
    ...quote,
    analysis: analyses[index],
    isLowest: quote.comparison.totalLandedCost === lowestLandedCost,
  }));

  await createAuditLog({
    userId,
    action: AuditAction.QUOTE_ANALYZED,
    entityType: 'QuoteComparison',
    entityId: rfqId,
    tenantId,
    metadata: { rfqId, quoteCount: quotesWithComparison.length },
  });

  return result;
}