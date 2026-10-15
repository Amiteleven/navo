import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { VendorDuplicateConfidence, AuditAction } from '@navo/shared';
import { createAuditLog } from '../audit/audit.service.js';
import { recordVendorEvent } from './vendor-event.service.js';
import { Prisma } from '@prisma/client';

export interface DuplicateScanResult {
  vendorId: string;
  potentialDuplicates: Array<{
    vendorId: string;
    name: string;
    confidence: VendorDuplicateConfidence;
    fieldsMatched: string[];
    method: string;
  }>;
}

export async function findPotentialDuplicates(
  vendorId: string,
  tenantId: string,
  threshold: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW'
): Promise<DuplicateScanResult> {
  const source = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId } });
  if (!source) throw new NotFoundError('Vendor');

  const where: Record<string, unknown> = {
    tenantId,
    id: { not: vendorId },
    status: { not: 'BLACKLISTED' },
  };

  const candidates = await prisma.vendor.findMany({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      gstin: true,
      phone: true,
      address: true,
    },
    take: 200,
  });

  const results: DuplicateScanResult['potentialDuplicates'] = [];

  for (const candidate of candidates) {
    const fieldsMatched: string[] = [];
    let confidenceScore = 0;

    if (candidate.email && source.email && candidate.email.toLowerCase() === source.email.toLowerCase()) {
      fieldsMatched.push('email');
      confidenceScore += 40;
    }

    if (candidate.gstin && source.gstin && candidate.gstin === source.gstin) {
      fieldsMatched.push('gstin');
      confidenceScore += 35;
    }

    if (candidate.phone && source.phone && candidate.phone === source.phone) {
      fieldsMatched.push('phone');
      confidenceScore += 20;
    }

    const sourceNameNorm = normalizeName(source.name);
    const candidateNameNorm = normalizeName(candidate.name);
    const nameSim = jaccardSimilarity(sourceNameNorm, candidateNameNorm);
    if (nameSim > 0.8) {
      fieldsMatched.push('name');
      confidenceScore += Math.round(nameSim * 25);
    }

    if (source.address && candidate.address && source.address === candidate.address) {
      fieldsMatched.push('address');
      confidenceScore += 10;
    }

    if (fieldsMatched.length === 0) continue;

    let confidence: VendorDuplicateConfidence;
    if (confidenceScore >= 75) confidence = VendorDuplicateConfidence.HIGH;
    else if (confidenceScore >= 50) confidence = VendorDuplicateConfidence.MEDIUM;
    else confidence = VendorDuplicateConfidence.LOW;

    const thresholdOrder = ['LOW', 'MEDIUM', 'HIGH', 'EXACT'];
    const thresholdIdx = thresholdOrder.indexOf(threshold);
    const confidenceIdx = thresholdOrder.indexOf(confidence);
    if (confidenceIdx < thresholdIdx) continue;

    results.push({
      vendorId: candidate.id,
      name: candidate.name,
      confidence,
      fieldsMatched,
      method: 'fuzzy_match',
    });
  }

  return { vendorId, potentialDuplicates: results };
}

function normalizeName(name: string): string[] {
  const stopWords = new Set(['the', 'and', 'of', 'for', 'in', 'corp', 'ltd', 'llc', 'inc']);
  return name
    .toLowerCase()
    .replace(/[.\-_]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .sort();
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

export async function recordDuplicateDetection(
  primaryVendorId: string,
  secondaryVendorId: string,
  confidence: VendorDuplicateConfidence,
  method: string,
  fieldsMatched: string[],
  score: number,
  tenantId: string
) {
  const [primary, secondary] = await Promise.all([
    prisma.vendor.findFirst({ where: { id: primaryVendorId, tenantId } }),
    prisma.vendor.findFirst({ where: { id: secondaryVendorId, tenantId } }),
  ]);

  if (!primary) throw new NotFoundError('Primary Vendor');
  if (!secondary) throw new NotFoundError('Secondary Vendor');

  return prisma.vendorDuplicate.create({
    data: {
      primaryVendorId,
      secondaryVendorId,
      confidence,
      score,
      matchedFields: fieldsMatched as unknown as Prisma.InputJsonValue,
      tenantId,
    },
  });
}

export async function confirmDuplicate(
  duplicateId: string,
  confirmedById: string,
  tenantId: string
) {
  const existing = await prisma.vendorDuplicate.findFirst({
    where: { id: duplicateId, tenantId },
  });
  if (!existing) throw new NotFoundError('VendorDuplicate');
  if (existing.confirmed) throw new ValidationError('Duplicate detection already confirmed');

  const updated = await prisma.vendorDuplicate.update({
    where: { id: duplicateId },
    data: { confirmed: true, confirmedById, confirmedAt: new Date() },
  });

  await createAuditLog({
    userId: confirmedById,
    action: AuditAction.STATUS_CHANGED,
    entityType: 'VendorDuplicate',
    entityId: duplicateId,
    tenantId,
    metadata: { confirmed: true, confidence: existing.confidence },
  });

  return updated;
}

export async function listDuplicateDetections(
  tenantId: string,
  filters: { confirmed?: boolean; confidence?: VendorDuplicateConfidence } = {}
) {
  const where: Record<string, unknown> = { tenantId };
  if (filters.confirmed !== undefined) where.confirmed = filters.confirmed;
  if (filters.confidence) where.confidence = filters.confidence;

  return prisma.vendorDuplicate.findMany({
    where,
    include: {
      primaryVendor: { select: { id: true, name: true, email: true } },
      secondaryVendor: { select: { id: true, name: true, email: true } },
      confirmedBy: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { detectedAt: 'desc' },
  });
}

export async function mergeVendors(
  primaryVendorId: string,
  secondaryVendorId: string,
  tenantId: string,
  userId: string
) {
  const [primary, secondary] = await Promise.all([
    prisma.vendor.findFirst({ where: { id: primaryVendorId, tenantId } }),
    prisma.vendor.findFirst({ where: { id: secondaryVendorId, tenantId } }),
  ]);

  if (!primary) throw new NotFoundError('Primary Vendor');
  if (!secondary) throw new NotFoundError('Secondary Vendor');

  const detection = await prisma.vendorDuplicate.findFirst({
    where: { primaryVendorId, secondaryVendorId, tenantId },
  });

  const tx = await prisma.$transaction(async (tx) => {
    await tx.vendorCapability.updateMany({
      where: { vendorId: secondaryVendorId },
      data: { vendorId: primaryVendorId },
    });

    await tx.vendorCertification.updateMany({
      where: { vendorId: secondaryVendorId },
      data: { vendorId: primaryVendorId },
    });

    await tx.vendorDocument.updateMany({
      where: { vendorId: secondaryVendorId },
      data: { vendorId: primaryVendorId },
    });

    await tx.vendorOnboarding.deleteMany({ where: { vendorId: secondaryVendorId } });

    await tx.vendorMatching.updateMany({
      where: { vendorId: secondaryVendorId },
      data: { vendorId: primaryVendorId },
    });

    await tx.vendorAssignment.updateMany({
      where: { vendorId: secondaryVendorId },
      data: { vendorId: primaryVendorId },
    });

    await tx.vendorCommercialHistory.updateMany({
      where: { vendorId: secondaryVendorId },
      data: { vendorId: primaryVendorId },
    });

    await tx.vendorEvent.updateMany({
      where: { vendorId: secondaryVendorId },
      data: { vendorId: primaryVendorId },
    });

    await tx.vendor.delete({ where: { id: secondaryVendorId } });

    if (detection) {
      await tx.vendorDuplicate.update({
        where: { id: detection.id },
        data: { confirmed: true, confirmedById: userId, confirmedAt: new Date() },
      });
    }

    return { primaryVendorId, secondaryVendorId };
  });

  await createAuditLog({
    userId,
    action: AuditAction.DELETED,
    entityType: 'Vendor',
    entityId: secondaryVendorId,
    tenantId,
    metadata: { mergedInto: primaryVendorId, detectionId: detection?.id },
  });

  await recordVendorEvent({
    vendorId: secondaryVendorId,
    eventType: 'MERGED',
    metadata: { mergedInto: primaryVendorId },
    tenantId,
    actorId: userId,
  });

  return tx;
}
