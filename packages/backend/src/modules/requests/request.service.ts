import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, RequestStatus, UserRole } from '@navo/shared';
import { extractRequirements } from '../ai/ai.service';
import { Prisma } from '@prisma/client';
import { suspendRequirementApprovalsForMaterialChange } from '../requirement-approval/approval-policy.service.js';

export interface CreateRequestInput {
  title: string;
  description: string;
  categoryId?: string;
  item: string;
  quantity: number;
  unit?: string;
  location: string;
  requiredDate: Date;
  specifications?: string;
  estimatedBudget?: number;
  priority?: number;
}

export interface UpdateRequestInput {
  title?: string;
  description?: string;
  categoryId?: string;
  item?: string;
  quantity?: number;
  unit?: string;
  location?: string;
  requiredDate?: Date;
  specifications?: string;
  estimatedBudget?: number;
  priority?: number;
}

export async function createRequest(input: CreateRequestInput, userId: string, tenantId: string) {
  const request = await prisma.procurementRequest.create({
    data: {
      ...input,
      requiredDate: new Date(input.requiredDate),
      requesterId: userId,
      tenantId,
      status: RequestStatus.DRAFT,
    },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.CREATED,
    entityType: 'ProcurementRequest',
    entityId: request.id,
    tenantId,
    newStatus: RequestStatus.DRAFT,
    metadata: { title: request.title },
  });
  
  return request;
}

export async function getRequest(requestId: string, tenantId: string) {
  const request = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
    include: {
      category: true,
      requester: { select: { id: true, firstName: true, lastName: true, email: true } },
      assignee: { select: { id: true, firstName: true, lastName: true, email: true } },
      extractedReq: true,
      rfqs: { include: { vendors: { include: { vendor: true } } } },
      approvals: { include: { approver: { select: { id: true, firstName: true, lastName: true, email: true } } } },
    },
  });
  
  if (!request) {
    throw new NotFoundError('Procurement Request');
  }
  
  return request;
}

export async function listRequests(
  tenantId: string,
  filters: {
    status?: RequestStatus;
    requesterId?: string;
    assigneeId?: string;
    categoryId?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };
  
  if (filters.status) where.status = filters.status;
  if (filters.requesterId) where.requesterId = filters.requesterId;
  if (filters.assigneeId) where.assigneeId = filters.assigneeId;
  if (filters.categoryId) where.categoryId = filters.categoryId;
  
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;
  
  const [requests, total] = await Promise.all([
    prisma.procurementRequest.findMany({
      where,
      include: {
        category: true,
        requester: { select: { id: true, firstName: true, lastName: true, email: true } },
        assignee: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { [filters.sortBy || 'createdAt']: filters.sortOrder || 'desc' },
      skip,
      take: limit,
    }),
    prisma.procurementRequest.count({ where }),
  ]);
  
  return { data: requests, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function updateRequest(requestId: string, tenantId: string, input: UpdateRequestInput, userId: string) {
  const existing = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
  });
  
  if (!existing) {
    throw new NotFoundError('Procurement Request');
  }
  
  const updated = await prisma.procurementRequest.update({
    where: { id: requestId },
    data: {
      ...input,
      requiredDate: input.requiredDate ? new Date(input.requiredDate) : undefined,
    },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'ProcurementRequest',
    entityId: requestId,
    tenantId,
    metadata: input as unknown as Prisma.InputJsonValue,
  });

  // A requirement whose approval was already granted must not
  // silently authorize sourcing against changed terms. When the
  // edit is material, the approval is superseded and the
  // requirement returns to the approval queue. A requirement
  // still pending approval needs no invalidation - its approver
  // has not decided against the old terms yet.
  if (existing.status === 'APPROVED_FOR_SOURCING') {
    await suspendRequirementApprovalsForMaterialChange({
      tenantId,
      requestId,
      previousReq: existing,
      updatedReq: {
        ...input,
        requiredDate: input.requiredDate ? new Date(input.requiredDate) : undefined,
      },
      actorId: userId,
    });
  }
  
  return updated;
}

export async function submitRequest(requestId: string, tenantId: string, userId: string) {
  const existing = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
  });
  
  if (!existing) {
    throw new NotFoundError('Procurement Request');
  }
  
  if (existing.status !== RequestStatus.DRAFT) {
    throw new ValidationError('Only draft requests can be submitted');
  }
  
  const updated = await prisma.procurementRequest.update({
    where: { id: requestId },
    data: { status: RequestStatus.SUBMITTED },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.SUBMITTED,
    entityType: 'ProcurementRequest',
    entityId: requestId,
    tenantId,
    previousStatus: RequestStatus.DRAFT,
    newStatus: RequestStatus.SUBMITTED,
  });
  
  return updated;
}

export async function extractAndUpdateRequirements(requestId: string, tenantId: string, userId: string) {
  const request = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
  });
  
  if (!request) {
    throw new NotFoundError('Procurement Request');
  }
  
  const extracted = await extractRequirements(request.description);
  
  const extractedReq = await prisma.extractedRequirement.upsert({
    where: { requestId },
    create: {
      requestId,
      ...extracted,
    },
    update: {
      ...extracted,
    },
  });
  
  await prisma.procurementRequest.update({
    where: { id: requestId },
    data: { status: RequestStatus.REQUIREMENT_EXTRACTED },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.STATUS_CHANGED,
    entityType: 'ProcurementRequest',
    entityId: requestId,
    tenantId,
    previousStatus: request.status,
    newStatus: RequestStatus.REQUIREMENT_EXTRACTED,
    aiRecommendation: JSON.stringify(extracted),
  });
  
  return { request: { ...request, status: RequestStatus.REQUIREMENT_EXTRACTED }, extractedReq };
}

export async function updateRequestStatus(
  requestId: string,
  tenantId: string,
  status: RequestStatus,
  userId: string,
  metadata?: Record<string, unknown>
) {
  const existing = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
  });
  
  if (!existing) {
    throw new NotFoundError('Procurement Request');
  }
  
  const updated = await prisma.procurementRequest.update({
    where: { id: requestId },
    data: { status },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.STATUS_CHANGED,
    entityType: 'ProcurementRequest',
    entityId: requestId,
    tenantId,
    previousStatus: existing.status,
    newStatus: status,
    metadata: metadata as unknown as Prisma.InputJsonValue | undefined,
  });
  
  return updated;
}

export async function deleteRequest(requestId: string, tenantId: string, userId: string) {
  const existing = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
  });
  
  if (!existing) {
    throw new NotFoundError('Procurement Request');
  }
  
  await prisma.procurementRequest.delete({ where: { id: requestId } });
  
  await createAuditLog({
    userId,
    action: AuditAction.DELETED,
    entityType: 'ProcurementRequest',
    entityId: requestId,
    tenantId,
    metadata: { title: existing.title },
  });
}

export async function getRequestStats(tenantId: string) {
  const statuses = Object.values(RequestStatus);
  const stats = await Promise.all(
    statuses.map(async (status) => ({
      status,
      count: await prisma.procurementRequest.count({ where: { tenantId, status } }),
    }))
  );
  
  return stats.reduce((acc, { status, count }) => {
    acc[status] = count;
    return acc;
  }, {} as Record<RequestStatus, number>);
}