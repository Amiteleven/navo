import prisma from '../../utils/prisma';
import { NotFoundError, ConflictError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction } from '@navo/shared';
import { UserRole } from '@navo/shared';
import { Prisma } from '@prisma/client';

export interface CreateTenantInput {
  name: string;
  slug: string;
  domain?: string;
}

export interface UpdateTenantInput {
  name?: string;
  domain?: string;
  logo?: string;
  settings?: Prisma.InputJsonValue;
  isActive?: boolean;
}

export async function createTenant(input: CreateTenantInput, userId: string): Promise<{ id: string }> {
  const existingTenant = await prisma.tenant.findUnique({
    where: { slug: input.slug.toLowerCase() },
  });
  
  if (existingTenant) {
    throw new ConflictError('Tenant slug already exists');
  }
  
  if (input.domain) {
    const existingDomain = await prisma.tenant.findUnique({
      where: { domain: input.domain.toLowerCase() },
    });
    
    if (existingDomain) {
      throw new ConflictError('Domain already in use');
    }
  }
  
  const tenant = await prisma.tenant.create({
    data: {
      name: input.name,
      slug: input.slug.toLowerCase(),
      domain: input.domain?.toLowerCase(),
    },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.CREATED,
    entityType: 'Tenant',
    entityId: tenant.id,
    tenantId: tenant.id,
    metadata: input as unknown as Prisma.InputJsonValue,
  });
  
  return { id: tenant.id };
}

export async function getTenant(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
  });
  
  if (!tenant) {
    throw new NotFoundError('Tenant');
  }
  
  return tenant;
}

export async function getTenantBySlug(slug: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: slug.toLowerCase() },
  });
  
  if (!tenant) {
    throw new NotFoundError('Tenant');
  }
  
  return tenant;
}

export async function updateTenant(tenantId: string, input: UpdateTenantInput, userId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
  });
  
  if (!tenant) {
    throw new NotFoundError('Tenant');
  }
  
  if (input.domain) {
    const existingDomain = await prisma.tenant.findFirst({
      where: { domain: input.domain.toLowerCase(), NOT: { id: tenantId } },
    });
    
    if (existingDomain) {
      throw new ConflictError('Domain already in use');
    }
  }
  
  const updated = await prisma.tenant.update({
    where: { id: tenantId },
    data: input,
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'Tenant',
    entityId: tenantId,
    tenantId,
    metadata: input as unknown as Prisma.InputJsonValue,
  });
  
  return updated;
}

export async function listTenants(userId: string, userRole: UserRole) {
  if (userRole !== UserRole.PLATFORM_ADMIN) {
    throw new Error('Unauthorized');
  }
  
  return prisma.tenant.findMany({
    orderBy: { createdAt: 'desc' },
  });
}

export async function getTenantStats(tenantId: string) {
  const [
    usersCount,
    vendorsCount,
    requestsCount,
    rfqsCount,
    quotesCount,
  ] = await Promise.all([
    prisma.user.count({ where: { tenantId, isActive: true } }),
    prisma.vendor.count({ where: { tenantId, status: 'ACTIVE' } }),
    prisma.procurementRequest.count({ where: { tenantId } }),
    prisma.rFQ.count({ where: { tenantId } }),
    prisma.quote.count({ where: { tenantId } }),
  ]);
  
  return {
    users: usersCount,
    vendors: vendorsCount,
    requests: requestsCount,
    rfqs: rfqsCount,
    quotes: quotesCount,
  };
}