/**
 * requirement-approval.service.ts
 *
 * Service for the first approval checkpoint: PENDING_DEPARTMENT_APPROVAL
 *
 * This creates and manages RequirementApprovalRequest records,
 * resolving approvers via the configured RequirementApprovalPolicy.
 */
import prisma from '../../utils/prisma';
import { Prisma } from '@prisma/client';
import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from '../../utils/errors';
import {
  resolveRequirementApprovalRoute,
  createRequirementApprovalDecisions,
} from './approval-policy.service';
import { UserRole } from '@navo/shared';
import { createAuditLog } from '../audit/audit.service.js';
import { AuditAction } from '@navo/shared';
import {
  APPROVER_ROLES,
  canDecideApprovalLevel,
} from '../purchase-approvals/approval-roles.js';

export interface SubmitApprovalResult {
  approvalId: string;
  status: string;
  autoApproved: boolean;
  approverId?: string | null;
}

/**
 * Roles allowed to decide a requirement approval level.
 * Mirrors the purchase-approval gate so both checkpoints
 * enforce the same approver authority.
 */
const REQUIREMENT_APPROVER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
];

/**
 * Submit a confirmed ProcurementRequest for department approval.
 */
export async function submitRequirementForApproval(params: {
  requestId: string;
  submitterId: string;
  tenantId: string;
  requesterComment?: string;
}): Promise<SubmitApprovalResult> {
  const { requestId, submitterId, tenantId, requesterComment } = params;

  const request = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
  });

  if (!request) throw new NotFoundError('ProcurementRequest');

  // Prevent duplicate submission. The check and the create run in one
  // transaction so two concurrent submissions cannot both pass the check.
  const existingPending = await prisma.requirementApprovalRequest.findFirst({
    where: { requestId, tenantId, status: 'PENDING_APPROVAL' },
    select: { id: true },
  });
  if (existingPending) {
    throw new ConflictError('This requirement already has a pending approval request');
  }

  // Required information must be present before a requirement can be
  // submitted for approval; an incomplete requirement must not reach
  // an approver.
  const missing: string[] = [];
  if (!request.title?.trim()) missing.push('title');
  if (!request.item?.trim()) missing.push('item');
  if (request.quantity === null || request.quantity === undefined) missing.push('quantity');
  if (request.estimatedBudget === null || request.estimatedBudget === undefined) {
    missing.push('estimatedBudget');
  }
  if (missing.length > 0) {
    throw new ValidationError(
      `Requirement is missing required information: ${missing.join(', ')}`,
    );
  }

  // Resolve policy
  const route = await resolveRequirementApprovalRoute({
    actor: {
      userId: submitterId,
      tenantId,
      role: UserRole.REQUESTER,
    },
    requirement: {
      id: request.id,
      title: request.title,
      category: request.categoryId ?? null,
      department: request.department ?? null,
      costCenter: request.costCenter ?? null,
      estimatedBudget: request.estimatedBudget ?? null,
      currency: 'INR',
      requesterId: request.requesterId,
    },
  });

  // Build unique reference
  const refSeq = await prisma.requirementApprovalRequest.count({ where: { tenantId } });
  const reference = `RAR-${Date.now().toString(36).toUpperCase()}-${refSeq + 1}`;

  // Create the approval request inside a transaction together with the
  // request status change so a failure cannot leave a half-submitted state.
  const { approvalRequest, updatedRequest } = await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction: a concurrent submission may have
    // created a pending request since the check above.
    const raced = await tx.requirementApprovalRequest.findFirst({
      where: { requestId, tenantId, status: 'PENDING_APPROVAL' },
      select: { id: true },
    });
    if (raced) {
      throw new ConflictError('This requirement already has a pending approval request');
    }

    const created = await tx.requirementApprovalRequest.create({
      data: {
        tenantId,
        requestId,
        submittedById: submitterId,
        reference,
        status: route.autoApproved ? 'APPROVED' : 'PENDING_APPROVAL',
        policyVersion: route.policyVersion,
        appliedRuleId: route.appliedRuleId,
        policySnapshot: route.policySnapshot ?? {},
        ruleSnapshot: route.ruleSnapshot ?? Prisma.DbNull,
        thresholdAmount: route.thresholdAmount,
        estimatedAmount: route.thresholdAmount,
        requesterComment,
        currentLevel: 1,
        ...(route.autoApproved
          ? { approvedAt: new Date(), approvedById: submitterId }
          : {}),
      },
    });

    const newStatus = route.autoApproved ? 'APPROVED_FOR_SOURCING' : 'PENDING_DEPARTMENT_APPROVAL';
    const reqUpdated = await tx.procurementRequest.update({
      where: { id: requestId },
      data: { status: newStatus },
    });

    return { approvalRequest: created, updatedRequest: reqUpdated };
  });

  let firstApproverId: string | null | undefined = null;
  const newStatus = route.autoApproved ? 'APPROVED_FOR_SOURCING' : 'PENDING_DEPARTMENT_APPROVAL';

  if (!route.autoApproved && route.levels.length > 0) {
    await createRequirementApprovalDecisions(
      approvalRequest.id,
      route.levels,
      tenantId,
      submitterId
    );

    const firstDecision = await prisma.requirementApprovalDecision.findFirst({
      where: { requirementApprovalRequestId: approvalRequest.id, level: 1 },
      select: { assignedApproverId: true },
    });
    firstApproverId = firstDecision?.assignedApproverId;
  }

  await createAuditLog({
    userId: submitterId,
    action: AuditAction.CREATED,
    entityType: 'RequirementApprovalRequest',
    entityId: approvalRequest.id,
    tenantId,
    metadata: { requestId, autoApproved: route.autoApproved, reference },
  });

  // Notify approver if assigned
  if (firstApproverId) {
    await prisma.notification.create({
      data: {
        tenantId,
        userId: firstApproverId,
        type: 'APPROVAL_ASSIGNED',
        title: 'New requirement pending your approval',
        message: `${request.title || request.item || 'A requirement'} has been submitted for your approval.`,
        data: {
          entityType: 'RequirementApprovalRequest',
          entityId: approvalRequest.id,
        },
        isRead: false,
      },
    });
  }

  return {
    approvalId: approvalRequest.id,
    status: newStatus,
    autoApproved: route.autoApproved,
    approverId: firstApproverId,
  };
}

/**
 * Department head decides on a requirement approval.
 *
 * Enforcement mirrors the purchase-approval gate:
 * 1. The actor must hold approver-side authority.
 * 2. The actor's role must satisfy the level's required role.
 * 3. The actor must be the assigned approver (when one is assigned).
 * 4. The requester may not approve their own requirement
 *    (segregation of duties).
 * 5. The decision is claimed with a conditional update so two
 *    concurrent approvers cannot both decide the same level.
 */
export async function decideOnRequirementApproval(params: {
  approvalId: string;
  decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  comments?: string;
  approverId: string;
  actorRole: UserRole;
  tenantId: string;
}): Promise<{ requestId: string; newStatus: string }> {
  const { approvalId, decision, comments, approverId, actorRole, tenantId } = params;

  // 1. Approver-side authority is required to decide anything.
  if (!REQUIREMENT_APPROVER_ROLES.includes(actorRole)) {
    throw new ForbiddenError(
      'Only a procurement manager, finance approver or administrator can decide approvals',
    );
  }

  const approval = await prisma.requirementApprovalRequest.findFirst({
    where: { id: approvalId, tenantId, status: 'PENDING_APPROVAL' },
    include: {
      decisions: {
        where: {
          status: 'PENDING',
          OR: [{ assignedApproverId: approverId }, { assignedApproverId: null }],
        },
        orderBy: { level: 'asc' },
        take: 1,
      },
      request: {
        select: { id: true, title: true, item: true, requesterId: true },
      },
    },
  });

  if (!approval) throw new NotFoundError('RequirementApprovalRequest');

  const decisionRecord = approval.decisions[0];
  if (!decisionRecord) {
    throw new ForbiddenError('You are not authorized to decide on this approval');
  }

  // 2. The actor's current role must satisfy the level's required role.
  if (!canDecideApprovalLevel(actorRole, decisionRecord.requiredRole)) {
    throw new ForbiddenError(
      `This approval level requires the ${decisionRecord.requiredRole} role`,
    );
  }

  // 3. When a specific approver is assigned, only that approver may decide.
  if (decisionRecord.assignedApproverId && decisionRecord.assignedApproverId !== approverId) {
    throw new ForbiddenError('You are not authorized to decide on this approval');
  }

  // 4. Segregation of duties: the requester cannot approve their own
  //    requirement, even when the level has no assigned approver.
  if (approval.request?.requesterId === approverId) {
    throw new ForbiddenError(
      'Segregation of duties: the requester cannot approve their own requirement',
    );
  }

  if ((decision === 'REJECTED' || decision === 'CHANGES_REQUESTED') && !comments?.trim()) {
    throw new ValidationError('Comments are required for rejection or send-back');
  }

  // 5. Claim the decision with a conditional update. A concurrent
  //    approver that already decided this level updates zero rows.
  const claimed = await prisma.requirementApprovalDecision.updateMany({
    where: { id: decisionRecord.id, status: 'PENDING' },
    data: { status: decision, comments, decidedAt: new Date(), decidedById: approverId },
  });
  if (claimed.count === 0) {
    throw new ConflictError('This approval level has already been decided');
  }

  const approvalStatusMap = { APPROVED: 'APPROVED', REJECTED: 'REJECTED', CHANGES_REQUESTED: 'CHANGES_REQUESTED' } as const;
  const requestStatusMap = { APPROVED: 'APPROVED_FOR_SOURCING', REJECTED: 'REJECTED', CHANGES_REQUESTED: 'SEND_BACK' } as const;

  const newApprovalStatus = approvalStatusMap[decision];
  const newRequestStatus = requestStatusMap[decision];

  await prisma.requirementApprovalRequest.update({
    where: { id: approvalId },
    data: { status: newApprovalStatus, approvedAt: new Date(), approvedById: approverId },
  });

  await prisma.procurementRequest.update({
    where: { id: approval.requestId },
    data: { status: newRequestStatus },
  });

  await createAuditLog({
    userId: approverId,
    action: AuditAction.UPDATED,
    entityType: 'RequirementApprovalRequest',
    entityId: approvalId,
    tenantId,
    metadata: { decision, comments, newRequestStatus },
  });

  // Notify requester
  if (approval.request?.requesterId) {
    const msgs = {
      APPROVED: 'Your requirement has been approved. NAVO will begin vendor matching.',
      REJECTED: `Your requirement has been rejected.${comments ? ` Reason: ${comments}` : ''}`,
      CHANGES_REQUESTED: `Your requirement was sent back for changes.${comments ? ` Comment: ${comments}` : ''}`,
    };
    const titles = {
      APPROVED: 'Requirement Approved ✅',
      REJECTED: 'Requirement Rejected ❌',
      CHANGES_REQUESTED: 'Requirement Sent Back 🔄',
    };
    await prisma.notification.create({
      data: {
        tenantId,
        userId: approval.request.requesterId,
        type: decision === 'APPROVED' ? 'APPROVAL_APPROVED' : decision === 'REJECTED' ? 'APPROVAL_REJECTED' : 'APPROVAL_CHANGES_REQUESTED',
        title: titles[decision],
        message: msgs[decision],
        data: {
          entityType: 'RequirementApprovalRequest',
          entityId: approvalId,
        },
        isRead: false,
      },
    });
  }

  return { requestId: approval.requestId, newStatus: newRequestStatus };
}

/**
 * Get pending requirement approvals for a department head.
 */
export async function getPendingRequirementApprovalsForUser(userId: string, tenantId: string) {
  return prisma.requirementApprovalRequest.findMany({
    where: {
      tenantId,
      status: 'PENDING_APPROVAL',
      decisions: {
        some: {
          status: 'PENDING',
          OR: [{ assignedApproverId: userId }, { assignedApproverId: null }],
        },
      },
    },
    include: {
      request: {
        select: {
          id: true,
          title: true,
          item: true,
          quantity: true,
          unit: true,
          estimatedBudget: true,
          department: true,
          location: true,
          requiredDate: true,
          description: true,
          specifications: true,
          requester: { select: { firstName: true, lastName: true, email: true } },
          requirementDraft: { select: { category: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get approval status for a requirement.
 */
export async function getApprovalStatusForRequest(requestId: string, tenantId: string) {
  return prisma.requirementApprovalRequest.findFirst({
    where: { requestId, tenantId },
    orderBy: { createdAt: 'desc' },
    include: { decisions: { orderBy: { level: 'asc' } } },
  });
}
