import prisma from '../../utils/prisma';
import { NotFoundError } from '../../utils/errors.js';
import { AuditAction } from '@navo/shared';
import { createAuditLog } from '../audit/audit.service.js';
import { decimalToNumber } from '../../utils/money.js';
import { Prisma } from '@prisma/client';

export interface CommercialHistoryInput {
  vendorId: string;
  periodStart: Date;
  orderCount: number;
  totalSpend: string;
  avgDiscountPct?: number;
  currency?: string;
}

export async function getCommercialHistory(
  vendorId: string,
  tenantId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  await assertVendorExists(vendorId, tenantId);

  return prisma.vendorCommercialHistory.findMany({
    where: { vendorId, tenantId },
    orderBy: { periodStart: 'desc' },
    take: opts.limit ?? 50,
    skip: opts.offset ?? 0,
  });
}

export async function addCommercialHistory(
  input: CommercialHistoryInput,
  tenantId: string
) {
  const { vendorId, totalSpend, ...rest } = input;
  await assertVendorExists(vendorId, tenantId);

  return prisma.vendorCommercialHistory.create({
    data: {
      vendorId,
      tenantId,
      totalSpend: new Prisma.Decimal(totalSpend),
      ...rest,
    },
  });
}

export async function getVendorSpendingSummary(vendorId: string, tenantId: string) {
  await assertVendorExists(vendorId, tenantId);

  const records = await prisma.vendorCommercialHistory.findMany({
    where: { vendorId, tenantId },
    select: { totalSpend: true, currency: true, periodStart: true, orderCount: true },
  });

  const totalAmount = records.reduce((sum, r) => sum.plus(r.totalSpend), new Prisma.Decimal(0));
  const yearToDate = records
    .filter((r) => new Date(r.periodStart).getFullYear() === new Date().getFullYear())
    .reduce((sum, r) => sum.plus(r.totalSpend), new Prisma.Decimal(0));

  return {
    totalSpend: { raw: totalAmount.toString(), formatted: `${decimalToNumber(totalAmount)}` },
    yearToDateSpend: { raw: yearToDate.toString(), formatted: `${decimalToNumber(yearToDate)}` },
    orderCount: records.reduce((sum, r) => sum + r.orderCount, 0),
    currency: records[0]?.currency || 'INR',
  };
}

export async function getTopVendorsBySpending(tenantId: string, period: 'all' | 'year' = 'all') {
  const where: Record<string, unknown> = { tenantId };

  if (period === 'year') {
    where.periodStart = { gte: new Date(new Date().getFullYear(), 0, 1) };
  }

  const records = await prisma.vendorCommercialHistory.findMany({
    where,
    select: {
      vendorId: true,
      totalSpend: true,
      currency: true,
    },
  });

  const vendorTotals = new Map<string, { total: Prisma.Decimal; currency: string }>();
  for (const r of records) {
    const existing = vendorTotals.get(r.vendorId) || { total: new Prisma.Decimal(0), currency: r.currency };
    existing.total = existing.total.plus(r.totalSpend);
    vendorTotals.set(r.vendorId, existing);
  }

  const sorted = Array.from(vendorTotals.entries())
    .sort((a, b) => b[1].total.minus(a[1].total).toNumber())
    .slice(0, 10);

  const vendorIds = sorted.map(([id]) => id);
  const vendors = await prisma.vendor.findMany({
    where: { id: { in: vendorIds }, tenantId },
    select: { id: true, name: true, vendorType: true },
  });

  const vendorMap = new Map(vendors.map((v) => [v.id, v]));

  return sorted.map(([vendorId, data]) => ({
    vendor: vendorMap.get(vendorId),
    totalSpend: decimalToNumber(data.total),
    currency: data.currency,
  }));
}

async function assertVendorExists(vendorId: string, tenantId: string): Promise<void> {
  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId } });
  if (!vendor) throw new NotFoundError('Vendor');
}
