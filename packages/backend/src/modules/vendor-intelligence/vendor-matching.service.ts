import prisma from '../../utils/prisma';
import { NotFoundError } from '../../utils/errors.js';
import {
  VendorType,
  VendorOnboardingStatus,
  VendorCertificationStatus,
  VendorMatchingFactor,
  AuditAction,
} from '@navo/shared';
import { createAuditLog } from '../audit/audit.service.js';
import { recordVendorEvent } from './vendor-event.service.js';
import { Prisma } from '@prisma/client';

export interface VendorMatchingWeights {
  capability: number;
  geography: number;
  certification: number;
  industryExperience: number;
  availability: number;
  capacity: number;
  historicalPerformance: number;
  commercialHistory: number;
  vendorStatus: number;
  productServiceFit: number;
}

const DEFAULT_WEIGHTS: VendorMatchingWeights = {
  capability: 25,
  geography: 15,
  certification: 10,
  industryExperience: 10,
  availability: 5,
  capacity: 5,
  historicalPerformance: 10,
  commercialHistory: 10,
  vendorStatus: 5,
  productServiceFit: 15,
};

export interface FactorScore {
  factor: VendorMatchingFactor;
  score: number;
  weight: number;
  detail: string;
}

export interface MatchResult {
  vendorId: string;
  matchScore: number;
  factorScores: FactorScore[];
}

export async function matchVendorsAgainstRequest(
  requestId: string,
  tenantId: string,
  limit: number = 20,
  weights: Partial<VendorMatchingWeights> = {}
): Promise<MatchResult[]> {
  const request = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
    include: { extractedReq: true },
  });

  if (!request) throw new NotFoundError('ProcurementRequest');

  const mergedWeights = { ...DEFAULT_WEIGHTS, ...weights };
  const totalWeight = Object.values(mergedWeights).reduce((a, b) => a + b, 0) || 1;

  const candidateVendors = await prisma.vendor.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      OR: [{ isPublic: true }, { assignments: { some: { requestId, tenantId } } }],
    },
    include: {
      capabilities: true,
      certifications: true,
      documents: true,
      performance: true,
      ratings: true,
      availability: true,
      commercialHistories: true,
      assignments: { where: { requestId } },
      onboarding: { select: { status: true } },
    },
    take: 100,
  });

  const results: MatchResult[] = [];

  for (const vendor of candidateVendors) {
    const factorScores = computeFactorScores(vendor, request, mergedWeights);
    const weightedSum = factorScores.reduce((sum, fs) => sum + fs.score * fs.weight, 0);
    const matchScore = Math.round((weightedSum / totalWeight) * 100) / 100;

    if (matchScore > 0) {
      results.push({
        vendorId: vendor.id,
        matchScore,
        factorScores,
      });
    }
  }

  results.sort((a, b) => b.matchScore - a.matchScore);
  return results.slice(0, limit);
}

function computeFactorScores(
  vendor: any,
  request: any,
  weights: VendorMatchingWeights
): FactorScore[] {
  const scores: FactorScore[] = [];

  const capabilityScore = scoreCapability(vendor, request);
  scores.push({
    factor: VendorMatchingFactor.CAPABILITY,
    score: capabilityScore,
    weight: weights.capability,
    detail: `${vendor.capabilities?.length ?? 0} capabilities matched`,
  });

  const geoScore = scoreGeography(vendor, request);
  scores.push({
    factor: VendorMatchingFactor.GEOGRAPHY,
    score: geoScore,
    weight: weights.geography,
    detail: `Location ${vendor.city || vendor.country || 'unknown'} vs request ${request.location || 'unknown'}`,
  });

  const certScore = scoreCertifications(vendor);
  scores.push({
    factor: VendorMatchingFactor.CERTIFICATION,
    score: certScore,
    weight: weights.certification,
    detail: `${vendor.certifications?.length ?? 0} certifications, ${vendor.certifications?.filter((c: any) => c.status === VendorCertificationStatus.VERIFIED).length ?? 0} verified`,
  });

  const industryScore = scoreIndustryExperience(vendor, request);
  scores.push({
    factor: VendorMatchingFactor.INDUSTRY_EXPERIENCE,
    score: industryScore,
    weight: weights.industryExperience,
    detail: vendor.vendorType ? `Vendor type: ${vendor.vendorType}` : 'No vendor type specified',
  });

  const availabilityScore = vendor.availability?.isOnline ? 75 : vendor.availability ? 40 : 0;
  scores.push({
    factor: VendorMatchingFactor.AVAILABILITY,
    score: availabilityScore,
    weight: weights.availability,
    detail: vendor.availability ? `Online: ${vendor.availability.isOnline}` : 'No availability data',
  });

  const capacityScore = Math.min(100, (vendor.performance?.totalOrders ?? 0) * 5);
  scores.push({
    factor: VendorMatchingFactor.CAPACITY,
    score: capacityScore,
    weight: weights.capacity,
    detail: `${vendor.performance?.totalOrders ?? 0} total orders executed`,
  });

  const perfScore = vendor.performance
    ? Math.round(
        (vendor.performance.onTimeDelivery +
          vendor.performance.qualityRating +
          vendor.performance.responsiveness) /
          3
      )
    : 0;
  scores.push({
    factor: VendorMatchingFactor.HISTORICAL_PERFORMANCE,
    score: perfScore,
    weight: weights.historicalPerformance,
    detail: `On-time: ${vendor.performance?.onTimeDelivery ?? 0}, Quality: ${vendor.performance?.qualityRating ?? 0}, Responsiveness: ${vendor.performance?.responsiveness ?? 0}`,
  });

  const historyScore = vendor.commercialHistories?.length > 0 ? 100 : 0;
  scores.push({
    factor: VendorMatchingFactor.COMMERCIAL_HISTORY,
    score: historyScore,
    weight: weights.commercialHistory,
    detail: `${vendor.commercialHistories?.length ?? 0} prior orders`,
  });

  const statusScore = vendor.status === 'ACTIVE' ? 100 : vendor.status === 'INACTIVE' ? 25 : 0;
  scores.push({
    factor: VendorMatchingFactor.VENDOR_STATUS,
    score: statusScore,
    weight: weights.vendorStatus,
    detail: `Status: ${vendor.status}`,
  });

  const fitScore = scoreProductServiceFit(vendor, request);
  scores.push({
    factor: VendorMatchingFactor.PRODUCT_SERVICE_FIT,
    score: fitScore,
    weight: weights.productServiceFit,
    detail: fitScore > 0 ? `${vendor.name} matches requirement category` : 'No direct category match',
  });

  return scores;
}

function scoreCapability(vendor: any, request: any): number {
  if (!vendor.capabilities || vendor.capabilities.length === 0) return 0;
  const queryTerms = [
    request.categoryId,
    request.extractedReq?.category,
    request.item,
    request.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!queryTerms) return 50;

  const matching = vendor.capabilities.filter((c: any) =>
    (c.name?.toLowerCase().includes(queryTerms) ||
     c.description?.toLowerCase().includes(queryTerms) ||
     c.category?.toLowerCase().includes(queryTerms))
  );
  if (matching.length === 0) return 0;
  if (matching.length >= 3) return 100;
  if (matching.length >= 1) return 70;
  return 40;
}

function scoreGeography(vendor: any, request: any): number {
  if (!vendor.city && !vendor.state && !vendor.country) return 0;
  const reqLocation = (request.location || '').toLowerCase();
  const vendorLocation = [vendor.city, vendor.state, vendor.country].filter(Boolean).join(' ').toLowerCase();
  if (!reqLocation || !vendorLocation) return 50;
  if (vendorLocation.includes(reqLocation) || reqLocation.includes(vendorLocation)) return 100;
  if (vendor.country && reqLocation.includes(vendor.country?.toLowerCase())) return 80;
  return 25;
}

function scoreCertifications(vendor: any): number {
  if (!vendor.certifications || vendor.certifications.length === 0) return 0;
  const verified = vendor.certifications.filter(
    (c: any) => c.status === VendorCertificationStatus.VERIFIED && (!c.validUntil || new Date(c.validUntil) > new Date())
  ).length;
  const total = vendor.certifications.length;
  if (total === 0) return 0;
  return Math.round((verified / total) * 100);
}

function scoreIndustryExperience(vendor: any, request: any): number {
  if (!vendor.vendorType) return 0;
  const vendorType = vendor.vendorType as string;
  if (vendorType === VendorType.MANUFACTURER && request.item) return 80;
  if (vendorType === VendorType.SERVICE_PROVIDER && request.extractedReq?.category === 'Service') return 90;
  if (vendorType === VendorType.SAAS_PROVIDER && request.extractedReq?.category === 'Software') return 95;
  if (vendorType === VendorType.LOGISTICS_PROVIDER && request.extractedReq?.category === 'Logistics') return 90;
  return 30;
}

function scoreProductServiceFit(vendor: any, request: any): number {
  const match = request.categoryId && vendor.categoryId === request.categoryId;
  if (match) return 100;
  if (vendor.categoryId || request.categoryId) return 40;
  return 50;
}

export async function saveMatchingResult(
  requestId: string,
  results: MatchResult[],
  tenantId: string,
  matchedById?: string
) {
  const saved: any[] = [];
  for (const result of results) {
    const matching = await prisma.vendorMatching.create({
      data: {
        vendorId: result.vendorId,
        requestId,
        score: result.matchScore,
        factorScores: result.factorScores as unknown as Prisma.InputJsonValue,
        matchingFactors: DEFAULT_WEIGHTS as unknown as Prisma.InputJsonValue,
        tenantId,
        matchedById,
      },
    });
    saved.push(matching);
  }
  return saved;
}

export async function getVendorMatchingResults(
  vendorId: string,
  tenantId: string,
  limit: number = 20
) {
  await assertVendorExists(vendorId, tenantId);
  return prisma.vendorMatching.findMany({
    where: { vendorId, tenantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

async function assertVendorExists(vendorId: string, tenantId: string): Promise<void> {
  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId } });
  if (!vendor) throw new NotFoundError('Vendor');
}
