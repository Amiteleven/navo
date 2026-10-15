import prisma from '../../utils/prisma';
import { NotFoundError } from '../../utils/errors.js';
import { VendorCertificationStatus, VendorDocumentType } from '@navo/shared';
import { Prisma } from '@prisma/client';

export interface CreateCapabilityInput {
  vendorId: string;
  category: string;
  description?: string;
  matchingFactors?: string[];
  name?: string;
  proficiencyLevel?: string;
}

export interface UpdateCapabilityInput {
  description?: string;
  matchingFactors?: string[];
  name?: string;
  proficiencyLevel?: string;
}

export interface CreateCertificationInput {
  vendorId: string;
  name: string;
  issuingBody?: string;
  validFrom?: Date;
  validUntil?: Date;
  documentId?: string;
}

export interface CreateDocumentInput {
  vendorId: string;
  documentType: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
  path: string;
}

export async function getVendorCapabilities(vendorId: string, tenantId: string) {
  await assertVendorExists(vendorId, tenantId);
  return prisma.vendorCapability.findMany({
    where: { vendorId, tenantId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createCapability(
  input: CreateCapabilityInput,
  tenantId: string
) {
  const { vendorId, matchingFactors, ...rest } = input;
  await assertVendorExists(vendorId, tenantId);
  const data: any = {
    vendorId,
    tenantId,
    ...rest,
  };
  if (matchingFactors) {
    data.matchingFactors = matchingFactors as unknown as Prisma.InputJsonValue;
  }
  return prisma.vendorCapability.create({ data });
}

export async function updateCapability(
  capabilityId: string,
  input: UpdateCapabilityInput,
  tenantId: string
) {
  const existing = await prisma.vendorCapability.findFirst({ where: { id: capabilityId, tenantId } });
  if (!existing) throw new NotFoundError('VendorCapability');

  return prisma.vendorCapability.update({
    where: { id: capabilityId },
    data: {
      ...input,
      matchingFactors: input.matchingFactors as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function deleteCapability(capabilityId: string, tenantId: string): Promise<void> {
  const existing = await prisma.vendorCapability.findFirst({ where: { id: capabilityId, tenantId } });
  if (!existing) throw new NotFoundError('VendorCapability');
  await prisma.vendorCapability.delete({ where: { id: capabilityId } });
}

export async function getVendorCertifications(vendorId: string, tenantId: string) {
  await assertVendorExists(vendorId, tenantId);
  return prisma.vendorCertification.findMany({
    where: { vendorId, tenantId },
    include: { document: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createCertification(
  input: CreateCertificationInput,
  tenantId: string
) {
  const { vendorId, ...rest } = input;
  await assertVendorExists(vendorId, tenantId);
  return prisma.vendorCertification.create({
    data: {
      vendorId,
      tenantId,
      ...rest,
    },
  });
}

export async function verifyCertification(
  certificationId: string,
  verifiedById: string,
  tenantId: string
) {
  const existing = await prisma.vendorCertification.findFirst({ where: { id: certificationId, tenantId } });
  if (!existing) throw new NotFoundError('VendorCertification');

  await prisma.vendorCertification.update({
    where: { id: certificationId },
    data: {
      status: VendorCertificationStatus.VERIFIED,
    },
  });

  if (existing.documentId) {
    await prisma.vendorDocument.update({
      where: { id: existing.documentId },
      data: {
        status: VendorCertificationStatus.VERIFIED,
        verifiedById,
        verifiedAt: new Date(),
      },
    });
  }

  return prisma.vendorCertification.findUnique({
    where: { id: certificationId },
    include: { document: true },
  });
}

export async function getVendorDocuments(vendorId: string, tenantId: string) {
  await assertVendorExists(vendorId, tenantId);
  return prisma.vendorDocument.findMany({
    where: { vendorId, tenantId },
    include: { uploadedBy: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function uploadVendorDocument(
  input: CreateDocumentInput,
  uploadedById: string,
  tenantId: string
) {
  const { vendorId, documentType, fileSize, ...rest } = input;
  await assertVendorExists(vendorId, tenantId);
  return prisma.vendorDocument.create({
    data: {
      vendorId,
      tenantId,
      uploadedById,
      ...rest,
      type: documentType as VendorDocumentType,
      sizeBytes: fileSize ?? 0,
    },
  });
}

export async function verifyVendorDocument(
  documentId: string,
  verifiedById: string,
  tenantId: string
) {
  const existing = await prisma.vendorDocument.findFirst({ where: { id: documentId, tenantId } });
  if (!existing) throw new NotFoundError('VendorDocument');

  return prisma.vendorDocument.update({
    where: { id: documentId },
    data: {
      status: VendorCertificationStatus.VERIFIED,
      verifiedById,
      verifiedAt: new Date(),
    },
  });
}

export async function getVendorProfileDetail(vendorId: string, tenantId: string) {
  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, tenantId },
    include: {
      category: true,
      capabilities: true,
      certifications: { include: { document: true } },
      documents: true,
      onboarding: true,
      performance: true,
      ratings: true,
      availability: true,
      workingHours: true,
    },
  });

  if (!vendor) throw new NotFoundError('Vendor');
  return vendor;
}

async function assertVendorExists(vendorId: string, tenantId: string): Promise<void> {
  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId } });
  if (!vendor) throw new NotFoundError('Vendor');
}
