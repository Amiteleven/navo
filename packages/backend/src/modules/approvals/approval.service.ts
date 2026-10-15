import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, ApprovalStatus, RequestStatus } from '@navo/shared';
import { generateRecommendation } from '../ai/ai.service';
import { Prisma } from '@prisma/client';

export interface CreateApprovalInput {
  requestId: string;
  approverId: string;
}

export interface DecideApprovalInput {
  status: ApprovalStatus;
  comments?: string;
}

export async function createApproval(input: CreateApprovalInput, userId: string, tenantId: string) {
  const request = await prisma.procurementRequest.findFirst({
    where: { id: input.requestId, tenantId },
    include: { approvals: true },
  });
  
  if (!request) {
    throw new NotFoundError('Procurement Request');
  }
  
  const existingPending = request.approvals.find((a) => a.status === ApprovalStatus.PENDING);
  if (existingPending) {
    throw new ValidationError('Request already has a pending approval');
  }
  
  const approver = await prisma.user.findFirst({
    where: { id: input.approverId, tenantId, isActive: true },
  });
  
  if (!approver) {
    throw new NotFoundError('Approver');
  }
  
  const approval = await prisma.approval.create({
    data: {
      requestId: input.requestId,
      approverId: input.approverId,
      status: ApprovalStatus.PENDING,
      tenantId,
    },
    include: {
      approver: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });
  
  await prisma.procurementRequest.update({
    where: { id: input.requestId },
    data: { status: RequestStatus.APPROVAL_PENDING },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.CREATED,
    entityType: 'Approval',
    entityId: approval.id,
    tenantId,
    metadata: { requestId: input.requestId, approverId: input.approverId },
  });
  
  return approval;
}

export async function getApproval(approvalId: string, tenantId: string) {
  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, tenantId },
    include: {
      request: {
        include: {
          category: true,
          requester: { select: { id: true, firstName: true, lastName: true, email: true } },
          rfqs: {
            include: {
              quotes: {
                include: {
                  vendor: { select: { id: true, name: true, status: true } },
                  comparison: true,
                },
              },
            },
          },
          recommendation: true,
        },
      },
      approver: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });
  
  if (!approval) {
    throw new NotFoundError('Approval');
  }
  
  return approval;
}

export async function listApprovals(
  tenantId: string,
  filters: {
    status?: ApprovalStatus;
    approverId?: string;
    requestId?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };
  
  if (filters.status) where.status = filters.status;
  if (filters.approverId) where.approverId = filters.approverId;
  if (filters.requestId) where.requestId = filters.requestId;
  
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;
  
  const [approvals, total] = await Promise.all([
    prisma.approval.findMany({
      where,
      include: {
        request: { select: { id: true, title: true, status: true, item: true, quantity: true } },
        approver: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.approval.count({ where }),
  ]);
  
  return { data: approvals, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function decideApproval(approvalId: string, tenantId: string, input: DecideApprovalInput, userId: string) {
  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, tenantId },
    include: { request: true },
  });
  
  if (!approval) {
    throw new NotFoundError('Approval');
  }
  
  if (approval.approverId !== userId) {
    throw new ValidationError('You are not the assigned approver');
  }
  
  if (approval.status !== ApprovalStatus.PENDING) {
    throw new ValidationError('Approval has already been decided');
  }
  
  const updated = await prisma.approval.update({
    where: { id: approvalId },
    data: {
      status: input.status,
      comments: input.comments,
      decidedAt: new Date(),
    },
  });
  
  let newRequestStatus: RequestStatus;
  
  switch (input.status) {
    case ApprovalStatus.APPROVED:
      newRequestStatus = RequestStatus.APPROVED;
      break;
    case ApprovalStatus.REJECTED:
      newRequestStatus = RequestStatus.REJECTED;
      break;
    case ApprovalStatus.CHANGES_REQUESTED:
      newRequestStatus = RequestStatus.CHANGES_REQUESTED;
      break;
    default:
      newRequestStatus = RequestStatus.APPROVAL_PENDING;
  }
  
  await prisma.procurementRequest.update({
    where: { id: approval.requestId },
    data: { status: newRequestStatus },
  });
  
  await createAuditLog({
    userId,
    action: input.status === ApprovalStatus.APPROVED ? AuditAction.APPROVED : AuditAction.REJECTED,
    entityType: 'Approval',
    entityId: approvalId,
    tenantId,
    previousStatus: ApprovalStatus.PENDING,
    newStatus: input.status,
    decision: input.comments,
  });
  
  return updated;
}

export async function generateApprovalRecommendation(requestId: string, tenantId: string, userId: string) {
  const request = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
    include: {
      rfqs: {
        include: {
          quotes: {
            include: {
              vendor: { select: { id: true, name: true, status: true } },
              comparison: true,
            },
          },
        },
      },
    },
  });
  
  if (!request) {
    throw new NotFoundError('Procurement Request');
  }
  
  // Collect all quotes from all RFQs
  const allQuotes = request.rfqs.flatMap((rfq) => rfq.quotes);
  
  if (allQuotes.length === 0) {
    throw new ValidationError('No quotes available for recommendation');
  }
  
  const quotesForAI = allQuotes.map((q) => ({
    id: q.id,
    vendor: { name: q.vendor.name, status: q.vendor.status },
    totalLandedCost: q.comparison?.totalLandedCost || q.unitPrice * q.quantity,
    deliveryDays: q.comparison?.deliveryDays || q.deliveryTimelineDays || 0,
    warrantyMonths: q.comparison?.warrantyMonths || q.warrantyMonths || 0,
    paymentTerms: q.comparison?.paymentTerms || q.paymentTerms || '',
  }));
  
  const recommendation = await generateRecommendation(quotesForAI, {
    item: request.item,
    quantity: request.quantity,
    location: request.location,
    requiredDate: request.requiredDate,
  });
  
  // Save recommendation
  const saved = await prisma.recommendation.upsert({
    where: { requestId },
    create: {
      requestId,
      recommendedQuoteId: recommendation.recommendedQuoteId,
      reasoning: recommendation.reasoning,
      factors: recommendation.factors as Prisma.InputJsonValue,
      commercialValue: recommendation.scores.commercial || 0,
      deliveryScore: recommendation.scores.delivery || 0,
      specificationScore: recommendation.scores.specifications || 0,
      vendorStatusScore: recommendation.scores.vendor || 0,
      historicalScore: recommendation.scores.historical || 0,
      benchmarkScore: recommendation.scores.benchmark || 0,
      paymentTermsScore: recommendation.scores.payment || 0,
      warrantyScore: recommendation.scores.warranty || 0,
      riskScore: recommendation.scores.risk || 0,
      totalScore: Object.values(recommendation.scores).reduce((a, b) => a + b, 0) / Object.keys(recommendation.scores).length,
    },
    update: {
      recommendedQuoteId: recommendation.recommendedQuoteId,
      reasoning: recommendation.reasoning,
      factors: recommendation.factors as Prisma.InputJsonValue,
      commercialValue: recommendation.scores.commercial || 0,
      deliveryScore: recommendation.scores.delivery || 0,
      specificationScore: recommendation.scores.specifications || 0,
      vendorStatusScore: recommendation.scores.vendor || 0,
      historicalScore: recommendation.scores.historical || 0,
      benchmarkScore: recommendation.scores.benchmark || 0,
      paymentTermsScore: recommendation.scores.payment || 0,
      warrantyScore: recommendation.scores.warranty || 0,
      riskScore: recommendation.scores.risk || 0,
      totalScore: Object.values(recommendation.scores).reduce((a, b) => a + b, 0) / Object.keys(recommendation.scores).length,
    },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.RECOMMENDATION_GENERATED,
    entityType: 'Recommendation',
    entityId: saved.id,
    tenantId,
    aiRecommendation: JSON.stringify(recommendation),
  });
  
  await prisma.procurementRequest.update({
    where: { id: requestId },
    data: { status: RequestStatus.RECOMMENDATION_READY },
  });
  
  return saved;
}

export async function getRecommendation(requestId: string, tenantId: string) {
  const recommendation = await prisma.recommendation.findUnique({
    where: { requestId },
  });
  
  if (!recommendation) {
    throw new NotFoundError('Recommendation');
  }
  
  return recommendation;
}