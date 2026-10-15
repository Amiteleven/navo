import prisma from '../../utils/prisma';
import { NotFoundError, ConflictError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, VendorStatus } from '@navo/shared';
import { Prisma } from '@prisma/client';

export interface CreateVendorInput {
  name: string;
  categoryId?: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  products?: string;
  notes?: string;
}

export interface UpdateVendorInput {
  name?: string;
  categoryId?: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  products?: string;
  status?: VendorStatus;
  notes?: string;
}

export async function createVendor(input: CreateVendorInput, userId: string, tenantId: string) {
  if (input.email) {
    const existing = await prisma.vendor.findFirst({
      where: { email: input.email.toLowerCase(), tenantId },
    });
    if (existing) {
      throw new ConflictError('Vendor with this email already exists');
    }
  }
  
  const vendor = await prisma.vendor.create({
    data: {
      ...input,
      email: input.email?.toLowerCase(),
      tenantId,
      status: VendorStatus.PENDING_APPROVAL,
    },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.CREATED,
    entityType: 'Vendor',
    entityId: vendor.id,
    tenantId,
    metadata: { name: vendor.name },
  });
  
  return vendor;
}

export async function getVendor(vendorId: string, tenantId: string) {
  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, tenantId },
    include: {
      category: true,
      performance: true,
      rfqs: { include: { rfq: true } },
      quotes: true,
    },
  });
  
  if (!vendor) {
    throw new NotFoundError('Vendor');
  }
  
  return vendor;
}

export async function listVendors(
  tenantId: string,
  filters: {
    status?: VendorStatus;
    categoryId?: string;
    search?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };
  
  if (filters.status) where.status = filters.status;
  if (filters.categoryId) where.categoryId = filters.categoryId;
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: 'insensitive' } },
      { contactPerson: { contains: filters.search, mode: 'insensitive' } },
      { email: { contains: filters.search, mode: 'insensitive' } },
      { products: { contains: filters.search, mode: 'insensitive' } },
    ];
  }
  
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;
  
  const [vendors, total] = await Promise.all([
    prisma.vendor.findMany({
      where,
      include: { category: true, performance: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.vendor.count({ where }),
  ]);
  
  return { data: vendors, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function updateVendor(vendorId: string, tenantId: string, input: UpdateVendorInput, userId: string) {
  const existing = await prisma.vendor.findFirst({
    where: { id: vendorId, tenantId },
  });
  
  if (!existing) {
    throw new NotFoundError('Vendor');
  }
  
  if (input.email && input.email !== existing.email) {
    const duplicate = await prisma.vendor.findFirst({
      where: { email: input.email.toLowerCase(), tenantId, NOT: { id: vendorId } },
    });
    if (duplicate) {
      throw new ConflictError('Vendor with this email already exists');
    }
  }
  
  const updated = await prisma.vendor.update({
    where: { id: vendorId },
    data: {
      ...input,
      email: input.email?.toLowerCase(),
      approvedAt: input.status === VendorStatus.ACTIVE && existing.status !== VendorStatus.ACTIVE ? new Date() : existing.approvedAt,
      approvedBy: input.status === VendorStatus.ACTIVE && existing.status !== VendorStatus.ACTIVE ? userId : existing.approvedBy,
    },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'Vendor',
    entityId: vendorId,
    tenantId,
    metadata: input as unknown as Prisma.InputJsonValue,
  });
  
  return updated;
}

export async function deleteVendor(vendorId: string, tenantId: string, userId: string) {
  const existing = await prisma.vendor.findFirst({
    where: { id: vendorId, tenantId },
  });
  
  if (!existing) {
    throw new NotFoundError('Vendor');
  }
  
  await prisma.vendor.delete({ where: { id: vendorId } });
  
  await createAuditLog({
    userId,
    action: AuditAction.DELETED,
    entityType: 'Vendor',
    entityId: vendorId,
    tenantId,
    metadata: { name: existing.name },
  });
}

export async function getVendorsByCategory(tenantId: string, categoryId: string) {
  return prisma.vendor.findMany({
    where: { tenantId, categoryId, status: VendorStatus.ACTIVE },
    orderBy: { name: 'asc' },
  });
}

export async function searchVendors(tenantId: string, query: string) {
  return prisma.vendor.findMany({
    where: {
      tenantId,
      status: VendorStatus.ACTIVE,
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { products: { contains: query, mode: 'insensitive' } },
        { category: { name: { contains: query, mode: 'insensitive' } } },
      ],
    },
    include: { category: true, performance: true },
    take: 20,
  });
}