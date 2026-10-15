import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, RFQStatus, RequestStatus } from '@navo/shared';

export interface CreateRFQInput {
  requestId: string;
  title: string;
  description: string;
  quantity: number;
  specifications?: string;
  deliveryLocation: string;
  requiredDeliveryDate: Date;
  submissionDeadline: Date;
  vendorIds: string[];
}

export async function createRFQ(input: CreateRFQInput, userId: string, tenantId: string) {
  const request = await prisma.procurementRequest.findFirst({
    where: { id: input.requestId, tenantId },
  });
  
  if (!request) {
    throw new NotFoundError('Procurement Request');
  }
  
  // Verify all vendors belong to the tenant
  const vendors = await prisma.vendor.findMany({
    where: { id: { in: input.vendorIds }, tenantId },
  });
  
  if (vendors.length !== input.vendorIds.length) {
    throw new ValidationError('One or more vendors not found or not in your tenant');
  }
  
  // Generate RFQ number
  const count = await prisma.rFQ.count({ where: { tenantId } });
  const rfqNumber = `RFQ-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
  
  const rfq = await prisma.rFQ.create({
    data: {
      rfqNumber,
      requestId: input.requestId,
      title: input.title,
      description: input.description,
      quantity: input.quantity,
      specifications: input.specifications,
      deliveryLocation: input.deliveryLocation,
      requiredDeliveryDate: new Date(input.requiredDeliveryDate),
      submissionDeadline: new Date(input.submissionDeadline),
      status: RFQStatus.DRAFT,
      createdById: userId,
      tenantId,
      vendors: {
        create: input.vendorIds.map((vendorId) => ({
          vendorId,
          status: 'INVITED',
        })),
      },
    },
    include: {
      vendors: { include: { vendor: true } },
    },
  });
  
  await prisma.procurementRequest.update({
    where: { id: input.requestId },
    data: { status: RequestStatus.RFQ_CREATED },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.RFQ_CREATED,
    entityType: 'RFQ',
    entityId: rfq.id,
    tenantId,
    metadata: { rfqNumber, vendorCount: input.vendorIds.length },
  });
  
  return rfq;
}

export async function getRFQ(rfqId: string, tenantId: string) {
  const rfq = await prisma.rFQ.findFirst({
    where: { id: rfqId, tenantId },
    include: {
      request: true,
      createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      vendors: { include: { vendor: true } },
      quotes: { include: { vendor: true, comparison: true } },
    },
  });
  
  if (!rfq) {
    throw new NotFoundError('RFQ');
  }
  
  return rfq;
}

export async function listRFQs(
  tenantId: string,
  filters: {
    status?: RFQStatus;
    requestId?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };
  
  if (filters.status) where.status = filters.status;
  if (filters.requestId) where.requestId = filters.requestId;
  
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;
  
  const [rfqs, total] = await Promise.all([
    prisma.rFQ.findMany({
      where,
      include: {
        request: { select: { id: true, title: true, status: true } },
        vendors: { include: { vendor: { select: { id: true, name: true } } } },
        _count: { select: { quotes: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.rFQ.count({ where }),
  ]);
  
  return { data: rfqs, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function sendRFQ(rfqId: string, tenantId: string, userId: string) {
  const rfq = await prisma.rFQ.findFirst({
    where: { id: rfqId, tenantId },
    include: { vendors: true },
  });
  
  if (!rfq) {
    throw new NotFoundError('RFQ');
  }
  
  if (rfq.status !== RFQStatus.DRAFT) {
    throw new ValidationError('Only draft RFQs can be sent');
  }
  
  if (rfq.vendors.length === 0) {
    throw new ValidationError('Cannot send RFQ without vendors');
  }
  
  const updated = await prisma.rFQ.update({
    where: { id: rfqId },
    data: {
      status: RFQStatus.SENT,
      vendors: {
        updateMany: {
          where: { rfqId },
          data: { invitedAt: new Date() },
        },
      },
    },
  });
  
  await prisma.procurementRequest.update({
    where: { id: rfq.requestId },
    data: { status: RequestStatus.RFQ_SENT },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.RFQ_SENT,
    entityType: 'RFQ',
    entityId: rfqId,
    tenantId,
    previousStatus: RFQStatus.DRAFT,
    newStatus: RFQStatus.SENT,
    metadata: { vendorCount: rfq.vendors.length },
  });
  
  return updated;
}

export async function closeRFQ(rfqId: string, tenantId: string, userId: string) {
  const rfq = await prisma.rFQ.findFirst({
    where: { id: rfqId, tenantId },
  });
  
  if (!rfq) {
    throw new NotFoundError('RFQ');
  }
  
  const updated = await prisma.rFQ.update({
    where: { id: rfqId },
    data: { status: RFQStatus.CLOSED },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'RFQ',
    entityId: rfqId,
    tenantId,
    previousStatus: rfq.status,
    newStatus: RFQStatus.CLOSED,
  });
  
  return updated;
}

export async function getRFQVendors(rfqId: string, tenantId: string) {
  return prisma.rFQVendor.findMany({
    where: { rfqId },
    include: { vendor: true },
  });
}