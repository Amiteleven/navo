import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import {
  VendorOnboardingStatus,
  AuditAction,
} from '@navo/shared';
import { createAuditLog } from '../audit/audit.service.js';
import { recordVendorEvent } from './vendor-event.service.js';
import { Prisma } from '@prisma/client';

const INVITED = VendorOnboardingStatus.INVITED;
const APP_STARTED = VendorOnboardingStatus.APPLICATION_STARTED;
const APP_SUBMITTED = VendorOnboardingStatus.APPLICATION_SUBMITTED;
const UNDER_REVIEW = VendorOnboardingStatus.UNDER_REVIEW;
const VERIF_REQ = VendorOnboardingStatus.VERIFICATION_REQUIRED;
const VERIFIED = VendorOnboardingStatus.VERIFIED;
const APPROVED = VendorOnboardingStatus.APPROVED;
const REJECTED = VendorOnboardingStatus.REJECTED;
const SUSPENDED = VendorOnboardingStatus.SUSPENDED;
const ARCHIVED = VendorOnboardingStatus.ARCHIVED;

const ONBOARDING_TRANSITIONS: Record<string, VendorOnboardingStatus[]> = {
  [INVITED]: [APP_STARTED, ARCHIVED],
  [APP_STARTED]: [APP_SUBMITTED, INVITED, ARCHIVED],
  [APP_SUBMITTED]: [UNDER_REVIEW, APP_STARTED, ARCHIVED],
  [UNDER_REVIEW]: [VERIF_REQ, VERIFIED, REJECTED, APP_SUBMITTED],
  [VERIF_REQ]: [VERIFIED, UNDER_REVIEW, REJECTED],
  [VERIFIED]: [APPROVED, VERIF_REQ, REJECTED, SUSPENDED],
  [APPROVED]: [SUSPENDED, ARCHIVED],
  [REJECTED]: [INVITED, ARCHIVED],
  [SUSPENDED]: [APPROVED, REJECTED, ARCHIVED],
  [ARCHIVED]: [],
};

const REQUIRED_DOCS_BY_TYPE: Record<string, string[]> = {
  MANUFACTURER: [
    'COMPANY_REGISTRATION',
    'TAX_DOCUMENT',
    'QUALITY_CERTIFICATE',
    'INSURANCE',
    'BANK_DETAILS',
  ],
  SERVICE_PROVIDER: [
    'COMPANY_REGISTRATION',
    'TAX_DOCUMENT',
    'CERTIFICATION',
    'BANK_DETAILS',
  ],
  SAAS_PROVIDER: [
    'COMPANY_REGISTRATION',
    'TAX_DOCUMENT',
    'SECURITY_CERTIFICATION',
    'BANK_DETAILS',
  ],
  DISTRIBUTOR: [
    'COMPANY_REGISTRATION',
    'TAX_DOCUMENT',
    'INSURANCE',
    'BANK_DETAILS',
  ],
  LOGISTICS_PROVIDER: [
    'COMPANY_REGISTRATION',
    'TAX_DOCUMENT',
    'INSURANCE',
    'BANK_DETAILS',
  ],
  DEFAULT: [
    'COMPANY_REGISTRATION',
    'TAX_DOCUMENT',
    'BANK_DETAILS',
  ],
};

export async function getOnboardingStatus(vendorId: string, tenantId: string) {
  const onboarding = await prisma.vendorOnboarding.findFirst({
    where: { vendorId, tenantId },
    include: { vendor: { select: { id: true, name: true, email: true, vendorType: true, verificationStatus: true } } },
  });

  if (!onboarding) {
    throw new NotFoundError('VendorOnboarding');
  }

  return onboarding;
}

export async function createOnboarding(vendorId: string, tenantId: string, actorId: string) {
  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId } });
  if (!vendor) throw new NotFoundError('Vendor');

  const requiredDocs = REQUIRED_DOCS_BY_TYPE[vendor.vendorType ?? ''] ?? REQUIRED_DOCS_BY_TYPE.DEFAULT;
  const uploadedDocTypes = await prisma.vendorDocument.findMany({
    where: { vendorId, tenantId },
    select: { type: true },
  });
  const uploadedTypes = uploadedDocTypes.map((d) => d.type.toString());
  const missingDocs = requiredDocs.filter((d) => !uploadedTypes.includes(d));

  const onboarding = await prisma.vendorOnboarding.create({
    data: {
      vendorId,
      tenantId,
      status: VendorOnboardingStatus.INVITED,
      missingDocuments: {
        required: requiredDocs,
        uploaded: uploadedTypes,
        missing: missingDocs,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  await recordVendorEvent({
    vendorId,
    eventType: 'ONBOARDING_STARTED',
    metadata: { status: VendorOnboardingStatus.INVITED },
    tenantId,
    actorId,
  });

  return onboarding;
}

export async function transitionOnboardingStatus(
  vendorId: string,
  newStatus: VendorOnboardingStatus,
  tenantId: string,
  actorId: string,
  notes?: string
) {
  const onboarding = await prisma.vendorOnboarding.findFirst({
    where: { vendorId, tenantId },
  });

  if (!onboarding) {
    throw new NotFoundError('VendorOnboarding');
  }

  const allowedTransitions = ONBOARDING_TRANSITIONS[onboarding.status as VendorOnboardingStatus] || [];
  if (!allowedTransitions.includes(newStatus)) {
    throw new ValidationError(
      `Cannot transition from ${onboarding.status} to ${newStatus}`
    );
  }

  const updateData: Record<string, unknown> = {
    status: newStatus,
    updatedAt: new Date(),
  };

  if (newStatus === VendorOnboardingStatus.APPLICATION_STARTED) {
    updateData.startedAt = updateData.startedAt ?? new Date();
  }
  if (newStatus === VendorOnboardingStatus.APPLICATION_SUBMITTED) {
    updateData.submittedAt = new Date();
  }
  if (newStatus === VendorOnboardingStatus.UNDER_REVIEW || newStatus === VendorOnboardingStatus.VERIFIED) {
    updateData.reviewedAt = new Date();
  }
  if (newStatus === VendorOnboardingStatus.REJECTED && notes) {
    updateData.reviewComments = notes;
  }
  if (newStatus === VendorOnboardingStatus.VERIFICATION_REQUIRED) {
    updateData.reviewComments = notes ?? onboarding.reviewComments;
  }

  const updated = await prisma.vendorOnboarding.update({
    where: { id: onboarding.id },
    data: updateData,
  });

  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId } });
  if (vendor) {
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { onboardingStatus: newStatus },
    });
  }

  await recordVendorEvent({
    vendorId,
    eventType: `ONBOARDING_${newStatus}`,
    metadata: { from: onboarding.status, to: newStatus, notes },
    tenantId,
    actorId,
  });

  await createAuditLog({
    userId: actorId,
    action: AuditAction.STATUS_CHANGED,
    entityType: 'VendorOnboarding',
    entityId: onboarding.id,
    tenantId,
    metadata: { from: onboarding.status, to: newStatus },
  });

  return updated;
}

export async function recalculateMissingDocs(vendorId: string, tenantId: string) {
  const onboarding = await prisma.vendorOnboarding.findFirst({
    where: { vendorId, tenantId },
    include: { vendor: true },
  });
  if (!onboarding) throw new NotFoundError('VendorOnboarding');

  const requiredDocs =
    REQUIRED_DOCS_BY_TYPE[onboarding.vendor?.vendorType ?? ''] ?? REQUIRED_DOCS_BY_TYPE.DEFAULT;

  const uploadedDocTypes = await prisma.vendorDocument.findMany({
    where: { vendorId, tenantId },
    select: { type: true },
  });
  const uploadedTypes = uploadedDocTypes.map((d) => d.type.toString());
  const missingDocs = requiredDocs.filter((d) => !uploadedTypes.includes(d));

  return prisma.vendorOnboarding.update({
    where: { id: onboarding.id },
    data: {
      missingDocuments: {
        required: requiredDocs,
        uploaded: uploadedTypes,
        missing: missingDocs,
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function getOnboardingDashboard(tenantId: string, filters: { status?: VendorOnboardingStatus; search?: string } = {}) {
  const where: Record<string, unknown> = { tenantId };
  if (filters.status) where.status = filters.status;

  const [vendors, total] = await Promise.all([
    prisma.vendorOnboarding.findMany({
      where,
      include: { vendor: { select: { id: true, name: true, email: true, vendorType: true, verificationStatus: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.vendorOnboarding.count({ where }),
  ]);

  let filtered = vendors;
  if (filters.search) {
    const searchLower = filters.search.toLowerCase();
    filtered = vendors.filter(
      (v) =>
        v.vendor?.name?.toLowerCase().includes(searchLower) ||
        v.vendor?.email?.toLowerCase().includes(searchLower)
    );
  }

  return { data: filtered, total, count: filtered.length };
}
