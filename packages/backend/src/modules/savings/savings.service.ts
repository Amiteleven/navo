import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError, ForbiddenError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, SavingsType, DealStatus } from '@navo/shared';
import { Prisma } from '@prisma/client';

export interface CreateSavingsRecordInput {
  dealId: string;
  type: SavingsType;
  baselineAmount: number;
  baselineSource: string;
  baselinePeriodStart?: Date;
  baselinePeriodEnd?: Date;
  calculationMethod: string;
  evidence?: Record<string, unknown>;
}

export interface UpdateSavingsRecordInput {
  type?: SavingsType;
  verifiedAt?: Date;
  verifiedBy?: string;
  evidence?: Record<string, unknown>;
}

export async function createSavingsRecord(
  input: CreateSavingsRecordInput,
  buyerId: string,
  tenantId: string
) {
  const deal = await prisma.deal.findFirst({
    where: { id: input.dealId, tenantId },
    include: { request: true, vendor: true },
  });

  if (!deal) {
    throw new NotFoundError('Deal');
  }

  if (deal.buyerId !== buyerId) {
    throw new ForbiddenError('Only the buyer can create savings records');
  }

  if (deal.status !== DealStatus.ACCEPTED && deal.status !== DealStatus.ORDERED && deal.status !== DealStatus.DELIVERED && deal.status !== DealStatus.COMPLETED) {
    throw new ValidationError('Can only record savings for accepted or completed deals');
  }

  if (!deal.acceptedOfferId) {
    throw new ValidationError('Deal has no accepted offer');
  }

  const acceptedOffer = await prisma.dealOffer.findUnique({
    where: { id: deal.acceptedOfferId },
  });

  if (!acceptedOffer) {
    throw new ValidationError('Accepted offer not found');
  }

  const originalQuoteAmount = acceptedOffer.unitPrice * acceptedOffer.quantity + 
    acceptedOffer.gst * (acceptedOffer.unitPrice * acceptedOffer.quantity) / 100 + 
    acceptedOffer.freightAmount + acceptedOffer.installationAmount + acceptedOffer.otherCharges;

  const finalAcceptedAmount = originalQuoteAmount;

  const savingsAmount = input.baselineAmount - finalAcceptedAmount;
  const savingsPercentage = input.baselineAmount > 0 ? (savingsAmount / input.baselineAmount) * 100 : 0;

  const savingsRecord = await prisma.savingsRecord.create({
    data: {
      dealId: input.dealId,
      requestId: deal.requestId,
      buyerId,
      vendorId: deal.vendorId,
      type: input.type,
      originalQuoteAmount,
      finalAcceptedAmount,
      baselineAmount: input.baselineAmount,
      baselineSource: input.baselineSource,
      baselinePeriodStart: input.baselinePeriodStart,
      baselinePeriodEnd: input.baselinePeriodEnd,
      savingsAmount,
      savingsPercentage,
      calculationMethod: input.calculationMethod,
      evidence: input.evidence as Prisma.JsonValue || Prisma.JsonNull,
      verifiedAt: input.type === SavingsType.VERIFIED ? new Date() : null,
      verifiedBy: input.type === SavingsType.VERIFIED ? buyerId : null,
      tenantId,
    },
    include: {
      request: { include: { category: true } },
      vendor: { select: { id: true, name: true } },
    },
  });

  await createAuditLog({
    userId: buyerId,
    action: AuditAction.SAVINGS_RECORDED,
    entityType: 'SavingsRecord',
    entityId: savingsRecord.id,
    tenantId,
    metadata: { 
      dealId: input.dealId, 
      type: input.type, 
      savingsAmount, 
      savingsPercentage,
      baselineSource: input.baselineSource,
    },
  });

  return savingsRecord;
}

export async function getSavingsRecord(savingsRecordId: string, tenantId: string) {
  const record = await prisma.savingsRecord.findFirst({
    where: { id: savingsRecordId, tenantId },
    include: {
      request: { include: { category: true } },
      vendor: { select: { id: true, name: true } },
      buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  if (!record) {
    throw new NotFoundError('Savings Record');
  }

  return record;
}

export async function listSavingsRecords(
  tenantId: string,
  userId: string,
  role: string,
  filters: {
    type?: SavingsType;
    dealId?: string;
    requestId?: string;
    vendorId?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };

  if (filters.type) where.type = filters.type;
  if (filters.dealId) where.dealId = filters.dealId;
  if (filters.requestId) where.requestId = filters.requestId;
  if (filters.vendorId) where.vendorId = filters.vendorId;

  if (role !== 'PLATFORM_ADMIN' && role !== 'COMPANY_ADMIN') {
    where.buyerId = userId;
  }

  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const [records, total] = await Promise.all([
    prisma.savingsRecord.findMany({
      where,
      include: {
        request: { include: { category: true } },
        vendor: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.savingsRecord.count({ where }),
  ]);

  return { data: records, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function updateSavingsRecord(
  savingsRecordId: string,
  input: UpdateSavingsRecordInput,
  userId: string,
  tenantId: string
) {
  const record = await prisma.savingsRecord.findFirst({
    where: { id: savingsRecordId, tenantId },
  });

  if (!record) {
    throw new NotFoundError('Savings Record');
  }

  if (record.buyerId !== userId) {
    throw new ForbiddenError('Only the buyer who created the record can update it');
  }

  const updated = await prisma.savingsRecord.update({
    where: { id: savingsRecordId },
    data: {
      ...input,
      evidence: input.evidence as Prisma.JsonValue || Prisma.JsonNull,
    },
    include: {
      request: { include: { category: true } },
      vendor: { select: { id: true, name: true } },
    },
  });

  await createAuditLog({
    userId,
    action: AuditAction.SAVINGS_RECORDED,
    entityType: 'SavingsRecord',
    entityId: savingsRecordId,
    tenantId,
    metadata: { 
      updated: true, 
      type: input.type,
      verifiedAt: input.verifiedAt?.toISOString(),
      verifiedBy: input.verifiedBy,
    },
  });

  return updated;
}

export async function getSavingsSummary(tenantId: string, userId: string, role: string) {
  const where: Record<string, unknown> = { tenantId };

  if (role !== 'PLATFORM_ADMIN' && role !== 'COMPANY_ADMIN') {
    where.buyerId = userId;
  }

  const [verified, potential, realized] = await Promise.all([
    prisma.savingsRecord.aggregate({
      where: { ...where, type: SavingsType.VERIFIED },
      _sum: { savingsAmount: true },
      _count: true,
    }),
    prisma.savingsRecord.aggregate({
      where: { ...where, type: SavingsType.POTENTIAL },
      _sum: { savingsAmount: true },
      _count: true,
    }),
    prisma.savingsRecord.aggregate({
      where: { ...where, type: SavingsType.REALIZED },
      _sum: { savingsAmount: true },
      _count: true,
    }),
  ]);

  return {
    verified: { amount: verified._sum.savingsAmount || 0, count: verified._count },
    potential: { amount: potential._sum.savingsAmount || 0, count: potential._count },
    realized: { amount: realized._sum.savingsAmount || 0, count: realized._count },
    total: { amount: (verified._sum.savingsAmount || 0) + (potential._sum.savingsAmount || 0) + (realized._sum.savingsAmount || 0) },
  };
}

export async function getTopSavingsVendors(tenantId: string, userId: string, role: string, limit = 5) {
  const where: Record<string, unknown> = { tenantId };

  if (role !== 'PLATFORM_ADMIN' && role !== 'COMPANY_ADMIN') {
    where.buyerId = userId;
  }

  const vendors = await prisma.savingsRecord.groupBy({
    by: ['vendorId'],
    where,
    _sum: { savingsAmount: true },
    _count: true,
    orderBy: { _sum: { savingsAmount: 'desc' } },
    take: limit,
  });

  const vendorIds = vendors.map(v => v.vendorId);
  const vendorDetails = await prisma.vendor.findMany({
    where: { id: { in: vendorIds } },
    select: { id: true, name: true, status: true },
  });

  return vendors.map(v => {
    const detail = vendorDetails.find(d => d.id === v.vendorId);
    return {
      vendorId: v.vendorId,
      vendorName: detail?.name || 'Unknown',
      vendorStatus: detail?.status || 'UNKNOWN',
      totalSavings: v._sum.savingsAmount || 0,
      dealCount: v._count,
    };
  });
}